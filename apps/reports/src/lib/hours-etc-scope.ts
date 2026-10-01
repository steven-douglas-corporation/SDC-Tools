import "server-only";

import { prisma } from "@/lib/prisma";
import { getEtcMonthJobIds } from "@/lib/etc-month-jobs";
import { resolveWhere } from "@/lib/hours-explorer";
import { PARTS_COST_SECTION } from "@/lib/sections";
import type { HoursFilters } from "@/lib/hours-filters";
import { buildEtcScopeReport, etcScopeCaveats, monthBounds, scopeFilters, type EtcScopeReport } from "@/lib/hours-etc-scope-rules";

// The queries behind "Match Monthly ETC" — see lib/hours-etc-scope-rules.ts for the
// rule and why it is exact.

export type EtcScope = {
  month: string;
  /** The page's filters, narrowed to what Monthly ETC counts. Every query on the page reads these. */
  scoped: HoursFilters;
  report: EtcScopeReport;
  monthIsLocked: boolean;
  caveats: string[];
};

export async function resolveEtcScope(filters: HoursFilters, month: string): Promise<EtcScope> {
  const { ids, monthIsLocked } = await getEtcMonthJobIds(month);
  const gridJobs = await prisma.job.findMany({ where: { id: { in: [...ids] } }, select: { id: true, jobId: true } });
  const gridJobIds = new Set(gridJobs.map((j) => j.jobId));

  // Every punch the user's OTHER filters reach in the month — the starting point the
  // report accounts for, hour by hour. Jobs and codes are deliberately not narrowed yet:
  // what they would remove is exactly what the report has to itemise.
  const b = monthBounds(month);
  const monthOnly: HoursFilters = {
    ...filters,
    from: filters.from && filters.from > b.from ? filters.from : b.from,
    to: filters.to && filters.to < b.to ? filters.to : b.to,
    months: [month],
  };
  const groups = await prisma.jobHoursDetail.groupBy({
    by: ["jobId", "section"],
    where: await resolveWhere(monthOnly),
    _sum: { hours: true },
  });
  const jobs = await prisma.job.findMany({
    where: { id: { in: [...new Set(groups.map((g) => g.jobId))] } },
    select: { id: true, jobId: true, jobName: true },
  });
  const jobById = new Map(jobs.map((j) => [j.id, j]));

  // Monthly ETC's side: Hours Worked as stored, for the grid's jobs — narrowed to the
  // user's job selection when there is one, so picking a job compares that job.
  const etcJobPks = gridJobs.filter((j) => !filters.jobIds?.length || filters.jobIds.includes(j.jobId)).map((j) => j.id);
  const entries = await prisma.etcEntry.findMany({
    where: { month, jobId: { in: etcJobPks }, section: { not: PARTS_COST_SECTION } },
    select: { section: true, hoursWorked: true },
  });

  const report = buildEtcScopeReport({
    punches: groups.map((g) => {
      const j = jobById.get(g.jobId);
      return { jobId: j?.jobId ?? String(g.jobId), jobName: j?.jobName ?? "", section: g.section, hours: Number(g._sum.hours ?? 0) };
    }),
    gridJobIds,
    etcEntries: entries.map((e) => ({ section: e.section, hoursWorked: Number(e.hoursWorked) })),
  });

  return {
    month,
    scoped: scopeFilters(filters, month, [...gridJobIds], report.inScopeCodes),
    report,
    monthIsLocked,
    caveats: etcScopeCaveats(filters, month),
  };
}
