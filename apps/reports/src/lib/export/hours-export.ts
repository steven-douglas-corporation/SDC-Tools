import { queryHoursExportRows, queryHoursGrouped, queryHoursSummary } from "@/lib/hours-explorer";
import { loadFrozenEtcMonthRows, loadMigrationSnapshotRows } from "@/lib/actual-hours";
import { SECTIONS } from "@/lib/sections";
import {
  parseHoursFilters,
  parseHoursGroupByList,
  parseHoursSort,
  describeHoursFilters,
  historicalEraScope,
  HOURS_GROUP_BY_LABEL,
  type HoursFilters,
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

// `historicalSheets` is kept apart from `spec` rather than folded into a
// `SheetSpec | SheetSpec[]`: the route hands one sheet list to BOTH writers, and
// buildCsv would happily concatenate these under the punches — the one thing a
// CSV of this export must never do, since a pivot over it would double-count.
// The route appends them for XLSX only.
export type HoursExportResult = { spec: SheetSpec; rowCount: number; historicalSheets: SheetSpec[] };

// Which of the two pre-punch eras to append. Both default off, so any caller
// that doesn't ask gets exactly the export it always did.
export type HoursExportOptions = { includeMigration?: boolean; includeFrozenEtc?: boolean };

export async function buildHoursExport(params: HoursSearchParams, now: Date, options: HoursExportOptions = {}): Promise<HoursExportResult> {
  const filters = parseHoursFilters(params);
  const historicalSheets = await buildHistoricalSheets(filters, options, now);
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
      historicalSheets,
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
    historicalSheets,
    spec: { sheetName: "Hours", title: "Hours", subtitle, columns, rows: body, totals, freezeColumns: 1 },
  };
}

// ── The two pre-punch eras, as sheets of their own (2026-09-24) ──────────────
//
// The punch sheet above is era 3 only (see lib/actual-hours.ts). Eras 1 and 2 are
// period totals with no employee and no punch behind them, so they cannot be rows
// in it, and a manager reconciling this file against the Projects page needs them.
// Each sheet says in its subtitle which of the page's filters it honoured and
// which it could not, because a filter silently ignored reads as a filter applied.

const SECTION_NAME = new Map(SECTIONS.map((s) => [s.code, s.name]));

function describeEraScope(filters: HoursFilters, withMonths: boolean): string[] {
  const applied = [filters.jobIds?.length ? `jobs: ${filters.jobIds.length === 1 ? filters.jobIds[0] : `${filters.jobIds.length} selected`}` : "all jobs"];
  if (filters.sections?.length) applied.push("sections (folded onto their standard columns)");
  if (withMonths && (filters.from || filters.to)) applied.push(`${filters.from ?? "…"} to ${filters.to ?? "…"} (as whole months)`);

  const notApplied: string[] = [];
  if (filters.employeeIds?.length) notApplied.push("employees");
  if (filters.departments?.length) notApplied.push("departments");
  if (!withMonths && (filters.from || filters.to)) notApplied.push("date range");

  const lines = [`Filters: ${applied.join(", ")}`];
  if (notApplied.length > 0) {
    lines.push(`Not applied: ${notApplied.join(", ")}. These figures have no ${withMonths ? "employee" : "employee or date"} behind them.`);
  }
  return lines;
}

async function buildHistoricalSheets(filters: HoursFilters, options: HoursExportOptions, now: Date): Promise<SheetSpec[]> {
  if (!options.includeMigration && !options.includeFrozenEtc) return [];
  const scope = historicalEraScope(filters);
  const stamp = `Exported ${now.toISOString().slice(0, 16).replace("T", " ")}`;
  const sheets: SheetSpec[] = [];

  if (options.includeMigration) {
    const rows = await loadMigrationSnapshotRows(scope);
    const total = rows.reduce((sum, r) => sum + r.hours, 0);
    sheets.push({
      sheetName: "Migration Snapshot",
      title: "Migration Snapshot",
      subtitle: [
        "Hours carried over from the original Excel migration, before ETC tracking. One total per job and section, with no date or employee.",
        ...describeEraScope(filters, false),
        `${stamp} — ${rows.length} row${rows.length === 1 ? "" : "s"}`,
      ],
      columns: [
        { header: "Job Id", type: "text", width: 10 },
        { header: "Job / Machine", type: "text", width: 30 },
        { header: "Section", type: "text", width: 10 },
        { header: "Section Name", type: "text", width: 26 },
        { header: "Hours", type: "hours" },
      ],
      rows: rows.map((r) => [r.jobId, r.jobName, r.section, SECTION_NAME.get(r.section) ?? "", r.hours]),
      totals: [`TOTAL (${rows.length} rows)`, null, null, null, total],
      freezeColumns: 1,
    });
  }

  if (options.includeFrozenEtc) {
    const rows = await loadFrozenEtcMonthRows(scope);
    const total = rows.reduce((sum, r) => sum + r.hours, 0);
    sheets.push({
      sheetName: "Frozen ETC Months",
      title: "Frozen ETC Months",
      subtitle: [
        "Hours Worked from the monthly ETC, for months the punch import does not cover. One total per job, section and month, frozen when the month closed.",
        ...describeEraScope(filters, true),
        `${stamp} — ${rows.length} row${rows.length === 1 ? "" : "s"}`,
      ],
      columns: [
        { header: "Job Id", type: "text", width: 10 },
        { header: "Job / Machine", type: "text", width: 30 },
        { header: "Month", type: "text", width: 10 },
        { header: "Section", type: "text", width: 10 },
        { header: "Section Name", type: "text", width: 26 },
        { header: "Hours", type: "hours" },
      ],
      rows: rows.map((r) => [r.jobId, r.jobName, r.month, r.section, SECTION_NAME.get(r.section) ?? "", r.hours]),
      totals: [`TOTAL (${rows.length} rows)`, null, null, null, null, total],
      freezeColumns: 1,
    });
  }

  return sheets;
}
