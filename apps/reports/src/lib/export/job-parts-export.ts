import type { CellValue, ColumnType, SheetColumn, SheetSpec } from "@/lib/export/sheet";

// ── Job Details — Parts List export (§Job Parts) ─────────────────────────────
//
// Unlike every other builder in this folder, this one does not query the database
// itself. JobProcurement.tsx's Parts List filters entirely in the browser (BOM/
// non-BOM scope, status, category/manufacturer/supplier, date range, search,
// "Left to invoice") — there is no server-side copy of that predicate to re-run,
// and building one here would risk it drifting from what the table actually
// shows. So the browser sends exactly the rows it is already rendering (via
// PoDetailPanel's own partsListSortColumns value accessors — the same numbers
// the cells and the footer print) and this just turns that into a SheetSpec the
// shared CSV/XLSX writers render, the way every other export in this app does.
//
// Validated rather than trusted outright: this is the one export endpoint whose
// row DATA (not just its filters) comes from the caller, so a malformed or
// oversized body fails cleanly here instead of reaching the CSV/XLSX writers or
// the audit log.

const MAX_COLUMNS = 30;
const MAX_ROWS = 20_000;
const MAX_FILTER_LINES = 12;
const MAX_STRING_LEN = 4000;

const COLUMN_TYPES: ReadonlySet<ColumnType> = new Set(["text", "number", "hours", "currency", "date"]);

export type JobPartsExportResult = { spec: SheetSpec; rowCount: number; tab: "assemblies" | "parts"; jobId: string };

function badRequest(message: string): never {
  throw new Error(message);
}

function sanitizeCell(v: unknown): CellValue {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") return v.length > MAX_STRING_LEN ? v.slice(0, MAX_STRING_LEN) : v;
  badRequest("A cell value must be a string, a number, or null.");
}

/** ISO "yyyy-mm-dd" strings, in a column typed "date", become real Date cells — the
 *  only way the XLSX writer's date number format (xlsx.ts's NUMBER_FORMAT) actually
 *  applies rather than sitting inert on a text cell. */
function coerceRow(row: CellValue[], columns: SheetColumn[]): CellValue[] {
  return row.map((cell, i) => {
    if (columns[i]?.type === "date" && typeof cell === "string" && cell) {
      const d = new Date(cell);
      return Number.isNaN(d.getTime()) ? cell : d;
    }
    return cell;
  });
}

function parseColumns(raw: unknown): SheetColumn[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_COLUMNS) {
    badRequest(`Expected 1–${MAX_COLUMNS} columns.`);
  }
  return raw.map((c): SheetColumn => {
    if (typeof c !== "object" || c === null) badRequest("Malformed column.");
    const { header, type, width } = c as Record<string, unknown>;
    if (typeof header !== "string" || !header) badRequest("Every column needs a header.");
    if (typeof type !== "string" || !COLUMN_TYPES.has(type as ColumnType)) badRequest(`Unknown column type "${String(type)}".`);
    return { header: header.slice(0, 60), type: type as ColumnType, width: typeof width === "number" ? width : undefined };
  });
}

function parseRows(raw: unknown, columns: SheetColumn[]): CellValue[][] {
  if (!Array.isArray(raw) || raw.length > MAX_ROWS) badRequest(`Expected at most ${MAX_ROWS} rows.`);
  return raw.map((r) => {
    if (!Array.isArray(r) || r.length !== columns.length) badRequest("Every row must match the column count.");
    return coerceRow(r.map(sanitizeCell), columns);
  });
}

export function buildJobPartsSheetSpec(body: unknown, now: Date): JobPartsExportResult {
  if (typeof body !== "object" || body === null) badRequest("Expected a JSON object.");
  const b = body as Record<string, unknown>;

  const jobId = typeof b.jobId === "string" ? b.jobId.trim().slice(0, 40) : "";
  if (!jobId) badRequest("Missing jobId.");

  const tab: "assemblies" | "parts" = b.tab === "assemblies" ? "assemblies" : "parts";
  const tabLabel = tab === "parts" ? "Parts List" : "Assemblies";

  const columns = parseColumns(b.columns);
  const rows = parseRows(b.rows, columns);

  let totals: CellValue[] | undefined;
  if (b.totals !== undefined) {
    if (!Array.isArray(b.totals) || b.totals.length !== columns.length) badRequest("totals must match the column count.");
    totals = coerceRow(b.totals.map(sanitizeCell), columns);
  }

  const filters = Array.isArray(b.filters)
    ? b.filters.filter((f): f is string => typeof f === "string").slice(0, MAX_FILTER_LINES)
    : [];

  const subtitle = [
    ...filters,
    `Exported ${now.toISOString().slice(0, 16).replace("T", " ")} — ${rows.length} row${rows.length === 1 ? "" : "s"}`,
  ];

  const spec: SheetSpec = {
    sheetName: `Job ${jobId} - ${tabLabel}`,
    title: `Job ${jobId} — ${tabLabel}`,
    subtitle,
    columns,
    rows,
    totals,
    // Qty + Part No — the two columns that still identify a row scrolled right,
    // same reasoning tm-parts-export.ts gives for its own freezeColumns.
    freezeColumns: 2,
  };

  return { spec, rowCount: rows.length, tab, jobId };
}
