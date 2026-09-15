import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyJobBom } from "../src/lib/build-readiness-sync";
import type { BomNode, BomPart } from "../src/lib/job-bom-rules";
import type { JobBom } from "../src/lib/job-bom";

// ── The exact reconciliation identities the Build Readiness drilldowns rely
// on ("Blocked KPI -> Blocked projects -> Blocked assemblies -> Blocking
// parts must reconcile exactly") ─────────────────────────────────────────────
//
// Each KPI count classifyJobBom returns is built from a specific filter over
// `detail.blockers`/`detail.upcoming`/`detail.assemblies` — this pins each of
// those filters down directly against classifyJobBom's OWN output, so a
// drilldown view that copies the same filter (BuildReadinessDrillViews.tsx)
// can never silently drift from the number it's supposed to explain.

const NOW = Date.UTC(2026, 7, 17); // 2026-08-17, arbitrary fixed instant
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

let nextId = 1;
function part(overrides: Partial<BomPart> = {}): BomPart {
  return {
    id: nextId++,
    pn: "PN",
    desc: "desc",
    manufacturer: "SDC",
    qty: 1,
    poQty: 0,
    receivedQty: 0,
    unitPrice: 10,
    costBasis: "none",
    source: "none",
    release: "contentsOnly",
    isAssembly: false,
    pullQty: 0,
    requiredDate: null,
    expectedDate: null,
    originalDate: null,
    revisedDate: null,
    poDate: null,
    receivedDate: null,
    status: "noPO",
    hold: false,
    supplier: null,
    poId: null,
    packetId: null,
    packetLabel: null,
    ...overrides,
  };
}

function node(overrides: Partial<BomNode> = {}): BomNode {
  return {
    key: "node",
    id: 1,
    depth: 1,
    label: "Node",
    pn: "",
    desc: "",
    isAssembly: false,
    release: "contentsOnly",
    self: null,
    packetId: null,
    packetLabel: null,
    children: [],
    parts: [],
    stats: { total: 0, received: 0, noPO: 0, ordered: 0, stock: 0, pct: 0 },
    totalCost: 0,
    totalPartQty: 0,
    nestedAssemblies: 0,
    ...overrides,
  };
}

// Every assembly's OWN buy line is fine (received) in this fixture — only
// the CHILD parts below are what's missing/late/on order, so each assembly's
// `self` line must not itself count as a blocker.
function readySelf(pn: string): BomPart {
  return part({ pn, status: "received", source: "po", receivedQty: 1 });
}

function makeBom(): JobBom {
  // Missing/uncovered — no PO, no stock, no process.
  const missingPart = part({ pn: "MISSING-1", status: "noPO", source: "none", unitPrice: 5 });
  const asmMissing = node({ key: "asmMissing", label: "Missing Assembly", self: readySelf("ASM-MISSING"), parts: [missingPart] });

  // Past due via a late, still-open PO (source "po" + status "ordered" + late -> "supplier_delay").
  const lateOrderedPart = part({ pn: "LATE-1", status: "ordered", source: "po", expectedDate: iso(NOW - 3 * DAY), unitPrice: 20, poId: "PO-4521", supplier: "Acme Supply" });
  const asmLate = node({ key: "asmLate", label: "Late Assembly", self: readySelf("ASM-LATE"), parts: [lateOrderedPart] });

  // Past due via a late in-house process item (source "process" + late -> "past_due", the OTHER half of the two-reason sum).
  const lateProcessPart = part({ pn: "LATE-2", status: "ordered", source: "process", expectedDate: iso(NOW - 1 * DAY), unitPrice: 8 });
  const asmLateProcess = node({ key: "asmLateProcess", label: "Late Process Assembly", self: readySelf("ASM-LATE-PROCESS"), parts: [lateProcessPart] });

  // On order, due soon (within 7 days, not late) — no blocker, but IS upcoming with onOrder=true.
  const dueSoonPart = part({ pn: "SOON-1", status: "ordered", source: "po", expectedDate: iso(NOW + 3 * DAY), unitPrice: 15 });
  const asmSoon = node({ key: "asmSoon", label: "Due Soon Assembly", self: readySelf("ASM-SOON"), parts: [dueSoonPart] });

  // Fully received — contributes to neither blockers nor upcoming.
  const receivedPart = part({ pn: "RCVD-1", status: "received", source: "po", receivedQty: 1, unitPrice: 12 });
  const asmReady = node({ key: "asmReady", label: "Ready Assembly", self: readySelf("ASM-READY"), parts: [receivedPart] });

  const section = node({
    key: "sec1",
    depth: 0,
    label: "Section 1",
    children: [asmMissing, asmLate, asmLateProcess, asmSoon, asmReady],
    parts: [],
  });

  return { jobId: "9999", roots: [section], grandTotalCost: 0, grandTotalPartQty: 0, rowCount: 0, vendors: [] };
}

test("partsUncovered counts exactly the blockers reason==='no_po' — same filter a Missing drilldown must use", () => {
  const bom = makeBom();
  const result = classifyJobBom(bom, "9999", "Test Job", NOW);
  const missing = result.detail.blockers.filter((b) => b.reason === "no_po");
  assert.equal(result.partsUncovered, missing.length);
  assert.equal(result.partsUncovered, 1);
});

test("partsPastDue counts exactly the blockers reason IN ('past_due','supplier_delay') — the two-reason sum a Past Due drilldown must reproduce", () => {
  const bom = makeBom();
  const result = classifyJobBom(bom, "9999", "Test Job", NOW);
  const pastDue = result.detail.blockers.filter((b) => b.reason === "past_due" || b.reason === "supplier_delay");
  assert.equal(result.partsPastDue, pastDue.length);
  assert.equal(result.partsPastDue, 2, "one supplier_delay (PO-sourced) + one past_due (process-sourced)");
  assert.ok(result.detail.blockers.some((b) => b.reason === "supplier_delay"));
  assert.ok(result.detail.blockers.some((b) => b.reason === "past_due"));
});

test("partsOnOrder counts exactly the upcoming entries with onOrder=true — an On Order drilldown needs no live fetch", () => {
  const bom = makeBom();
  const result = classifyJobBom(bom, "9999", "Test Job", NOW);
  const onOrder = result.detail.upcoming.filter((u) => u.onOrder);
  assert.equal(result.partsOnOrder, onOrder.length);
  assert.equal(result.partsOnOrder, 3, "LATE-1, LATE-2 and SOON-1 are all status===ordered with an expected date");
});

test("partsDueSoon7d counts exactly the upcoming entries whose expectedDate falls in [now, now+7d]", () => {
  const bom = makeBom();
  const result = classifyJobBom(bom, "9999", "Test Job", NOW);
  const weekEnd = NOW + 7 * DAY;
  const dueSoon = result.detail.upcoming.filter((u) => {
    const t = new Date(u.expectedDate).getTime();
    return t >= NOW && t <= weekEnd;
  });
  assert.equal(result.partsDueSoon7d, dueSoon.length);
  assert.equal(result.partsDueSoon7d, 1, "only SOON-1 (in +3d) falls inside the window — the two late parts are in the PAST");
});

test("materialValueTotal is exactly the sum of every assembly's own materialValue — a Material $ drilldown needs no filter", () => {
  const bom = makeBom();
  const result = classifyJobBom(bom, "9999", "Test Job", NOW);
  const sum = result.detail.assemblies.reduce((s, a) => s + a.materialValue, 0);
  assert.ok(Math.abs(result.materialValueTotal - sum) < 1e-9);
});

test("assembliesTotal counts exactly the assemblies with a non-null buildableQty — an Assemblies/Ready/Partial/Blocked drilldown must filter the same set", () => {
  const bom = makeBom();
  const result = classifyJobBom(bom, "9999", "Test Job", NOW);
  const counted = result.detail.assemblies.filter((a) => a.buildableQty !== null);
  assert.equal(result.assembliesTotal, counted.length);
  assert.equal(result.assembliesTotal, 5, "every assembly here has its own self/buy line, so none are null");
});

test("every BlockerEntry carries the part's own poId as poNumber — so a blocker row can drill straight into its PO", () => {
  const bom = makeBom();
  const result = classifyJobBom(bom, "9999", "Test Job", NOW);
  const supplierDelay = result.detail.blockers.find((b) => b.reason === "supplier_delay")!;
  assert.equal(supplierDelay.poNumber, "PO-4521", "the late PO-sourced part's poId must flow through to the blocker entry unchanged");
  const noPo = result.detail.blockers.find((b) => b.reason === "no_po")!;
  assert.equal(noPo.poNumber, null, "an uncovered part genuinely has no PO — must not default to something else");
});

// ── overallReadinessPct: quantity-weighted, and deduped across reused BOM
// positions (2026-08-17 fix) ─────────────────────────────────────────────────

test("overallReadinessPct is quantity-weighted across the whole job, not line-count coverage", () => {
  // 5 assemblies here, all qty 1 (makeBom's default) — 4 self-lines received,
  // 1 self-line ("ASM-MISSING") is also received (readySelf), only the CHILD
  // parts vary: 1 of 5 children is genuinely uncovered (MISSING-1), 2 are
  // late-but-ordered, 1 is due-soon-but-ordered, 1 is received. So by qty:
  // 5 self (received) + RCVD-1 (received) = 6 covered; LATE-1/LATE-2/SOON-1/
  // MISSING-1 (4 uncovered-or-not-yet-received) = required 10 total, covered 6.
  const bom = makeBom();
  const result = classifyJobBom(bom, "9999", "Test Job", NOW);
  assert.equal(result.requiredQtyTotal, 10);
  assert.equal(result.coveredQtyTotal, 6);
  assert.equal(result.overallReadinessPct, 60);
});

test("a reused sub-assembly's shared leaf part counts ONCE toward overallReadinessPct, even though it appears at two BOM positions", () => {
  // Same physical part (same id) required under two different parent
  // assemblies — legitimate BOM reuse (job-bom-rules.ts's buildAssembly()
  // own comment), and each position correctly gets its own AssemblyDetail
  // row. The PROJECT-level total must not double-count it.
  const sharedPart = part({ pn: "SHARED-1", status: "noPO", source: "none", qty: 4, receivedQty: 0 });
  const asmA = node({ key: "asmA", label: "A", self: readySelf("ASM-A"), parts: [sharedPart] });
  const asmB = node({ key: "asmB", label: "B", self: readySelf("ASM-B"), parts: [sharedPart] });
  const section = node({ key: "sec1", depth: 0, label: "Section 1", children: [asmA, asmB], parts: [] });
  const bom: JobBom = { jobId: "9998", roots: [section], grandTotalCost: 0, grandTotalPartQty: 0, rowCount: 0, vendors: [] };

  const result = classifyJobBom(bom, "9998", "Test Job", NOW);
  // Naive per-position sum would double-count SHARED-1's qty 4 (once under
  // each parent) on top of the two self lines: (1+4) + (1+4) = 10 required.
  // Deduped by id, it must appear only once: 1 (asmA self) + 1 (asmB self) + 4 (SHARED-1 once) = 6.
  assert.equal(result.requiredQtyTotal, 6, "SHARED-1's qty must be counted once, not once per BOM position it occurs at");
  assert.equal(result.coveredQtyTotal, 2, "only the two received self-lines are covered; SHARED-1 is uncovered");
});

test("a BOM tree with zero requirement lines anywhere yields requiredQtyTotal 0 (the signal refreshOneJob/refreshBuildReadiness use to set status 'notReleased')", () => {
  const section = node({ key: "sec1", depth: 0, label: "Section 1", children: [], parts: [] });
  const bom: JobBom = { jobId: "9997", roots: [section], grandTotalCost: 0, grandTotalPartQty: 0, rowCount: 0, vendors: [] };
  const result = classifyJobBom(bom, "9997", "Test Job", NOW);
  assert.equal(result.requiredQtyTotal, 0);
  assert.equal(result.overallReadinessPct, 0, "must read as 0, never 100, when nothing has been released");
});

// ── A pass that nobody is running, and two callers starting one (2026-09-14) ──
//
// refreshBuildReadiness set status='running' and only its own last line cleared
// it, so a pm2 restart mid-pass (every deploy) left the row 'running' forever and
// triggerBuildReadinessRefresh returned early on it — `force` included. And that
// trigger was read-then-fire, so two clicks started two passes. The decision is a
// pure function now, and the SQL claim is that decision as one conditional UPDATE.

import {
  decidePassClaim,
  isRunningRowStale,
  presentMetaStatus,
  claimBuildReadinessPass,
  snapshotStatusFor,
  CONCURRENCY,
  PER_JOB_TIMEOUT_MS,
  BOM_POOL_MAX,
  RUNNING_STALE_MS,
  META_HEARTBEAT_MS,
  type ClaimDb,
} from "../src/lib/build-readiness-sync";
import { BOM_QUERY_CONCURRENCY, BOM_QUERY_COUNT } from "../src/lib/job-bom";
import { TOTALETO_TIMEOUT } from "../src/lib/totaleto-connection";

const T0 = Date.UTC(2026, 8, 14, 15, 0, 0);
const MIN = 60_000;
const FRESH_MS = 2 * MIN;
const claimOpts = (force: boolean, now = T0) => ({ force, now, staleAfterMs: RUNNING_STALE_MS, freshForMs: FRESH_MS });

test("a 'running' row whose heartbeat is recent is alive — and force does NOT override a live pass", () => {
  const live = { status: "running", completedAt: null, updatedAt: new Date(T0 - 10_000) };
  assert.equal(isRunningRowStale(live, T0), false);
  assert.equal(decidePassClaim(live, claimOpts(false)), "already_running");
  assert.equal(decidePassClaim(live, claimOpts(true)), "already_running", "force must not start a second pass beside a live one");
  assert.equal(presentMetaStatus(live, T0), "running");
});

test("a 'running' row with no heartbeat for RUNNING_STALE_MS is a corpse: claimable, and shown as 'partial'", () => {
  // The pm2-restart case: the process died 20 minutes ago, the row still says running.
  const dead = { status: "running", completedAt: null, updatedAt: new Date(T0 - 20 * MIN) };
  assert.equal(isRunningRowStale(dead, T0), true);
  assert.equal(decidePassClaim(dead, claimOpts(false)), "claim", "a page visit may start a pass over a dead one");
  assert.equal(decidePassClaim(dead, claimOpts(true)), "claim", "so may Refresh now");
  assert.equal(presentMetaStatus(dead, T0), "partial", "the dashboard must stop saying Refreshing… about a dead process");
  // Never stamped at all is the same thing.
  assert.equal(isRunningRowStale({ status: "running", updatedAt: null }, T0), true);
  // The threshold is generous next to the beat: a blocked event loop or slow write
  // cannot produce a false corpse.
  assert.ok(RUNNING_STALE_MS >= 12 * META_HEARTBEAT_MS, "stale cutoff must absorb many missed beats");
  // And a row that is NOT running is never "stale" whatever its age.
  assert.equal(isRunningRowStale({ status: "ok", updatedAt: new Date(T0 - 3 * 60 * MIN) }, T0), false);
});

test("a recently completed pass is 'fresh' for a plain page visit, but not for Refresh now", () => {
  const justDone = { status: "ok", completedAt: new Date(T0 - 30_000), updatedAt: new Date(T0 - 30_000) };
  assert.equal(decidePassClaim(justDone, claimOpts(false)), "fresh");
  assert.equal(decidePassClaim(justDone, claimOpts(true)), "claim", "force overrides the freshness window");
  const olderDone = { status: "partial", completedAt: new Date(T0 - FRESH_MS - 1), updatedAt: new Date(T0 - FRESH_MS - 1) };
  assert.equal(decidePassClaim(olderDone, claimOpts(false)), "claim");
  assert.equal(decidePassClaim({ status: "idle", completedAt: null, updatedAt: null }, claimOpts(false)), "claim", "never completed = start one");
});

// A stub of the one Prisma method the claim uses: records each tagged-template
// call and answers with a scripted affectedRows per UPDATE.
function stubDb(updateAnswers: number[]): ClaimDb & { calls: { sql: string; values: unknown[] }[] } {
  const calls: { sql: string; values: unknown[] }[] = [];
  return {
    calls,
    async $executeRaw(query: TemplateStringsArray, ...values: unknown[]) {
      const sql = query.join("?");
      calls.push({ sql, values });
      if (/^\s*INSERT/i.test(sql)) return 0; // row already exists
      return updateAnswers.shift() ?? 0;
    },
  };
}

test("claimBuildReadinessPass: only the caller whose UPDATE affected one row wins", async () => {
  // Two concurrent claimants against MySQL: the row can satisfy the WHERE for
  // exactly one of them. Modelled as the first UPDATE answering 1 and the second 0.
  const db = stubDb([1, 0]);
  const a = await claimBuildReadinessPass({ force: false, triggeredByName: "A", freshForMs: FRESH_MS, now: new Date(T0), db });
  const b = await claimBuildReadinessPass({ force: false, triggeredByName: "B", freshForMs: FRESH_MS, now: new Date(T0), db });
  assert.equal(a, true);
  assert.equal(b, false, "the loser must not start a pass");
});

test("claimBuildReadinessPass: the UPDATE is decidePassClaim written as SQL, with JS-Date cutoffs", async () => {
  const db = stubDb([1]);
  const now = new Date(T0);
  await claimBuildReadinessPass({ force: true, triggeredByName: "Abhi", freshForMs: FRESH_MS, now, db });
  const update = db.calls.find((c) => /^\s*UPDATE/i.test(c.sql));
  assert.ok(update, "an UPDATE must be issued");
  // The three conditions: singleton row; not running OR stale heartbeat; forced OR never/long-ago completed.
  assert.match(update.sql, /WHERE id = 1/);
  assert.match(update.sql, /status <> 'running' OR updatedAt IS NULL OR updatedAt < \?/, "a stale running row must be claimable");
  assert.match(update.sql, /\? = 1 OR completedAt IS NULL OR completedAt < \?/, "force must override the freshness window");
  // It claims by writing 'running' itself — the claim IS the status write — and
  // resets the counters so the loser cannot double-count jobsDone.
  assert.match(update.sql, /SET status = 'running'/);
  assert.match(update.sql, /jobsDone = 0, jobsFailed = 0/);
  assert.match(update.sql, /completedAt = NULL/);
  // Cutoffs are JS Dates from the same clock as `now`, never NOW() — see the
  // session-timezone note in upsertSnapshot / refresh-service.ts's claimLock.
  const dates = update.values.filter((v): v is Date => v instanceof Date);
  assert.ok(dates.some((d) => d.getTime() === T0 - RUNNING_STALE_MS), "stale cutoff = now - RUNNING_STALE_MS");
  assert.ok(dates.some((d) => d.getTime() === T0 - FRESH_MS), "fresh cutoff = now - freshForMs");
  assert.ok(update.values.includes(1), "force is passed as 1");
  assert.ok(update.values.includes("Abhi"));
  assert.ok(!/NOW\(/i.test(update.sql), "MySQL NOW() is the session timezone; every comparison must use JS Dates");
  // And the row is made to exist first, so a missing singleton can never mean "nobody may ever refresh".
  assert.match(db.calls[0].sql, /INSERT INTO BuildReadinessRefreshMeta/);
});

// ── Failed is not empty (2026-09-14) ─────────────────────────────────────────
//
// getJobBom() is fail-soft, and this file's "failed" branch was only reachable on
// a null it never returned — so every Total ETO fault during a pass was stored as
// "empty" ("No BOM") for a job that has one.
const emptyBom = (jobId: string): JobBom => ({ jobId, roots: [], grandTotalCost: 0, grandTotalPartQty: 0, rowCount: 0, vendors: [] });

test("snapshotStatusFor tells a failed read from a genuinely empty BOM", () => {
  assert.equal(snapshotStatusFor(null), "failed", "timed out / threw: no read happened");
  assert.equal(
    snapshotStatusFor({ ok: false, bom: emptyBom("1142"), kind: "pool_exhausted", reason: "no free connection" }),
    "failed",
    "a read that failed carries an empty bom for page callers, but the pass must write 'failed', not 'No BOM'",
  );
  assert.equal(snapshotStatusFor({ ok: true, bom: emptyBom("2000") }), "empty", "a read that succeeded and found nothing IS 'No BOM'");
  assert.equal(snapshotStatusFor({ ok: true, bom: makeBom() }), "hasBom");
});

// ── Workers x per-job fan-out must fit in the Total ETO pool (2026-09-14) ────
test("the bulk pass can never ask the 120s pool for more connections than it has", () => {
  assert.ok(
    CONCURRENCY * BOM_QUERY_CONCURRENCY <= BOM_POOL_MAX,
    `${CONCURRENCY} workers x ${BOM_QUERY_CONCURRENCY} queries = ${CONCURRENCY * BOM_QUERY_CONCURRENCY} > pool max ${BOM_POOL_MAX} — this is the 36-on-5 starvation coming back`,
  );
  assert.ok(CONCURRENCY * BOM_QUERY_CONCURRENCY < BOM_POOL_MAX, "leave headroom for a page render or PO drill-down during a pass");
  // The per-job ceiling is honest about the rounds a job now takes: each round is
  // bounded by mssql's own requestTimeout, so anything shorter would fail a slow
  // but working job on the pass's terms rather than the driver's.
  const rounds = Math.ceil(BOM_QUERY_COUNT / BOM_QUERY_CONCURRENCY);
  assert.ok(PER_JOB_TIMEOUT_MS > rounds * TOTALETO_TIMEOUT.bom, "per-job timeout must exceed rounds x requestTimeout");
});
