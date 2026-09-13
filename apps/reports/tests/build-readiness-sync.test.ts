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
