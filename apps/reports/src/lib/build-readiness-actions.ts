"use server";

import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { refreshBuildReadiness, refreshOneJob, claimBuildReadinessPass, presentMetaStatus } from "@/lib/build-readiness-sync";
import {
  type BuildReadinessData,
  type BuildReadinessFilters,
  type JobSnapshotRow,
  type RefreshMetaRow,
  type JobDetail,
  readinessBand,
} from "@/lib/build-readiness-types";

// A page visit "counts" as fresh enough not to restart a pass — see this
// file's own triggerBuildReadinessRefresh. Short on purpose: the point is
// "don't double-fire on a rapid back/forward," not "only refresh sometimes" —
// you asked for live data on every real visit, not a cache TTL.
const STALE_MS = 2 * 60 * 1000;

async function currentUserName(): Promise<string | null> {
  const session = await auth();
  return session?.user?.name ?? session?.user?.email ?? null;
}

type MetaRawRow = {
  status: string;
  startedAt: Date | null;
  completedAt: Date | null;
  jobsTotal: number;
  jobsDone: number;
  jobsFailed: number;
  triggeredByName: string | null;
  durationMs: number | null;
  updatedAt: Date | null;
};

async function readMeta(): Promise<RefreshMetaRow> {
  const rows = await prisma.$queryRaw<MetaRawRow[]>`
    SELECT status, startedAt, completedAt, jobsTotal, jobsDone, jobsFailed, triggeredByName, durationMs, updatedAt
    FROM BuildReadinessRefreshMeta WHERE id = 1
  `;
  const r = rows[0];
  if (!r) return { status: "idle", startedAt: null, completedAt: null, jobsTotal: 0, jobsDone: 0, jobsFailed: 0, triggeredByName: null, durationMs: null };
  return {
    // A 'running' row whose heartbeat has stopped (the process died mid-pass) is
    // shown as 'partial', not 'running' — see build-readiness-sync.ts's
    // RUNNING_STALE_MS. Otherwise the page said "Refreshing…" forever after a
    // restart, and the button that could have fixed it refused to fire.
    status: presentMetaStatus(r, Date.now()) as RefreshMetaRow["status"],
    startedAt: r.startedAt ? r.startedAt.toISOString() : null,
    completedAt: r.completedAt ? r.completedAt.toISOString() : null,
    jobsTotal: r.jobsTotal,
    jobsDone: r.jobsDone,
    jobsFailed: r.jobsFailed,
    triggeredByName: r.triggeredByName,
    durationMs: r.durationMs,
  };
}

// Starts a full live cross-job pass if one isn't already running and the last
// one is stale (or `force`, from the "Refresh now" button) — WITHOUT awaiting
// it to completion. See build-readiness-sync.ts's own header for why that's
// safe on this app's persistent Node process. The client polls
// getBuildReadinessData() afterward to watch it progress.
//
// ── One atomic claim, not read-then-fire (2026-09-14) ─────────────────────
//
// This used to read the meta row, decide, and then fire the pass — so two tabs
// (or a page visit landing beside a "Refresh now" click) both read 'idle' and
// both started a pass: jobsDone climbed twice as fast as jobsTotal and Total ETO
// took double the load. And a row left at 'running' by a restart mid-pass made
// EVERY call here return early, `force` included, until somebody edited it by
// hand. claimBuildReadinessPass is one conditional UPDATE: exactly one caller
// gets affectedRows === 1, a stale 'running' row (no heartbeat for
// RUNNING_STALE_MS) is claimable, and `force` overrides the freshness window —
// but never a pass that is genuinely alive.
export async function triggerBuildReadinessRefresh(force = false): Promise<RefreshMetaRow> {
  const userName = await currentUserName();
  const claimed = await claimBuildReadinessPass({ force, triggeredByName: userName, freshForMs: STALE_MS });
  if (claimed) {
    void refreshBuildReadiness(userName).catch((err) => console.error("[build-readiness] refresh failed:", err));
  }
  // Read back rather than synthesised: whichever caller won, every caller sees the
  // same row — 'running', with the winner's name on it.
  return readMeta();
}

// Drill-down's "Refresh this project" — bounded to one job, so an inline
// await (~100s worst case) is reasonable even though the bulk pass never
// awaits inline.
export async function refreshBuildReadinessProject(jobId: string): Promise<void> {
  await refreshOneJob(jobId);
  revalidatePath("/build-readiness");
}

function safeParseDetail(raw: string): JobDetail {
  try {
    const d = JSON.parse(raw) as Partial<JobDetail>;
    return {
      assemblies: d.assemblies ?? [],
      // Re-projected rather than passed through, so a row written BEFORE the
      // sync stopped storing `lines` (build-readiness-sync.ts) is trimmed on
      // read too. Without this, the payload would stay at its old size for
      // every existing snapshot until the next full refresh overwrote it —
      // and any legacy row would quietly carry 3 KB/vendor of dead weight
      // forever. Picking the four fields explicitly also means a stored row
      // cannot smuggle extra keys into the RSC payload.
      vendors: (d.vendors ?? []).map((v) => ({
        name: v.name,
        pos: (v.pos ?? []).map(({ poId, itemCount, received, pct }) => ({ poId, itemCount, received, pct })),
      })),
      blockers: d.blockers ?? [],
      upcoming: d.upcoming ?? [],
    };
  } catch {
    return { assemblies: [], vendors: [], blockers: [], upcoming: [] };
  }
}

type SnapshotRawRow = {
  jobId: string;
  jobName: string;
  customer: string | null;
  status: string;
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
  materialValueTotal: unknown; // Decimal — comes back as a string/number depending on the mysql driver
  materialValueAtRisk: unknown;
  nextUnlockDate: Date | null;
  detailJson: string;
  computedAt: Date;
};

export async function getBuildReadinessData(filters?: BuildReadinessFilters): Promise<BuildReadinessData> {
  const [rows, meta] = await Promise.all([
    prisma.$queryRaw<SnapshotRawRow[]>`
      SELECT jobId, jobName, customer, status, overallReadinessPct, requiredQtyTotal, coveredQtyTotal, assembliesTotal, assembliesReady, assembliesPartial,
             assembliesBlocked, partsUncovered, partsOnOrder, partsPastDue, partsDueSoon7d, materialValueTotal,
             materialValueAtRisk, nextUnlockDate, detailJson, computedAt
      FROM BuildReadinessJobSnapshot ORDER BY jobId
    `,
    readMeta(),
  ]);

  let jobs: JobSnapshotRow[] = rows.map((r) => ({
    jobId: r.jobId,
    jobName: r.jobName,
    customer: r.customer,
    status: r.status as JobSnapshotRow["status"],
    overallReadinessPct: r.overallReadinessPct,
    requiredQtyTotal: r.requiredQtyTotal,
    coveredQtyTotal: r.coveredQtyTotal,
    assembliesTotal: r.assembliesTotal,
    assembliesReady: r.assembliesReady,
    assembliesPartial: r.assembliesPartial,
    assembliesBlocked: r.assembliesBlocked,
    partsUncovered: r.partsUncovered,
    partsOnOrder: r.partsOnOrder,
    partsPastDue: r.partsPastDue,
    partsDueSoon7d: r.partsDueSoon7d,
    materialValueTotal: Number(r.materialValueTotal),
    materialValueAtRisk: Number(r.materialValueAtRisk),
    nextUnlockDate: r.nextUnlockDate ? r.nextUnlockDate.toISOString() : null,
    detail: safeParseDetail(r.detailJson),
    computedAt: r.computedAt.toISOString(),
  }));

  if (filters) {
    if (filters.query) {
      const q = filters.query.trim().toLowerCase();
      if (q) jobs = jobs.filter((j) => j.jobId.toLowerCase().includes(q) || j.jobName.toLowerCase().includes(q));
    }
    if (filters.customers?.length) jobs = jobs.filter((j) => j.customer != null && filters.customers!.includes(j.customer));
    if (filters.statuses?.length) jobs = jobs.filter((j) => filters.statuses!.includes(readinessBand(j)));
    if (filters.suppliers?.length) {
      jobs = jobs.filter((j) => j.detail.vendors.some((v) => filters.suppliers!.includes(v.name)));
    }
    if (filters.assemblyQuery) {
      const q = filters.assemblyQuery.trim().toLowerCase();
      if (q) jobs = jobs.filter((j) => j.detail.assemblies.some((a) => a.pn.toLowerCase().includes(q) || a.label.toLowerCase().includes(q)));
    }
  }

  return { meta, jobs };
}
