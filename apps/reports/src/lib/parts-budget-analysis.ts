import "server-only";
import { prisma } from "@/lib/prisma";
import { compareJobIds, VALID_JOB_TYPES } from "@/lib/job-filters";
import { PARTS_COST_SECTION } from "@/lib/sections";
import { getPartsCostForJobs, loadAllTransfers } from "@/lib/sync-totaleto";
import { summarizeTransfersForJobs } from "@/lib/parts-transfer-netting";
import { readPriorEtcByJob, type PriorEtcResolution } from "@/lib/parts-prior-etc";
import { readLeftToPurchaseLastMonth } from "@/lib/parts-left-to-purchase";
import { assemblePartsCostFinancials } from "@/lib/parts-cost-financials";
import { leftToInvoiceForLines } from "@/lib/left-to-invoice";
import { withTimeoutOrNull } from "@/lib/with-timeout";
import { PARTS_BUDGET_EXCLUDED_TYPES, roundPct, type PartsBudgetRow } from "@/lib/parts-budget-bands";

// ── Projection vs Budget, for every job at once (2026-10-22) ───────────────────────────────────
//
// One row per job, each assembled by the SAME function the Job Details card uses
// (assemblePartsCostFinancials), so a job cannot read differently here. Only the loading differs: the
// card reads one job; this reads Total ETO once for all of them and then assembles each on its own.
// Run per job rather than as one selection because a selection sums its jobs, and the question here is
// which JOB is over.
//
// ── Which jobs ──────────────────────────────────────────────────────────────────────────────────
//
// The jobs on the Job Details picker (a valid project type, but NOT T&M — see below) that have parts to report: a Parts Cost row on
// the Monthly ETC, or a completed job with a final Parts Cost Actual on the Projects tab. A job with
// neither has nothing to project. A closed job is shown at that final actual — never at purchased + still to
// purchase, which would count old open POs and a stale forecast as cost on a finished job. A job that has a row but has bought nothing yet reads "No parts activity
// yet" on its card, so it is counted (`notStarted`) rather than drawn as a $0 projection.
//
// ── Live, not month-scoped ──────────────────────────────────────────────────────────────────────
//
// The projection is as of now, like the card, so it ignores the Dashboard's month picker. The result is
// held for a few minutes: the read is one Total ETO round trip plus a handful of queries, and the section
// is opened far more often than the figures change.

// ── T&M jobs are not part of this report (2026-10-23, by request) ────────────────────────────────
//
// Time-and-materials jobs were showing up in this report (job 1165, Johnson Matthey, in the 0–10% band) and
// do not belong in it. Every other valid type stays. Excluded in the query itself, so a T&M job cannot reach
// the chart, the summary, the table, the Customer/Type menus or the export.
export const PARTS_BUDGET_JOB_TYPES = VALID_JOB_TYPES.filter((t) => !PARTS_BUDGET_EXCLUDED_TYPES.includes(t));

const BUDGET_MS = 120_000;
const TTL_MS = 5 * 60_000;

export type PartsBudgetAnalysis =
  | { state: "ok"; rows: PartsBudgetRow[]; notStarted: number; asOf: string }
  | { state: "unavailable" };

let cache: { at: number; value: PartsBudgetAnalysis } | null = null;
let inflight: Promise<PartsBudgetAnalysis> | null = null;

export async function loadPartsBudgetAnalysis(): Promise<PartsBudgetAnalysis> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  // One load at a time: two people opening the tab together share the read instead of doubling it.
  inflight ??= compute()
    .then((value) => {
      // A failure is never held: the next open tries again.
      if (value.state === "ok") cache = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

async function compute(): Promise<PartsBudgetAnalysis> {
  try {
    const jobs = await prisma.job.findMany({
      where: {
        type: { in: [...PARTS_BUDGET_JOB_TYPES] },
        OR: [
          { etcEntries: { some: { section: PARTS_COST_SECTION } } },
          { status: "Complete", costActualHistorical: { gt: 0 } },
        ],
      },
      select: {
        id: true, jobId: true, jobName: true, customer: true, type: true, status: true,
        costQuoted: true, costActualHistorical: true, startDate: true, completeDate: true,
      },
    });
    if (jobs.length === 0) return { state: "ok", rows: [], notStarted: 0, asOf: new Date().toISOString() };
    jobs.sort((a, b) => compareJobIds(a.jobId, b.jobId));

    const byJob = await withTimeoutOrNull(
      `TotalETO parts (${jobs.length} jobs)`,
      BUDGET_MS,
      () => getPartsCostForJobs(jobs.map((j) => j.jobId)),
      (e) => console.error("parts-budget-analysis: getPartsCostForJobs failed:", e),
    );
    // All-or-nothing, like the card: a failed read must not turn every job into "$0, nothing bought".
    if (!byJob) return { state: "unavailable" };

    // Transfers: read once, then netted per job. A failed read leaves them un-netted, which the card says
    // outright; here it would change figures silently, so the whole analysis is withheld instead.
    const allTransfers = await withTimeoutOrNull(
      "TotalETO transfers",
      BUDGET_MS,
      () => loadAllTransfers(null),
      (e) => console.error("parts-budget-analysis: loadTransfers failed:", e),
    );
    if (!allTransfers) return { state: "unavailable" };

    // Each job's own ETC month (its latest row, any section: the card's rule for a single job), then the
    // two reads that depend on a month, once per distinct month.
    const latest = await prisma.etcEntry.groupBy({
      by: ["jobId"],
      where: { jobId: { in: jobs.map((j) => j.id) } },
      _max: { month: true },
    });
    const monthOf = new Map(latest.map((l) => [l.jobId, l._max.month ?? null]));
    const pksByMonth = new Map<string, number[]>();
    for (const j of jobs) {
      const m = monthOf.get(j.id);
      if (!m) continue;
      pksByMonth.set(m, [...(pksByMonth.get(m) ?? []), j.id]);
    }
    const priorByMonth = new Map<string, Map<number, PriorEtcResolution> | null>();
    const ltpByMonth = new Map<string, Map<number, number | null>>();
    for (const [m, pks] of pksByMonth) {
      priorByMonth.set(m, await readPriorEtcByJob(pks, m).catch(() => null));
      ltpByMonth.set(m, await readLeftToPurchaseLastMonth(pks, m).catch(() => new Map<number, number | null>()));
    }

    const rows: PartsBudgetRow[] = [];
    let notStarted = 0;
    for (const j of jobs) {
      const month = monthOf.get(j.id) ?? null;
      const lines = byJob.get(j.jobId) ?? [];
      const f = assemblePartsCostFinancials({
        jobs: [j],
        byJob,
        failedJobs: 0,
        transfers: summarizeTransfersForJobs(allTransfers, [j.jobId]),
        transfersUnavailable: false,
        etcMonth: month,
        priorByJob: month ? (priorByMonth.get(month) ?? null) : new Map<number, PriorEtcResolution>(),
        ltpLastMonth: month ? (ltpByMonth.get(month) ?? new Map<number, number | null>()) : new Map<number, number | null>(),
        leftToInvoice: leftToInvoiceForLines(lines),
      });

      // A closed job is shown at its final actual, as the card does (PartsCostSummary: completedMode).
      const final = f.completedActual != null;
      if (!final && f.totalSpent === 0 && f.projection === 0) {
        notStarted++;
        continue;
      }
      const projected = final ? (f.completedActual as number) : f.projection;
      const budget = f.budget;
      rows.push({
        id: j.id,
        jobId: j.jobId,
        jobName: j.jobName,
        customer: j.customer,
        type: j.type,
        status: j.status,
        // Date-only values, the way the Projects tab shows them.
        start: j.startDate ? j.startDate.toISOString().slice(0, 10) : null,
        end: j.completeDate ? j.completeDate.toISOString().slice(0, 10) : null,
        budget,
        projected,
        delta: budget != null ? projected - budget : null,
        pct: budget != null && budget !== 0 ? roundPct(((projected - budget) / budget) * 100) : null,
        purchased: final ? null : f.purchased,
        stillToPurchase: final ? 0 : f.stillToPurchase,
        excess: final ? 0 : f.excessPurchased,
        basis: final ? "final" : f.stpJobsFromForecast > 0 ? "estimate" : "live",
      });
    }
    return { state: "ok", rows, notStarted, asOf: new Date().toISOString() };
  } catch (e) {
    console.error("[parts-budget-analysis] failed:", e);
    return { state: "unavailable" };
  }
}
