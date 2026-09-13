import { queryHoursExportRows, queryHoursGrouped, queryHoursSummary } from "@/lib/hours-explorer";
import {
  parseHoursFilters,
  parseHoursGroupByList,
  parseHoursSort,
  describeHoursFilters,
  HOURS_GROUP_BY_LABEL,
  type HoursSearchParams,
} from "@/lib/hours-filters";
import type { CellValue, SheetColumn, SheetSpec } from "@/lib/export/sheet";

// ── The Hours tab, as a spreadsheet ─────────────────────────────────────────
//
// Same pipeline Projects/Monthly ETC already use (SheetSpec -> buildCsv/buildXlsx), and
// the SAME filter/sort/group-by parsing (hours-filters.ts) and the SAME queries
// (hours-explorer.ts) the page's table uses — so the file matches the table the manager
// was looking at, the guarantee lib/projects-query.ts gives the Projects export.
//
// Two shapes, chosen by whether the table is currently grouped (found live, 2026-08-13:
// the export used to ALWAYS build the ungrouped detail sheet regardless of what was on
// screen — a manager looking at a grouped table got the full punch-level detail instead):
//
//   grouped   — one row per ROOT-level group value (job, employee, section, department,
//               date, or month — whichever is first in `groupBy`), with its own Hours sum
//               and Punches count. Deliberately root-level only, not a recursive expansion
//               of every level the manager happened to click open: which tree nodes are
//               expanded is pure client React state (HoursGroupedTree.tsx), never in the
//               URL, so it isn't something a server-side export can see or reproduce —
//               the root grouping is the one grouped view that's always fully determined
//               by the URL alone, and the one whose row count and totals the table's own
//               footer already shows without the manager expanding anything.
//   ungrouped — the detail sheet: one row per punch, in the table's own current sort.
//
// Both totals rows read from queryHoursSummary's DB-side aggregate over the FULL filtered
// set, not a reduce over the (possibly-capped) exported rows — so "exported total = Total
// Hours KPI" holds exactly even in the one edge case (an unfiltered export past
// MAX_EXPORT_ROWS) where summing the file's own rows would come up short.

export type HoursExportResult = { spec: SheetSpec; rowCount: number };

export async function buildHoursExport(params: HoursSearchParams, now: Date): Promise<HoursExportResult> {
  const filters = parseHoursFilters(params);
  const groupByLevels = parseHoursGroupByList(params.groupBy);
  const summary = await queryHoursSummary(filters);

  const subtitleBase = [`Filters: ${describeHoursFilters(filters)}`];

  if (groupByLevels.length > 0) {
    const groupBy = groupByLevels[0];
    const groups = await queryHoursGrouped(filters, groupBy);

    // No Punches column (2026-08-17, by request) — matches the on-screen
    // grouped tree (HoursGroupedTree.tsx), which dropped it the same way, so
    // this export reflects exactly what a grouped view shows. `g.punchCount`
    // is still computed by queryHoursGrouped; it's just not put in the sheet.
    const columns: SheetColumn[] = [
      { header: HOURS_GROUP_BY_LABEL[groupBy], type: "text", width: 30 },
      { header: "Hours", type: "hours" },
    ];
    const body: CellValue[][] = groups.map((g) => [g.label, g.hours]);
    const totals: CellValue[] = [`TOTAL (${groups.length} ${HOURS_GROUP_BY_LABEL[groupBy].toLowerCase()}${groups.length === 1 ? "" : "s"})`, summary.totalHours];

    const subtitle = [
      ...subtitleBase,
      `Grouped by ${HOURS_GROUP_BY_LABEL[groupBy].toLowerCase()}`,
      `Exported ${now.toISOString().slice(0, 16).replace("T", " ")} — ${groups.length} group${groups.length === 1 ? "" : "s"}`,
    ];

    return {
      rowCount: groups.length,
      spec: { sheetName: "Hours", title: "Hours (grouped)", subtitle, columns, rows: body, totals, freezeColumns: 1 },
    };
  }

  const sort = parseHoursSort(params.sort, params.dir);
  const { rows, truncated } = await queryHoursExportRows(filters, sort);

  const columns: SheetColumn[] = [
    { header: "Date", type: "date" },
    { header: "Employee", type: "text", width: 22 },
    { header: "Department", type: "text", width: 20 },
    { header: "Job Id", type: "text", width: 10 },
    { header: "Job / Machine", type: "text", width: 30 },
    // Section and Function as separate columns (2026-08-21). The export is the
    // artifact people pivot against the Paylocity workbook, so a combined
    // "10-211 — General" cell was the worst place of all for it: a PivotTable cannot
    // split it back apart. Raw values, plus the rule book's verdict, so the export
    // reconciles against Paylocity directly.
    { header: "Section", type: "text", width: 10 },
    { header: "Section Name", type: "text", width: 26 },
    { header: "Function", type: "text", width: 10 },
    { header: "Function Name", type: "text", width: 24 },
    { header: "Mapping Status", type: "text", width: 14 },
    { header: "Hours", type: "hours" },
  ];

  const body: CellValue[][] = rows.map((r) => [
    new Date(`${r.date}T00:00:00.000Z`),
    r.employee,
    r.department,
    r.jobId,
    r.jobName,
    r.rawSection,
    r.rawSectionName,
    r.rawFunction,
    r.standardTaskDescription,
    r.mappingStatus,
    r.hours,
  ]);

  // Index the Hours column by NAME rather than by a hardcoded position — splitting
  // Section/Function moved it from 6 to 10, and a literal here would have silently put
  // the total under "Mapping Status".
  const hoursCol = columns.findIndex((c) => c.header === "Hours");
  const totals: CellValue[] = columns.map((_, i) => (i === 0 ? `TOTAL (${rows.length} punches)` : i === hoursCol ? summary.totalHours : null));

  const subtitle = [...subtitleBase, `Exported ${now.toISOString().slice(0, 16).replace("T", " ")} — ${rows.length} punch${rows.length === 1 ? "" : "es"}`];
  if (truncated) subtitle.push(`Truncated to the first ${rows.length.toLocaleString()} rows — narrow the filters for a complete export.`);

  return {
    rowCount: rows.length,
    spec: { sheetName: "Hours", title: "Hours", subtitle, columns, rows: body, totals, freezeColumns: 1 },
  };
}
