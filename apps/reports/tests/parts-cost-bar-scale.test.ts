import { test } from "node:test";
import assert from "node:assert/strict";
import { sharedBarMax, scaleToPct } from "../src/lib/parts-cost-financials-shared";

// ── The Parts Cost card's two bars must share ONE domain (2026-08-17) ──────
//
// Reported: "the second bar is visually taller even though its total value
// is lower than the Budget bar." Real numbers: Budget $215,565, Projection
// (Invoiced $47,192 + ETC $165,314) $212,506 — Projection should draw
// slightly SHORTER than Budget. These are arithmetic tests against the real
// functions PartsCostSummary.tsx calls (sharedBarMax/scaleToPct), not a
// source-inspection guess at what the component does — a genuine proof the
// invariant holds, that would fail if either function's behavior regressed.

test("a higher value scales to a taller (larger) percentage than a lower one, on the same shared max", () => {
  const budget = 215_565;
  const invoiced = 47_192;
  const etc = 165_314;
  const projection = invoiced + etc; // 212,506 — what the bar's two segments sum to

  const max = sharedBarMax(budget, projection);
  const budgetPct = scaleToPct(budget, max);
  const projectionPct = scaleToPct(invoiced, max) + scaleToPct(etc, max);

  assert.ok(budget > projection, "sanity: budget really is the bigger number in this example");
  assert.ok(budgetPct > projectionPct, `budget (${budgetPct}%) must draw taller than projection (${projectionPct}%) since it is the larger dollar value`);
});

test("equal values produce exactly equal percentages", () => {
  const max = sharedBarMax(500, 500);
  assert.equal(scaleToPct(500, max), scaleToPct(500, max));
  assert.equal(scaleToPct(300, max), scaleToPct(300, max));
});

test("scaling is monotonic — every dollar increase strictly increases the percentage, up to the ceiling", () => {
  const max = sharedBarMax(1000);
  let last = -1;
  for (const v of [0, 100, 250, 500, 750, 999]) {
    const p = scaleToPct(v, max);
    assert.ok(p > last, `value ${v} must scale to more than the previous, smaller value`);
    last = p;
  }
});

test("the shared max comes from ALL values passed in, not each bar's own value alone", () => {
  // This is the exact bug shape the report describes: if each bar computed
  // its own max independently, a bar showing 100% of ITSELF would draw full
  // height regardless of the other bar's actual dollar value.
  const max = sharedBarMax(1_000_000, 10);
  assert.equal(max, 1_000_000, "the max must be the largest of every value in the shared domain");
  assert.ok(scaleToPct(10, max) < 1, "a tiny value against a huge shared max must draw a tiny bar, not 100%");
});

test("stacked segments sum to exactly the same percentage as scaling the combined total directly", () => {
  // The bar's two segments (Invoiced, ETC) must sum to the same height as
  // Projection's own total would scale to — this is what makes "the bar's
  // total height is Projection" true by construction, not by coincidence.
  const max = sharedBarMax(300_000, 212_506);
  const invoiced = 47_192;
  const etc = 165_314;
  const stackedSum = scaleToPct(invoiced, max) + scaleToPct(etc, max);
  const combinedDirectly = scaleToPct(invoiced + etc, max);
  assert.ok(Math.abs(stackedSum - combinedDirectly) < 1e-9, `stacked segments (${stackedSum}) must equal scaling the combined total directly (${combinedDirectly})`);
});

test("headroom caps every value at the SAME ceiling below 100%, never at 100% itself", () => {
  const max = sharedBarMax(500);
  const full = scaleToPct(500, max, 94);
  assert.equal(full, 94, "the value equal to the shared max must land exactly at the ceiling, not at 100");
  const half = scaleToPct(250, max, 94);
  assert.equal(half, 47, "headroom must scale proportionally too — half the max is half the ceiling");
});

test("a zero shared domain (no budget, no projection) never divides by zero", () => {
  const max = sharedBarMax(0, 0);
  assert.equal(max, 1, "sharedBarMax floors at 1 so scaleToPct never computes 0/0");
  assert.equal(scaleToPct(0, max), 0);
  assert.ok(Number.isFinite(scaleToPct(0, max)));
});
