"use server";

import { auth } from "@/lib/auth";
import { getJobBom } from "@/lib/job-bom";
import { getJobPartsCost } from "@/lib/sync-totaleto";
import { withTimeoutOrNull, UPSTREAM_BUDGET_MS } from "@/lib/with-timeout";
import { flattenBomParts, type FlatPart } from "@/lib/po-detail";
import { findJobBomUnit } from "@/lib/build-readiness-tree";

// ── Build Readiness's assembly drilldowns → the live, named parts list ──────
//
// The stored snapshot's AssemblyDetail carries only counts (missingParts/
// onOrderParts/pastDueParts) and the bottleneck subset (limitingParts) — it
// never persisted a full per-part list, so "which parts, by name, are
// available/missing/on order" for one assembly isn't answerable from the
// snapshot alone. This fetches it live, the same two-call pattern
// build-readiness-po-actions.ts's loadPoDetailForJob already uses (getJobBom
// + getJobPartsCost, both time-boxed), then locates the SAME unit a stored
// AssemblyDetail.key refers to via build-readiness-tree.ts's findJobBomUnit
// (the one shared key algorithm — see that file's own header for why this
// can never independently drift from the snapshot's own keys) and returns
// just that unit's own parts, fully enriched (FlatPart.st.key already
// answers "available/missing/on-order" unambiguously — the same
// classification JobProcurement.tsx's own Parts List uses).
export type AssemblyPartsResult =
  | { ok: true; parts: FlatPart[] }
  | { ok: false; reason: "unavailable" | "not-found" };

// `assemblyKeys` (plural) — "What Can We Build Now" merges every BOM tree
// position sharing the same part number into ONE displayed row (a reused
// sub-assembly design can legitimately occur more than once in a job's
// BOM), so its drilldown needs every underlying position's parts, not just
// one. Fetched ONCE regardless of how many keys are passed — `getJobBom`/
// `getJobPartsCost` are the same live, 100+-second-in-the-worst-case
// TotalETO calls `loadPoDetailForJob` already budgets for, and re-running
// them per merged position would multiply that cost for no reason when one
// fetch already has every position in the same tree.
export async function loadAssemblyPartsForJob(jobId: string, assemblyKeys: string[]): Promise<AssemblyPartsResult> {
  const session = await auth();
  if (!session?.user) throw new Error("Not signed in.");
  if (!jobId || typeof jobId !== "string") throw new Error(`Invalid job id "${jobId}".`);
  if (!Array.isArray(assemblyKeys) || assemblyKeys.length === 0 || assemblyKeys.some((k) => !k || typeof k !== "string")) {
    throw new Error(`Invalid assembly keys "${JSON.stringify(assemblyKeys)}".`);
  }

  const [bom, partsCost] = await Promise.all([
    withTimeoutOrNull(`Build Readiness assembly detail — BOM (job ${jobId})`, UPSTREAM_BUDGET_MS, () => getJobBom(jobId), (e) =>
      console.error(`loadAssemblyPartsForJob: getJobBom failed for job ${jobId}:`, e),
    ),
    withTimeoutOrNull(`Build Readiness assembly detail — parts (job ${jobId})`, UPSTREAM_BUDGET_MS, () => getJobPartsCost(jobId), (e) =>
      console.error(`loadAssemblyPartsForJob: getJobPartsCost failed for job ${jobId}:`, e),
    ),
  ]);

  if (!bom) return { ok: false, reason: "unavailable" };

  const units = assemblyKeys.map((k) => findJobBomUnit(bom, k)).filter((u): u is NonNullable<typeof u> => u !== null);
  if (units.length === 0) return { ok: false, reason: "not-found" };

  const allParts = flattenBomParts(bom, partsCost?.lines ?? []);
  const ownIds = new Set(units.flatMap((u) => u.ownParts.map((p) => p.id)));
  const parts = allParts.filter((p) => ownIds.has(p.id));
  return { ok: true, parts };
}
