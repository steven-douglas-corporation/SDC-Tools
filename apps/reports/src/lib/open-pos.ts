import "server-only";
import { prisma } from "@/lib/prisma";
import { getPartsCostForJobs } from "@/lib/sync-totaleto";
import { DEFAULT_VISIBLE_STATUSES, validJobTypeFilter } from "@/lib/job-filters";
import { devFakeEtoEnabled, fakeSampleJobs } from "@/lib/dev-fake-eto";
import { withTimeoutOrNull } from "@/lib/with-timeout";
import { buildOpenPos, type OpenPosResult } from "@/lib/open-pos-rules";

// Server half of Open POs. The rules live in open-pos-rules.ts (no server imports, so
// tests call them directly); this file only decides WHICH jobs and fetches their lines.
//
// Jobs: Active and HeadStart, valid job types: the Projects grid's default population.
// HeadStart is in on purpose: procurement buys for a job before it is fully Active, and
// those POs are exactly the commitments this page exists to show.
//
// One batched Total ETO round trip (getPartsCostForJobs), the same call T&M and the
// Parts Cost card make for every job. A failed read is reported as a failure, never as
// an empty list: "no open POs" and "could not reach Total ETO" must not look alike.

const BUDGET_MS = 120_000;

export type OpenPosLoad = { ok: true; data: OpenPosResult } | { ok: false; error: string };

/** Today as a local `YYYY-MM-DD`, the format every parts-path comparison uses. */
function todayYmd(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export async function loadOpenPos(): Promise<OpenPosLoad> {
  const jobs: { jobId: string; jobName: string; status: string }[] = await prisma.job.findMany({
    where: { status: { in: [...DEFAULT_VISIBLE_STATUSES] }, ...validJobTypeFilter },
    select: { jobId: true, jobName: true, status: true },
  });
  // Local development only (SDC_DEV_FAKE_ETO=1, never set in production): generated sample
  // jobs on top of the seeded few, so the page can be seen with a long list. See
  // dev-fake-eto.ts for why they are added here and not seeded into the database.
  if (devFakeEtoEnabled()) {
    const have = new Set(jobs.map((j) => j.jobId));
    jobs.push(...fakeSampleJobs().filter((j) => !have.has(j.jobId)));
  }
  if (jobs.length === 0) return { ok: true, data: buildOpenPos(new Map(), [], todayYmd()) };

  const byJob = await withTimeoutOrNull(
    `TotalETO parts for Open POs (${jobs.length} jobs)`,
    BUDGET_MS,
    () => getPartsCostForJobs(jobs.map((j) => j.jobId)),
    (e) => console.error("loadOpenPos: getPartsCostForJobs failed:", e),
  );
  if (!byJob) return { ok: false, error: "Could not read purchase orders from Total ETO. Try again in a minute." };

  // Keyed by Job.jobId ("1118"), the same lookup getPartsCostFinancials and T&M use.
  return { ok: true, data: buildOpenPos(byJob, jobs, todayYmd()) };
}
