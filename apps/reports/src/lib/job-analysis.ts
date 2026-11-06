import "server-only";
import { prisma } from "@/lib/prisma";
import { compareJobIds, etcActiveJobFilter } from "@/lib/job-filters";
import { getPartsMonthFigures } from "@/lib/parts-month-figures";
import { previousMonth } from "@/lib/left-to-invoice";

// ── Job Details → Analysis ───────────────────────────────────────────────────
//
// One row per job on Monthly ETC's live grid (`etcActiveJobFilter`: Active, billable, a
// valid job type, not completed), with two figures that are always for the SAME month —
// the month before the one we are in. Same job list as Monthly ETC on purpose: SDC's
// own internal jobs are non-billable, have no Parts Cost row there, and would otherwise
// make the two totals differ by exactly their spend.
//
// The figures themselves come from lib/parts-month-figures.ts — the one source Monthly
// ETC reads too — so there is no second formula to drift. lib/parts-parity.ts checks
// them against the Job Details Parts List, which is built independently.

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
    where: { ...etcActiveJobFilter },
    select: { id: true, jobId: true, jobName: true },
  });
  // Numeric order from 1101 upward; anything below 1101 (or non-numeric) follows at the end.
  const FIRST_JOB = 1101;
  const rank = (id: string) => (/^\d+$/.test(id) && Number(id) >= FIRST_JOB ? 0 : 1);
  jobs.sort((a, b) => rank(a.jobId) - rank(b.jobId) || compareJobIds(a.jobId, b.jobId));

  const figures = await getPartsMonthFigures(
    jobs.map((j) => ({ pk: j.id, jobNumber: j.jobId })),
    month,
  );

  const rows: JobAnalysisRow[] = jobs.map((j) => {
    const f = figures.byJobPk.get(j.id);
    return { jobId: j.jobId, jobName: j.jobName, leftToInvoice: f?.leftToInvoice ?? null, moneySpent: f?.moneySpent ?? null };
  });

  return { month, rows, leftToInvoiceFailed: figures.leftToInvoiceFailed, moneySpentFailed: figures.moneySpentFailed };
}
