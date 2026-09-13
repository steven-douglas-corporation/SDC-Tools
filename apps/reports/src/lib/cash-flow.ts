import "server-only";
import { prisma } from "@/lib/prisma";
import { validJobTypeFilter } from "@/lib/job-filters";
import { fetchProjectEstimates, fetchArForecastRows, fetchApForecastRows, fetchPoForecastRows } from "@/lib/cash-flow-totaleto";
import { buildArLines, buildApLines, buildPoLines, buildEtcLines, aggregateLines, type CashFlowLine } from "@/lib/cash-flow-normalize";
import {
  getEtcAllocations,
  getForecastOverrides,
  getSnapshotLines,
  getSnapshotById,
  getSnapshotAtOrBefore,
  getLatestSnapshot,
  listSnapshots,
  type SnapshotSummary,
} from "@/lib/cash-flow-snapshot-store";

export { getLatestSnapshot as getLatestSnapshotSummary };

export { listSnapshots };
export type { SnapshotSummary };

// The one read layer the Cash Flow UI goes through (2026-08-19). "Current" is
// ALWAYS a live Total ETO query (never the latest snapshot) — the
// reconciliation guarantee ("current SDC Cash Flow reconciles with Total
// ETO") only holds if "Current" can never lag behind whatever a refresh
// hasn't captured yet. Any other `AsOf` reads a stored, immutable snapshot.

export type AsOf = { kind: "current" } | { kind: "snapshot"; snapshot: SnapshotSummary };

export type ProjectEstimate = {
  projectId: string;
  customer: string | null;
  jobName: string | null;
  salesPrice: number;
  materialEstimate: number;
  laborEstimate: number;
  totalEstimate: number;
  projectProfit: number;
  remainingCost: number | null;
};

async function jobNamesByProjectId(): Promise<Map<string, string>> {
  const jobs = await prisma.job.findMany({ select: { jobId: true, jobName: true } });
  return new Map(jobs.map((j) => [j.jobId, j.jobName]));
}

// Total ETO's raw project tables carry test/sandbox rows this app has never
// shown anywhere ("a job must have a real Type... noise and must never
// appear in any list, count, dashboard, or export" — job-filters.ts's own
// header, and applied without exception across this app's other TotalETO-
// sourced features). Cash Flow reads TotalETO directly rather than through
// this app's own Job-sync pipeline, so it has to apply that SAME gate itself
// — confirmed necessary live: without it, TotalETO project ids like
// "1000000000"/"1000000002" (no customer, no real estimate) showed up
// as real forecast rows.
export async function getValidProjectIds(): Promise<Set<string>> {
  const jobs = await prisma.job.findMany({ where: validJobTypeFilter, select: { jobId: true } });
  return new Set(jobs.map((j) => j.jobId));
}

export async function getProjectEstimates(): Promise<ProjectEstimate[]> {
  const [estimates, jobNames, validIds] = await Promise.all([fetchProjectEstimates(), jobNamesByProjectId(), getValidProjectIds()]);
  return estimates.filter((e) => validIds.has(e.projectId)).map((e) => ({ ...e, jobName: jobNames.get(e.projectId) ?? null }));
}

/**
 * The live forecast, with PM overrides (cash-flow-actions.ts) layered on
 * top — an override REPLACES its one (project, category, month) cell rather
 * than adding to it, since it represents "we know better than the raw ERP
 * figure for this one line," not an adjustment on top of it. Overrides are
 * a CURRENT-only concept: they never apply to a stored historical snapshot,
 * which is exactly what "immutable" means here — even the same override,
 * re-fetched a year from now against an unrelated old snapshot, must not
 * reach back and change what that snapshot says the forecast looked like.
 */
export async function getCurrentCashFlowLines(): Promise<CashFlowLine[]> {
  const [arRows, apRows, poRows, etcAllocations, overrides, estimates, validIds] = await Promise.all([
    fetchArForecastRows(),
    fetchApForecastRows(),
    fetchPoForecastRows(),
    getEtcAllocations(),
    getForecastOverrides(),
    fetchProjectEstimates(),
    getValidProjectIds(),
  ]);
  const customerByProject = new Map(estimates.filter((e): e is typeof e & { customer: string } => !!e.customer).map((e) => [e.projectId, e.customer]));

  const lines = aggregateLines([
    ...buildArLines(arRows.filter((r) => validIds.has(r.projectId)), customerByProject),
    ...buildApLines(apRows.filter((r) => validIds.has(r.projectId)), customerByProject),
    ...buildPoLines(poRows.filter((r) => validIds.has(r.projectId)), customerByProject),
    ...buildEtcLines(etcAllocations, customerByProject),
  ]);

  if (overrides.length === 0) return lines;

  const indexByKey = new Map(lines.map((l, i) => [`${l.projectId}|${l.forecastMonth}|${l.category}`, i]));
  const result = [...lines];
  for (const o of overrides) {
    const key = `${o.projectId}|${o.forecastMonth}|${o.category}`;
    const idx = indexByKey.get(key);
    if (idx != null) {
      result[idx] = { ...result[idx], amount: o.amount };
    } else {
      // An override for a cell the live query no longer has anything in
      // (e.g. the underlying AR term was deleted upstream) still shows, so a
      // PM's forecast isn't silently dropped just because ERP data moved.
      result.push({
        projectId: o.projectId,
        customer: customerByProject.get(o.projectId) ?? null,
        forecastMonth: o.forecastMonth,
        flowType: o.category === "AR" ? "incoming" : "outgoing",
        category: o.category as CashFlowLine["category"],
        amount: o.amount,
      });
    }
  }
  return result;
}

export async function getCashFlowLines(asOf: AsOf): Promise<CashFlowLine[]> {
  return asOf.kind === "current" ? getCurrentCashFlowLines() : getSnapshotLines(asOf.snapshot.id);
}

/**
 * Resolves a URL param into an `AsOf` — accepts "current" (or nothing), a
 * snapshot id ("42"), or an ISO date ("2026-07-31", the nearest snapshot AT
 * OR BEFORE that date — "prior month-end"/"custom historical snapshot" both
 * resolve through this same date lookup). Falls back to "current" for
 * anything unrecognized rather than erroring the whole page over a stale
 * bookmark.
 */
export async function resolveAsOf(param: string | undefined): Promise<AsOf> {
  if (!param || param === "current") return { kind: "current" };
  if (/^\d+$/.test(param)) {
    const snap = await getSnapshotById(Number(param));
    if (snap) return { kind: "snapshot", snapshot: snap };
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(param)) {
    const snap = await getSnapshotAtOrBefore(new Date(`${param}T00:00:00.000Z`));
    if (snap) return { kind: "snapshot", snapshot: snap };
  }
  return { kind: "current" };
}
