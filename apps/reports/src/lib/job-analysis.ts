import "server-only";
import { prisma } from "@/lib/prisma";
import { ACTIVE_JOB_WHERE, compareJobIds } from "@/lib/job-filters";
import { readPartsEtcBreakout } from "@/lib/parts-etc-breakout";
import { getPartsCostBookedByJob } from "@/lib/sync-totaleto";
import { monthWindowUtc } from "@/lib/etc";
import { previousMonth } from "@/lib/left-to-invoice";
import { withTimeoutOrNull, UPSTREAM_BUDGET_MS } from "@/lib/with-timeout";

// ── Job Details → Analysis ───────────────────────────────────────────────────
//
// One row per ACTIVE job on the Job Details page (same universe as its picker's
// "Active" group: status Active + a valid job type), with two figures that are
// always for the SAME month — the month before the one we are in:
//
//   Left to Invoice   the Parts List's PM figure: the list rewound to that month's end
//                     (readPartsEtcBreakout → explainLeftToInvoice, asOfPosting). Signed,
//                     i.e. the raw sum the Parts List footer shows, not Monthly ETC's
//                     floored-at-0 cell. SDC-supplied lines are left out, as in the list.
//   Money Spent Month the Parts List's Invoiced $ footer with the Invoiced date range
//                     set to the 1st–last of that month (getPartsCostBookedByJob — the
//                     same AP-document query and SDC exclusion the windowed list uses).
//
// Both are read for exactly the job numbers listed, so a job that is not on the Job
// Details page can never appear, and a job that is cannot be missing.

export type JobAnalysisRow = {
  jobId: string;
  jobName: string;
  /** Null = Total ETO could not be read for this figure ("—"), never a silent $0. */
  leftToInvoice: number | null;
  moneySpent: number | null;
};

export type JobAnalysis = {
  month: string; // YYYY-MM
  rows: JobAnalysisRow[];
  leftToInvoiceFailed: boolean;
  moneySpentFailed: boolean;
};

export async function getJobAnalysis(today: Date = new Date()): Promise<JobAnalysis> {
  const month = previousMonth(today);
  const jobs = await prisma.job.findMany({
    // TEMPORARY: these have no Parts Cost row in Monthly ETC, so they are left out
    // until the two views are reconciled.
    where: { ...ACTIVE_JOB_WHERE, jobId: { notIn: ["1083", "1155", "2025", "2026"] } },
    select: { id: true, jobId: true, jobName: true },
  });
  // Numeric order from 1101 upward; anything below 1101 (or non-numeric) follows at the end.
  const FIRST_JOB = 1101;
  const rank = (id: string) => (/^\d+$/.test(id) && Number(id) >= FIRST_JOB ? 0 : 1);
  jobs.sort((a, b) => rank(a.jobId) - rank(b.jobId) || compareJobIds(a.jobId, b.jobId));

  const { start, endExclusive } = monthWindowUtc(month);
  const [breakout, booked] = await Promise.all([
    readPartsEtcBreakout(jobs.map((j) => ({ pk: j.id, jobNumber: j.jobId })), month),
    withTimeoutOrNull(
      `TotalETO money spent ${month} (Job Details analysis)`,
      UPSTREAM_BUDGET_MS,
      () => getPartsCostBookedByJob(start, endExclusive),
      (e) => console.error("[job-analysis] getPartsCostBookedByJob failed:", e),
    ),
  ]);

  const round2 = (n: number) => Math.round(n * 100) / 100;
  const rows: JobAnalysisRow[] = jobs.map((j) => {
    const lti = breakout.byJobPk.get(j.id)?.rawLeftToInvoice ?? null;
    return {
      jobId: j.jobId,
      jobName: j.jobName,
      leftToInvoice: breakout.linesFailed || lti === null ? null : round2(lti),
      // A job with no AP lines in the month is absent from the map: that is $0 spent,
      // a real answer, but only when the query itself succeeded.
      moneySpent: booked ? round2(booked.net.get(String(Number(j.jobId))) ?? booked.net.get(j.jobId) ?? 0) : null,
    };
  });

  return { month, rows, leftToInvoiceFailed: breakout.linesFailed, moneySpentFailed: booked === null };
}
