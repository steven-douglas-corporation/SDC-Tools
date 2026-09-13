import { test } from "node:test";
import assert from "node:assert/strict";
import { barDomains, barHeightPct, type ScalableRow } from "../src/lib/bar-scale";

// The invariants the Estimate-to-Complete-vs-Actual chart must hold. A
// square-root curve broke them once (added, then reverted 2026-08-20); these
// tests are what stop that happening quietly again.

const row = (planned: number, actual: number, isTotal = false): ScalableRow => ({ planned, actual, isTotal });

// The live 59-job selection, reduced to what drives the scale: the tallest
// section is 24,540h and the tallest billing-group Total is 84,236h. Those are
// real figures, and 13,409 / 20,173 / 24,540 are the values that prompted the
// request.
const REAL_SECTIONS = [row(13409, 9000), row(20173, 15000), row(24540, 18000)];
const REAL_TOTALS = [row(84236, 60000, true)];

test("equal values give equal heights", () => {
  const d = barDomains([row(500, 500), row(900, 100)]);
  assert.equal(barHeightPct(500, false, d), barHeightPct(500, false, d));
  // Across rows, too — a section's height depends only on its value.
  assert.equal(barHeightPct(100, false, d), barHeightPct(100, false, d));
});

test("a larger value is always proportionally taller — the property a curve breaks", () => {
  const d = barDomains(REAL_SECTIONS);
  // Height ratio must equal value ratio, not merely be ordered. A sqrt curve
  // passes an ordering check and fails this one.
  const ratio = barHeightPct(13409, false, d) / barHeightPct(24540, false, d);
  assert.ok(Math.abs(ratio - 13409 / 24540) < 1e-9, `height ratio ${ratio} must equal value ratio ${13409 / 24540}`);

  // And monotonic across the whole range, at fine granularity.
  let prev = -1;
  for (let v = 0; v <= 24540; v += 613) {
    const h = barHeightPct(v, false, d);
    assert.ok(h > prev, `height must strictly increase with value (at ${v})`);
    prev = h;
  }
});

test("the tallest section fills the plot area — no headroom left unused", () => {
  const d = barDomains(REAL_SECTIONS);
  assert.equal(barHeightPct(24540, false, d), 100);
});

test("Totals no longer squash the sections — the reported bug", () => {
  const withTotals = barDomains([...REAL_SECTIONS, ...REAL_TOTALS]);
  // On one shared scale the tallest section reached only 29% of the plot.
  const shared = (24540 / 84236) * 100;
  assert.ok(shared < 30, "sanity: the old shared scale really was that compressed");
  // Now it reaches 100%, and every section grows by the same factor — which is
  // what makes it a rescale rather than a distortion.
  assert.equal(barHeightPct(24540, false, withTotals), 100);
  const factor = barHeightPct(13409, false, withTotals) / ((13409 / 84236) * 100);
  const factor2 = barHeightPct(20173, false, withTotals) / ((20173 / 84236) * 100);
  assert.ok(Math.abs(factor - factor2) < 1e-9, "every section is scaled by the identical factor");
  assert.ok(factor > 3.4 && factor < 3.5, `expected ~3.43x taller, got ${factor}`);
});

test("Totals stay honest against each other", () => {
  // The comparison that matters in the Total band: Engineering vs Shop.
  const rows = [row(1000, 900), row(60000, 50000, true), row(30000, 20000, true)];
  const d = barDomains(rows);
  assert.equal(barHeightPct(60000, true, d), 100);
  assert.equal(barHeightPct(30000, true, d), 50, "half the value is half the bar");
});

test("a section's height is unaffected by how large the Totals are", () => {
  // The whole point: adding or growing a Total must not shrink the detail bars.
  const withoutTotals = barDomains(REAL_SECTIONS);
  const withTotals = barDomains([...REAL_SECTIONS, ...REAL_TOTALS]);
  const withHugeTotal = barDomains([...REAL_SECTIONS, row(9_000_000, 8_000_000, true)]);
  for (const v of [13409, 20173, 24540]) {
    assert.equal(barHeightPct(v, false, withTotals), barHeightPct(v, false, withoutTotals));
    assert.equal(barHeightPct(v, false, withHugeTotal), barHeightPct(v, false, withoutTotals));
  }
});

test("zero maps to zero, with no minimum-height floor", () => {
  // A section with no hours must read as absent rather than being nudged up to
  // look present.
  const d = barDomains(REAL_SECTIONS);
  assert.equal(barHeightPct(0, false, d), 0);
  assert.equal(barHeightPct(0, true, d), 0);
});

test("negatives clamp to zero rather than hanging below the baseline", () => {
  const d = barDomains(REAL_SECTIONS);
  assert.equal(barHeightPct(-5000, false, d), 0);
});

test("all-zero data renders flat, not NaN", () => {
  const d = barDomains([row(0, 0), row(0, 0, true)]);
  assert.equal(d.detailMax, 1);
  assert.equal(d.totalMax, 1);
  assert.equal(barHeightPct(0, false, d), 0);
  assert.ok(Number.isFinite(barHeightPct(0, true, d)));
});

test("a chart with no Total rows still scales its sections to full height", () => {
  // The "Total" pill hides that band entirely; the sections must not change.
  const d = barDomains(REAL_SECTIONS);
  assert.equal(d.totalMax, 1, "no total rows leaves the total domain at its floor");
  assert.equal(barHeightPct(24540, false, d), 100);
});

test("no bar can exceed the plot area", () => {
  const d = barDomains([...REAL_SECTIONS, ...REAL_TOTALS]);
  for (const r of [...REAL_SECTIONS, ...REAL_TOTALS]) {
    assert.ok(barHeightPct(r.planned, r.isTotal, d) <= 100);
    assert.ok(barHeightPct(r.actual, r.isTotal, d) <= 100);
  }
});
