import type { Prisma } from "@prisma/client";
import type { SortState } from "@/lib/table-sort";
import { sectionNumberAndName, rawSectionNumberAndName, functionGroupFor, taskFor, departmentFor, codesInSection, codesInFunctionGroup, codesInTask, codesInDepartment, departmentOrderRank, UNDEFINED_LABEL } from "@/lib/hours-operational-grouping";
import { reconcileRounding } from "@/lib/rounding";
import { canonicalSectionFor } from "@/lib/paylocity-canonical";
import { rawCodesFoldingInto } from "@/lib/sections";
import { classifyPunch, STANDARD_DEPARTMENTS, UNDEFINED_LABEL as STANDARD_UNDEFINED } from "@/lib/paylocity-standard-rules";
import { EMPLOYEE_TEAMS, teamFor } from "@/lib/employee-teams";

// ── Filtering/grouping rules for the Hours tab, kept I/O-free ──────────────────
//
// Same reason sections.ts's mapPunchToColumns and drill-filters.ts's matching logic live
// in their own no-I/O modules: this is testable without a database, and importable by
// both the query layer (hours-explorer.ts, `server-only`) and by tests.
//
// Semantics mirror drill-filters.ts exactly, just compiled to a Prisma `where` instead of
// evaluated over an in-memory row array: OR within a dimension, AND across dimensions,
// empty selection = no constraint. The Hours tab can't reuse drill-filters.ts directly —
// that model assumes the full row set is already in memory to filter over, which the
// tab's own performance requirement (don't load every punch into the browser) rules out.

export type HoursFilters = {
  jobIds?: string[];
  employeeIds?: string[];
  sections?: string[];
  // The employee's raw HR/Paylocity department string (Employee.department) —
  // a FILTER only. This must never back the "Department" Group By dimension
  // (see HoursGroupBy/rollupByOperationalTier's "department" tier, which is
  // Section+Function-derived) — that conflation is exactly what regressed
  // once already (2026-08-17). Keeping this field named `departments` even
  // though it means something narrower than the word now implies elsewhere
  // in this file, rather than renaming it, because the query-string param
  // and the filter menu's own label ("Department") are still legitimately
  // about the HR field — only the Group By dimension of the same name changed.
  departments?: string[];
  // "YYYY-MM", exact match against JobHoursDetail.month. Independent of from/to —
  // NEVER derived from or converted into a from/to range, and vice versa. A group-by
  // tree node for "month" narrows here rather than by widening from/to to the calendar
  // month, because that widening could reintroduce days an ancestor's own from/to
  // range had already excluded, inflating a child's total past its parent's. Filtering
  // on the SAME column a level groups by is what keeps a child's WHERE clause a strict
  // subset of its parent's — see narrowFiltersForGroupValue below.
  months?: string[];
  from?: string; // "YYYY-MM-DD", inclusive
  to?: string; // "YYYY-MM-DD", inclusive
  // Raw-shape narrowing for the "Section"/"Function" Group By tiers (2026-08-21) —
  // deliberately NOT expressed as `sections: [...specific codes]` the way
  // "Section Name"/"Function Group"/"Task Description"/"Department" narrow (see
  // narrowFiltersForGroupValue below): those four reverse-index off
  // OPERATIONAL_GROUPING, which only knows the codes the standard mapping has
  // enumerated — exactly the assumption the Hours page's ingestion fix broke, since
  // a code outside that table is now a real row instead of a dropped one. `sectionNumber`
  // matches on the raw code's OWN prefix (`${sectionNumber}-`) and `functionId` on its
  // suffix (`-${functionId}`), so a section number or Function ID no mapping table has
  // ever seen still narrows to exactly the rows it actually has, standardized or not.
  sectionNumber?: string;
  functionId?: string;
  // ── TRUE raw narrowing, off the stored raw columns (2026-08-21) ───────────
  //
  // `sectionNumber`/`functionId` above match on the STANDARDIZED `section` column's
  // prefix/suffix. That was the best available before raw identity was persisted, but
  // it means they report the FOLDED code: a punch booked to 12-211 is stored with
  // section 10-211, so "Function 211 / Section 10" is what those dimensions show for
  // it, and there was no way to ask what was actually punched.
  //
  // These two read JobHoursDetail.rawSection/rawFunction directly, so they answer the
  // reconciliation question — "what did Paylocity actually say" — and grouping by them
  // reproduces the raw Paylocity PivotTable exactly. Both are kept, because they
  // answer genuinely different questions and conflating them is what made the original
  // 23-hour discrepancy report so hard to resolve.
  rawSectionNumber?: string;
  rawFunctionId?: string;
  /** "Mapped" | "Undefined" — the approved-rule-book verdict on the raw pair. */
  mappingStatus?: string;
  /** "PM" | "Engineering" | "Shop" | "Undefined" — the reconciliation bucket. */
  standardDepartment?: string;
  // "Undefined" is a real, stored value now (2026-08-21) — mappingStatus and
  // standardDepartment are columns written once at ingestion, not computed per query.
};

// The Department FILTER's own display order (2026-08-17, by request — "match
// the order used in Monthly ETC"), for the raw HR strings `HoursFilters.
// departments` holds. Business order, not alphabetical: the same
// delivery-team sequence employee-teams.ts already defines. Also the
// canonical department rank for the Hours tab's "Group By Department" sort
// (HoursDetailPanel.tsx imports this directly, rather than keeping its own
// copy — a since-removed local copy collapsed the blank "—" bucket and a
// real-but-unmapped department to the same rank; see below for why they must
// not tie). A raw HR string that resolves to one of the 7 teams (via that
// file's own alias table, e.g. "Mechanical Build / Manufacturing" -> Build)
// ranks by that team's position; anything else (Finance, Sales, a typo, a
// since-renamed department) sorts alphabetically after every ranked team;
// the blank "—" bucket always sorts last of all.
// This is the FILTER's own order — see `departmentOrderRank` in
// hours-operational-grouping.ts for the unrelated Group By dimension's order,
// which is Section+Function-derived and has no reason to share a function
// with this HR-string one even though both now read "business order, not
// alphabetical."
export function departmentFilterRank(department: string): number {
  if (department === "—") return Number.MAX_SAFE_INTEGER;
  const team = teamFor({ department });
  const i = team ? EMPLOYEE_TEAMS.indexOf(team) : -1;
  return i === -1 ? Number.MAX_SAFE_INTEGER - 1 : i;
}

// ── One dedicated field per dimension (2026-08-21) ────────────────────────
//
// RAW dimensions — group on the untouched Paylocity value:
//   sectionNumber -> rawSection      functionId -> rawFunction
//
// STANDARDIZED dimensions — allowed to combine many raw values, because that is what
// a reporting category IS:
//   sectionName, functionGroup, taskDescription, department, standardDepartment,
//   mappingStatus
//
// The separation is the whole point. "Group By Function" showing 413 and 414 as one
// row labelled "413" was the defect: the group key came from the STANDARDIZED section
// (where 10-414 has been folded onto 10-413) while the detail rows underneath carried
// raw Function 414. Parent said 413, children said 414.
//
// There are deliberately no separate "Raw Section"/"Raw Function" dimensions. Section
// and Function ARE the raw values now, so a second pair would be two ways to ask one
// question — and the duplicate is how the two drift apart again.
export type HoursGroupBy = "job" | "employee" | "functionId" | "sectionNumber" | "department" | "date" | "month" | "sectionName" | "functionGroup" | "taskDescription" | "mappingStatus" | "standardDepartment";

export const HOURS_GROUP_BY_VALUES: readonly HoursGroupBy[] = [
  "job",
  "employee",
  "functionId",
  "sectionNumber",
  "department",
  "date",
  "month",
  "sectionName",
  "functionGroup",
  "taskDescription",
  "mappingStatus",
  "standardDepartment",
];

// One label map for all three places that render a dimension name — the field picker,
// the tree's per-level column header, and (previously duplicated as a page.tsx-local
// const) the page itself.
//
// "Function" and "Section" (2026-08-21) replace the old combined "Function / Section"
// dimension (which grouped by the raw, phase-specific punch code, e.g. "10-313") with
// two INDEPENDENT dimensions a user can pick either or both of, in either order —
// "Function" rolls up by the bare, phase-agnostic Function ID (functionIdFor/
// functionLabelFor: "313 — Software" spans 10-313 AND 80-313 alike), "Section" by the
// phase's Section Number + Name alone ("10 — Complete Design and Build"). Selecting
// both nests the table in whichever order they were picked, same as any other pair of
// Group By dimensions — see HoursGroupByMenu.
//
// "Section Name"/"Function Group"/"Task Description"/"Department" are all the standard
// operational hierarchy (hours-operational-grouping.ts) — deliberately worded
// differently from "Function"/"Section" so the dimensions are never confused with each
// other in the Group By menu. "Department" here is Section+Function-derived
// (departmentFor/codesInDepartment), NOT the employee's raw HR department string — that
// field is a separate FILTER (HoursFilters.departments) and must never back this label
// again (2026-08-17 regression fix).
export const HOURS_GROUP_BY_LABEL: Record<HoursGroupBy, string> = {
  job: "Job",
  employee: "Employee",
  functionId: "Function",
  sectionNumber: "Section",
  department: "Department",
  date: "Date",
  month: "Month",
  sectionName: "Section Name",
  functionGroup: "Function Group",
  taskDescription: "Task Description",
  mappingStatus: "Mapping Status",
  standardDepartment: "Standard Department",
};

// ── Which ROW FIELD each dimension groups on ───────────────────────────
//
// Declared once, as data, so "what does this dimension group on" has exactly one
// answer that a test can check against real rows. This is what makes parent/child
// integrity verifiable instead of aspirational: for any group, every detail row
// beneath it must have `HOURS_GROUP_BY_ROW_FIELD[dim](row) === group.key`.
//
// Dimensions whose key is not a field on the row itself (job/employee/date/month are
// keyed on ids and dates, and the standardized name tiers are derived from the
// standardized section) map to null and are checked by their own narrowing instead.
export const HOURS_GROUP_BY_ROW_FIELD: Record<HoursGroupBy, ((row: GroupCheckRow) => string) | null> = {
  // RAW — the untouched Paylocity values.
  sectionNumber: (r) => r.rawSection,
  functionId: (r) => r.rawFunction,
  // STANDARDIZED — intentionally many-to-one.
  standardDepartment: (r) => r.standardDepartment,
  mappingStatus: (r) => r.mappingStatus,
  // Keyed on ids/dates rather than a classification.
  job: (r) => r.jobId,
  employee: (r) => r.employeeId,
  date: (r) => r.date,
  month: (r) => r.date.slice(0, 7),
  // Derived from the standardized section code; checked via their own code sets.
  sectionName: null,
  functionGroup: null,
  taskDescription: null,
  department: null,
};

/** The minimum a row must expose for HOURS_GROUP_BY_ROW_FIELD to check it. */
export type GroupCheckRow = {
  rawSection: string;
  rawFunction: string;
  standardDepartment: string;
  mappingStatus: string;
  jobId: string;
  employeeId: string;
  date: string;
};

/**
 * Parent/child integrity: every row must belong under the group it was fetched for.
 *
 * Returns the rows that do NOT match, so a caller can report them rather than merely
 * knowing a count. Used by tests and by the audit scripts against live data; cheap
 * enough that a caller could assert on it in development too.
 */
export function groupMismatches<T extends GroupCheckRow>(
  rows: readonly T[],
  groupBy: HoursGroupBy,
  key: string,
): T[] {
  const field = HOURS_GROUP_BY_ROW_FIELD[groupBy];
  if (!field) return [];
  return rows.filter((r) => field(r) !== key);
}

/**
 * Parses the `groupBy` query param into an ORDERED list of dimensions — order is
 * meaningful (Job -> Employee nests differently than Employee -> Job), unlike every
 * other Hours param, which is an unordered set. De-dupes (a dimension selected twice
 * would nest under itself) and drops unknown values rather than rejecting the whole
 * list, so a stale/hand-edited URL degrades to "whatever's still valid" instead of
 * clearing every level. A bookmarked single-value `?groupBy=job` (pre-multi-level)
 * still parses to `["job"]` with no special-casing.
 */
export function parseHoursGroupByList(v: string | undefined): HoursGroupBy[] {
  if (!v) return [];
  const seen = new Set<HoursGroupBy>();
  const out: HoursGroupBy[] = [];
  for (const raw of v.split(",").map((s) => s.trim())) {
    if ((HOURS_GROUP_BY_VALUES as readonly string[]).includes(raw) && !seen.has(raw as HoursGroupBy)) {
      seen.add(raw as HoursGroupBy);
      out.push(raw as HoursGroupBy);
    }
  }
  return out;
}

export type HoursGroupRow = { key: string; label: string; hours: number; punchCount: number };

// ── Detail-table sort ────────────────────────────────────────────────────────
//
// Only columns with a real, directly-orderable column or to-one relation on
// JobHoursDetail are sortable — "date" (workDate), "jobId"/"jobName" (via the `job`
// relation, already joined), "section", "hours". Employee and Department are
// deliberately left non-sortable: employeeId is a plain Paylocity id string with no
// Prisma relation to Employee (a real join would need a schema change), so ordering by
// it would reorder rows by an opaque id rather than the visible name — same "leave it
// plain rather than force a misleading sort" call the off-grid drill's list-valued
// columns already make elsewhere in this app.
export type HoursDetailSortKey = "date" | "jobId" | "jobName" | "section" | "hours";

export const HOURS_DETAIL_SORT_KEYS: readonly HoursDetailSortKey[] = ["date", "jobId", "jobName", "section", "hours"];

/** The detail table is server-paginated, so sort has to be a real `ORDER BY` (see
 *  hours-explorer.ts's orderByForSort) — a client-side sort would only reorder the
 *  current page, silently misrepresenting the other 24,900 rows as unsorted. */
export function parseHoursSort(sortParam: string | undefined, dirParam: string | undefined): SortState<HoursDetailSortKey> {
  if (!sortParam || !(HOURS_DETAIL_SORT_KEYS as readonly string[]).includes(sortParam)) return null;
  return { key: sortParam as HoursDetailSortKey, direction: dirParam === "desc" ? "desc" : "asc" };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// ── Query-string <-> HoursFilters, in ONE place ─────────────────────────────
//
// Read by both the page (the table it renders) and the export route (the file it
// builds) — the same reason projects-query.ts exists: "the export matches the table" is
// only true if the two build the filter from the same code, not two copies of it.
//
// Plain comma-join, unlike quoted-display-prefs.ts's escaped encodeParamList/
// decodeParamList: those exist because Projects filters on customer NAMES, which
// legitimately contain commas ("FIRST SOLAR, INC."). Every Hours dimension is a job id,
// a Paylocity employee id, a section code, or a department name — none of which do.

export type HoursSearchParams = {
  jobs?: string;
  employees?: string;
  sections?: string;
  departments?: string;
  from?: string;
  to?: string;
  // Not read by parseHoursFilters below (they don't affect WHICH rows match, only
  // how they're grouped/ordered) — carried on this type so the export route can
  // parse them off the SAME query string via parseHoursGroupByList/parseHoursSort
  // instead of the export reconstructing its own copy of "what does the page's URL
  // mean" and risking it drifting from what the table actually shows.
  groupBy?: string;
  sort?: string;
  dir?: string;
};

function splitParam(v: string | undefined): string[] | undefined {
  if (v === undefined) return undefined;
  const list = v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 ? list : undefined;
}

// ── Every query param that represents user filtering (2026-09-02) ──────────
//
// The one list "Clear filters" clears, and the one list the active-count is
// computed from. It lives beside the parser deliberately: a dimension added to
// HoursSearchParams without being added here would produce a Clear button that
// silently leaves that filter applied, which is worse than no button at all.
//
// `page` is included because it is meaningless once the filters change, `view`
// because a loaded saved view IS a set of filters wearing a name, and
// `sort`/`dir` because the request asks for the page's intended default view
// back — not for its default rows in whatever order the last click left them.
export const HOURS_FILTER_PARAMS = [
  "jobs",
  "employees",
  "sections",
  "departments",
  "from",
  "to",
  "groupBy",
  "sort",
  "dir",
  "view",
  "page",
] as const;

/**
 * How many filtering CONTROLS are currently doing something, for the toolbar's
 * "Clear filters (N)" badge.
 *
 * Counted per control rather than per param, which is what a reader of the
 * toolbar means by "how many filters are on": a from/to range is one date
 * filter, not two, and `sort`+`dir` are one ordering. Neither `page` nor a
 * default, unfiltered state counts — a page number is not a filter, and "no
 * selection" is not a selection.
 */
export function countActiveHoursFilters(sp: Record<string, string | undefined>): number {
  const set = (k: string) => Boolean(sp[k] && String(sp[k]).trim() !== "");
  let n = 0;
  for (const k of ["jobs", "employees", "sections", "departments", "groupBy", "view"]) if (set(k)) n += 1;
  if (set("from") || set("to")) n += 1;
  if (set("sort")) n += 1;
  return n;
}

export function parseHoursFilters(sp: HoursSearchParams): HoursFilters {
  return {
    jobIds: splitParam(sp.jobs),
    employeeIds: splitParam(sp.employees),
    sections: splitParam(sp.sections),
    departments: splitParam(sp.departments),
    from: sp.from || undefined,
    to: sp.to || undefined,
  };
}

/** A plain-English summary of the active filters, for the export subtitle and audit log. */
export function describeHoursFilters(f: HoursFilters): string {
  const parts: string[] = [];
  parts.push(f.jobIds?.length ? `jobs: ${f.jobIds.length === 1 ? f.jobIds[0] : `${f.jobIds.length} selected`}` : "all jobs");
  parts.push(f.employeeIds?.length ? `${f.employeeIds.length} employee${f.employeeIds.length === 1 ? "" : "s"}` : "all employees");
  parts.push(
    f.sections?.length ? `${f.sections.length} function${f.sections.length === 1 ? "" : "s"}/section${f.sections.length === 1 ? "" : "s"}` : "all functions",
  );
  parts.push(f.departments?.length ? `${f.departments.length} department${f.departments.length === 1 ? "" : "s"}` : "all departments");
  if (f.from || f.to) parts.push(`${f.from ?? "…"} to ${f.to ?? "…"}`);
  return parts.join(", ");
}

/**
 * Employee and department are two constraints on the same "who" concept, so when both are
 * set at once they must intersect (a punch from the picked employee AND in the picked
 * department), not each independently widen the match — the same AND-across-dimensions
 * rule drill-filters.ts uses for every other pair of dimensions.
 *
 * `departmentEmployeeIds` — the employee ids the department selection resolves to
 * (department isn't a column on the punch table itself) — is resolved by the caller,
 * since that lookup needs the Employee table and this function stays I/O-free.
 */
export function buildHoursWhere(
  filters: HoursFilters,
  departmentEmployeeIds?: string[],
): Prisma.JobHoursDetailWhereInput {
  const where: Prisma.JobHoursDetailWhereInput = {};

  if (filters.jobIds && filters.jobIds.length > 0) {
    where.job = { jobId: { in: filters.jobIds } };
  }
  // Every constraint that lands on the `section` column composed with AND, via a
  // list of independent conditions rather than fields merged onto one filter object
  // — `sections` (an exact list), `sectionNumber` (a raw prefix) and `functionId` (a
  // raw suffix) can all be active at once (e.g. a top-level Function/Section FILTER
  // narrowed further by drilling into a Section group), and each must independently
  // hold, the same AND-across-dimensions rule this file uses everywhere else. A
  // single active condition is assigned directly to `where.section` rather than
  // wrapped in a one-element `AND` — same "don't wrap the common case" shape
  // `employeeConstraints` below already uses, and what every existing caller of this
  // function already expects `where.section` to look like.
  const sectionConditions: Prisma.JobHoursDetailWhereInput[] = [];
  if (filters.sections && filters.sections.length > 0) {
    sectionConditions.push({ section: { in: filters.sections } });
  }
  if (filters.sectionNumber) {
    sectionConditions.push({ section: { startsWith: `${filters.sectionNumber}-` } });
  }
  if (filters.functionId) {
    sectionConditions.push({ section: { endsWith: `-${filters.functionId}` } });
  }
  // Exact equality, not a prefix/suffix shape: these are their own columns, so there
  // is no code string to pattern-match against and no chance of "1" matching "11".
  if (filters.rawSectionNumber !== undefined) {
    sectionConditions.push({ rawSection: filters.rawSectionNumber });
  }
  if (filters.rawFunctionId !== undefined) {
    sectionConditions.push({ rawFunction: filters.rawFunctionId });
  }
  // Plain equality on the STORED columns (2026-08-21) — mappingStatus/standardDepartment
  // are written once at ingestion (classifyPunch, applied to the raw pair) and never
  // recomputed per page, so narrowing to a bucket is a real indexed column read, not a
  // JS-computed OR over every approved pair.
  if (filters.mappingStatus !== undefined) {
    sectionConditions.push({ mappingStatus: filters.mappingStatus });
  }
  if (filters.standardDepartment !== undefined) {
    sectionConditions.push({ standardDepartment: filters.standardDepartment });
  }
  if (sectionConditions.length === 1) {
    Object.assign(where, sectionConditions[0]);
  } else if (sectionConditions.length > 1) {
    where.AND = sectionConditions;
  }
  if (filters.months && filters.months.length > 0) {
    where.month = { in: filters.months };
  }

  const employeeConstraints: string[][] = [];
  if (filters.employeeIds && filters.employeeIds.length > 0) employeeConstraints.push(filters.employeeIds);
  if (filters.departments && filters.departments.length > 0) employeeConstraints.push(departmentEmployeeIds ?? []);
  if (employeeConstraints.length === 1) {
    where.employeeId = { in: employeeConstraints[0] };
  } else if (employeeConstraints.length > 1) {
    const [a, b] = employeeConstraints;
    where.employeeId = { in: a.filter((id) => b.includes(id)) };
  }

  const fromDate = filters.from && ISO_DATE.test(filters.from) ? new Date(`${filters.from}T00:00:00.000Z`) : undefined;
  const toDate = filters.to && ISO_DATE.test(filters.to) ? new Date(`${filters.to}T23:59:59.999Z`) : undefined;
  if (fromDate || toDate) {
    where.workDate = { ...(fromDate ? { gte: fromDate } : {}), ...(toDate ? { lte: toDate } : {}) };
  }

  return where;
}

/**
 * Narrows `filters` by one more resolved value from an expanded group-by tree node —
 * e.g. a user expands the "1148" row under a "job" level, and this produces the
 * filters for that row's children (whatever the next chosen level is).
 *
 * Each case narrows on the SAME column its dimension groups by (job -> jobIds,
 * employee -> employeeIds, etc.), never a derived one. That's deliberate: it's what
 * makes a child's WHERE clause a strict SUBSET of its parent's, which in turn is what
 * makes "a group's total never disagrees with its children's" true by construction —
 * every row at every depth is an independent server aggregate over a narrowing chain
 * of subsets of the same base filter, not a client-side re-sum of anything. "date" and
 * "month" both stay on their own columns for the same reason (see the `months` field
 * above) — collapsing "month" into a from/to override would let a child's range
 * escape whatever from/to the parent already had.
 */
/**
 * The FOUR operational-hierarchy dimensions — sectionName/functionGroup/
 * taskDescription, plus "department" as of 2026-08-17 (see
 * hours-operational-grouping.ts's OperationalEntry.department for why it's its
 * own tier, not an alias for functionGroup) — narrow by setting
 * `filters.sections`, expanded to every raw code the picked label covers (via
 * hours-operational-grouping.ts's reverse lookups) instead of a single code.
 * That's still a strict subset of whatever the parent's `sections` constraint
 * already was (an empty/absent constraint included), which is what keeps a
 * child's total from ever disagreeing with its parent's.
 *
 * "department" here is DELIBERATELY NOT `{ ...filters, departments: [value] }`
 * — that field is the employee's raw HR string (a different filter dimension
 * entirely, see HoursFilters.departments) and narrowing on it here is the
 * exact bug this was fixed to stop reintroducing.
 *
 * "sectionNumber"/"functionId" are deliberately NOT part of that reverse-index
 * group, for the same reason rollupByOperationalTier's own comment gives: those
 * four reverse indexes only know the codes OPERATIONAL_GROUPING has enumerated,
 * so expanding into `sections` would narrow an unmapped section number or
 * Function ID to an empty list — the exact "standardization decides existence"
 * bug the 2026-08-21 ingestion fix closed, reopened one layer up. They set
 * `filters.sectionNumber`/`filters.functionId` instead, which buildHoursWhere
 * matches by the raw code's own prefix/suffix shape.
 */
export function narrowFiltersForGroupValue(filters: HoursFilters, groupBy: HoursGroupBy, value: string): HoursFilters {
  switch (groupBy) {
    case "job":
      return { ...filters, jobIds: [value] };
    case "employee":
      return { ...filters, employeeIds: [value] };
    // Narrow on the RAW columns, matching what these dimensions now group on. This
    // used to set `functionId`/`sectionNumber`, which buildHoursWhere matched against
    // the STANDARDIZED code's prefix/suffix — so drilling into "Function 413" returned
    // every row stored on a `-413` column, raw 414 punches included. Parent and child
    // disagreed, which is the defect this fixes.
    case "functionId":
      return { ...filters, rawFunctionId: value };
    case "sectionNumber":
      return { ...filters, rawSectionNumber: value };
    case "month":
      return { ...filters, months: [value] };
    case "date":
      return { ...filters, from: value, to: value };
    // Widened through rawCodesFoldingInto (2026-08-21): codesInSection/etc. return
    // STANDARDIZED codes (10-413), but `section` is stored raw now, so a raw pair
    // that only reaches that code THROUGH the fold (10-414, 12/13/14-211, the
    // 10-311 split) would silently drop out of the narrowed set without this —
    // clicking into "Manufacturing" would show 10-413's rows and miss 10-414's.
    case "sectionName":
      return { ...filters, sections: rawCodesFoldingInto(codesInSection(value)) };
    case "functionGroup":
      return { ...filters, sections: rawCodesFoldingInto(codesInFunctionGroup(value)) };
    case "taskDescription":
      return { ...filters, sections: rawCodesFoldingInto(codesInTask(value)) };
    case "department":
      return { ...filters, sections: rawCodesFoldingInto(codesInDepartment(value)) };
    case "mappingStatus":
      return { ...filters, mappingStatus: value };
    case "standardDepartment":
      return { ...filters, standardDepartment: value };
  }
}

/** `"10-311"` -> `["10", "311"]`. First hyphen only; both halves are already normalized. */
export function splitRawPair(value: string): [string, string] {
  const at = value.indexOf("-");
  return at < 0 ? [value, ""] : [value.slice(0, at), value.slice(at + 1)];
}

// ── The raw / reconciliation tier ──────────────────────────────────────────
//
// Rolls the per-(rawSection, rawFunction) aggregates — a single
// `groupBy: ["rawSection","rawFunction"]` query — into whichever raw dimension was
// asked for. Structurally the same idea as rollupByOperationalTier, but reading the
// RAW columns, so every tier here reproduces Paylocity rather than the app's folded
// columns.
//
// Deliberately does NOT consult OPERATIONAL_GROUPING for its labels: that table only
// knows codes the standard mapping enumerated, and the whole point of this tier is to
// show what was actually punched, including combinations no mapping table has ever
// heard of. Names come from the canonical vocabulary where it has one, and from the
// bare code where it does not.
export type RawTier = "sectionNumber" | "functionId" | "mappingStatus" | "standardDepartment";

export type RawAggregate = { rawSection: string; rawFunction: string; hours: number; punchCount: number };

export function rollupByRawTier(rows: readonly RawAggregate[], tier: RawTier): HoursGroupRow[] {
  const acc = new Map<string, { label: string; hours: number; punchCount: number; rank: number }>();

  for (const r of rows) {
    const c = classifyPunch(r.rawSection, r.rawFunction);
    let key: string;
    let label: string;
    let rank = 0;
    switch (tier) {
      // The KEY is the bare raw value — always. The LABEL may carry the standardized
      // name for readability, but the key must never be derived from it: keying on a
      // label is how two different raw Function IDs collapsed into one group.
      case "sectionNumber":
        key = r.rawSection;
        label = rawSectionLabel(r.rawSection);
        break;
      case "functionId":
        key = r.rawFunction;
        label = rawFunctionLabel(r.rawFunction);
        break;
      case "mappingStatus":
        key = c.mappingStatus;
        label = c.mappingStatus;
        // Undefined sorts last: it is the exception list, and burying the mapped
        // majority under it reads as though something is wrong when nothing is.
        rank = c.mappingStatus === "Mapped" ? 0 : 1;
        break;
      case "standardDepartment":
        key = c.department;
        label = c.department;
        rank = c.department === STANDARD_UNDEFINED ? STANDARD_DEPARTMENTS.length : STANDARD_DEPARTMENTS.indexOf(c.department as (typeof STANDARD_DEPARTMENTS)[number]);
        break;
    }
    const cur = acc.get(key);
    if (cur) {
      cur.hours += r.hours;
      cur.punchCount += r.punchCount;
    } else acc.set(key, { label, hours: r.hours, punchCount: r.punchCount, rank });
  }

  const out = [...acc].map(([key, v]) => ({ key, label: v.label, hours: v.hours, punchCount: v.punchCount, rank: v.rank }));
  if (tier === "mappingStatus" || tier === "standardDepartment") {
    // Fixed business order — a manager expects the same sequence every month.
    out.sort((a, b) => a.rank - b.rank || b.hours - a.hours);
  } else {
    // Section and Function are CODES: read them in code order (10 -> 40 -> 50 ...,
    // 111 -> 211 -> 311 ...), which is how they read on the Paylocity pivot this
    // grouping has to be comparable against. Non-numeric keys (a stray "Not Defined"
    // MachineSec, or the blank bucket) sort after every real code rather than being
    // left to whatever NaN does in a comparator.
    // `/^\d+$/`, NOT Number.isFinite(Number(key)): Number("") and Number(" ") are both
    // 0, so the blank bucket would sort as section/function zero and land BEFORE every
    // real code instead of after them. The blank bucket is the "we could not read this
    // cell" case and belongs at the end with the other unreadable keys.
    const numeric = (k: string) => /^\d+$/.test(k);
    out.sort((a, b) => {
      const aNum = numeric(a.key);
      const bNum = numeric(b.key);
      if (aNum && bNum) return Number(a.key) - Number(b.key);
      if (aNum) return -1;
      if (bNum) return 1;
      return a.key.localeCompare(b.key);
    });
  }
  return out.map(({ rank: _rank, ...row }) => row);
}

// ── Names, WITHOUT the code prefixed ─────────────────────────────────────
//
// These return the name alone, so a table can put the code and the name in their own
// columns. A combined "10 — Complete Design & Build" cell is fine for a group-by tree
// NODE (where one line has to identify itself) and wrong for a detail row, where the
// whole point is to be able to read, sort and compare the two halves independently.
// The combined forms below are built FROM these, so the two can never drift.

/** "Complete Design & Build" for section "10"; the Undefined label when unknown. */
export function rawSectionName(rawSection: string): string {
  if (rawSection === "") return UNDEFINED_LABEL;
  const { sectionName } = rawSectionNumberAndName(`${rawSection}-`);
  return sectionName || UNDEFINED_LABEL;
}

/**
 * "General" for function "311", from the canonical vocabulary — the Function's OWN
 * name, independent of which Section it was punched against and of whether that
 * PAIRING is approved. A caller wanting the verdict wants classifyPunch's
 * taskDescription instead; conflating the two loses which half of the pair is wrong.
 */
export function rawFunctionName(rawFunction: string): string {
  if (rawFunction === "") return UNDEFINED_LABEL;
  return canonicalSectionFor(rawFunction) ?? UNDEFINED_LABEL;
}

/** "10 — Complete Design & Build", for a group-by tree node that must identify itself. */
export function rawSectionLabel(rawSection: string): string {
  if (rawSection === "") return "— (blank)";
  const name = rawSectionName(rawSection);
  return name === UNDEFINED_LABEL ? rawSection : `${rawSection} — ${name}`;
}

/** "311 — General", likewise. */
export function rawFunctionLabel(rawFunction: string): string {
  if (rawFunction === "") return "— (blank)";
  const name = rawFunctionName(rawFunction);
  return name === UNDEFINED_LABEL ? rawFunction : `${rawFunction} — ${name}`;
}

// ── THE punch-identity projection, shared by every hours page ──────────────
//
// Section and Function, raw and standardized, split into their own fields, plus the
// approved rule book's verdict on the raw pair.
//
// Lives here (pure, no I/O) rather than in either query module because the Hours page,
// the Job Hour Details panel and the Monthly ETC month view must all show the SAME
// values for the same punch. Each one projecting its own fields — splitting the code,
// looking up names, deciding Mapped vs Undefined — is how three pages come to disagree
// about one punch, and how a drill-through stops matching the KPI above it.
export type PunchIdentity = {
  // ── Raw — exactly what Paylocity said, never rewritten ──────────────────
  rawSection: string;
  rawSectionName: string;
  rawFunction: string;
  rawFunctionName: string;
  /** `"${rawSection}-${rawFunction}"`, generated directly from the raw values —
   *  NEVER regenerated from a standardized field. The immutable composite key a
   *  Section+Function reconciliation compares against Paylocity. */
  rawSectionFunctionKey: string;
  // ── Standard — reporting metadata ADDED on top; never mutates the raw values ──
  standardDepartment: string;
  standardSectionName: string;
  standardTaskDescription: string;
  mappingStatus: string;
  undefinedReason?: string;
};

/**
 * THE one punch-identity projection (2026-08-21). Storage no longer folds, aliases or
 * splits a raw punch to fit the rule book — `section` in JobHoursDetail IS the raw
 * pair. This function reads the two raw halves directly and adds standardization as
 * separate, additional fields; it never derives a raw value from anything
 * standardized, and never merges one raw pair into another.
 */
export function punchIdentity(rawSection: string, rawFunction: string): PunchIdentity {
  const c = classifyPunch(rawSection, rawFunction);
  return {
    rawSection,
    rawSectionName: rawSectionName(rawSection),
    rawFunction,
    // The raw Function's OWN name, never the verdict — "311" is "General" even in
    // Section 10, where the PAIRING is Undefined. Keeping these apart is what lets a
    // reader see which half of the pair is the problem.
    rawFunctionName: rawFunctionName(rawFunction),
    rawSectionFunctionKey: `${rawSection}-${rawFunction}`,
    standardDepartment: c.department,
    // Section identity is never reclassified — only whether a given PAIR is
    // approved is. Reusing the raw section's own name here is honest: nothing about
    // "Section 10" changes depending on which Function it is paired with.
    standardSectionName: rawSectionName(rawSection),
    // "Undefined" for an unapproved pair — classifyPunch's own word, not a second
    // decision made here.
    standardTaskDescription: c.taskDescription,
    mappingStatus: c.mappingStatus,
    undefinedReason: c.undefinedReason,
  };
}

// Standardized tiers only. sectionNumber/functionId moved to the RAW tier on
// 2026-08-21 — they are Paylocity values, and deriving them from the standardized
// `section` column is what made a Function group label disagree with its own rows.
export type OperationalTier = "sectionName" | "functionGroup" | "taskDescription" | "department";

/**
 * Section isn't a column that already carries the operational label, so this groups
 * the per-raw-section aggregates (from a plain `groupBy: ["section"]` query, the same
 * one the flat "section" dimension already runs) into whichever tier of
 * hours-operational-grouping.ts's hierarchy was asked for — including "department",
 * which used to be its OWN separate code path grouping by `employeeId` and re-rolling
 * by `Employee.department` (the now-removed `rollupByDepartment`). That was the second
 * "grouping implementation" the regression fix (2026-08-17) was explicitly asked to
 * eliminate: there is exactly ONE rollup function for every operational tier now,
 * "department" included, all reading the same `bySection` aggregate. A raw code with
 * no entry in that table rolls up under UNDEFINED_LABEL rather than being dropped —
 * see that module's header for why that's the required behavior, not a fallback of
 * convenience.
 */
// ── Whole-number hours that always sum to their own displayed total (2026-08-17) ─
//
// The Hours tab must never show a decimal — every displayed hours figure is
// Math.round'd — but rounding a set of sibling rows (a Group By level's
// rows, or the root rows against the Total Hours KPI) INDEPENDENTLY can make
// their displayed sum disagree with a separately-rounded parent/KPI total by
// a unit or two, even though the underlying raw hours already sum EXACTLY
// (every JobHoursDetail.section/jobId/employeeId/etc. grouping column is
// non-nullable, so partitioning a filtered set by one and summing the parts
// reproduces the whole — see hours-explorer.ts's queryHoursGrouped). This is
// the exact "sum of roundings != rounding of the sum" class already fixed
// for the Parts Cost card (src/lib/rounding.ts) — same fix, reused rather
// than re-derived.
//
// `targetTotal` lets a caller reconcile a set of CHILD rows against their
// PARENT row's own already-displayed (and possibly ±1-adjusted) number,
// rather than a fresh rounding of the children's own raw sum — see
// reconcileRounding's own header for why that distinction matters once more
// than one level of nesting is involved. Omit it for the root level, which
// has no parent row to match — it reconciles against its own sum instead,
// which is also exactly what the Total Hours KPI's own rounding produces.
//
// Returns a Map so a caller renders in whatever (sorted) order it likes and
// still looks a row's reconciled value up by its own stable `key`.
export function reconcileGroupRowHours(rows: { key: string; hours: number }[], targetTotal?: number): Map<string, number> {
  const reconciled = reconcileRounding(rows.map((r) => r.hours), targetTotal);
  return new Map(rows.map((r, i) => [r.key, reconciled[i]]));
}

export function rollupByOperationalTier(bySection: { section: string; hours: number; punchCount: number }[], tier: OperationalTier): HoursGroupRow[] {
  const rolled = new Map<string, HoursGroupRow>();
  for (const r of bySection) {
    // Standardized tiers ONLY. `r.section` is the standardized code, which is correct
    // here — these dimensions are reporting categories and are meant to combine many
    // raw values. sectionNumber/functionId used to be computed here too, off this same
    // standardized code, and that was the bug: a Paylocity value must never be derived
    // from a standardized one. They now live in rollupByRawTier, keyed on the actual
    // rawSection/rawFunction columns.
    const label =
      tier === "sectionName"
        ? sectionNumberAndName(r.section).sectionName
        : tier === "functionGroup"
          ? functionGroupFor(r.section)
          : tier === "department"
            ? departmentFor(r.section)
            : taskFor(r.section);
    const key = tier === "sectionName" ? sectionNumberAndName(r.section).sectionNumber : label;
    const cur = rolled.get(key) ?? { key, label, hours: 0, punchCount: 0 };
    cur.hours += r.hours;
    cur.punchCount += r.punchCount;
    rolled.set(key, cur);
  }
  const rows = [...rolled.values()];
  // "Department" reads in the fixed business order (2026-08-17, by request —
  // "match Monthly ETC exactly"), never by hours: a manager scanning down the
  // list expects PM/ME/CE/... in the same sequence every month, regardless of
  // which one happened to log the most hours.
  if (tier === "department") {
    return rows.sort((a, b) => departmentOrderRank(a.label) - departmentOrderRank(b.label));
  }
  // The remaining standardized tiers (sectionName/functionGroup/taskDescription) read
  // biggest-first, which is what they were built for. The numeric code ordering that
  // used to live here belonged to sectionNumber/functionId, which are now raw
  // dimensions handled by rollupByRawTier.
  return rows.sort((a, b) => b.hours - a.hours);
}
