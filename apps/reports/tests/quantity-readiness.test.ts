import { test } from "node:test";
import assert from "node:assert/strict";
import { quantityReadiness } from "../src/lib/job-bom-rules";

// ── quantityReadiness — the one formula every readiness % in this app must
// use (Build Readiness's project-level number, JobProcurement.tsx's own
// summary, and every per-assembly statsForRoots pct) ────────────────────────
//
// The defect this replaces: line-count coverage (received LINES / total
// LINES) treated a 99%-received-by-quantity line identically to a 0%-received
// one, and let a single trivial fully-covered line count the same as a
// large, mostly-uncovered one. Confirmed distorting real jobs by double
// digits (2026-08-17 live audit).

test("a single line partially received by quantity scores proportionally, not as a binary miss", () => {
  const r = quantityReadiness([{ qty: 100, receivedQty: 99 }]);
  assert.equal(r.requiredQty, 100);
  assert.equal(r.coveredQty, 99);
  assert.equal(r.pct, 99, "99/100 received must read as 99%, not 0% the way line-count coverage would");
});

test("quantity weighting: a large required-qty line dominates several small fully-covered lines", () => {
  // Line-count coverage would read this as 3/4 = 75%. Quantity-weighted, the
  // one large, mostly-uncovered line (qty 1000, only 10 received) dominates.
  const r = quantityReadiness([
    { qty: 1000, receivedQty: 10 },
    { qty: 1, receivedQty: 1 },
    { qty: 1, receivedQty: 1 },
    { qty: 1, receivedQty: 1 },
  ]);
  assert.equal(r.requiredQty, 1003);
  assert.equal(r.coveredQty, 13);
  assert.equal(r.pct, 1, "13/1003 rounds to 1%, nowhere near line-count coverage's 75%");
});

test("an over-received/over-ordered line is capped at its own required qty, never inflating past 100", () => {
  const r = quantityReadiness([
    { qty: 10, receivedQty: 25 }, // over-shipped
    { qty: 10, receivedQty: 0 },
  ]);
  assert.equal(r.coveredQty, 10, "the over-shipped line contributes at most its own required qty");
  assert.equal(r.pct, 50, "the overage must not mask the second line's shortfall");
});

test("zero parts (or zero total required qty) resolves to 0%, not 100% or NaN", () => {
  assert.equal(quantityReadiness([]).pct, 0);
  assert.equal(quantityReadiness([{ qty: 0, receivedQty: 0 }]).pct, 0);
});

test("fully covered resolves to exactly 100%", () => {
  const r = quantityReadiness([
    { qty: 5, receivedQty: 5 },
    { qty: 3, receivedQty: 3 },
  ]);
  assert.equal(r.pct, 100);
});
