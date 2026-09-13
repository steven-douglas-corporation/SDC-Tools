import ExcelJS from "exceljs";
import { safeSheetName, type SheetSpec, type ColumnType } from "@/lib/export/sheet";

// ── XLSX, from the same spec the CSV uses (§24.5) ────────────────────────────
//
// exceljs rather than a hand-rolled writer: the requirement list is "numeric cell types,
// currency formatting, date formatting, zeros stay numeric zero, blanks stay blank,
// frozen headers, sensible widths", and every one of those is a real number format or a
// real sheet property — not something to approximate with a CSV renamed .xls (which is
// what most quick implementations do, and which Excel warns about on open).
//
// Formats, chosen so a reader can total a column without retyping it:
//   hours    -> #,##0     (this app displays whole hours everywhere; ui/format.ts)
//   currency -> $#,##0    with a wide column, because Parts Cost reaches seven figures
//               and a too-narrow numeric column renders as ##### (§24.13.13)
//   date     -> yyyy-mm-dd, unambiguous between locales
//
// A null value writes NOTHING, which leaves a genuinely empty cell. Writing 0 or ""
// there would make a cleared New ETC indistinguishable from a planned zero — see
// DEVLOG §16 for why that difference is load-bearing.

const NUMBER_FORMAT: Record<ColumnType, string | undefined> = {
  text: undefined,
  number: "#,##0.##",
  hours: "#,##0",
  currency: "$#,##0",
  date: "yyyy-mm-dd",
};

// One spec, or several sheets in one workbook.
//
// The array form exists for the Monthly ETC export's password-protected Standard Sheet /
// Standard Fees sheets: they belong in the SAME file the manager already downloaded, not
// in a second one they have to keep alongside it. A lone spec still renders exactly the
// workbook it always did — one worksheet, same name, same frozen pane — which is what
// keeps the unprotected export unchanged when Standards are locked.
export async function buildXlsx(input: SheetSpec | SheetSpec[]): Promise<Buffer> {
  const specs = Array.isArray(input) ? input : [input];
  if (specs.length === 0) throw new Error("An export needs at least one sheet.");

  const wb = new ExcelJS.Workbook();
  wb.creator = "SDC Projects Reports";
  wb.created = new Date();

  // Excel refuses two worksheets with the same name, and safeSheetName's 31-character
  // clamp can collide two names that differed only past the cut. Resolving up front beats
  // an exceljs throw halfway through writing a file the user is already downloading.
  const used = new Set<string>();
  for (const spec of specs) writeSheet(wb, spec, uniqueSheetName(spec.sheetName, used));

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}

function uniqueSheetName(name: string, used: Set<string>): string {
  const base = safeSheetName(name);
  let candidate = base;
  for (let n = 2; used.has(candidate); n++) {
    const suffix = ` (${n})`;
    candidate = `${base.slice(0, 31 - suffix.length)}${suffix}`;
  }
  used.add(candidate);
  return candidate;
}

function writeSheet(wb: ExcelJS.Workbook, spec: SheetSpec, sheetName: string): void {
  const ws = wb.addWorksheet(sheetName, {
    views: [
      {
        // Freeze the header block AND the identifying columns, so scrolling right on a
        // 70-column ETC sheet keeps the job number in view — the same reason the grid
        // itself has sticky columns.
        state: "frozen",
        xSplit: spec.freezeColumns ?? 0,
        ySplit: headerRowCount(spec),
      },
    ],
  });

  // ── Title block ───────────────────────────────────────────────────────────
  const titleRow = ws.addRow([spec.title]);
  titleRow.font = { bold: true, size: 14 };
  for (const line of spec.subtitle) {
    ws.addRow([line]).font = { italic: true, size: 10, color: { argb: "FF666666" } };
  }
  ws.addRow([]);

  // ── Header rows ───────────────────────────────────────────────────────────
  //
  // Two rows when any column belongs to a department band: the band above (merged
  // across its columns) and the leaf header below. That is the on-screen structure, and
  // it is the one thing CSV cannot express — which is exactly why the CSV flattens to
  // "ME Gen - Prior ETC" instead.
  const hasGroups = spec.columns.some((c) => c.group);
  let groupRowNumber = 0;
  if (hasGroups) {
    const groupRow = ws.addRow(spec.columns.map((c) => c.group ?? ""));
    groupRowNumber = groupRow.number;
    groupRow.font = { bold: true, size: 10 };
    groupRow.alignment = { horizontal: "center" };
  }
  const headerRow = ws.addRow(spec.columns.map((c) => c.header));
  headerRow.font = { bold: true, size: 10 };
  headerRow.alignment = { horizontal: "center", wrapText: true };
  headerRow.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFEFEF" } };
    cell.border = { bottom: { style: "thin", color: { argb: "FF808080" } } };
  });

  // Merge each run of identical group labels, so "ME Gen" sits once over its five
  // columns rather than five times.
  if (hasGroups && groupRowNumber > 0) {
    let start = 0;
    while (start < spec.columns.length) {
      const label = spec.columns[start].group ?? "";
      let end = start;
      while (end + 1 < spec.columns.length && (spec.columns[end + 1].group ?? "") === label) end++;
      if (label !== "" && end > start) ws.mergeCells(groupRowNumber, start + 1, groupRowNumber, end + 1);
      start = end + 1;
    }
  }

  // ── Data ──────────────────────────────────────────────────────────────────
  for (const row of spec.rows) {
    // `null` must reach the sheet as an empty cell. exceljs writes `null` as blank, but
    // going through addRow with an explicit array keeps the column alignment exact even
    // when the trailing cells are all empty.
    const added = ws.addRow(row.map((v) => (v === null ? null : v)));
    added.font = { size: 10 };
  }

  if (spec.totals) {
    const totals = ws.addRow(spec.totals.map((v) => (v === null ? null : v)));
    totals.font = { bold: true, size: 10 };
    totals.eachCell((cell) => {
      cell.border = { top: { style: "double", color: { argb: "FF000000" } } };
    });
  }

  // ── Column types and widths ───────────────────────────────────────────────
  spec.columns.forEach((col, i) => {
    const column = ws.getColumn(i + 1);
    const fmt = NUMBER_FORMAT[col.type];
    if (fmt) column.numFmt = fmt;
    column.width = col.width ?? defaultWidth(col);
    column.alignment = { horizontal: col.type === "text" ? "left" : "right" };
  });

  // Auto-filter over the header row, so a reader can slice the export the way they
  // sliced the page.
  const headerNumber = headerRow.number;
  if (spec.rows.length > 0) {
    ws.autoFilter = {
      from: { row: headerNumber, column: 1 },
      to: { row: headerNumber + spec.rows.length, column: spec.columns.length },
    };
  }
}

// Title + subtitles + blank + (group row) + header row.
function headerRowCount(spec: SheetSpec): number {
  return 1 + spec.subtitle.length + 1 + (spec.columns.some((c) => c.group) ? 1 : 0) + 1;
}

function defaultWidth(col: { header: string; type: ColumnType }): number {
  switch (col.type) {
    // Seven-figure money plus a $ and separators.
    case "currency":
      return 16;
    case "date":
      return 12;
    case "hours":
    case "number":
      return 10;
    default:
      return Math.min(40, Math.max(12, col.header.length + 2));
  }
}
