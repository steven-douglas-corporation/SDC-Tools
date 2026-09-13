import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeAssemblyInstances } from "../src/lib/build-readiness-forecast";
import type { AssemblyDetail } from "../src/lib/build-readiness-types";

// ── mergeAssemblyInstances: the "What Can We Build Now" duplicate-row fix ────
//
// The same assembly part number can legitimately occur at more than one BOM
// tree position in a job (job-bom-rules.ts's buildAssembly() renders a reused
// sub-assembly design fully under each parent). This pins down that merging
// those positions' AssemblyDetail rows produces the sums/derived figures the
// card and its drilldown both rely on, and — critically — that a SINGLE
// instance passes through untouched (the overwhelming majority case).

function asm(overrides: Partial<AssemblyDetail> = {}): AssemblyDetail {
  return {
    key: "k",
    pn: "PN-1",
    label: "Widget",
    release: "contentsOnly",
    requiredQty: 10,
    coveredQty: 10,
    readinessPct: 100,
    buildableQty: 10,
    buildablePct: 100,
    limitingParts: [],
    missingParts: 0,
    onOrderParts: 0,
    pastDueParts: 0,
    materialValue: 100,
    nextExpectedDelivery: null,
    estimatedBuildableDate: null,
    ...overrides,
  };
}

test("a single instance passes through exactly, no distortion", () => {
  const a = asm({
    requiredQty: 7,
    coveredQty: 5,
    readinessPct: 71,
    buildableQty: 3,
    buildablePct: 43,
    materialValue: 250,
    limitingParts: [{ pn: "BOLT", available: 3, required: 7 }],
    nextExpectedDelivery: "2026-09-01",
    estimatedBuildableDate: "2026-09-05",
  });
  const merged = mergeAssemblyInstances([a]);
  assert.equal(merged.requiredQty, 7);
  assert.equal(merged.coveredQty, 5);
  assert.equal(merged.readinessPct, 71);
  assert.equal(merged.buildableQty, 3);
  assert.equal(merged.buildablePct, 43);
  assert.equal(merged.materialValue, 250);
  assert.deepEqual(merged.limitingParts, [{ pn: "BOLT", available: 3, required: 7 }]);
  assert.equal(merged.nextExpectedDelivery, "2026-09-01");
  assert.equal(merged.estimatedBuildableDate, "2026-09-05");
});

test("required/covered/material qty sum exactly across positions", () => {
  const merged = mergeAssemblyInstances([
    asm({ requiredQty: 10, coveredQty: 10, materialValue: 100, buildableQty: 10 }),
    asm({ requiredQty: 5, coveredQty: 2, materialValue: 40, buildableQty: 2 }),
  ]);
  assert.equal(merged.requiredQty, 15);
  assert.equal(merged.coveredQty, 12);
  assert.equal(merged.materialValue, 140);
});

test("buildableQty sums exactly and buildablePct is recomputed from the summed qtys, not averaged", () => {
  const merged = mergeAssemblyInstances([
    asm({ requiredQty: 10, buildableQty: 10, buildablePct: 100 }),
    asm({ requiredQty: 10, buildableQty: 4, buildablePct: 40 }),
  ]);
  assert.equal(merged.buildableQty, 14);
  // Exact recompute: 14/20 = 70, NOT (100+40)/2 = 70 by coincidence here —
  // use unequal weights below to distinguish the two.
  assert.equal(merged.buildablePct, 70);

  const skewed = mergeAssemblyInstances([
    asm({ requiredQty: 90, buildableQty: 90, buildablePct: 100 }),
    asm({ requiredQty: 10, buildableQty: 0, buildablePct: 0 }),
  ]);
  // Naive average of the two percentages would be 50; exact recompute is 90/100 = 90.
  assert.equal(skewed.buildableQty, 90);
  assert.equal(skewed.buildablePct, 90);
});

test("any unbuildable instance makes the merged buildableQty/buildablePct null", () => {
  const merged = mergeAssemblyInstances([
    asm({ requiredQty: 10, buildableQty: 10, buildablePct: 100 }),
    asm({ requiredQty: 5, buildableQty: null, buildablePct: null, release: "assemblyOnly" }),
  ]);
  assert.equal(merged.buildableQty, null);
  assert.equal(merged.buildablePct, null);
});

test("readinessPct is a requiredQty-weighted average across positions", () => {
  const merged = mergeAssemblyInstances([
    asm({ requiredQty: 90, readinessPct: 100 }),
    asm({ requiredQty: 10, readinessPct: 0 }),
  ]);
  // Weighted: (100*90 + 0*10)/100 = 90 — NOT a naive average (which would be 50).
  assert.equal(merged.readinessPct, 90);
});

test("limitingParts merge by pn, summing available and required across positions", () => {
  const merged = mergeAssemblyInstances([
    asm({ limitingParts: [{ pn: "BOLT", available: 3, required: 10 }] }),
    asm({ limitingParts: [{ pn: "BOLT", available: 2, required: 5 }, { pn: "NUT", available: 1, required: 4 }] }),
  ]);
  const byPn = new Map(merged.limitingParts.map((lp) => [lp.pn, lp]));
  assert.deepEqual(byPn.get("BOLT"), { pn: "BOLT", available: 5, required: 15 });
  assert.deepEqual(byPn.get("NUT"), { pn: "NUT", available: 1, required: 4 });
});

test("nextExpectedDelivery takes the earliest date across positions", () => {
  const merged = mergeAssemblyInstances([
    asm({ nextExpectedDelivery: "2026-09-15" }),
    asm({ nextExpectedDelivery: "2026-09-01" }),
    asm({ nextExpectedDelivery: null }),
  ]);
  assert.equal(merged.nextExpectedDelivery, "2026-09-01");
});

test("estimatedBuildableDate takes the latest date among still-blocked positions, ignoring already-ready ones", () => {
  const merged = mergeAssemblyInstances([
    asm({ requiredQty: 10, buildableQty: 10, estimatedBuildableDate: "2026-08-01" }), // already ready — excluded
    asm({ requiredQty: 10, buildableQty: 4, estimatedBuildableDate: "2026-09-10" }),
    asm({ requiredQty: 10, buildableQty: 0, estimatedBuildableDate: "2026-09-20" }),
  ]);
  assert.equal(merged.estimatedBuildableDate, "2026-09-20");
});

test("estimatedBuildableDate is null once every position is fully buildable", () => {
  const merged = mergeAssemblyInstances([
    asm({ requiredQty: 10, buildableQty: 10, estimatedBuildableDate: null }),
    asm({ requiredQty: 5, buildableQty: 5, estimatedBuildableDate: null }),
  ]);
  assert.equal(merged.estimatedBuildableDate, null);
});
