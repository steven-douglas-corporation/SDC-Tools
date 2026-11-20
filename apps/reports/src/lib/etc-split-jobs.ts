import { prisma } from "@/lib/prisma";
import { compareJobIds } from "@/lib/job-filters";
import { getEtcMonthJobWhere } from "@/lib/etc-month-jobs";
import { currentMonth } from "@/lib/etc";
import { PARTS_COST_SECTION } from "@/lib/sections";

// ── The jobs behind the Cash Flow "Left to Invoice Split" ────────────────────
//
// Reported 2026-11-20: the split totalled $2,436,651 (60 jobs) while the Monthly ETC Parts Cost
// Left to Invoice column totalled $2,353,431 (42 jobs). Every job on BOTH pages agreed to the
// dollar — the split had simply taken its job list from every project in Total ETO, while the
// Monthly ETC grid shows only the month's jobs.
//
// So the split now takes its jobs from the same place the grid does: `getEtcMonthJobWhere` (the
// single source of "which jobs are in this ETC month", shared with the Standard Sheet), narrowed
// to the jobs that have a Parts Cost row — the rows that carry the Left to Invoice cell — and put
// in the grid's own order: numeric Job Id, with active T&M jobs sunk to the bottom.

export type EtcSplitJob = {
  pk: number;
  jobId: string;
  jobName: string;
  /** The manager's typed Left to Invoice on this month's Parts Cost row, or null = "use the computed figure". */
  override: number | null;
};

/**
 * The ETC month the split reads its job list from: the month picked with the cutoff picker, else the
 * month Monthly ETC itself opens on (its newest month with entries; this calendar month if none).
 */
export async function resolveSplitMonth(ltiMonth: string | null): Promise<string> {
  if (ltiMonth) return ltiMonth;
  const latest = await prisma.etcEntry.findFirst({ orderBy: { month: "desc" }, select: { month: true } });
  return latest?.month ?? currentMonth();
}

/** The month's jobs, exactly as the Monthly ETC grid lists and orders them. */
export async function getEtcSplitJobs(month: string): Promise<EtcSplitJob[]> {
  const { where } = await getEtcMonthJobWhere(month);
  const jobs = await prisma.job.findMany({
    where,
    select: {
      id: true,
      jobId: true,
      jobName: true,
      status: true,
      type: true,
      etcEntries: { where: { month, section: PARTS_COST_SECTION }, select: { leftToInvoice: true } },
    },
  });
  // Same two-step order as the grid (etc/page.tsx): Job Id numerically, then active T&M last.
  // Array#sort is stable, so the second pass only moves rows across the T&M boundary.
  const isActiveTm = (j: { status: string | null; type: string | null }) => j.status === "Active" && j.type === "T&M";
  jobs.sort((a, b) => compareJobIds(a.jobId, b.jobId));
  jobs.sort((a, b) => Number(isActiveTm(a)) - Number(isActiveTm(b)));
  return jobs
    .filter((j) => j.jobId && j.etcEntries.length > 0)
    .map((j) => ({
      pk: j.id,
      jobId: j.jobId,
      jobName: j.jobName ?? "",
      override: j.etcEntries[0].leftToInvoice != null ? Math.round(Number(j.etcEntries[0].leftToInvoice) * 100) / 100 : null,
    }));
}
