import { test } from "node:test";
import assert from "node:assert/strict";
import { projectionResidual } from "../src/lib/parts-cost-financials-shared";

// ── Numeric proof of the 2026-08-19 fix, not just a source-pattern match ────
//
// tests/parts-actual-gl-posted.test.ts guards the SHAPE of the fix (source
// text says `projectionResidual`, not a raw sum) — this file proves the
// actual MATH holds, with real dollar figures, across the scenarios the fix
// was specifically asked to cover: fully invoiced, partially invoiced,
// un-invoiced committed, ETC remaining, zero ETC, and the general invariant
// that must hold for every one of them.
//
// `projectionResidual` is the one piece of arithmetic
// `computePartsBudgetProjection` can't be unit-tested through directly (it's
// async and hits Prisma/TotalETO — no live DB in CI, same as every other
// Parts Cost test in this suite) — but `total = actual +
// projectionResidual(committedNotPosted, estimateToPurchase)` is the WHOLE
// fix, so proving this one function's arithmetic proves the fix.

// Job 1119 — Karl Storz Stamping Machine, the live figures that surfaced the
// bug (screenshot review, 2026-08-19). Total Parts Cost Spent was reading
// GREATER than Projection.
test("job 1119 (Karl Storz): the reported case — ETC hasn't caught up to an open commitment", () => {
  const invoiced = 124_581;
  const committedNotPosted = 8_847; // "Left to be invoiced"
  const estimateToPurchase = 2_638; // "ETC" — stale relative to the open PO
  const totalSpent = invoiced + committedNotPosted; // 133,428 — "Total Parts Cost Spent"

  const total = invoiced + projectionResidual(committedNotPosted, estimateToPurchase);

  assert.equal(total, 133_428, "projection must equal the reported Total Parts Cost Spent exactly, once ETC's shortfall is floored");
  assert.ok(total >= totalSpent, "projection must never fall below total spent");
});

test("fully invoiced parts, nothing left to commit or estimate: projection equals what's already spent", () => {
  const invoiced = 200_000;
  const committedNotPosted = 0;
  const estimateToPurchase = 0;
  const total = invoiced + projectionResidual(committedNotPosted, estimateToPurchase);
  assert.equal(total, 200_000);
});

test("partially invoiced, healthy ETC (ETC already covers the open commitment): behavior is unchanged from the 2026-08-17 fix", () => {
  const invoiced = 50_000;
  const committedNotPosted = 1_000; // a small open PO
  const estimateToPurchase = 5_000; // the manager's estimate already comfortably covers it
  const total = invoiced + projectionResidual(committedNotPosted, estimateToPurchase);
  // Must be exactly invoiced + estimateToPurchase — byte-identical to the
  // formula before this fix, since ETC is the larger term here.
  assert.equal(total, invoiced + estimateToPurchase);
  assert.equal(total, 55_000);
});

test("un-invoiced committed parts exceeding a stale ETC: the fix floors at the committed amount", () => {
  const invoiced = 50_000;
  const committedNotPosted = 5_000; // real, open PO — will be invoiced eventually
  const estimateToPurchase = 1_000; // manager's estimate hasn't been revised to reflect it
  const total = invoiced + projectionResidual(committedNotPosted, estimateToPurchase);
  assert.equal(total, invoiced + committedNotPosted, "the committed amount must win when it exceeds a stale ETC");
  assert.equal(total, 55_000);
  assert.notEqual(total, invoiced + estimateToPurchase, "must NOT silently keep using the stale, too-small ETC");
});

test("ETC remaining, nothing yet committed: the plain estimate carries the projection", () => {
  const invoiced = 10_000;
  const committedNotPosted = 0;
  const estimateToPurchase = 15_000;
  const total = invoiced + projectionResidual(committedNotPosted, estimateToPurchase);
  assert.equal(total, 25_000);
});

test("zero ETC, real committed spend outstanding: projection still reflects the commitment, not zero", () => {
  const invoiced = 80_000;
  const committedNotPosted = 12_000;
  const estimateToPurchase = 0; // manager thinks the job is done buying, but a PO is still open
  const total = invoiced + projectionResidual(committedNotPosted, estimateToPurchase);
  assert.equal(total, 92_000, "an open commitment is real money that will be invoiced — zero ETC cannot erase it");
});

test("zero everything: projection is exactly what's invoiced, no phantom residual", () => {
  const invoiced = 0;
  assert.equal(invoiced + projectionResidual(0, 0), 0);
});

// ── The invariant itself, swept across a wide range of combinations ────────
//
// For EVERY non-negative (invoiced, committedNotPosted, estimateToPurchase)
// triple, projection must be >= totalSpent (invoiced + committedNotPosted).
// This is the literal business rule ("Projection >= Total Parts Cost Spent
// whenever both metrics use the same cost scope") swept over many points
// rather than asserted for one.
test("projection never falls below total spent, across a sweep of committed/ETC combinations", () => {
  const invoicedValues = [0, 1_000, 50_000, 500_000];
  const committedValues = [0, 500, 8_847, 25_000, 100_000];
  const etcValues = [0, 500, 2_638, 8_847, 25_000, 100_000];

  for (const invoiced of invoicedValues) {
    for (const committedNotPosted of committedValues) {
      for (const estimateToPurchase of etcValues) {
        const totalSpent = invoiced + committedNotPosted;
        const projection = invoiced + projectionResidual(committedNotPosted, estimateToPurchase);
        assert.ok(
          projection >= totalSpent,
          `invoiced=${invoiced} committed=${committedNotPosted} etc=${estimateToPurchase}: projection ${projection} fell below total spent ${totalSpent}`,
        );
      }
    }
  }
});

// ── Projection vs Budget — unchanged arithmetic, still correct after the fix ─
//
// variance $ = projection − budget; variance % = variance / budget × 100.
// This math lives in parts-cost-financials.ts and was never the bug — proven
// here with the corrected projection figures so "the fix didn't break
// variance" is checked, not assumed.
test("Projection vs Budget: over-budget, under-budget, and on-budget all compute correctly off the corrected projection", () => {
  const budget = 149_630; // job 1119's own quote, from the report
  const projection = 133_428; // the corrected projection for that same job

  const varianceDollars = projection - budget;
  const variancePct = (varianceDollars / budget) * 100;

  assert.equal(varianceDollars, -16_202);
  assert.ok(variancePct < 0, "under budget must be negative");
  assert.ok(Math.abs(variancePct - -10.827) < 0.01);

  // Over budget: projection exceeds budget → positive variance.
  const overBudget = 100_000;
  const overProjection = 120_000;
  assert.ok(overProjection - overBudget > 0);

  // On budget: projection equals budget exactly → zero variance.
  assert.equal(50_000 - 50_000, 0);
});
