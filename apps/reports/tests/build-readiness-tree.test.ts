import { test } from "node:test";
import assert from "node:assert/strict";
import { walkJobBomUnits, findJobBomUnit } from "../src/lib/build-readiness-tree";
import type { BomNode, BomPart } from "../src/lib/job-bom-rules";
import type { JobBom } from "../src/lib/job-bom";

// ── build-readiness-tree.ts: the ONE walk + key algorithm, exercised directly ──
//
// This pins down the exact key format (parent path, "/"-joined, plus the
// "<section.key>-loose" synthetic bucket) that build-readiness-sync.ts's
// stored AssemblyDetail.key has always used — a live re-fetch (the assembly
// drilldown) can only ever find the right node again if this never quietly
// changes shape.

let nextId = 1000;
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

function makeBom(): JobBom {
  const assemblyC = node({ key: "asmC", label: "Assembly C", self: part({ pn: "C-000" }), parts: [part({ pn: "C-001" })] });
  const assemblyB = node({ key: "asmB", label: "Assembly B", self: part({ pn: "B-000" }), children: [assemblyC] });
  const assemblyA = node({ key: "asmA", label: "Assembly A", self: part({ pn: "A-000" }), parts: [part({ pn: "A-001" })] });
  const section = node({
    key: "sec1",
    depth: 0,
    label: "Section 1",
    children: [assemblyA, assemblyB],
    parts: [part({ pn: "LOOSE-001" })],
  });
  return { jobId: "9999", roots: [section], grandTotalCost: 0, grandTotalPartQty: 0, rowCount: 0, vendors: [] };
}

test("walkJobBomUnits assigns the exact parent-path key format", () => {
  const units = walkJobBomUnits(makeBom());
  const keys = units.map((u) => u.key);
  assert.deepEqual(keys.sort(), ["asmA", "asmB", "asmB/asmC", "sec1/sec1-loose"].sort());
});

test("walkJobBomUnits's key for a nested assembly is 'parentKey/ownKey'", () => {
  const units = walkJobBomUnits(makeBom());
  const asmC = units.find((u) => u.node.label === "Assembly C")!;
  assert.equal(asmC.key, "asmB/asmC");
});

test("the loose-parts bucket key is '<sectionKey>/<sectionKey>-loose'", () => {
  const units = walkJobBomUnits(makeBom());
  const loose = units.find((u) => u.node.label === "Loose parts")!;
  assert.equal(loose.key, "sec1/sec1-loose");
  assert.equal(loose.node.self, null, "the loose bucket has no buy/build unit — buildableQtyFor treats it as null");
  assert.deepEqual(loose.ownParts.map((p) => p.pn), ["LOOSE-001"]);
});

test("ownParts is [self, ...parts] when self is set, and just parts otherwise", () => {
  const units = walkJobBomUnits(makeBom());
  const asmA = units.find((u) => u.node.label === "Assembly A")!;
  assert.deepEqual(asmA.ownParts.map((p) => p.pn), ["A-000", "A-001"]);
});

test("findJobBomUnit locates the exact same unit a stored key refers to", () => {
  const bom = makeBom();
  const found = findJobBomUnit(bom, "asmB/asmC");
  assert.ok(found);
  assert.equal(found!.node.label, "Assembly C");
});

test("findJobBomUnit returns null for a key that no longer exists (BOM changed since the snapshot)", () => {
  assert.equal(findJobBomUnit(makeBom(), "asmZ/does-not-exist"), null);
});

test("every unit's key is unique — no two units ever collide", () => {
  const units = walkJobBomUnits(makeBom());
  const keys = units.map((u) => u.key);
  assert.equal(new Set(keys).size, keys.length);
});
