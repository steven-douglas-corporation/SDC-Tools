"use server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getJobBom } from "@/lib/job-bom";
import { getPartsCostForJobs } from "@/lib/sync-totaleto";
import { flattenBomParts } from "@/lib/po-detail";
import { bomUncoveredEstimate } from "@/lib/still-to-purchase";
import { withTimeoutOrNull } from "@/lib/with-timeout";

// ── The BOM cross-check for "Still to purchase" (2026-10-19) ─────────────────
//
// The Parts Cost card's "still to purchase" is the manager's forecast less what is already ordered.
// This reads what the BOM itself says is not yet ordered, so the two can be set side by side.
//
// Loaded ON DEMAND, when the explanation panel is opened, and never by the card: reading a job's BOM
// from Total ETO can take far longer than the card is allowed to (the job page's own notes record
// 100+ seconds on a bad day), and a cross-check must not hold up the figure it is checking. One job
// only — a BOM belongs to one job.
//
// Read-only. Returns null for anything it cannot answer (not signed in is an error; a slow or failed
// upstream read is simply "no cross-check"), so the panel can say nothing rather than something wrong.

const BOM_CHECK_BUDGET_MS = 90_000;

export type BomStillToBuy = { amount: number; parts: number };

export async function loadBomStillToBuy(jobPk: number): Promise<BomStillToBuy | null> {
  const session = await auth();
  if (!session?.user) throw new Error("Not signed in.");
  if (!Number.isSafeInteger(jobPk)) return null;

  const job = await prisma.job.findUnique({ where: { id: jobPk }, select: { jobId: true } });
  if (!job) return null;

  return withTimeoutOrNull(
    `BOM still-to-buy check (job ${job.jobId})`,
    BOM_CHECK_BUDGET_MS,
    async () => {
      const [bom, byJob] = await Promise.all([getJobBom(job.jobId), getPartsCostForJobs([job.jobId])]);
      const rows = flattenBomParts(bom, byJob.get(job.jobId) ?? [], null);
      return bomUncoveredEstimate(rows);
    },
    (e) => console.error(`loadBomStillToBuy failed for job ${job.jobId}:`, e),
  );
}
