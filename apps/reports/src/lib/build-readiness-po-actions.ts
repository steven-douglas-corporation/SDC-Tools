"use server";

import { auth } from "@/lib/auth";
import { getJobBom } from "@/lib/job-bom";
import type { PoLineGroup } from "@/lib/job-bom";
import { getJobPartsCost } from "@/lib/sync-totaleto";
import { withTimeoutOrNull, UPSTREAM_BUDGET_MS } from "@/lib/with-timeout";
import { flattenBomParts, makePoGroup, findAuthoritativePo, NO_PO_KEY, type PoGroup } from "@/lib/po-detail";

// ── Build Readiness's Upcoming Unlocks → the shared PO detail drawer ─────────
//
// The Build Readiness snapshot (build-readiness-sync.ts) only stores
// jobId/poNumber/supplier per row — not the full BOM + purchase-line detail
// the drawer (PoDetailPanel.tsx's PoPanel, shared with Job Hour Details →
// Procurement) renders. This fetches that detail live, on click, the same way
// job-hours/page.tsx already fetches getJobBom + parts cost for its own
// Procurement drawer — two concurrent, time-boxed TotalETO calls rather than
// one page-load cost paid for every job in the snapshot up front.
export type PoDetailResult =
  | { ok: true; supplier: string; po: PoGroup; authoritative?: PoLineGroup }
  | { ok: false; reason: "unavailable" | "not-found" };

export async function loadPoDetailForJob(jobId: string, supplier: string | null, poNumber: string): Promise<PoDetailResult> {
  const session = await auth();
  if (!session?.user) throw new Error("Not signed in.");
  if (!jobId || typeof jobId !== "string") throw new Error(`Invalid job id "${jobId}".`);
  if (!poNumber || typeof poNumber !== "string") throw new Error(`Invalid PO number "${poNumber}".`);

  const [bom, partsCost] = await Promise.all([
    withTimeoutOrNull(`Build Readiness PO detail — BOM (job ${jobId})`, UPSTREAM_BUDGET_MS, () => getJobBom(jobId), (e) =>
      console.error(`loadPoDetailForJob: getJobBom failed for job ${jobId}:`, e),
    ),
    withTimeoutOrNull(`Build Readiness PO detail — parts (job ${jobId})`, UPSTREAM_BUDGET_MS, () => getJobPartsCost(jobId), (e) =>
      console.error(`loadPoDetailForJob: getJobPartsCost failed for job ${jobId}:`, e),
    ),
  ]);

  if (!bom) return { ok: false, reason: "unavailable" };

  const parts = flattenBomParts(bom, partsCost?.lines ?? []);
  const supKey = supplier ?? "Unknown supplier";
  const poParts = parts.filter((p) => (p.supplier ?? "Unknown supplier") === supKey && (p.poNumber ?? NO_PO_KEY) === poNumber);
  if (!poParts.length) return { ok: false, reason: "not-found" };

  const authoritative = findAuthoritativePo(bom.vendors, poNumber);
  return { ok: true, supplier: supKey, po: makePoGroup(poNumber, poParts), authoritative };
}
