import { prisma } from "@/lib/prisma";
import { getEtcMonthJobWhere } from "@/lib/etc-month-jobs";
import { readPartsEtcBreakout } from "@/lib/parts-etc-breakout";
import { resolveLeftToInvoice, previousMonth, monthEndLabel } from "@/lib/left-to-invoice";
import { showsPartsBreakout } from "@/lib/parts-breakout-scope";
import { round2 } from "@/lib/etc";
import { PARTS_COST_SECTION } from "@/lib/sections";

// Job Details → "Analysis": every active job's Left to Invoice and Money Spent Month for the
// PREVIOUS calendar month (in November: October), like the Procurement "PM" rewind.
//
// Nothing is computed separately from the Monthly ETC grid. Per job it is the same two reads the
// grid's Parts Cost block uses for that month: the Parts Cost entry's `hoursWorked` (Money Spent
// Month) and Left to Invoice through resolveLeftToInvoice at that month's cutoff. The job set is
// the grid's own universe for the month (getEtcMonthJobWhere), so the two screens list the same jobs.

export type EtcAnalysisRow = {
  jobId: string;
  jobName: string;
  /** null when Total ETO could not be reached for the job. */
  leftToInvoice: number | null;
  /** null when the job has no Parts Cost row for that month. */
  moneySpent: number | null;
};

export type EtcAnalysisData = {
  month: string;
  monthLabel: string;
  rangeLabel: string;
  cutoffLabel: string;
  hasLeftToInvoice: boolean;
  rows: EtcAnalysisRow[];
};

export async function getEtcAnalysis(today: Date = new Date()): Promise<EtcAnalysisData> {
  const month = previousMonth(today);
  const { where } = await getEtcMonthJobWhere(month);
  const jobs = await prisma.job.findMany({
    where,
    select: {
      id: true,
      jobId: true,
      jobName: true,
      etcEntries: { where: { month, section: PARTS_COST_SECTION }, select: { hoursWorked: true, leftToInvoice: true } },
    },
  });

  const hasLeftToInvoice = showsPartsBreakout(month);
  const breakout = hasLeftToInvoice
    ? await readPartsEtcBreakout(
        jobs.filter((j) => j.jobId).map((j) => ({ pk: j.id, jobNumber: j.jobId })),
        month,
      ).catch((e) => {
        console.error("[etc-analysis] parts breakout failed; Left to Invoice will read —:", e);
        return null;
      })
    : null;

  const rows: EtcAnalysisRow[] = jobs.map((job) => {
    const entry = job.etcEntries[0] ?? null;
    const b = breakout?.byJobPk.get(job.id) ?? null;
    const leftToInvoice = hasLeftToInvoice
      ? resolveLeftToInvoice({
          computed: b?.rawLeftToInvoice == null ? null : round2(b.rawLeftToInvoice),
          stored: entry?.leftToInvoice != null ? round2(Number(entry.leftToInvoice)) : null,
        }).value
      : null;
    return {
      jobId: job.jobId,
      jobName: job.jobName,
      leftToInvoice,
      moneySpent: entry ? Number(entry.hoursWorked) : null,
    };
  });
  rows.sort((a, b) => a.jobId.localeCompare(b.jobId, undefined, { numeric: true }));

  const monthName = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1).toLocaleString("en-US", { month: "long" });
  const cutoffLabel = monthEndLabel(month);
  return {
    month,
    monthLabel: `${monthName} ${month.slice(0, 4)}`,
    rangeLabel: `${monthName} 1 – ${cutoffLabel}`,
    cutoffLabel,
    hasLeftToInvoice,
    rows,
  };
}
