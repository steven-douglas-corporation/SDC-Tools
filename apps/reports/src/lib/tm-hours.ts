import "server-only";
import { prisma } from "@/lib/prisma";
import { punchIdentity, type PunchIdentity } from "@/lib/hours-filters";
import { SECTIONS, mapPunchToColumns } from "@/lib/sections";
import { validJobTypeFilter } from "@/lib/job-filters";
import { classifyTmHoursSection, TM_HOURS_KEYS, type TmHoursDrillKey } from "@/lib/tm-hours-classify";

export type { TmHoursDrillKey };

export type TmHoursDrillRow = {
  date: string | null;
  employee: string;
  department: string;
  jobId: string;
  jobName: string;
  section: string;
  hours: number;
} & PunchIdentity;
// ^ Section and Function split into their own raw/standardized fields (2026-08-21),
// from the one shared projection in hours-filters.ts — same as the Hours page, the Job
// Hour Details panel and Monthly ETC. This drill reads the same JobHoursDetail table
// they do, so it must not be the one view still showing a combined "Function /
// Section" value.

// ── T&M's four Hours cards, read from the app's own Paylocity ingest ────────
//
// Retired the live Power BI 'Hours Actual' DAX query these four cards used to
// run (tm-report.ts's old fetchTmHoursDrill) — a second, independent
// Paylocity reader alongside the one Monthly ETC already has. Per explicit
// request, Engineering/Shop/PM/Manufacturing Hours now read the SAME local
// `JobHoursDetail` table (the app's Paylocity-Excel-via-Power-BI ingest —
// see job-hours-source.ts's own header) that Monthly ETC's KPI cards and
// punch drill already use, through the SAME code->card mapping — see
// tm-hours-classify.ts for exactly which codes and why (that file is the
// pure half of this one, importable from a plain test without a database).
//
// Part Invoiced Amount / SDC Manufactured Parts Sales Price / Expense Reports
// are UNCHANGED — still Power BI DAX, in tm-report.ts. Nothing here touches
// those three.
//
// ── One query, one classifier (the reconciliation requirement) ─────────────
//
// getTmHoursTotals (an aggregate) and getTmHoursDrillRows (row detail) both
// filter `JobHoursDetail` with the IDENTICAL where-clause shape (same job
// PKs, same inclusive date range, same section-code set) and the same
// classifyTmHoursSection() decides which of the four cards a row belongs to
// in both places — so a card's KPI total and its own drill-through can't
// disagree the way the old Power BI SUMMARIZECOLUMNS query once did. The
// aggregate is never capped (a GROUP BY over ~30 codes is always small); the
// row-level detail is, for payload-size safety on a wide job/date
// selection — see MAX_ROWS.

const SECTION_NAME = new Map(SECTIONS.map((s) => [s.code, s.name]));

/** "YYYY-MM-DD" (inclusive on both ends) -> a Prisma `workDate` range. */
function dateRangeWhere(startDate: string, endDate: string) {
  return {
    gte: new Date(`${startDate}T00:00:00.000Z`),
    // workDate is a plain DATE column — "<= the end day's own midnight" already
    // includes every punch dated that day, no need for a next-day exclusive bound.
    lte: new Date(`${endDate}T00:00:00.000Z`),
  };
}

export type TmHoursTotals = Record<TmHoursDrillKey, number>;

/** All five keys at zero — the starting point, and the shape of an empty selection. */
function emptyTotals(): TmHoursTotals {
  return Object.fromEntries(TM_HOURS_KEYS.map((k) => [k, 0])) as TmHoursTotals;
}

/**
 * The four KPI totals — an aggregate GROUP BY over the SAME rows
 * getTmHoursDrillRows reads for a card's own drill, so summing that
 * function's returned rows for one key always equals this function's total
 * for the same key (barring MAX_ROWS truncation on the drill side, which is
 * flagged, not silent).
 */
export async function getTmHoursTotals(jobPks: number[], startDate: string, endDate: string): Promise<TmHoursTotals> {
  const totals = emptyTotals();
  if (jobPks.length === 0) return totals;

  // `section` is the RAW pair now (2026-08-21) — grouping by it directly and
  // filtering to ALL_TM_HOURS_CODES would miss every raw punch that FOLDS onto one
  // of those codes (10-311 -> 312/313, 10-414 -> 413, etc.), so every raw pair for
  // the scope is folded via mapPunchToColumns here before classifying.
  const grouped = await prisma.jobHoursDetail.groupBy({
    by: ["section"],
    where: { jobId: { in: jobPks }, workDate: dateRangeWhere(startDate, endDate) },
    _sum: { hours: true },
  });

  for (const g of grouped) {
    const hours = Number(g._sum?.hours ?? 0);
    const cols = mapPunchToColumns(g.section, hours);
    // A raw pair mapPunchToColumns does not recognise at all yields NO columns —
    // Service/Spare Parts phases, the unmapped 10-400, and the malformed codes
    // ("-311", "1-312", "5-111") whose phase prefix is missing in the export.
    // Those hours were being dropped here without a trace; they land in
    // `otherHours` now so the five cards reconcile to what was actually punched.
    // See the audit note in tm-hours-classify.ts.
    if (cols.length === 0) {
      totals.otherHours += hours;
      continue;
    }
    for (const col of cols) {
      totals[classifyTmHoursSection(col.section)] += col.hours;
    }
  }
  return totals;
}

// A job with years of history could carry thousands of punches — same cap and
// same reasoning as job-hours-detail.ts's own MAX_ROWS (that file's cap isn't
// reused directly since it isn't exported, but the value and the reasoning
// are identical: far above any real job/range, bounding only the worst case).
const MAX_ROWS = 4000;

export type TmHoursDrillResult = { rows: TmHoursDrillRow[]; truncated: boolean };

/** Row-level detail behind one Hours card, for its own drill-through. */
export async function getTmHoursDrillRows(
  jobPks: number[],
  startDate: string,
  endDate: string,
  key: TmHoursDrillKey,
): Promise<TmHoursDrillResult> {
  if (jobPks.length === 0) return { rows: [], truncated: false };

  // No `section` filter in SQL (2026-08-21) — `section` is the raw pair, so this
  // fetches every raw punch for the scope and folds+filters in JS below, exactly as
  // getTmHoursTotals does for the matching aggregate.
  const [detail, employees] = await Promise.all([
    prisma.jobHoursDetail.findMany({
      where: { jobId: { in: jobPks }, workDate: dateRangeWhere(startDate, endDate) },
      select: { section: true, rawSection: true, rawFunction: true, workDate: true, employeeId: true, hours: true, job: { select: { jobId: true, jobName: true } } },
      orderBy: [{ workDate: "desc" }, { section: "asc" }],
      take: MAX_ROWS + 1,
    }),
    prisma.employee.findMany({ where: { paylocityId: { not: null } }, select: { paylocityId: true, name: true, department: true } }),
  ]);

  const truncated = detail.length > MAX_ROWS;
  const kept = truncated ? detail.slice(0, MAX_ROWS) : detail;
  const byPaylocityId = new Map(employees.map((e) => [e.paylocityId!, e]));
  const rows: TmHoursDrillRow[] = kept
    .flatMap((d) => {
      const emp = byPaylocityId.get(d.employeeId);
      const hours = Number(d.hours);
      // A raw punch that folds/splits can land in more than one ETC column; only the
      // allocation(s) belonging to THIS card are kept — the raw identity on every
      // resulting row is still the untouched original (via punchIdentity below).
      //
      // Selected by classifyTmHoursSection(), NOT by a per-key code list
      // (HOURS_CODES_BY_KEY, deleted 2026-09-01). That list was a SECOND
      // definition of the same mapping, sitting next to the classifier the
      // TOTALS use — exactly the kind of pair that drifts and makes a card
      // disagree with its own drill-through. One function decides now, in both
      // places.
      //
      // An unrecognised raw pair yields no columns and is emitted as one
      // `otherHours` row carrying its own raw code, matching what
      // getTmHoursTotals adds to that bucket.
      const cols = mapPunchToColumns(d.section, hours);
      const allocations = cols.length > 0 ? cols : [{ section: d.section, hours }];
      return allocations
        .filter((col) => classifyTmHoursSection(col.section) === key)
        .map((col) => ({
          date: d.workDate.toISOString().slice(0, 10),
          employee: emp?.name ?? (d.employeeId ? `#${d.employeeId}` : "—"),
          department: emp?.department?.trim() || "—",
          jobId: d.job.jobId,
          jobName: d.job.jobName,
          section: SECTION_NAME.get(col.section) ?? col.section,
          hours: col.hours,
          ...punchIdentity(d.rawSection, d.rawFunction),
        }));
    })
    .filter((r) => r.hours !== 0);

  return { rows, truncated };
}

/**
 * Resolves T&M's own app job-id strings ("1101") to the Prisma PKs
 * JobHoursDetail is keyed on. An EMPTY `jobIds` means "All Jobs selected" —
 * the same convention buildTmFilters() uses for the Power BI path — so it
 * resolves to every valid job's PK, not zero.
 */
export async function resolveTmJobPks(jobIds: string[]): Promise<number[]> {
  const where = jobIds.length > 0 ? { jobId: { in: jobIds }, ...validJobTypeFilter } : validJobTypeFilter;
  const jobs = await prisma.job.findMany({ where, select: { id: true } });
  return jobs.map((j) => j.id);
}
