import "server-only";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { PARTS_COST_SECTION, mapPunchToColumns } from "@/lib/sections";
import type { HistoricalEraScope } from "@/lib/hours-filters";

// THE definition of "actual hours worked to date", for every report that shows
// one. Both the Projects grid and the Job Hour Details dashboard call this, so
// the two can't drift apart — which is exactly what happened before it existed.
//
// ── The bug this was written for (2026-08-01) ───────────────────────────────
// Cumulative actuals used to be `actualHistoricalHours + Σ EtcEntry.hoursWorked`.
// But auto-sync only refreshes EtcEntry.hoursWorked for the CURRENT open month
// (see the etc_hours_worked step), while the punch tables are rewritten from the
// whole Paylocity export every pass. So a closed month's ETC hours are frozen at
// whatever the export said while that month was live, and every late or
// retro-coded punch since is invisible to them.
//
// Measured across Jan–Jul 2026: 6,954 hours missing over 259 job/month/section
// cells, concentrated in 40-211 Debug (+3,902h) — the hours people book latest.
// June and July agreed to within 12 hours, because they hadn't closed yet.
//
// That freeze is deliberate and must stay: New ETC is computed off hoursWorked,
// and re-syncing a closed month against today's roster corrupted historical data
// once already (isSafeForLiveEtcSync in etc.ts). So nothing here writes — the ETC
// arithmetic is untouched. This only changes what the REPORTS read.
//
// ── The rule ────────────────────────────────────────────────────────────────
// Per job and section, add three non-overlapping eras:
//   1. actualHistoricalHours — the Excel-migration snapshot, for work done
//      before the job was ever ETC-tracked.
//   2. EtcEntry.hoursWorked for months the punch import does NOT cover — ETC
//      history that predates the punch feed. Frozen, but it's all there is.
//   3. JobHoursDetail punches for the months it DOES cover — live, and the only
//      figure that agrees with the drill-through under the chart.
//
// Era 3 takes precedence over era 2 for the same month by construction: the two
// queries partition on `coveredMonths`, so no month is counted twice.

// ── The snapshot already contains January 2025 (2026-09-28) ─────────────────
//
// Era 1 is `Hours Through 20250131.xlsx`: a lifetime total per job and section,
// THROUGH 2025-01-31. The punch feed (Job_Hours_2025.xlsx) starts 2025-01-06. So
// for any job that has a snapshot, its January 2025 punches are already inside
// that snapshot, and adding them counted them twice.
//
// Measured against production on 2026-09-28: 46 jobs had January 2025 punches
// (6,417.49h). The 37 with a snapshot carried 5,618.35h of them, every one with a
// snapshot at least that large. Job 1105 (Clip-iT Retrofit) is the proof: its only
// work before February was in January, and its snapshot equals its January punches
// exactly (8.89h and 8.89h). Power BI makes the same cut: its punch feed starts
// 2025-02-01 and the historical import covers everything before.
//
// The other 9 jobs have no snapshot at all (799.14h, mostly the service and
// utility jobs the Excel tracker never carried). For them the punches are the only
// record, so a flat cutoff would lose them. The rule is therefore per job: a month
// at or before SNAPSHOT_THROUGH_MONTH counts for era 2 or 3 only when the job has
// no snapshot. Rows are not touched; this only decides what the reports read.
//
// Per job rather than per section: the snapshot is a whole-job crosstab, so a
// section with 0 in it means no hours were booked there, not that it is missing.
export const SNAPSHOT_THROUGH_MONTH = "2025-01";

// Whether a job/month is already inside the migration snapshot. Pure, so the rule
// is testable without a database; OUTSIDE_SNAPSHOT below is the same rule as SQL.
export function supersededBySnapshot(month: string, jobHasSnapshot: boolean): boolean {
  return jobHasSnapshot && month <= SNAPSHOT_THROUGH_MONTH;
}

// The where-fragment every era-2 and era-3 read of a job's hours must include, in
// its AND list. Keeps the month, or keeps the job when it has no
// non-zero snapshot row. EtcEntry and JobHoursDetail both have `month` and `job`.
export const OUTSIDE_SNAPSHOT = {
  OR: [
    { month: { gt: SNAPSHOT_THROUGH_MONTH } },
    { job: { estimatedHours: { none: { actualHistoricalHours: { not: 0 } } } } },
  ],
} satisfies Prisma.JobHoursDetailWhereInput & Prisma.EtcEntryWhereInput;

// Which months the punch import actually covers. Everything else falls back to
// the frozen ETC figure. Derived from the data rather than configured, so it
// widens on its own as the import's window grows.
export async function coveredMonths(): Promise<string[]> {
  const rows = await prisma.jobHoursDetail.groupBy({ by: ["month"] });
  return rows.map((r) => r.month);
}

// jobPk -> section -> cumulative actual hours. Jobs and sections with no hours
// are simply absent; callers already treat a miss as zero.
export type ActualHoursBySection = Map<number, Map<string, number>>;

// ── The fold this file was missing (2026-09-02) ─────────────────────────────
//
// JobHoursDetail.section stores the RAW Paylocity pair ("40-311", "10-414",
// "13-211") — since 2026-08-21 it is deliberately never rewritten at write time,
// and each consumer folds it onto the app's fixed columns itself. Every other
// consumer does: sync-actuals.ts for JobMonthlyActualHours and the ETC grid's
// Hours Worked, job-hours-detail.ts for the drill under the chart, tm-hours.ts
// for the T&M cards. This file never did — it grouped by the raw pair and handed
// the raw codes to callers as though they were column codes.
//
// The consequence, measured on job 1131 before the fix: 3,442.36 punch hours in
// the table, 2,032.03 drawn by the chart. 1,410.33 hours — 41% of the job — had
// no bar to land in and were silently dropped by the caller, which iterates the
// fixed SECTIONS list. Every one of those codes has a signed-off destination:
// 40-311 -> 40-211 (490h), 10-414 -> 10-413 (355h), 13/14/15/11/12-211 -> 10-211
// (399h), 40-412 -> 40-411, 10-311 -> its documented 30/70 split, and so on.
//
// It also meant the chart disagreed with its OWN drill-through, which folds.
//
// mapPunchToColumns is that fold, and calling it here is what makes this
// function's answer mean the same thing as every other page's. It is called with
// no resolver, exactly as the other query-time consumers call it: the
// model-derived resolver exists only during import, and SECTION_ALIASES is the
// documented static fallback.

export async function loadActualHoursBySection(jobPks: number[]): Promise<ActualHoursBySection> {
  const out: ActualHoursBySection = new Map();
  if (jobPks.length === 0) return out;

  const covered = await coveredMonths();
  const [historical, frozen, punches] = await Promise.all([
    prisma.estimatedHours.findMany({
      where: { jobId: { in: jobPks } },
      select: { jobId: true, section: true, actualHistoricalHours: true },
    }),
    prisma.etcEntry.groupBy({
      by: ["jobId", "section"],
      where: { jobId: { in: jobPks }, section: { not: PARTS_COST_SECTION }, month: { notIn: covered }, AND: [OUTSIDE_SNAPSHOT] },
      _sum: { hoursWorked: true },
    }),
    prisma.jobHoursDetail.groupBy({
      by: ["jobId", "section"],
      where: { jobId: { in: jobPks }, month: { in: covered }, AND: [OUTSIDE_SNAPSHOT] },
      _sum: { hours: true },
    }),
  ]);

  const add = (jobId: number, section: string, hours: number) => {
    if (!hours) return;
    let sections = out.get(jobId);
    if (!sections) out.set(jobId, (sections = new Map()));
    sections.set(section, (sections.get(section) ?? 0) + hours);
  };

  // Eras 1 and 2 are app-owned grid data, already keyed by column code — only the
  // punches carry a raw pair that has to be folded. See the note above.
  for (const h of historical) add(h.jobId, h.section, Number(h.actualHistoricalHours ?? 0));
  for (const f of frozen) add(f.jobId, f.section, Number(f._sum.hoursWorked ?? 0));
  for (const p of punches) {
    for (const col of mapPunchToColumns(p.section, Number(p._sum.hours ?? 0))) add(p.jobId, col.section, col.hours);
  }

  return out;
}

// Per-section month-by-month worked hours across the given jobs, oldest first —
// the timeline behind a section's Actual bar on the Job Hour Details dashboard.
//
// Same two-era split as above (punches where covered, frozen ETC before that) so
// the timeline adds up to the bar it explains. The migration snapshot can't
// appear here at all: it carries no month, only a total.
export async function loadMonthlyWorkedBySection(jobPks: number[]): Promise<Record<string, { month: string; worked: number }[]>> {
  if (jobPks.length === 0) return {};

  const covered = await coveredMonths();
  const [frozen, punches] = await Promise.all([
    prisma.etcEntry.groupBy({
      by: ["month", "section"],
      where: { jobId: { in: jobPks }, section: { not: PARTS_COST_SECTION }, month: { notIn: covered }, AND: [OUTSIDE_SNAPSHOT] },
      _sum: { hoursWorked: true },
    }),
    prisma.jobHoursDetail.groupBy({
      by: ["month", "section"],
      where: { jobId: { in: jobPks }, month: { in: covered }, AND: [OUTSIDE_SNAPSHOT] },
      _sum: { hours: true },
    }),
  ]);

  // section -> month -> hours. Nested rather than a composite string key, so no
  // separator has to be chosen that a section code or month can't contain.
  const bySection = new Map<string, Map<string, number>>();
  const add = (section: string, month: string, worked: number) => {
    if (!worked) return; // a month nobody touched the section is noise in a drill-down
    let months = bySection.get(section);
    if (!months) bySection.set(section, (months = new Map()));
    months.set(month, (months.get(month) ?? 0) + worked);
  };
  for (const f of frozen) add(f.section, f.month, Number(f._sum.hoursWorked ?? 0));
  // Folded exactly as the cumulative figure above is — a timeline that did not
  // would stop adding up to the bar it explains, which is the one thing this
  // drill-down is for.
  for (const p of punches) {
    for (const col of mapPunchToColumns(p.section, Number(p._sum.hours ?? 0))) add(col.section, p.month, col.hours);
  }

  const out: Record<string, { month: string; worked: number }[]> = {};
  for (const [section, months] of bySection) {
    // YYYY-MM sorts correctly as a string, so no date parsing needed.
    out[section] = [...months].map(([month, worked]) => ({ month, worked })).sort((a, b) => a.month.localeCompare(b.month));
  }
  return out;
}

// ── Punches with no usable job (2026-09-28) ─────────────────────────────────
//
// The Projects grid's "No Job ID" row. These punches never reach JobHoursDetail:
// the import files them in UndefinedHoursRow instead, from the same file in the
// same transaction, so the two tables together are every job-number outcome of
// one import with nothing counted in both.
//
// Only the two job-number reasons. Both are raised AFTER the year-ownership gate
// in paylocity-workbook.ts, so the overlapping workbooks cannot put a punch here
// twice. The other reasons are not "no job id" and are left out on purpose:
// CONTROL_TOTAL_CODE rows are report totals rather than time, INVALID_HOURS rows
// carry no hours, and MISSING_WORK_DATE / INVALID_LABOR_CODE are raised BEFORE the
// year gate, so summing them could count an overlapping file's copy as well.
//
// countsTowardKpi is ignored: that flag scopes the ETC KPI, and this row exists to
// show everything, phase 80/90 and the pool codes included.
//
// Punch-era only, and limited to coveredMonths() so it spans the same months as
// era 3. Eras 1 and 2 were only ever recorded against a job, so there is no
// jobless counterpart to them.
export const JOBLESS_REASONS = ["MISSING_JOB_ID", "JOB_NOT_FOUND"] as const;

export type JoblessActuals = {
  // Folded column code (or raw code, when it has no column) -> hours.
  bySection: Map<string, number>;
  // What the job cell said, largest first: "Not Defined", "2026 SERVICE", "925".
  byLabel: { label: string; hours: number }[];
};

export async function loadJoblessActualsBySection(): Promise<JoblessActuals> {
  const covered = await coveredMonths();
  const where = { reason: { in: [...JOBLESS_REASONS] }, month: { in: covered } };
  const [bySectionRows, byLabelRows] = await Promise.all([
    prisma.undefinedHoursRow.groupBy({ by: ["section"], where, _sum: { hours: true } }),
    prisma.undefinedHoursRow.groupBy({ by: ["label"], where, _sum: { hours: true } }),
  ]);

  const bySection = new Map<string, number>();
  // Folded exactly as a job's punches are, so the row's cells mean what the job
  // rows' cells mean.
  for (const u of bySectionRows) {
    for (const col of mapPunchToColumns(u.section, Number(u._sum.hours ?? 0))) {
      if (col.hours) bySection.set(col.section, (bySection.get(col.section) ?? 0) + col.hours);
    }
  }
  const byLabel = byLabelRows
    .map((u) => ({ label: u.label, hours: Number(u._sum.hours ?? 0) }))
    .filter((u) => u.hours !== 0)
    .sort((a, b) => b.hours - a.hours);
  return { bySection, byLabel };
}

// ── Eras 1 and 2, row by row, for the Hours export (2026-09-24) ──────────────
//
// The Hours page reads JobHoursDetail only, so it shows era 3 alone, and its total
// for a job can sit well below the Actual Hours every other report shows. These
// let the Hours export append the two missing eras as sheets of their own, so a
// manager can see where the difference is. They are not punches and cannot be
// made into punches: the migration snapshot is one number per job/section, a
// frozen month is one number per job/section/month, and nothing finer exists.
//
// Same partition as loadActualHoursBySection above (era 2 is only the months
// coveredMonths() does NOT cover, less any month already inside a job's
// snapshot), so these sheets plus the punch sheet never count a month twice —
// with one exception the export states on the sheet: the punch sheet still lists
// January 2025 for jobs whose snapshot already includes it (SNAPSHOT_THROUGH_MONTH).
// PARTS_COST is excluded from both: it is dollars stored in
// the hours column, not hours.
//
// Zero rows are skipped, here and in the existence check, so the export is
// only offered for a sheet that would contain something.

function eraWhere(scope: HistoricalEraScope) {
  return {
    ...(scope.jobIds ? { job: { jobId: { in: scope.jobIds } } } : {}),
    section: scope.sections ? { in: scope.sections.filter((s) => s !== PARTS_COST_SECTION) } : { not: PARTS_COST_SECTION },
  };
}

function frozenMonthFilter(scope: HistoricalEraScope, covered: string[]): Prisma.StringFilter {
  return {
    notIn: covered,
    ...(scope.fromMonth ? { gte: scope.fromMonth } : {}),
    ...(scope.toMonth ? { lte: scope.toMonth } : {}),
  };
}

// Which of the two eras has anything at all under the given scope. Two
// findFirsts, not aggregates: the Hours page calls this on every render and only
// needs to know whether to offer the sheets.
export async function historicalErasAvailable(scope: HistoricalEraScope): Promise<{ migration: boolean; frozenEtc: boolean }> {
  const covered = await coveredMonths();
  const [migration, frozen] = await Promise.all([
    prisma.estimatedHours.findFirst({
      where: { ...eraWhere(scope), actualHistoricalHours: { not: 0 } },
      select: { id: true },
    }),
    prisma.etcEntry.findFirst({
      where: { ...eraWhere(scope), month: frozenMonthFilter(scope, covered), hoursWorked: { not: 0 }, AND: [OUTSIDE_SNAPSHOT] },
      select: { id: true },
    }),
  ]);
  return { migration: migration !== null, frozenEtc: frozen !== null };
}

export type MigrationSnapshotRow = { jobId: string; jobName: string; section: string; hours: number };

// Era 1. Already one row per job/section (EstimatedHours is @@unique on the pair),
// so nothing to aggregate. The scope's month range does not apply: there is no month.
export async function loadMigrationSnapshotRows(scope: HistoricalEraScope): Promise<MigrationSnapshotRow[]> {
  const rows = await prisma.estimatedHours.findMany({
    where: { ...eraWhere(scope), actualHistoricalHours: { not: 0 } },
    select: { section: true, actualHistoricalHours: true, job: { select: { jobId: true, jobName: true } } },
    orderBy: [{ job: { jobId: "asc" } }, { section: "asc" }],
  });
  return rows.map((r) => ({ jobId: r.job.jobId, jobName: r.job.jobName, section: r.section, hours: Number(r.actualHistoricalHours) }));
}

export type FrozenEtcMonthRow = { jobId: string; jobName: string; month: string; section: string; hours: number };

// Era 2. EtcEntry is one row per job/section/month already, so again no grouping.
export async function loadFrozenEtcMonthRows(scope: HistoricalEraScope): Promise<FrozenEtcMonthRow[]> {
  const covered = await coveredMonths();
  const rows = await prisma.etcEntry.findMany({
    where: { ...eraWhere(scope), month: frozenMonthFilter(scope, covered), hoursWorked: { not: 0 }, AND: [OUTSIDE_SNAPSHOT] },
    select: { month: true, section: true, hoursWorked: true, job: { select: { jobId: true, jobName: true } } },
    orderBy: [{ job: { jobId: "asc" } }, { month: "asc" }, { section: "asc" }],
  });
  return rows.map((r) => ({ jobId: r.job.jobId, jobName: r.job.jobName, month: r.month, section: r.section, hours: Number(r.hoursWorked) }));
}
