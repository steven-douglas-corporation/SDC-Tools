import { loadTmPartsLines, tmDrillRowsFrom } from "@/lib/tm-parts-source";
import { PARTS_CARDS, TM_PARTS_KEYS, TM_PARTS_LABELS, type TmPartsDrillKey, type TmPartsDrillRow } from "@/lib/tm-report";
import { filterTmPartsDrillRows, normalizeTmPartsQuery } from "@/lib/tm-parts-search";
import { isValidDateRange, sanitizeJobIds } from "@/lib/tm-drill-validate";
import type { CellValue, SheetColumn, SheetSpec } from "@/lib/export/sheet";

// ── One T&M Parts card's drill-through, as a spreadsheet ────────────────────
//
// Same pipeline, and the same reasoning, as tm-hours-export.ts: SheetSpec ->
// buildCsv/buildXlsx, off the SAME row source the panel renders
// (loadTmPartsLines + tmDrillRowsFrom, via tm-parts-source.ts), with the
// search box forwarded and applied through lib/tm-parts-search.ts — the SAME
// predicate the panel filters with. See that file's header for why it's
// shared rather than re-implemented here.
//
// The panel's SORT is not forwarded, for the same reason tm-hours-export.ts
// gives: the sheet is emitted in tmDrillRowsFrom's own order, and a column
// sort is client state a spreadsheet reproduces natively in one click.
//
// No row-cap guard here (contrast tm-hours-export.ts's 4,000-row check):
// loadTmPartsLines reads Total ETO's Parts Cost query directly, with no
// MAX_ROWS truncation to defend against.

export type TmPartsExportParams = {
  key?: string;
  jobs?: string;
  from?: string;
  to?: string;
  q?: string;
};

export type TmPartsExportResult = { spec: SheetSpec; rowCount: number; cardLabel: string };

/** Rejects anything not one of the three real card keys — same guard the drill action applies. */
function parseKey(raw: string | undefined): TmPartsDrillKey {
  if (!raw || !TM_PARTS_KEYS.includes(raw as TmPartsDrillKey)) {
    throw new Error(`Invalid drill key "${raw ?? ""}".`);
  }
  return raw as TmPartsDrillKey;
}

/** Which row field reconciles to this card's KPI — the same fact PARTS_CARDS already carries. */
function amountKeyFor(key: TmPartsDrillKey): "totalPrice" | "invoicedAmount" {
  return PARTS_CARDS[key].amountColumn === "Invoiced Amount" ? "invoicedAmount" : "totalPrice";
}

// Headers match the panel's own column labels exactly ("Job ID", "Job /
// Machine", "Job Cost", "Invoiced $"), not the underlying field names — the
// file has to be recognisable as the table it came from.
const COLUMNS: SheetColumn[] = [
  { header: "Purchase Date", type: "date", width: 12 },
  { header: "Invoiced Date", type: "date", width: 12 },
  { header: "Job ID", type: "text", width: 14 },
  { header: "Job / Machine", type: "text", width: 34 },
  { header: "Part No", type: "text", width: 18 },
  { header: "Description", type: "text", width: 34 },
  { header: "Supplier", type: "text", width: 24 },
  { header: "PO #", type: "text", width: 14 },
  { header: "Qty", type: "number", width: 10 },
  { header: "Unit $", type: "currency", width: 14 },
  { header: "Job Cost", type: "currency", width: 16 },
  { header: "Invoiced $", type: "currency", width: 16 },
];

function rowCells(r: TmPartsDrillRow): CellValue[] {
  return [
    r.purchaseDate ?? null,
    r.invoicedDate ?? null,
    r.jobId || null,
    r.jobName || null,
    r.partNumber || null,
    r.description || null,
    r.supplier || null,
    r.poNumber || null,
    r.quantity,
    r.unitPrice,
    r.totalPrice,
    r.invoicedAmount,
  ];
}

export async function buildTmPartsExport(params: TmPartsExportParams, now: Date): Promise<TmPartsExportResult> {
  const key = parseKey(params.key);
  const startDate = params.from ?? "";
  const endDate = params.to ?? "";
  if (!isValidDateRange(startDate, endDate)) throw new Error("Invalid date range.");

  const jobIds = sanitizeJobIds((params.jobs ?? "").split(",").filter(Boolean));
  const filters = { jobIds, startDate, endDate };
  const source = await loadTmPartsLines(filters);
  const allRows = tmDrillRowsFrom(source, key, filters);

  const q = normalizeTmPartsQuery(params.q);
  const rows = filterTmPartsDrillRows(allRows, q);
  const cardLabel = TM_PARTS_LABELS[key];
  const amountKey = amountKeyFor(key);
  const amountColIndex = amountKey === "totalPrice" ? 10 : 11;

  const total = rows.reduce((sum, r) => sum + r[amountKey], 0);
  // Only the reconciling column gets a total, matching the panel's own
  // footer — the other dollar column is real per-row data but was never a
  // card total the panel claims, so it stays blank here too.
  const totals: CellValue[] = [null, null, null, null, null, `Total (${COLUMNS[amountColIndex].header})`, null, null, null, null, null, null];
  totals[amountColIndex] = total;

  const subtitle = [
    `Card: ${cardLabel}`,
    `Range: ${startDate} to ${endDate}`,
    `Jobs: ${jobIds.length > 0 ? jobIds.join(", ") : "All"}`,
  ];
  // Stated in the file, not just implied by the row count — same reasoning as
  // tm-hours-export.ts's own line.
  if (q) subtitle.push(`Search: "${params.q?.trim()}" (${rows.length} of ${allRows.length} rows)`);
  subtitle.push(`Exported ${now.toISOString().slice(0, 16).replace("T", " ")} — ${rows.length} row${rows.length === 1 ? "" : "s"}`);

  const spec: SheetSpec = {
    sheetName: `T&M - ${cardLabel}`,
    title: `T&M — ${cardLabel}`,
    subtitle,
    columns: COLUMNS,
    rows: rows.map(rowCells),
    totals,
    // Purchase/Invoiced Date + Job ID + Job/Machine identify a part row at a
    // glance when scrolling right, the same four the panel keeps leftmost.
    freezeColumns: 4,
  };

  return { spec, rowCount: rows.length, cardLabel };
}
