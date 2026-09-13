import "server-only";
import { prisma } from "@/lib/prisma";
import { PARTS_COST_SECTION, mapPunchToColumns } from "@/lib/sections";

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
      where: { jobId: { in: jobPks }, section: { not: PARTS_COST_SECTION }, month: { notIn: covered } },
      _sum: { hoursWorked: true },
    }),
    prisma.jobHoursDetail.groupBy({
      by: ["jobId", "section"],
      where: { jobId: { in: jobPks }, month: { in: covered } },
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
      where: { jobId: { in: jobPks }, section: { not: PARTS_COST_SECTION }, month: { notIn: covered } },
      _sum: { hoursWorked: true },
    }),
    prisma.jobHoursDetail.groupBy({
      by: ["month", "section"],
      where: { jobId: { in: jobPks }, month: { in: covered } },
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
