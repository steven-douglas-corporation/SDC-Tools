import "server-only";

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { HOURS_IMPORT_CODES, mapPunchToColumns } from "@/lib/sections";
import { classifyPunch, emptyBucketTotals, type BucketTotals } from "@/lib/paylocity-standard-rules";
import { buildHoursWhere, punchIdentity, rollupByOperationalTier, rollupByRawTier, departmentFilterRank, type HoursFilters, type HoursGroupBy, type HoursGroupRow, type HoursDetailSortKey, type PunchIdentity } from "@/lib/hours-filters";
import { sectionDisplayName } from "@/lib/hours-operational-grouping";
import type { SortState } from "@/lib/table-sort";

export type { HoursFilters, HoursGroupBy, HoursGroupRow };

// ── The Hours tab's one read path ───────────────────────────────────────────
//
// Everything here reads JobHoursDetail — the same punch-level table actual-hours.ts and
// the Job Hour Details drill already trust — so this introduces no second definition of
// "hours worked". Job-attributed only, by request: unattributed punches stay in the
// existing Undefined Hours feature rather than being duplicated into a table whose
// columns (Job ID, Job Name) assume every row has one.
//
// Every query composes the SAME `where` (buildHoursWhere, hours-filters.ts) the table and
// the summary strip both use, so "Total Hours" is structurally SUM(current filter), never
// a second computation — the exact bug class §42.14 in this app already fixed once for
// Undefined Hours.

// sectionDisplayName (hours-operational-grouping.ts) is the one shared name
// lookup: SECTIONS' own name for the 17 codes that drive the Quoted/ETC grid
// columns, else this module's task label for everything else JobHoursDetail.section
// can hold (Service/Spare Parts never will get a SECTIONS row). Pre-built into a
// Map here — not called per-row — because this file's queries iterate far more
// rows than there are codes; HOURS_IMPORT_CODES is every code JobHoursDetail.section
// can hold, so building the map from it covers every code this map is ever
// actually queried with.
const SECTION_NAME = new Map<string, string>([...HOURS_IMPORT_CODES].map((code) => [code, sectionDisplayName(code)]));

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;

export type HoursFilterOptions = {
  jobs: { jobId: string; jobName: string }[];
  employees: { employeeId: string; name: string; department: string }[];
  sections: { code: string; name: string }[];
  departments: string[];
};

export type HoursRow = {
  id: number;
  date: string; // YYYY-MM-DD
  employeeId: string;
  employee: string;
  department: string;
  jobId: string;
  jobName: string;
  // `section`/`sectionName` are the STORED raw pair and its display label — storage
  // never folds, aliases or splits a punch (2026-08-21), so `section` here IS
  // `rawSection-rawFunction` on the live path. Kept for the many consumers already
  // keyed on this combined code; nothing should render it as the ONLY available
  // value — see PunchIdentity below for the separated columns a detail table uses.
  section: string;
  sectionName: string;
  hours: number;
} & PunchIdentity;
// ^ Section and Function as separate raw/standardized fields, from the one shared
// projection in hours-filters.ts — same intersection HoursDetailRow uses, so the
// Hours page, Job Hour Details and Monthly ETC cannot drift on what one punch shows.

export type HoursPage = { rows: HoursRow[]; total: number; page: number; pageSize: number };

export type HoursSummary = { totalHours: number; jobs: number; employees: number; sections: number };

// Department isn't a column on JobHoursDetail — an employeeId allowlist is how a
// department filter reaches it. "—" (the em dash drill-filters.ts uses for a blank
// value) matches employees with no department set.
async function employeeIdsForDepartments(departments: string[]): Promise<string[]> {
  if (departments.length === 0) return [];
  const wantsBlank = departments.includes("—");
  const named = departments.filter((d) => d !== "—");
  const employees = await prisma.employee.findMany({
    where: {
      paylocityId: { not: null },
      OR: [...(named.length ? [{ department: { in: named } }] : []), ...(wantsBlank ? [{ department: null }, { department: "" }] : [])],
    },
    select: { paylocityId: true },
  });
  return employees.map((e) => e.paylocityId!);
}

async function resolveWhere(filters: HoursFilters) {
  const deptEmployeeIds =
    filters.departments && filters.departments.length > 0 ? await employeeIdsForDepartments(filters.departments) : undefined;
  return buildHoursWhere(filters, deptEmployeeIds);
}

/** The filter menus' own option lists — only values actually present in the punch table. */
export async function getHoursFilterOptions(): Promise<HoursFilterOptions> {
  const [jobRows, sectionRows, employeeIdRows, employees] = await Promise.all([
    prisma.jobHoursDetail.findMany({ distinct: ["jobId"], select: { job: { select: { jobId: true, jobName: true } } } }),
    prisma.jobHoursDetail.findMany({ distinct: ["section"], select: { section: true } }),
    prisma.jobHoursDetail.findMany({ distinct: ["employeeId"], select: { employeeId: true } }),
    prisma.employee.findMany({ where: { paylocityId: { not: null } }, select: { paylocityId: true, name: true, department: true } }),
  ]);

  const employeeById = new Map(employees.map((e) => [e.paylocityId!, e]));

  // Deliberately NOT job-filters.ts's compareJobIds(): that falls back to a
  // plain (non-numeric) string compare the moment EITHER side fails Number()
  // parsing, which sorts "SVC-10" before "SVC-9" -- wrong once a non-numeric
  // job id's suffix reaches double digits. localeCompare's own numeric mode
  // gets that case right for both plain numeric AND SVC-style ids alike.
  const jobs = jobRows
    .map((r) => ({ jobId: r.job.jobId, jobName: r.job.jobName }))
    .sort((a, b) => a.jobId.localeCompare(b.jobId, undefined, { numeric: true }));

  const sections = sectionRows
    .map((r) => ({ code: r.section, name: SECTION_NAME.get(r.section) ?? r.section }))
    .sort((a, b) => a.code.localeCompare(b.code));

  const employeeList = employeeIdRows
    .map((r) => r.employeeId)
    .map((id) => {
      const e = employeeById.get(id);
      return { employeeId: id, name: e?.name ?? `#${id}`, department: e?.department?.trim() || "—" };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const departments = [...new Set(employeeList.map((e) => e.department))].sort((a, b) => {
    const ra = departmentFilterRank(a);
    const rb = departmentFilterRank(b);
    return ra !== rb ? ra - rb : a.localeCompare(b);
  });

  return { jobs, sections, employees: employeeList, departments };
}

type DetailRow = {
  id: number;
  section: string;
  rawSection: string;
  rawFunction: string;
  workDate: Date;
  employeeId: string;
  hours: unknown;
  job: { jobId: string; jobName: string };
};

// Shared by the paginated table and the export — one row shape, one join, so the file a
// manager downloads can never disagree with the table they were looking at.
async function mapDetailRows(detail: DetailRow[]): Promise<HoursRow[]> {
  const employeeIds = [...new Set(detail.map((d) => d.employeeId))];
  const employees = await prisma.employee.findMany({
    where: { paylocityId: { in: employeeIds } },
    select: { paylocityId: true, name: true, department: true },
  });
  const byPaylocityId = new Map(employees.map((e) => [e.paylocityId!, e]));

  return detail.map((d) => {
    const emp = byPaylocityId.get(d.employeeId);
    return {
      id: d.id,
      date: d.workDate.toISOString().slice(0, 10),
      employeeId: d.employeeId,
      employee: emp?.name ?? `#${d.employeeId}`,
      department: emp?.department?.trim() || "—",
      jobId: d.job.jobId,
      jobName: d.job.jobName,
      section: d.section,
      sectionName: SECTION_NAME.get(d.section) ?? d.section,
      hours: Number(d.hours),
      ...punchIdentity(d.rawSection, d.rawFunction),
    };
  });
}


const DETAIL_SELECT = {
  id: true,
  section: true,
  rawSection: true,
  rawFunction: true,
  workDate: true,
  employeeId: true,
  hours: true,
  job: { select: { jobId: true, jobName: true } },
} as const;

// `id: "desc"` is always the trailing tie-breaker, sort or no sort — same reason the
// pre-sort default already had one: without it, rows with an equal sort value could
// shuffle between page loads (MySQL makes no ordering guarantee among ties), which
// would look like pagination duplicating or skipping rows.
function orderByForSort(sort: SortState<HoursDetailSortKey>): Prisma.JobHoursDetailOrderByWithRelationInput[] {
  if (!sort) return [{ workDate: "desc" }, { id: "desc" }];
  const dir = sort.direction;
  switch (sort.key) {
    case "date":
      return [{ workDate: dir }, { id: "desc" }];
    case "jobId":
      return [{ job: { jobId: dir } }, { id: "desc" }];
    case "jobName":
      return [{ job: { jobName: dir } }, { id: "desc" }];
    case "section":
      return [{ section: dir }, { id: "desc" }];
    case "hours":
      return [{ hours: dir }, { id: "desc" }];
  }
}

export async function queryHoursRows(
  filters: HoursFilters,
  opts: { page?: number; pageSize?: number; sort?: SortState<HoursDetailSortKey> } = {},
): Promise<HoursPage> {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, opts.pageSize ?? DEFAULT_PAGE_SIZE));
  const where = await resolveWhere(filters);

  const [total, detail] = await Promise.all([
    prisma.jobHoursDetail.count({ where }),
    prisma.jobHoursDetail.findMany({
      where,
      select: DETAIL_SELECT,
      orderBy: orderByForSort(opts.sort ?? null),
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  const rows = await mapDetailRows(detail);
  return { rows, total, page, pageSize };
}

export type HoursExportRows = { rows: HoursRow[]; truncated: boolean };

// A single, un-paginated fetch for the export — bounded, not "everything with no
// question asked": an unfiltered export today is ~25k rows (fine to generate an XLSX
// from server-side), but the cap and `truncated` flag mean a much larger future table
// degrades to "the export says so" rather than a silent partial file, the same contract
// job-hours-detail.ts already uses for a job's punch drill.
const MAX_EXPORT_ROWS = 50_000;

export type HoursDrillRows = { rows: HoursRow[]; truncated: boolean };

// Terminal level of the Hours tab's Group By tree (HoursGroupedTree) — the raw
// punch records behind a leaf group (job 1116 -> Service Engineering -> …),
// fetched whole rather than paginated so expanding a row stays a single round
// trip with no nested pager UI underneath it. `filters` arrives already
// narrowed to that exact leaf (narrowFiltersForGroupValue applied once per
// ancestor level), so this is the SAME buildHoursWhere every other level's
// aggregate used — the leaf's total and the sum of these rows can never
// disagree, by construction, not by re-summing anything client-side.
//
// A smaller cap than the export's MAX_EXPORT_ROWS: this renders inline under
// one table row, not into a downloaded file, so 50k here would mean 50k
// <tr>s in the DOM instead of a spreadsheet someone scrolls outside the
// browser. `truncated` lets the caller say so plainly rather than pretending
// the visible rows are the whole story.
//
// 5,000, not a smaller "a leaf is usually small" guess: measured live, a
// single-dimension leaf as coarse as one Department (no further Group By
// level chosen at all) routinely holds 1,000-2,000 punches on its own — e.g.
// Service Engineering's 1,903 — so a lower cap would truncate the exact
// example this feature was built around. Reserved for the genuinely
// pathological case (an entire broad dimension with no narrowing at all),
// not the common one.
const MAX_DRILL_ROWS = 5000;

export async function queryHoursDrillRows(filters: HoursFilters): Promise<HoursDrillRows> {
  const where = await resolveWhere(filters);
  const detail = await prisma.jobHoursDetail.findMany({
    where,
    select: DETAIL_SELECT,
    orderBy: [{ workDate: "desc" }, { id: "desc" }],
    take: MAX_DRILL_ROWS + 1,
  });
  const truncated = detail.length > MAX_DRILL_ROWS;
  const rows = await mapDetailRows(truncated ? detail.slice(0, MAX_DRILL_ROWS) : detail);
  return { rows, truncated };
}

// `sort` defaults to the same workDate-desc order every other caller here uses
// when the table itself has no sort active — but when it does, the export's
// row order needs to match what's on screen, not silently fall back to date
// order underneath a sort the user actually chose.
export async function queryHoursExportRows(filters: HoursFilters, sort?: SortState<HoursDetailSortKey>): Promise<HoursExportRows> {
  const where = await resolveWhere(filters);
  const detail = await prisma.jobHoursDetail.findMany({
    where,
    select: DETAIL_SELECT,
    orderBy: orderByForSort(sort ?? null),
    take: MAX_EXPORT_ROWS + 1,
  });
  const truncated = detail.length > MAX_EXPORT_ROWS;
  const rows = await mapDetailRows(truncated ? detail.slice(0, MAX_EXPORT_ROWS) : detail);
  return { rows, truncated };
}

// ── The Undefined Hours drill-through (2026-08-21) ─────────────────────────
//
// Every punch whose raw Section+Function combination is not in the approved rule
// book, with the raw values preserved so the punch can be corrected in Paylocity or
// the rule book extended — the two real fixes. Columns are exactly the audit set that
// was asked for: Job | Employee | Date | Raw Section | Raw Section Name | Raw
// Function | Raw Function Name | Hours.
//
// Narrowing is `mappingStatus: "Undefined"` — a plain equality on the SAME stored
// column every page's Group By reads (rollupByRawTier, the KPI buckets). That column
// is written ONCE at ingestion by classifyPunch, so an Undefined drill built from its
// own hand-written pair list — the earlier version of this function — is exactly how
// a drill-through comes to disagree with the number above it, a defect this app has
// already had once (see unattributed-hours.ts).
//
// `filters` composes normally, so this can be scoped to one job, month or employee —
// the Job 1119 case that started this is just `{ jobIds: ["1119"] }`.
export type UndefinedHoursDrill = {
  rows: HoursRow[];
  truncated: boolean;
  /** Total across ALL matching rows, not just the returned page — so a truncated
   *  list still states the true total instead of implying the visible rows are it. */
  totalHours: number;
  punchCount: number;
};

export async function queryUndefinedHoursDrill(filters: HoursFilters = {}): Promise<UndefinedHoursDrill> {
  const scoped: HoursFilters = { ...filters, mappingStatus: "Undefined" };
  const where = await resolveWhere(scoped);

  // Aggregate and rows come from ONE where clause, so the stated total is the total of
  // what was matched even when the row list is capped.
  const [agg, detail] = await Promise.all([
    prisma.jobHoursDetail.aggregate({ where, _sum: { hours: true }, _count: true }),
    prisma.jobHoursDetail.findMany({
      where,
      select: DETAIL_SELECT,
      orderBy: [{ workDate: "desc" }, { id: "desc" }],
      take: MAX_DRILL_ROWS + 1,
    }),
  ]);
  const truncated = detail.length > MAX_DRILL_ROWS;
  return {
    rows: await mapDetailRows(truncated ? detail.slice(0, MAX_DRILL_ROWS) : detail),
    truncated,
    totalHours: Number(agg._sum.hours ?? 0),
    punchCount: agg._count,
  };
}

/**
 * The four reconciliation buckets over the stored punches, from one grouped query.
 *
 * This is what makes `PM + Engineering + Shop + Undefined = raw total` checkable at
 * any time against live data, and it shares `classifyPunch` with the drill above, so
 * the Undefined bucket here and the drill's `totalHours` are the same number by
 * construction rather than by coincidence.
 */
export async function queryStandardBuckets(filters: HoursFilters = {}): Promise<BucketTotals> {
  const where = await resolveWhere(filters);
  const g = await prisma.jobHoursDetail.groupBy({ by: ["rawSection", "rawFunction"], where, _sum: { hours: true } });
  const totals = emptyBucketTotals();
  for (const r of g) totals[classifyPunch(r.rawSection, r.rawFunction).department] += Number(r._sum.hours ?? 0);
  return totals;
}

export async function queryHoursSummary(filters: HoursFilters): Promise<HoursSummary> {
  const where = await resolveWhere(filters);
  const [agg, jobs, employees, sections] = await Promise.all([
    prisma.jobHoursDetail.aggregate({ where, _sum: { hours: true } }),
    prisma.jobHoursDetail.findMany({ where, distinct: ["jobId"], select: { jobId: true } }),
    prisma.jobHoursDetail.findMany({ where, distinct: ["employeeId"], select: { employeeId: true } }),
    prisma.jobHoursDetail.findMany({ where, distinct: ["section"], select: { section: true } }),
  ]);
  return {
    totalHours: Number(agg._sum.hours ?? 0),
    jobs: jobs.length,
    employees: employees.length,
    sections: sections.length,
  };
}

export async function queryHoursGrouped(filters: HoursFilters, groupBy: HoursGroupBy): Promise<HoursGroupRow[]> {
  const where = await resolveWhere(filters);

  // "Department" is Section+Function-derived (hours-operational-grouping.ts's
  // `departmentFor`), NOT the employee's raw HR/Paylocity `Employee.department`
  // string — that regressed once already (2026-08-17) via a SEPARATE code path
  // here that grouped by `employeeId` and re-rolled by the HR field. Fixed by
  // deleting that path entirely and routing "department" through the exact
  // same `groupBy: ["section"]` + rollupByOperationalTier mechanism every other
  // operational tier already uses — there is only one way left to compute any
  // of these four dimensions, so a second implementation can't quietly grow
  // back next to it.
  if (groupBy === "sectionName" || groupBy === "functionGroup" || groupBy === "taskDescription" || groupBy === "department") {
    // `section` is the RAW pair now (2026-08-21) — these four tiers were built when
    // it was always the folded/split value, and hours-operational-grouping.ts's
    // OPERATIONAL_GROUPING table is keyed by exactly those folded codes. A raw pair
    // that ONLY existed post-fold before (10-414, 12/13/14-211, ...) has no entry
    // there, so grouping directly on raw `section` now undercounts every folded
    // category — measured: "Manufacturing" read 8.61h (10-413 alone) instead of
    // 182.50h (10-413 + 10-414). Folding each distinct raw pair through
    // mapPunchToColumns before the lookup is the same fix already applied to the ETC
    // grid's own consumers (syncActualHours, getEtcMonthHoursDetail, tm-hours) — the
    // fold happens at READ time, in memory, and never touches storage.
    const g = await prisma.jobHoursDetail.groupBy({ by: ["section"], where, _sum: { hours: true }, _count: true });
    const folded = g.flatMap((r) => {
      const cols = mapPunchToColumns(r.section, Number(r._sum.hours ?? 0));
      return cols.map((col, i) => ({
        section: col.section,
        hours: col.hours,
        // Punch count isn't splittable the way hours are; charge every count to the
        // FIRST destination only, so the grand total still foots without either
        // dropping counts or double-counting them across a split's two halves.
        punchCount: i === 0 ? r._count : 0,
      }));
    });
    return rollupByOperationalTier(folded, groupBy);
  }

  // ── The raw / reconciliation tier (2026-08-21) ──────────────────────────
  //
  // One query grouping on the RAW columns, rolled up by rollupByRawTier. Separate from
  // the operational branch above because that one groups on `section` — the folded,
  // standardized column — and so cannot answer "what did Paylocity actually say".
  // Grouping here by "rawPair" reproduces the Paylocity PivotTable exactly.
  if (groupBy === "sectionNumber" || groupBy === "functionId" || groupBy === "mappingStatus" || groupBy === "standardDepartment") {
    const g = await prisma.jobHoursDetail.groupBy({
      by: ["rawSection", "rawFunction"],
      where,
      _sum: { hours: true },
      _count: true,
    });
    return rollupByRawTier(
      g.map((r) => ({
        rawSection: r.rawSection,
        rawFunction: r.rawFunction,
        hours: Number(r._sum.hours ?? 0),
        punchCount: r._count,
      })),
      groupBy,
    );
  }

  if (groupBy === "job") {
    const g = await prisma.jobHoursDetail.groupBy({ by: ["jobId"], where, _sum: { hours: true }, _count: true });
    const jobs = await prisma.job.findMany({ where: { id: { in: g.map((r) => r.jobId) } }, select: { id: true, jobId: true, jobName: true } });
    const byPk = new Map(jobs.map((j) => [j.id, j]));
    return g
      .map((r) => {
        const j = byPk.get(r.jobId);
        // `key` must be the business Job Id (what buildHoursWhere's jobIds filter
        // expects), not the internal PK `r.jobId` (JobHoursDetail's FK to Job.id) — a
        // group-by tree node narrows by feeding a row's `key` straight back into
        // narrowFiltersForGroupValue, so a PK here would silently narrow to the wrong
        // job (or nothing).
        return { key: j ? j.jobId : String(r.jobId), label: j ? `${j.jobId} — ${j.jobName}` : String(r.jobId), hours: Number(r._sum.hours ?? 0), punchCount: r._count };
      })
      .sort((a, b) => b.hours - a.hours);
  }

  if (groupBy === "employee") {
    const g = await prisma.jobHoursDetail.groupBy({ by: ["employeeId"], where, _sum: { hours: true }, _count: true });
    const employees = await prisma.employee.findMany({ where: { paylocityId: { in: g.map((r) => r.employeeId) } }, select: { paylocityId: true, name: true } });
    const byId = new Map(employees.map((e) => [e.paylocityId!, e.name]));
    return g
      .map((r) => ({ key: r.employeeId, label: byId.get(r.employeeId) ?? `#${r.employeeId}`, hours: Number(r._sum.hours ?? 0), punchCount: r._count }))
      .sort((a, b) => b.hours - a.hours);
  }

  if (groupBy === "month") {
    const g = await prisma.jobHoursDetail.groupBy({ by: ["month"], where, _sum: { hours: true }, _count: true });
    return g
      .map((r) => ({ key: r.month, label: r.month, hours: Number(r._sum.hours ?? 0), punchCount: r._count }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }

  // "date"
  const g = await prisma.jobHoursDetail.groupBy({ by: ["workDate"], where, _sum: { hours: true }, _count: true });
  return g
    .map((r) => {
      const key = r.workDate.toISOString().slice(0, 10);
      return { key, label: key, hours: Number(r._sum.hours ?? 0), punchCount: r._count };
    })
    .sort((a, b) => a.key.localeCompare(b.key));
}
