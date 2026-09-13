import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcileRounding } from "../src/lib/rounding";

// The generic "largest remainder" rounding reconciliation, extracted so both
// Parts Cost (parts-cost-financials-shared.ts's reconcilePartsCostRounding,
// now a thin re-export of this) and the Hours tab (hours-filters.ts's
// reconcileGroupRowHours) share ONE implementation instead of two.

test("independently-rounded parts can disagree with a separately-rounded total — the bug this exists to fix", () => {
  const parts = [10.4, 10.4, 10.4];
  const naiveSum = parts.reduce((s, p) => s + Math.round(p), 0);
  const realTotal = Math.round(parts.reduce((s, p) => s + p, 0));
  assert.notEqual(naiveSum, realTotal, "sanity: naive independent rounding really does disagree with rounding the sum");
});

test("reconciled parts always sum to exactly the (default) rounded total", () => {
  const parts = [10.4, 10.4, 10.4];
  const result = reconcileRounding(parts);
  assert.equal(result.reduce((s, p) => s + p, 0), Math.round(parts.reduce((s, p) => s + p, 0)));
});

test("every result is a whole number", () => {
  const result = reconcileRounding([23207.616, 101371.554, 189298.04]);
  for (const v of result) assert.equal(v, Math.round(v));
});

test("an explicit targetTotal is honored exactly, even when it differs from the parts' own rounded sum", () => {
  // The shape this exists for: a child level reconciling against its PARENT's
  // own already-displayed (possibly ±1-adjusted) figure, not a fresh rounding
  // of the children's own raw sum.
  const parts = [5.4, 5.4]; // naive sum rounds to 11 on its own (5.4+5.4=10.8 -> 11)
  const result = reconcileRounding(parts, 12); // parent says 12
  assert.equal(result.reduce((s, p) => s + p, 0), 12, "must hit the EXTERNAL target, not the parts' own rounding");
});

test("no result is off from its own raw value by more than 1", () => {
  const parts = [1.9, 2.9, 3.9, 4.9];
  const result = reconcileRounding(parts);
  parts.forEach((p, i) => {
    assert.ok(Math.abs(result[i] - p) < 1, `part ${i}: ${p} -> ${result[i]} is off by more than one unit of rounding`);
  });
});

test("an empty array reconciles to an empty array, never throws", () => {
  assert.deepEqual(reconcileRounding([]), []);
  assert.deepEqual(reconcileRounding([], 5), []);
});

test("a single part reconciles to its own rounded value", () => {
  assert.deepEqual(reconcileRounding([7.6]), [8]);
});

test("the largest remainders absorb the leftover units, not the first N parts arbitrarily", () => {
  // 0.9 and 0.1 both floor to 0; the leftover unit from rounding 1.0's total up
  // must go to the 0.9 (the larger remainder), not to 0.1 just because it's first.
  const result = reconcileRounding([0.1, 0.9]);
  assert.deepEqual(result, [0, 1]);
});
