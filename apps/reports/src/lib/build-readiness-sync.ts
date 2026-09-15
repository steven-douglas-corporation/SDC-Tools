import "server-only";

// ── Build Readiness — live cross-job refresh + classification ───────────────
//
// This is NOT a second readiness formula. Every coverage/cost/release-status
// decision below reads a field job-bom-rules.ts's `makePart()` already
// computed (`.status`, `.source`, `.hold`, `.unitPrice`, `.costBasis`,
// `.release`) or calls one of its exported pure functions directly
// (`isUncoveredPart`, `buildableQtyFor`) — this file only WALKS the tree
// `getJobBom()` already built and classified, and persists the result. See
// job-bom-rules.ts's own header for why "no PO" isn't "missing", the BOM
// release-status rules, and the cost fallback chain.
//
// Performance context (why this is a throttled background pass, not something
// a page request can await): `getJobBom(jobId)` is a live call straight to
// TotalETO and is genuinely slow — 100+ seconds per job, measured (see
// with-timeout.ts's own header). There is no bulk variant. Across every active
// billable job that is minutes of work, so this runs in small concurrent
// batches (not all at once — dozens of simultaneous mssql connections against
// a shared production SQL Server is its own risk) and persists each job's
// result the moment it completes, so BuildReadinessRefreshMeta.jobsDone climbs
// continuously and the dashboard can render progressively instead of waiting
// for the whole pass.

import { prisma } from "@/lib/prisma";
import { getJobBomResult, BOM_QUERY_CONCURRENCY, BOM_QUERY_COUNT, type JobBom, type JobBomResult } from "@/lib/job-bom";
import { TOTALETO_TIMEOUT, POOL_MAX, runWithTotalEtoAbort } from "@/lib/totaleto-connection";
import {
  type BomNode,
  type BomPart,
  isUncoveredPart,
  buildableQtyFor,
  quantityReadiness,
} from "@/lib/job-bom-rules";
import { flattenBomParts } from "@/lib/po-detail";
import { walkJobBomUnits } from "@/lib/build-readiness-tree";
import { etcActiveJobFilter } from "@/lib/job-filters";
import type { BlockerEntry, BlockerReason, AssemblyDetail, JobDetail, UpcomingDeliveryEntry } from "@/lib/build-readiness-types";

const DAY = 86_400_000;

// ── Jobs processed at once, sized against the Total ETO pool (2026-09-14) ───
//
// Was 6, on the belief that a job was one connection. It was six: the BOM walk
// fired its six queries in parallel, so six workers were 36 acquires against a
// pool of 5 — the queue behind it timed out, was classified pool_exhausted,
// retried three times each (queuing six more), and the walk finally returned an
// EMPTY bom that this file wrote as "No BOM" for jobs that have one. Confirmed
// live before the fix: job 1142 (151 parts on Procurement) came back empty under
// 6-way load.
//
// The invariant now is arithmetic, and pinned by tests/build-readiness-sync.test.ts:
// workers x queries-in-flight-per-job <= the pool's max. job-bom.ts runs
// BOM_QUERY_CONCURRENCY statements at a time, so 4 x 2 = 8 connections at peak,
// leaving 2 of the 120s pool's 10 for a page render or a PO drill-down that lands
// while a pass is running.
export const CONCURRENCY = 4;

// Not the 12s UPSTREAM_BUDGET_MS used for page-render bounding elsewhere
// (with-timeout.ts) — that budget would time out literally every job here, since
// a single BOM walk can take 100+ seconds. A job now runs its six statements in
// BOM_QUERY_CONCURRENCY-wide rounds, each bounded by mssql's own requestTimeout
// (TOTALETO_TIMEOUT.bom), so the honest per-job ceiling is rounds x that timeout
// plus a margin. When it fires, the walk is ABORTED (runWithTotalEtoAbort), not
// merely abandoned: an orphaned walk would keep the very connections the next
// job is waiting for.
const BOM_QUERY_ROUNDS = Math.ceil(BOM_QUERY_COUNT / BOM_QUERY_CONCURRENCY);
export const PER_JOB_TIMEOUT_MS = BOM_QUERY_ROUNDS * TOTALETO_TIMEOUT.bom + 10_000;

/** The pool the BOM walk draws on, for the invariant test: workers x fan-out must fit in it. */
export const BOM_POOL_MAX = POOL_MAX;

async function withJobTimeout<T>(label: string, ms: number, work: () => Promise<T>): Promise<T | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      runWithTotalEtoAbort(controller.signal, work),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const err = new Error(`${label} did not respond within ${ms}ms`);
          controller.abort(err);
          reject(err);
        }, ms);
      }),
    ]);
  } catch (err) {
    console.error(`[build-readiness] ${label} failed:`, err);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Failed is not empty (2026-09-14) ─────────────────────────────────────────
//
// getJobBom() is fail-soft by contract — a query error yields an empty JobBom —
// which is right for a page render and wrong here, where the answer is persisted
// for everyone: "failed" is only reachable when the read returned null, and
// getJobBom never returns null, so every Total ETO fault during a pass was stored
// as "empty" ("No BOM"). getJobBomResult carries the distinction, and this file
// now writes what actually happened. The one retry after a short backoff is kept
// for FAILURES only: a BOM that genuinely came back empty is not going to grow a
// second time, and asking again only spends pool time the next job needs.
async function getJobBomWithRetry(jobId: string): Promise<JobBomResult | null> {
  const first = await withJobTimeout(`Build Readiness (job ${jobId})`, PER_JOB_TIMEOUT_MS, () => getJobBomResult(jobId));
  if (first?.ok) return first;
  await sleep(2000);
  const retry = await withJobTimeout(`Build Readiness (job ${jobId}, retry)`, PER_JOB_TIMEOUT_MS, () => getJobBomResult(jobId));
  return retry?.ok ? retry : (retry ?? first);
}

/**
 * What a job's read means for its snapshot row. Pure, so the failed/empty split
 * is testable without a database: `failed` for a read that did not happen or
 * did not succeed (timed out, threw, Total ETO fault), `empty` for a read that
 * succeeded and found no BOM rows, `hasBom` otherwise (classify it).
 */
export function snapshotStatusFor(result: JobBomResult | null): "failed" | "empty" | "hasBom" {
  if (!result || !result.ok) return "failed";
  return result.bom.roots.length === 0 ? "empty" : "hasBom";
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

// ── Per-part blocker classification ──────────────────────────────────────────
//
// One reason per part (first match wins), so the Top Blockers breakdown is a
// clean partition rather than double-counted buckets. Every input here is a
// field job-bom-rules.ts's makePart() already computed — no coverage rule is
// re-derived.
function blockerReasonFor(p: BomPart, now: number): BlockerReason | null {
  if (p.status === "received") return null;
  if (p.hold) return "on_hold";
  if (isUncoveredPart(p)) return "no_po";
  const due = p.expectedDate || p.requiredDate;
  const dueMs = due ? new Date(due).getTime() : NaN;
  const isLate = Number.isFinite(dueMs) && dueMs < now;
  if (p.source === "stock" && p.receivedQty < p.qty) return "inventory_shortage";
  if (p.source === "po" && p.status === "ordered" && isLate) return "supplier_delay";
  if (isLate) return "past_due";
  if (!due) return "missing_expected_date";
  return null;
}

function partMaterialValue(p: BomPart): number {
  return p.unitPrice * p.qty;
}

// One assembly node's full detail row, plus the blocker/upcoming entries its
// own direct parts (and its own `self` line) contribute. Does NOT recurse
// into children — each child produces its own row via its own call.
// `key`/`ownParts` come from build-readiness-tree.ts's `walkJobBomUnits` —
// the one place that walk + key-assignment happens now.
function classifyNode(
  node: BomNode,
  key: string,
  ownParts: BomPart[],
  jobId: string,
  jobName: string,
  now: number,
): { detail: AssemblyDetail; blockers: BlockerEntry[]; upcoming: { part: BomPart; assemblyLabel: string }[]; blockedPartIds: Set<number> } {
  const blockers: BlockerEntry[] = [];
  const upcoming: { part: BomPart; assemblyLabel: string }[] = [];
  const blockedPartIds = new Set<number>();

  let missingParts = 0;
  let onOrderParts = 0;
  let pastDueParts = 0;
  let nextExpectedDelivery: string | null = null;

  for (const p of ownParts) {
    const reason = blockerReasonFor(p, now);
    if (reason) {
      blockedPartIds.add(p.id);
      blockers.push({
        reason,
        jobId,
        jobName,
        assemblyKey: key,
        assemblyLabel: node.label,
        partPn: p.pn,
        partDesc: p.desc,
        supplier: p.supplier,
        poNumber: p.poId ?? null,
        materialValue: partMaterialValue(p),
        daysLate: p.expectedDate ? Math.max(0, Math.round((now - new Date(p.expectedDate).getTime()) / DAY)) : null,
        expectedDate: p.expectedDate,
      });
      if (reason === "no_po") missingParts++;
      if (reason === "supplier_delay" || reason === "past_due") pastDueParts++;
    }
    if (p.status === "ordered") onOrderParts++;
    if (p.status !== "received" && p.expectedDate) {
      if (!nextExpectedDelivery || p.expectedDate < nextExpectedDelivery) nextExpectedDelivery = p.expectedDate;
      upcoming.push({ part: p, assemblyLabel: node.label });
    }

    // Best-effort "awaiting release" overlay — an assembly that IS itself a
    // buy/build unit (Assembly Only / Both) but whose own line is uncovered
    // or held. This is deliberately an OVERLAY (the part above already got
    // its natural reason) rather than a replacement: there is no first-class
    // "awaiting release" signal in Total ETO today, so this is the closest
    // honest approximation, not a fabricated rule.
    if (p === node.self && node.release !== "contentsOnly" && (reason === "no_po" || reason === "on_hold")) {
      blockers.push({
        reason: "awaiting_release",
        jobId,
        jobName,
        assemblyKey: key,
        assemblyLabel: node.label,
        partPn: p.pn,
        partDesc: p.desc,
        supplier: p.supplier,
        poNumber: p.poId ?? null,
        materialValue: 0, // already counted once under its natural reason above
        daysLate: null,
        expectedDate: p.expectedDate,
      });
    }
  }

  const buildable = buildableQtyFor(node);
  // For a real buy/build unit (node.self set) these are UNIT quantities. For a
  // "Contents Only" container or the loose-parts bucket (no self line — there
  // is no single "unit" to count), they fall back to a part-LINE count at the
  // same granularity as node.stats.pct, so readinessPct and required/covered
  // never imply two different units of measure for the same row.
  const requiredQty = node.self?.qty ?? ownParts.length;
  const coveredQty = node.self ? node.self.receivedQty : ownParts.filter((p) => p.status === "received").length;

  let estimatedBuildableDate: string | null = null;
  if (buildable && buildable.buildableQty < requiredQty && buildable.limitingParts.length > 0) {
    const byPn = new Map(node.parts.map((p) => [p.pn, p]));
    const dates = buildable.limitingParts.map((lp) => byPn.get(lp.pn)?.expectedDate ?? null);
    estimatedBuildableDate = dates.every((d) => d != null) ? dates.reduce((a, b) => (a! > b! ? a : b))! : null;
  }

  const detail: AssemblyDetail = {
    key,
    pn: node.pn,
    label: node.label,
    release: node.release,
    requiredQty,
    coveredQty,
    readinessPct: node.stats.pct,
    buildableQty: buildable?.buildableQty ?? null,
    buildablePct: buildable?.buildablePct ?? null,
    limitingParts: buildable?.limitingParts ?? [],
    missingParts,
    onOrderParts,
    pastDueParts,
    materialValue: node.self ? node.self.unitPrice * node.self.qty + node.parts.reduce((s, p) => s + partMaterialValue(p), 0) : node.parts.reduce((s, p) => s + partMaterialValue(p), 0),
    nextExpectedDelivery,
    estimatedBuildableDate,
  };

  return { detail, blockers, upcoming, blockedPartIds };
}

// Walks a whole job's BOM tree (every section -> every nested assembly, plus
// each section's own loose-parts bucket as a synthetic row) into the flat
// JobDetail shape this dashboard persists and reads. Section container nodes
// themselves are skipped (they're not a buildable unit), but everything under
// them is visited.
export function classifyJobBom(bom: JobBom, jobId: string, jobName: string, now: number): {
  detail: JobDetail;
  overallReadinessPct: number;
  requiredQtyTotal: number;
  coveredQtyTotal: number;
  assembliesTotal: number;
  assembliesReady: number;
  assembliesPartial: number;
  assembliesBlocked: number;
  partsUncovered: number;
  partsOnOrder: number;
  partsPastDue: number;
  partsDueSoon7d: number;
  materialValueTotal: number;
  materialValueAtRisk: number;
  nextUnlockDate: string | null;
} {
  const assemblies: AssemblyDetail[] = [];
  const blockers: BlockerEntry[] = [];
  const upcomingSource: { part: BomPart; assemblyLabel: string; assemblyKey: string }[] = [];
  const blockedPartIds = new Set<number>();

  // `assembliesTotal`/Ready/Partial/Blocked count TotalETO release-status-
  // tagged BUILDABLE UNITS ONLY (a node with its own self/buy line — release
  // "Assembly Only" or "Both"). Confirmed live (2026-08-17): most jobs never
  // set that field at all and are procured as a flat parts list, so these
  // read 0 for the large majority of real jobs even at high overall
  // readiness. That is NOT a bug — it answers "how many independently-bought
  // sub-assemblies does this job have," a genuinely different question from
  // "how much of this job's required material is covered," which is what
  // overallReadinessPct (below) answers. Do not conflate the two again.
  let assembliesTotal = 0, assembliesReady = 0, assembliesPartial = 0, assembliesBlocked = 0;

  for (const unit of walkJobBomUnits(bom)) {
    const { detail, blockers: nodeBlockers, upcoming, blockedPartIds: nodeBlocked } = classifyNode(unit.node, unit.key, unit.ownParts, jobId, jobName, now);
    assemblies.push(detail);
    blockers.push(...nodeBlockers);
    for (const u of upcoming) upcomingSource.push({ part: u.part, assemblyLabel: u.assemblyLabel, assemblyKey: detail.key });
    for (const id of nodeBlocked) blockedPartIds.add(id);

    if (detail.buildableQty !== null) {
      assembliesTotal++;
      if (detail.buildableQty >= detail.requiredQty) assembliesReady++;
      else if (detail.buildableQty > 0) assembliesPartial++;
      else assembliesBlocked++;
    }
  }

  // Project-level readiness: quantity-weighted coverage over the whole job's
  // UNIQUE required parts (flattenBomParts already dedupes by physical part
  // id — po-detail.ts's own header — so a sub-assembly legitimately reused
  // under two parents contributes its parts once here, not twice). This is
  // the exact same function+dedup JobProcurement.tsx's own top-of-page
  // summary uses, so the two can never disagree about the same job again.
  // partsLines ([]) is PO/cost enrichment this calc never reads.
  const { requiredQty: requiredQtyTotal, coveredQty: coveredQtyTotal, pct: overallReadinessPct } = quantityReadiness(flattenBomParts(bom, []));

  const now0 = now;
  const weekEnd = now0 + 7 * DAY;
  let partsUncovered = 0, partsOnOrder = 0, partsPastDue = 0, partsDueSoon7d = 0;
  for (const b of blockers) {
    if (b.reason === "no_po") partsUncovered++;
    if (b.reason === "supplier_delay" || b.reason === "past_due") partsPastDue++;
  }
  for (const u of upcomingSource) {
    if (u.part.status === "ordered") partsOnOrder++;
    const t = u.part.expectedDate ? new Date(u.part.expectedDate).getTime() : NaN;
    if (Number.isFinite(t) && t >= now0 && t <= weekEnd) partsDueSoon7d++;
  }

  const materialValueTotal = assemblies.reduce((s, a) => s + a.materialValue, 0);
  let materialValueAtRisk = 0;
  const seenBlocked = new Set<string>();
  for (const b of blockers) {
    if (b.reason === "awaiting_release") continue; // overlay only — already counted under its natural reason
    const key = `${b.assemblyKey}:${b.partPn}`;
    if (seenBlocked.has(key)) continue;
    seenBlocked.add(key);
    materialValueAtRisk += b.materialValue;
  }

  const upcomingDates = upcomingSource.map((u) => u.part.expectedDate).filter((d): d is string => !!d).sort();
  const nextUnlockDate = upcomingDates.length ? upcomingDates[0] : null;

  const upcoming: UpcomingDeliveryEntry[] = upcomingSource
    .filter((u) => u.part.expectedDate)
    .map((u) => ({
      jobId,
      jobName,
      poNumber: u.part.poId,
      supplier: u.part.supplier,
      expectedDate: u.part.expectedDate!,
      assemblyKey: u.assemblyKey,
      assemblyLabel: u.assemblyLabel,
      incomingParts: [{ pn: u.part.pn, qty: u.part.qty }],
      buildableBefore: null, // filled in by the read layer, which recomputes buildable-before/after per window
      buildableAfter: null,
      // Mirrors the exact test partsOnOrder's own source loop above uses —
      // so a drilldown on the main table's "On Order" cell can filter
      // `detail.upcoming` directly and reconcile with the KPI by construction.
      onOrder: u.part.status === "ordered",
    }));

  // `lines` (every individual PO line) is dropped here rather than stored and
  // shipped: it was 70.5% of the whole snapshot and no consumer reads it. See
  // build-readiness-types.ts's SnapshotVendor for the measurements and for what
  // to do if per-line detail is ever genuinely needed. Names and the PO
  // rollup counts every consumer DOES read are preserved exactly.
  const vendors = bom.vendors.map((v) => ({
    name: v.name,
    pos: v.pos.map(({ poId, itemCount, received, pct }) => ({ poId, itemCount, received, pct })),
  }));

  return {
    detail: { assemblies, vendors, blockers, upcoming },
    overallReadinessPct,
    requiredQtyTotal: Math.round(requiredQtyTotal),
    coveredQtyTotal: Math.round(coveredQtyTotal),
    assembliesTotal,
    assembliesReady,
    assembliesPartial,
    assembliesBlocked,
    partsUncovered,
    partsOnOrder,
    partsPastDue,
    partsDueSoon7d,
    materialValueTotal,
    materialValueAtRisk,
    nextUnlockDate,
  };
}

// ── Persistence (raw SQL — see schema.prisma's own comment on why) ─────────

// "notReleased": a BOM tree exists (this job is not "empty"/"No BOM") but
// walking it found zero actual required parts anywhere — set by the callers
// below, right after classifyJobBom, since only they know both facts
// (bom.roots.length > 0 AND requiredQtyTotal === 0) at once.
async function upsertSnapshot(jobId: string, jobName: string, customer: string | null, status: "ok" | "failed" | "empty" | "notReleased", computed: ReturnType<typeof classifyJobBom> | null): Promise<void> {
  const c = computed ?? {
    detail: { assemblies: [], vendors: [], blockers: [], upcoming: [] },
    overallReadinessPct: 0, requiredQtyTotal: 0, coveredQtyTotal: 0, assembliesTotal: 0, assembliesReady: 0, assembliesPartial: 0, assembliesBlocked: 0,
    partsUncovered: 0, partsOnOrder: 0, partsPastDue: 0, partsDueSoon7d: 0,
    materialValueTotal: 0, materialValueAtRisk: 0, nextUnlockDate: null as string | null,
  };
  // ── computedAt is a JS Date, never NOW(3) (2026-08-24) ────────────────────
  //
  // Reported as "PO Tracking data does not appear to be up to date". It was
  // current; the TIMESTAMP was wrong. MySQL NOW(3) returns the session time zone
  // (SYSTEM = UTC-4 on this server) while Prisma reads a DATETIME column back as
  // UTC, so a refresh that had just finished stored 14:00 local into a field the
  // app then treated as 14:00Z. BuildReadinessDrillViews renders that through
  // toLocaleString(), converting to local a second time, so a 2:00pm refresh
  // displayed as 10:00am — four hours stale, every time.
  //
  // Measured on this database: NOW(3) 14:04:10 vs UTC_TIMESTAMP(3) 18:04:10.
  //
  // Not a new discovery for this codebase, which is the frustrating part:
  // refresh-service.ts hit the same thing and its claimLock comment already
  // spells it out ("NOW(3) is the MySQL SESSION's timezone while a JS Date is
  // sent as UTC ... every freshly written startedAt compared as four hours old").
  // That file was fixed; this one was missed. A JS Date parameter is the
  // established fix, so it is what is used here.
  const detailJson = JSON.stringify(c.detail);
  await prisma.$executeRaw`
    INSERT INTO BuildReadinessJobSnapshot
      (jobId, jobName, customer, status, overallReadinessPct, requiredQtyTotal, coveredQtyTotal, assembliesTotal, assembliesReady, assembliesPartial, assembliesBlocked,
       partsUncovered, partsOnOrder, partsPastDue, partsDueSoon7d, materialValueTotal, materialValueAtRisk, nextUnlockDate, detailJson, computedAt)
    VALUES
      (${jobId}, ${jobName}, ${customer}, ${status}, ${c.overallReadinessPct}, ${c.requiredQtyTotal}, ${c.coveredQtyTotal}, ${c.assembliesTotal}, ${c.assembliesReady}, ${c.assembliesPartial}, ${c.assembliesBlocked},
       ${c.partsUncovered}, ${c.partsOnOrder}, ${c.partsPastDue}, ${c.partsDueSoon7d}, ${c.materialValueTotal}, ${c.materialValueAtRisk}, ${c.nextUnlockDate ? new Date(c.nextUnlockDate) : null}, ${detailJson}, ${new Date()})
    ON DUPLICATE KEY UPDATE
      jobName = VALUES(jobName), customer = VALUES(customer), status = VALUES(status),
      overallReadinessPct = VALUES(overallReadinessPct), requiredQtyTotal = VALUES(requiredQtyTotal), coveredQtyTotal = VALUES(coveredQtyTotal),
      assembliesTotal = VALUES(assembliesTotal),
      assembliesReady = VALUES(assembliesReady), assembliesPartial = VALUES(assembliesPartial), assembliesBlocked = VALUES(assembliesBlocked),
      partsUncovered = VALUES(partsUncovered), partsOnOrder = VALUES(partsOnOrder), partsPastDue = VALUES(partsPastDue), partsDueSoon7d = VALUES(partsDueSoon7d),
      materialValueTotal = VALUES(materialValueTotal), materialValueAtRisk = VALUES(materialValueAtRisk),
      nextUnlockDate = VALUES(nextUnlockDate), detailJson = VALUES(detailJson), computedAt = VALUES(computedAt)
  `;
}

async function bumpMeta(fields: Partial<{ status: string; startedAt: Date; completedAt: Date; jobsTotal: number; jobsDone: number; jobsFailed: number; triggeredByName: string | null; durationMs: number }>): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = ?`);
    values.push(v);
  }
  if (sets.length === 0) return;
  await prisma.$executeRawUnsafe(
    `UPDATE BuildReadinessRefreshMeta SET ${sets.join(", ")}, updatedAt = ? WHERE id = 1`,
    ...values,
    new Date(),
  );
}

async function incrementMetaDone(failed: boolean): Promise<void> {
  await prisma.$executeRaw`
    UPDATE BuildReadinessRefreshMeta
    SET jobsDone = jobsDone + 1, jobsFailed = jobsFailed + ${failed ? 1 : 0}, updatedAt = ${new Date()}
    WHERE id = 1
  `;
}

// ── A "running" row that nobody is running (2026-09-14) ─────────────────────
//
// refreshBuildReadiness sets status = 'running' at the top and clears it at the
// bottom, and nothing else ever did. A pass takes 15+ minutes; a pm2 restart mid-
// pass (every deploy) left the row saying 'running' forever, and
// triggerBuildReadinessRefresh returned early on that status — with or without
// `force` — so every "Refresh now" after a restart was a silent no-op until
// somebody edited the row by hand.
//
// Same fix as refresh-service.ts's RefreshLock: the pass HEARTBEATS. `updatedAt`
// is re-stamped every META_HEARTBEAT_MS while the pass lives (and on every job it
// finishes), so "running, but updatedAt is old" comes to mean "the process running
// this died", not "this pass started a while ago". RUNNING_STALE_MS only has to
// clear the longest plausible gap between beats — a blocked event loop, a slow
// MySQL write — not the length of a pass. 5 minutes is 60 missed beats.
export const META_HEARTBEAT_MS = 5_000;
export const RUNNING_STALE_MS = 5 * 60_000;

/** Is a row that claims to be running actually alive? Pure; both sides from the same clock. */
export function isRunningRowStale(meta: { status: string; updatedAt: Date | null }, now: number, staleAfterMs: number = RUNNING_STALE_MS): boolean {
  if (meta.status !== "running") return false;
  if (!meta.updatedAt) return true; // never stamped at all — nothing is breathing
  return now - meta.updatedAt.getTime() > staleAfterMs;
}

/**
 * The status to SHOW for a meta row: a 'running' row whose heartbeat has stopped
 * is presented as 'partial' (it did some jobs and did not finish), so the
 * dashboard stops saying "Refreshing…" about a process that no longer exists.
 */
export function presentMetaStatus(meta: { status: string; updatedAt: Date | null }, now: number): string {
  return isRunningRowStale(meta, now) ? "partial" : meta.status;
}

export type PassClaimDecision = "already_running" | "fresh" | "claim";

/**
 * Whether a caller may start a pass. Pure; the SQL in claimBuildReadinessPass is
 * this decision written as one conditional UPDATE, and the test pins that they
 * agree.
 *
 *   already_running — a live pass (heartbeat within staleAfterMs). `force` does
 *                     NOT override a live pass; it overrides a STALE one.
 *   fresh           — the last pass completed within freshForMs and this is not
 *                     a forced refresh (a rapid back/forward, not a real request).
 *   claim           — start one.
 */
export function decidePassClaim(
  meta: { status: string; completedAt: Date | null; updatedAt: Date | null },
  opts: { force: boolean; now: number; staleAfterMs: number; freshForMs: number },
): PassClaimDecision {
  if (meta.status === "running" && !isRunningRowStale(meta, opts.now, opts.staleAfterMs)) return "already_running";
  if (!opts.force && meta.completedAt && opts.now - meta.completedAt.getTime() <= opts.freshForMs) return "fresh";
  return "claim";
}

/** The slice of PrismaClient the claim needs — so a test can hand in a stub. */
export type ClaimDb = { $executeRaw: (query: TemplateStringsArray, ...values: unknown[]) => Promise<number> };

/**
 * Atomically claims the singleton meta row for a new pass. Exactly one of any
 * number of concurrent callers sees affectedRows === 1, and only that caller may
 * start the pass — the check-then-act that used to live in
 * triggerBuildReadinessRefresh (read meta, then fire) let two clicks start two
 * passes that double-counted jobsDone and doubled the Total ETO load.
 *
 * The WHERE is decidePassClaim as SQL: not running, or running-but-stale; and
 * (forced, or never completed, or completed longer than freshForMs ago). Both
 * comparisons are against JS Dates, never NOW() — see upsertSnapshot's note on
 * the session timezone.
 */
export async function claimBuildReadinessPass(opts: {
  force: boolean;
  triggeredByName: string | null;
  freshForMs: number;
  now?: Date;
  db?: ClaimDb;
}): Promise<boolean> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const staleCutoff = new Date(now.getTime() - RUNNING_STALE_MS);
  const freshCutoff = new Date(now.getTime() - opts.freshForMs);
  // The row is a singleton the migration seeds; a missing one would make every
  // claim affect 0 rows and nobody would ever refresh. Cheap insurance.
  await db.$executeRaw`INSERT INTO BuildReadinessRefreshMeta (id, status, updatedAt) VALUES (1, 'idle', ${now}) ON DUPLICATE KEY UPDATE id = id`;
  const claimed = await db.$executeRaw`
    UPDATE BuildReadinessRefreshMeta
       SET status = 'running', startedAt = ${now}, completedAt = NULL, durationMs = NULL,
           jobsTotal = 0, jobsDone = 0, jobsFailed = 0, triggeredByName = ${opts.triggeredByName}, updatedAt = ${now}
     WHERE id = 1
       AND (status <> 'running' OR updatedAt IS NULL OR updatedAt < ${staleCutoff})
       AND (${opts.force ? 1 : 0} = 1 OR completedAt IS NULL OR completedAt < ${freshCutoff})`;
  return claimed === 1;
}

function startMetaHeartbeat(): () => void {
  const timer = setInterval(() => {
    // Only while the row is still ours to stamp: a stale-claim by another caller
    // will have reset the row, and a beat from the corpse must not revive it.
    void prisma.$executeRaw`UPDATE BuildReadinessRefreshMeta SET updatedAt = ${new Date()} WHERE id = 1 AND status = 'running'`.catch((err) => {
      console.error("[build-readiness] meta heartbeat failed:", err);
    });
  }, META_HEARTBEAT_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

// ── Entry points ─────────────────────────────────────────────────────────────

// One job, live, awaited inline — used for the drill-down's "Refresh this
// project" action (bounded to a single job, so an inline await is reasonable
// even at ~100s).
export async function refreshOneJob(jobId: string): Promise<void> {
  const job = await prisma.job.findUnique({ where: { jobId }, select: { jobId: true, jobName: true, customer: true } });
  if (!job) return;
  const result = await getJobBomWithRetry(job.jobId);
  const outcome = snapshotStatusFor(result);
  if (outcome === "hasBom" && result) {
    const computed = classifyJobBom(result.bom, job.jobId, job.jobName, Date.now());
    await upsertSnapshot(job.jobId, job.jobName, job.customer, computed.requiredQtyTotal === 0 ? "notReleased" : "ok", computed);
    return;
  }
  await upsertSnapshot(job.jobId, job.jobName, job.customer, outcome === "empty" ? "empty" : "failed", null);
}

// The full cross-job pass. Fire-and-forget from build-readiness-actions.ts —
// this function itself fully awaits its own work; it's the CALLER that
// chooses not to await it to completion.
//
// The caller must already hold the claim (claimBuildReadinessPass returned true):
// this function no longer writes status = 'running' itself, because the claim IS
// that write, done atomically, and a second unconditional write here would let a
// caller that lost the claim overwrite the winner's row.
export async function refreshBuildReadiness(triggeredByName: string | null): Promise<void> {
  const startedAt = new Date();
  const stopHeartbeat = startMetaHeartbeat();
  let anyFailed = false;
  try {
    const jobs = await prisma.job.findMany({ where: etcActiveJobFilter, select: { jobId: true, jobName: true, customer: true } });
    await bumpMeta({ jobsTotal: jobs.length, triggeredByName });

    await mapWithConcurrency(jobs, CONCURRENCY, async (job) => {
      const result = await getJobBomWithRetry(job.jobId);
      const outcome = snapshotStatusFor(result);
      const failed = outcome === "failed";
      if (failed) anyFailed = true;
      try {
        if (outcome === "hasBom" && result) {
          const computed = classifyJobBom(result.bom, job.jobId, job.jobName, Date.now());
          await upsertSnapshot(job.jobId, job.jobName, job.customer, computed.requiredQtyTotal === 0 ? "notReleased" : "ok", computed);
        } else {
          await upsertSnapshot(job.jobId, job.jobName, job.customer, outcome === "empty" ? "empty" : "failed", null);
        }
      } catch (err) {
        console.error(`[build-readiness] snapshot upsert failed for job ${job.jobId}:`, err);
        anyFailed = true;
      }
      await incrementMetaDone(failed);
    });
  } catch (err) {
    // The pass itself broke (the job list could not be read, a meta write threw).
    // Recorded as partial below rather than left 'running' — that is the row the
    // staleness rule exists to recover from, and there is no reason to wait for it.
    console.error("[build-readiness] pass aborted:", err);
    anyFailed = true;
  } finally {
    stopHeartbeat();
    const completedAt = new Date();
    await bumpMeta({
      status: anyFailed ? "partial" : "ok",
      completedAt,
      durationMs: completedAt.getTime() - startedAt.getTime(),
    }).catch((err) => console.error("[build-readiness] could not close the pass record:", err));
  }
}
