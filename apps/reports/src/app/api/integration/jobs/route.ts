import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import type { NextRequest } from "next/server";
import { validJobTypeFilter, compareJobIds } from "@/lib/job-filters";
import { checkSchedulerToken } from "@/lib/scheduler-api-auth";

// Read-only job list for the SDC_Scheduler "create project from job list"
// picker. Server-to-server; guarded by SCHEDULER_SHARED_TOKEN (NOT the browser
// NextAuth session — see proxy.ts, which exempts /api/integration). Never
// writes.
//
// Mirrors the same job universe as /api/jobs/export (validJobTypeFilter +
// numeric Job Id sort) so the picker shows exactly the jobs the ETC app itself
// considers real.
export async function GET(req: NextRequest) {
  const denied = checkSchedulerToken(req);
  if (denied) return denied;

  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q") ?? undefined;
  const status = searchParams.get("status") ?? undefined;

  const where: Prisma.JobWhereInput = { ...validJobTypeFilter };
  if (q) where.OR = [{ jobName: { contains: q } }, { jobId: { contains: q } }];
  if (status) where.status = status;

  const jobs = await prisma.job.findMany({
    where,
    select: {
      jobId: true,
      jobName: true,
      status: true,
      customer: true,
      type: true,
      billable: true,
    },
  });
  jobs.sort((a, b) => compareJobIds(a.jobId, b.jobId));

  return Response.json({ jobs });
}
