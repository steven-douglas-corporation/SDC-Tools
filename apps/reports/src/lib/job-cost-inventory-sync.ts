import "server-only";
import fs from "fs/promises";
import path from "path";
import ExcelJS from "exceljs";
import { prisma } from "@/lib/prisma";

// ── Job Cost Explorer: Lisa's monthly inventory workbook (2026-08-11) ────────
//
// Replaces the hand-maintained src/data/job-cost/inventory-data.json — a single
// always-latest snapshot someone had to manually regenerate from this exact
// workbook and drop in, which had gone stale (stuck on May 2026) by the time
// this file was written. This reads the real thing directly.
//
// ── The workbook's actual shape (confirmed by opening the real file) ────────
//
// It is NOT "a new file each month" in the sense of one file per month sitting
// side by side — it is ONE growing workbook that Lisa renames after its latest
// month (e.g. "2026.06.30 12000-000 SDC Inventory.xlsx") while adding a new
// dated SHEET inside it every month: "SDC inventory 6.30.26", "SDC inventory
// 5.31.26", … back to 2023, alongside her own separate "*ETC*"/"*Est to
// Compl*"/"*CTC*" tracking tabs in the SAME file. So "detect a new monthly
// file" really means "detect a new dated sheet inside whichever file matches",
// and a full re-parse each Refresh Data pass is the simplest correct way to
// find one — measured live against the real 58-sheet/1.1MB file: 613ms, cheap
// enough to not need any separate change-detection/hashing on top.
//
// Every row is upserted keyed on (jobId, asOfDate) — never a wholesale
// replace — so a newly-added month's sheet can only ADD rows, never touch an
// already-stored older month. That is what makes "reproduce the July view
// while working in August" survive a new file arriving at all.
//
// The two functions that only READ this table (getInventorySnapshotForDate,
// listInventorySnapshotDates) live in the SIBLING file
// job-cost-inventory-snapshot.ts, not here — see that file's own header for
// why: job-cost-source.ts imports those statically on every page render, and
// a plain `import` pulls in this WHOLE file (fs/ExcelJS included) for
// bundling/tracing purposes even though page render never calls
// syncJobCostInventorySnapshots below. Keeping the two pure DB reads apart
// from this file's fs.readdir/ExcelJS.readFile work is what keeps this file's
// dynamic, outside-the-project path out of every page's build trace.

// /*turbopackIgnore*/ below (2026-08-11): this path is a runtime-computed
// value pointing OUTSIDE the project entirely (Lisa's OneDrive-synced Finance
// folder). Next's build-time file tracer (@vercel/nft) statically scans for
// `fs`/`path` calls to figure out which files a route needs bundled — when it
// can't resolve an argument to a literal path (this one comes from
// `process.env` or a hardcoded absolute path, never a project-relative
// literal), it falls back to over-including files to be safe, which is
// exactly the "next.config.ts was traced unintentionally" build warning this
// caused on every route that reaches this module (confirmed: still happened
// through auto-sync.ts's OWN dynamic import of this file, not only through a
// static one — a literal-string `await import(...)` is traced too). The
// ignore comment tells the tracer "don't try to resolve this expression as a
// file dependency at all", which is correct here: nothing this reads is ever
// a project file that bundling could need.
const INVENTORY_FOLDER =
  process.env.JOB_COST_INVENTORY_FOLDER?.trim() || "C:/Users/akamuju/Steven Douglas Corp/Finance - General";

// A sheet counts as an inventory snapshot only if its name contains "inventory"
// (case-insensitive) AND carries a M.D.YY-ish date. The "contains inventory" half
// is what excludes every one of Lisa's OWN "25-June ETC" / "Monthly Est to
// Compl 9.30.24" / "12.31 CTC Dec_version 4" tabs living in the same
// workbook — confirmed by listing all 58 real sheet names, none of Lisa's other
// tabs contain the word.
const SHEET_DATE_RE = /(\d{1,2})\.(\d{1,2})\.(\d{2,4})/;

export function parseSheetDate(sheetName: string): string | null {
  if (!/inventory/i.test(sheetName)) return null;
  const m = SHEET_DATE_RE.exec(sheetName);
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  let year = Number(m[3]);
  if (year < 100) year += 2000;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

// Excel's own lock file for a workbook someone has open ("~$2026.06.30 ....xlsx")
// — never a real inventory file, and ExcelJS can't parse it anyway.
function isRealWorkbook(fileName: string): boolean {
  return !fileName.startsWith("~$") && /inventory/i.test(fileName) && fileName.toLowerCase().endsWith(".xlsx");
}

type SheetColumns = { headerRow: number; jobCol: number; salesCol: number; pctCol: number };

// Anchored to "Job #" first, then "Total Sold Price"/"% Complete" are looked
// for ONLY within that SAME row — not a multi-row scan window. The real file
// has a merged two-row super-header immediately above ("$ Complete " / "%
// Complete " at row 4, columns J/K) labeling the "change from prior month"
// pair, one row above the real per-column header at row 5 ("Job #" | … |
// "Total Sold Price" | … | "% Complete " at column I). A window scan visits
// row 4 before row 5 and locks onto ITS "% Complete" first — silently reading
// the prior-month DELTA column as if it were the real one. Anchoring
// everything to Job #'s own row is what rules that out structurally, not just
// for this one sheet's layout. Returns null (skip the sheet) if any of the
// three isn't found on that row — a moved column must show up as "no data for
// that month", not as a silently wrong one.
function findInventoryColumns(ws: ExcelJS.Worksheet): SheetColumns | null {
  for (let r = 1; r <= Math.min(8, ws.rowCount); r++) {
    const row = ws.getRow(r);
    let jobCol: number | null = null;
    for (let c = 1; c <= ws.columnCount; c++) {
      const text = typeof row.getCell(c).value === "string" ? (row.getCell(c).value as string).trim() : "";
      if (text && /^job\s*#/i.test(text)) {
        jobCol = c;
        break;
      }
    }
    if (jobCol == null) continue;
    let salesCol: number | null = null;
    let pctCol: number | null = null;
    for (let c = 1; c <= ws.columnCount; c++) {
      const text = typeof row.getCell(c).value === "string" ? (row.getCell(c).value as string).trim() : "";
      if (!text) continue;
      if (salesCol == null && /total sold price/i.test(text)) salesCol = c;
      else if (pctCol == null && /^%\s*complete/i.test(text)) pctCol = c;
    }
    if (salesCol == null || pctCol == null) return null;
    return { headerRow: r, jobCol, salesCol, pctCol };
  }
  return null;
}

// ExcelJS hands back either a plain value or a formula-result wrapper
// ({formula, result, ...}) — every real data cell in this sheet is a formula
// (Total Sold Price nets several change-order terms; % Complete divides two
// other columns), so unwrapping .result is required, not defensive dressing.
function unwrapCell(v: ExcelJS.CellValue): unknown {
  if (v != null && typeof v === "object" && "result" in (v as object)) return (v as { result: unknown }).result;
  if (v != null && typeof v === "object" && "text" in (v as object)) return (v as { text: unknown }).text;
  return v;
}

// Same normalization sync-totaleto.ts already uses for every numeric job id
// coming out of an external system (String(Number(x))) — applied here because
// the file this replaces stores "0979" for job 979, which the app-side
// Job.jobId ("979", confirmed — no real job id is zero-padded) NEVER matches,
// so that job's Sales$/%Complete has been silently dropped from Job Cost
// Explorer this whole time.
//
// Returns null for anything that ISN'T a bare number — confirmed against the
// live Job table that every real job id is purely numeric with no exceptions,
// so this is not a narrowing of what a real row can look like. It IS what
// rejects the two kinds of non-job text sharing this same column found in the
// real file: the sheet's own title block above the header ("Steven Douglas
// Corp.", the as-of date, "Job #" itself) and freeform notes below the last
// real row ("1160 includes a late penalty clause", "Prior month inventory") —
// both otherwise indistinguishable from a real row by position alone, since
// Lisa's own notes carry real-looking Sales $ values in their row too.
function normalizeJobId(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? String(n) : null;
}

type InventoryRow = { jobId: string; salesPrice: number | null; percentComplete: number | null };

export function readInventorySheet(ws: ExcelJS.Worksheet): InventoryRow[] {
  const cols = findInventoryColumns(ws);
  if (!cols) return [];
  const out: InventoryRow[] = [];
  for (let r = cols.headerRow + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const jobId = normalizeJobId(unwrapCell(row.getCell(cols.jobCol).value));
    if (!jobId) continue;
    const salesRaw = unwrapCell(row.getCell(cols.salesCol).value);
    const pctRaw = unwrapCell(row.getCell(cols.pctCol).value);
    const salesPrice = typeof salesRaw === "number" && Number.isFinite(salesRaw) ? salesRaw : null;
    // The sheet stores a fraction (0.801… for "80.1%"); the app-wide convention
    // (fmtPct, and the JSON file this replaces) is 0-100 — confirmed against real
    // non-null entries already in inventory-data.json (77.7, 93.7, 100.0, …).
    const percentComplete = typeof pctRaw === "number" && Number.isFinite(pctRaw) ? Math.round(pctRaw * 1000) / 10 : null;
    out.push({ jobId, salesPrice, percentComplete });
  }
  return out;
}

export async function syncJobCostInventorySnapshots(): Promise<string | { skip: string }> {
  let fileNames: string[];
  try {
    fileNames = (await fs.readdir(/* turbopackIgnore: true */ INVENTORY_FOLDER)).filter(isRealWorkbook);
  } catch (err) {
    return { skip: `inventory folder not reachable (${INVENTORY_FOLDER}): ${err instanceof Error ? err.message : String(err)}` };
  }
  if (fileNames.length === 0) return { skip: `no *inventory*.xlsx file found in ${INVENTORY_FOLDER}` };

  let filesRead = 0;
  let sheetsMatched = 0;
  let rowsUpserted = 0;
  const fileErrors: string[] = [];

  for (const fileName of fileNames) {
    const filePath = path.join(/* turbopackIgnore: true */ INVENTORY_FOLDER, fileName);
    try {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(/* turbopackIgnore: true */ filePath);
      filesRead++;
      for (const ws of wb.worksheets) {
        const asOfDate = parseSheetDate(ws.name);
        if (!asOfDate) continue;
        sheetsMatched++;
        const rows = readInventorySheet(ws);
        for (const r of rows) {
          await prisma.$executeRaw`
            INSERT INTO JobCostInventorySnapshot (jobId, asOfDate, salesPrice, percentComplete, sourceFile, sourceSheet, syncedAt)
            VALUES (${r.jobId}, ${asOfDate}, ${r.salesPrice}, ${r.percentComplete}, ${fileName}, ${ws.name}, ${new Date()})
            ON DUPLICATE KEY UPDATE salesPrice=${r.salesPrice}, percentComplete=${r.percentComplete}, sourceFile=${fileName}, sourceSheet=${ws.name}, syncedAt=${new Date()}`;
          rowsUpserted++;
        }
      }
    } catch (err) {
      // One bad file must not take the others down with it — matching auto-sync's
      // own "failures are isolated" rule, applied one level down since this step
      // itself can see more than one file.
      fileErrors.push(`${fileName}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (filesRead === 0) return { skip: `found ${fileNames.length} candidate file(s) but none could be read: ${fileErrors.join("; ")}` };

  const errSuffix = fileErrors.length ? ` (${fileErrors.length} file(s) failed: ${fileErrors.join("; ")})` : "";
  return `${filesRead} file(s), ${sheetsMatched} dated sheet(s), ${rowsUpserted} row(s) upserted${errSuffix}`;
}
