import "server-only";
import { prisma } from "@/lib/prisma";
import { ACTIVE_JOB_WHERE, compareJobIds } from "@/lib/job-filters";
import { getPartsCostForJobs, loadAllTransfers } from "@/lib/sync-totaleto";
import { summarizeTransfersForJobs } from "@/lib/parts-transfer-netting";
import { readPriorEtcByJob, type PriorEtcResolution } from "@/lib/parts-prior-etc";
import { readLeftToPurchaseLastMonth } from "@/lib/parts-left-to-purchase";
import { assemblePartsCostFinancials } from "@/lib/parts-cost-financials";
import { leftToInvoiceForLines } from "@/lib/left-to-invoice";
import { withTimeoutOrNull } from "@/lib/with-timeout";

// Job Details → "Analysis": every ACTIVE job's Left to Invoice and Money Spent Month, side by side.
//
// Pulled ONLY from what the Job Details tab itself shows. Each job is assembled by the same
// function the page's Parts Cost card uses (assemblePartsCostFinancials), from the same inputs the
// card reads, so a job reads here exactly as it does on its own card and drill-through:
//   Left to Invoice    = financials.leftToInvoice      (the card's Left to Invoice)
//   Money Spent Month  = financials.partsSpentThisMonth (the drill-through's Money Spent Month)
// Each job's month is the card's rule for a single job — its latest Monthly ETC month — so in
// November, before November's ETC is started, that is October. The selection of jobs on the page
// does not affect this: it always covers every active job. Same loading pattern as
// parts-budget-analysis.ts (one Total ETO round trip for all jobs, then one assembly per job).

export type EtcAnalysisRow = {
  jobId: string;
  jobName: string;
  /** The ETC month this job's figures describe (its latest). Null when it has no ETC month. */
  month: string | null;
  leftToInvoice: number;
  moneySpent: number;
};

export type EtcAnalysisData = { rows: EtcAnalysisRow[]; unavailable: boolean };

const BUDGET_MS = 120_000;

export async function getEtcAnalysis(): Promise<EtcAnalysisData> {
  const jobs = await prisma.job.findMany({
    where: ACTIVE_JOB_WHERE,
    select: { id: true, jobId: true, jobName: true, costQuoted: true, costActualHistorical: true, status: true },
  });
  if (jobs.length === 0) return { rows: [], unavailable: false };
  jobs.sort((a, b) => compareJobIds(a.jobId, b.jobId));

  const byJob = await withTimeoutOrNull(
    `TotalETO parts (${jobs.length} jobs)`,
    BUDGET_MS,
    () => getPartsCostForJobs(jobs.map((j) => j.jobId)),
    (e) => console.error("etc-analysis: getPartsCostForJobs failed:", e),
  );
  // All-or-nothing, like the card: a failed read must not turn every job into "$0".
  if (!byJob) return { rows: [], unavailable: true };
  const allTransfers = await withTimeoutOrNull("TotalETO transfers", BUDGET_MS, () => loadAllTransfers(null), (e) =>
    console.error("etc-analysis: loadAllTransfers failed:", e),
  );
  if (!allTransfers) return { rows: [], unavailable: true };

  const latest = await prisma.etcEntry.groupBy({ by: ["jobId"], where: { jobId: { in: jobs.map((j) => j.id) } }, _max: { month: true } });
  const monthOf = new Map(latest.map((l) => [l.jobId, l._max.month ?? null]));
  const pksByMonth = new Map<string, number[]>();
  for (const j of jobs) {
    const m = monthOf.get(j.id);
    if (m) pksByMonth.set(m, [...(pksByMonth.get(m) ?? []), j.id]);
  }
  const priorByMonth = new Map<string, Map<number, PriorEtcResolution> | null>();
  const ltpByMonth = new Map<string, Map<number, number | null>>();
  for (const [m, pks] of pksByMonth) {
    priorByMonth.set(m, await readPriorEtcByJob(pks, m).catch(() => null));
    ltpByMonth.set(m, await readLeftToPurchaseLastMonth(pks, m).catch(() => new Map<number, number | null>()));
  }

  const rows: EtcAnalysisRow[] = jobs.map((j) => {
    const month = monthOf.get(j.id) ?? null;
    const f = assemblePartsCostFinancials({
      jobs: [j],
      byJob,
      failedJobs: 0,
      transfers: summarizeTransfersForJobs(allTransfers, [j.jobId]),
      transfersUnavailable: false,
      etcMonth: month,
      priorByJob: month ? (priorByMonth.get(month) ?? null) : new Map<number, PriorEtcResolution>(),
      ltpLastMonth: month ? (ltpByMonth.get(month) ?? new Map<number, number | null>()) : new Map<number, number | null>(),
      leftToInvoice: leftToInvoiceForLines(byJob.get(j.jobId) ?? []),
    });
    return { jobId: j.jobId, jobName: j.jobName, month, leftToInvoice: f.leftToInvoice, moneySpent: f.partsSpentThisMonth };
  });
  return { rows, unavailable: false };
}
