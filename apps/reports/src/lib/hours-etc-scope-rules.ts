import { ETC_TRACKED_CODES, ENGINEERING_OTHER_CODES, billingGroupForSection, mapPunchToColumns } from "@/lib/sections";
import { sectionDisplayName } from "@/lib/hours-operational-grouping";
import type { HoursFilters } from "@/lib/hours-filters";

// ── "Match Monthly ETC" on the Hours tab (2026-10-01) ──────────────────────
//
// The Hours tab counts every punch. Monthly ETC's Hours Worked counts only the
// punches that land on one of its section columns, on a job its grid lists for
// that month. Both are right; but with nothing on screen saying so, the gap
// between them (1,874h in September 2026) read as a black box.
//
// This is the Hours tab restricted to EXACTLY what Monthly ETC counts, plus an
// itemised account of everything it leaves out. The rule is not restated here —
// it is the same two calls the sync makes:
//
//   • codes: mapPunchToColumns + ETC_TRACKED_CODES — what syncHoursWorked's
//     foldRowsToEtcColumns and its `ETC_TRACKED_CODES.has(section)` test do
//     (lib/sync-actuals.ts). A raw code is in scope when every column it folds
//     onto is tracked. 10-311 is the only split, and both halves (10-312,
//     10-313) are tracked, so no raw code is ever partly in scope and a plain
//     `section IN (...)` filter reproduces Hours Worked exactly.
//   • jobs: getEtcMonthJobIds(month) — the grid's own job universe
//     (lib/etc-month-jobs.ts), which the Engineering/Shop KPI cards sum over.
//
// Pure (no Prisma) so the rules are testable; the queries live in
// lib/hours-etc-scope.ts.

export const ETC_MONTH_PARAM = "etcMonth";

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export function parseEtcMonth(v: string | undefined): string | undefined {
  return v && MONTH.test(v.trim()) ? v.trim() : undefined;
}

/** "2026-09" -> { from: "2026-09-01", to: "2026-09-30" }. */
export function monthBounds(month: string): { from: string; to: string } {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
}

/** True when every Monthly ETC column this raw punch code folds onto is one the grid tracks. */
export function rawCodeInEtcScope(rawCode: string): boolean {
  return mapPunchToColumns(rawCode, 1).every((c) => ETC_TRACKED_CODES.has(c.section));
}

// Why a code has no Monthly ETC column, in the words a reader would use. Decided
// on the FOLDED code (12-411 is Shop build, 10-414 is Manufacturing), most
// specific first, so the buckets match the Hours tab's own groups.
export const EXCLUSION_REASONS = [
  "Manufacturing",
  "Project Management",
  "Warranty",
  "Service",
  "Spare Parts",
  "Engineering “Other”",
  "Unmapped / other codes",
] as const;
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

export function exclusionReasonFor(rawCode: string): ExclusionReason {
  const folded = mapPunchToColumns(rawCode, 1)[0]?.section ?? rawCode;
  if (folded === "10-413") return "Manufacturing";
  if (folded === "10-111") return "Project Management";
  const phase = folded.split("-")[0];
  if (phase === "70") return "Warranty";
  if (phase === "80") return "Service";
  if (phase === "90") return "Spare Parts";
  if (ENGINEERING_OTHER_CODES.has(folded)) return "Engineering “Other”";
  return "Unmapped / other codes";
}

export type ScopePunchGroup = { jobId: string; jobName: string; section: string; hours: number };
export type EngShop = { engineering: number; shop: number; total: number };

export type EtcScopeReport = {
  /** Every punch the user's other filters reach in the month, before the Monthly ETC rule. */
  allHours: number;
  /** What this view keeps — the Hours tab's side of the comparison. */
  view: EngShop;
  /** Σ EtcEntry.hoursWorked for the same jobs — Monthly ETC's side. */
  etc: EngShop;
  /** Left out first: codes with no Monthly ETC column, whatever job they are on. */
  excludedByCode: { reason: ExclusionReason; hours: number; codes: { code: string; name: string; hours: number }[] }[];
  /** Left out second: tracked codes on a job the grid does not list. */
  excludedByJob: { jobId: string; jobName: string; hours: number }[];
  /** The raw codes present this month that are in scope — what the filter narrows `sections` to. */
  inScopeCodes: string[];
};

const engShop = (): EngShop => ({ engineering: 0, shop: 0, total: 0 });

function addTo(b: EngShop, section: string, hours: number) {
  const group = billingGroupForSection(section);
  if (group === "Engineering") b.engineering += hours;
  else if (group === "Shop") b.shop += hours;
  b.total += hours;
}

/**
 * Splits a month's punches into what Monthly ETC counts and what it leaves out.
 *
 * The order matches the sync: syncHoursWorked drops untracked codes first and only
 * then looks the job up, so a Manufacturing punch on an overhead job is reported
 * under Manufacturing, not under the job. Every hour lands in exactly one place,
 * so view.total + Σ excludedByCode + Σ excludedByJob === allHours.
 */
export function buildEtcScopeReport(input: {
  punches: readonly ScopePunchGroup[];
  gridJobIds: ReadonlySet<string>;
  etcEntries: readonly { section: string; hoursWorked: number }[];
}): EtcScopeReport {
  const view = engShop();
  const etc = engShop();
  const byReason = new Map<ExclusionReason, Map<string, number>>();
  const byJob = new Map<string, { jobName: string; hours: number }>();
  const inScope = new Set<string>();
  let allHours = 0;

  for (const p of input.punches) {
    allHours += p.hours;
    if (!rawCodeInEtcScope(p.section)) {
      const reason = exclusionReasonFor(p.section);
      const codes = byReason.get(reason) ?? new Map<string, number>();
      codes.set(p.section, (codes.get(p.section) ?? 0) + p.hours);
      byReason.set(reason, codes);
      continue;
    }
    inScope.add(p.section);
    if (!input.gridJobIds.has(p.jobId)) {
      const j = byJob.get(p.jobId) ?? { jobName: p.jobName, hours: 0 };
      j.hours += p.hours;
      byJob.set(p.jobId, j);
      continue;
    }
    for (const col of mapPunchToColumns(p.section, p.hours)) addTo(view, col.section, col.hours);
  }

  for (const e of input.etcEntries) addTo(etc, e.section, e.hoursWorked);

  return {
    allHours,
    view,
    etc,
    excludedByCode: EXCLUSION_REASONS.filter((r) => byReason.has(r)).map((reason) => {
      const codes = [...byReason.get(reason)!].map(([code, hours]) => ({ code, name: sectionDisplayName(code), hours })).sort((a, b) => b.hours - a.hours);
      return { reason, hours: codes.reduce((s, c) => s + c.hours, 0), codes };
    }),
    excludedByJob: [...byJob].map(([jobId, j]) => ({ jobId, ...j })).sort((a, b) => b.hours - a.hours),
    inScopeCodes: [...inScope].sort(),
  };
}

// A value no job or code can have, for "narrow to nothing": buildHoursWhere skips an
// empty list entirely (an empty filter means "all"), so an empty intersection has to
// be spelled as a list that matches no row.
const MATCHES_NOTHING = "\u0000none";

const intersect = (picked: string[] | undefined, allowed: readonly string[]) => {
  const out = picked?.length ? picked.filter((v) => allowed.includes(v)) : [...allowed];
  return out.length ? out : [MATCHES_NOTHING];
};

/**
 * The user's filters, narrowed to the Monthly ETC rule for `month`: the month's dates
 * (intersected with any range already set), the grid's jobs and the in-scope codes
 * (each intersected with any selection already made). Employee and department
 * filters pass through untouched — they are the user's to set, and the panel says
 * that Monthly ETC is not narrowed by them.
 */
export function scopeFilters(filters: HoursFilters, month: string, gridJobIds: readonly string[], inScopeCodes: readonly string[]): HoursFilters {
  const b = monthBounds(month);
  return {
    ...filters,
    from: filters.from && filters.from > b.from ? filters.from : b.from,
    to: filters.to && filters.to < b.to ? filters.to : b.to,
    months: [month],
    jobIds: intersect(filters.jobIds, gridJobIds),
    sections: intersect(filters.sections, inScopeCodes),
  };
}

/** Plain-English reasons the two sides cannot be expected to agree, given the filters the user also has on. */
export function etcScopeCaveats(filters: HoursFilters, month: string): string[] {
  const b = monthBounds(month);
  const out: string[] = [];
  if ((filters.from && filters.from > b.from) || (filters.to && filters.to < b.to)) {
    out.push("Your date range covers only part of the month; Monthly ETC is always the whole month. Clear Dates to compare.");
  }
  if (filters.employeeIds?.length || filters.departments?.length) {
    out.push("An employee or department filter is on; Monthly ETC counts everyone, so its side is not narrowed by it.");
  }
  if (filters.sections?.length) {
    out.push("A Section-Function filter is on; Monthly ETC’s side is not narrowed by it.");
  }
  return out;
}
