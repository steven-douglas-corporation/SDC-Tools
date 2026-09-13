import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getExecutionEtcByJob } from "@/lib/execution-etc";
import { validJobTypeFilter } from "@/lib/job-filters";
import { checkSchedulerToken } from "@/lib/scheduler-api-auth";

// Read-only job detail for the SDC_Scheduler "create project from job list"
// flow. When the scheduler opens a job it pulls, in one call:
//   - release/delivery estimates  (poStartDate / startDate / completeDate)
//   - billable vs non-billable    (Job.billable)
//   - actuals vs execution        (TotalETO actual hours + execution ETC)
//
// Server-to-server; guarded by SCHEDULER_SHARED_TOKEN (NOT the browser NextAuth
// session — see proxy.ts, which exempts /api/integration). Never writes. The
// execution-ETC rollup is scoped to the latest ETC month (the same "current
// month" the ETC grid renders), so the scheduler always sees the live figure
// without having to know how the ETC app computes it.
function toDate(d: Date | null | undefined): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

function toNum(d: unknown): number | null {
  if (d === null || d === undefined) return null;
  const n = Number(d);
  return Number.isFinite(n) ? n : null;
}

export async function GET(
  req: NextRequest,
  ctx: RouteContext<"/api/integration/jobs/[jobId]">,
) {
  const denied = checkSchedulerToken(req);
  if (denied) return denied;

  const { jobId } = await ctx.params;

  // Type-gate like the list endpoint / export do: a "noise" job (null/invalid
  // Type) that never appears in any list must not be served in full detail
  // (costs, hours, execution ETC) to the Scheduler just because its id is known.
  const job = await prisma.job.findFirst({ where: { jobId, ...validJobTypeFilter } });
  if (!job) return Response.json({ error: "job_not_found" }, { status: 404 });

  // Per-category QUOTED hours for the scheduler's Project Release budget grid.
  // Keyed by section code (e.g. "10-211" ME General). Same job.id gotcha as
  // below: EstimatedHours.jobId is the internal Job.id PK, not the "1079" string.
  const estRows = await prisma.estimatedHours.findMany({
    where: { jobId: job.id },
    select: { section: true, quotedHours: true },
  });
  const quotedHoursBySection: Record<string, number> = {};
  for (const r of estRows) {
    const n = Number(r.quotedHours);
    if (Number.isFinite(n)) quotedHoursBySection[r.section] = n;
  }

  // Execution ETC for the current (latest) ETC month, matching the grid.
  // NOTE: EtcEntry.jobId is the internal Job.id (autoincrement PK), NOT the
  // "1079"-style Job.jobId string — so the rollup is keyed on job.id here.
  let executionEtc = { engineering: 0, shop: 0, parts: 0 };
  let executionMonth: string | null = null;
  const latest = await prisma.etcEntry.findFirst({
    orderBy: { month: "desc" },
    select: { month: true },
  });
  if (latest?.month) {
    const map = await getExecutionEtcByJob([job.id], latest.month);
    executionEtc = map.get(job.id) ?? executionEtc;
    executionMonth = latest.month;
  }

  return Response.json({
    jobId: job.jobId,
    jobName: job.jobName,
    status: job.status,
    customer: job.customer,
    type: job.type,
    billable: job.billable,
    // "release / delivery" estimated dates
    poStartDate: toDate(job.poStartDate),
    startDate: toDate(job.startDate),
    completeDate: toDate(job.completeDate),
    // actuals vs execution
    hours: {
      estEng: toNum(job.totEtoEstEngHours),
      actEng: toNum(job.totEtoActEngHours),
      estMfg: toNum(job.totEtoEstMfgHours),
      actMfg: toNum(job.totEtoActMfgHours),
    },
    costQuoted: toNum(job.costQuoted),
    costActualHistorical: toNum(job.costActualHistorical),
    quotedHoursBySection,
    executionEtc,
    executionMonth,
    totEtoSyncedAt: job.totEtoSyncedAt ? job.totEtoSyncedAt.toISOString() : null,
  });
}
