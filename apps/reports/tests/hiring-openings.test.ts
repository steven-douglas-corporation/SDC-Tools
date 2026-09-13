import { test } from "node:test";
import assert from "node:assert/strict";
import { countOpenings, openingsFor, openingsSuffix, openingsSummary, type HasOpenings } from "../src/lib/hiring-openings";
import { hiringCapacityHours, hiringPositionCapacityHours } from "../src/lib/workforce-capacity";
import { annualCapacityHours } from "../src/lib/workforce-capacity-policy";

// One hiring position record can represent several openings (2026-08-24):
// `quantity` is how many were asked for, `filledCount` how many are hired
// against it, and quantity - filledCount is what still counts toward every
// hiring total and capacity figure.
//
// The year is pinned to 2026 throughout — workforce-capacity-policy.ts throws
// UnconfiguredYearError for a year with no policy, so a hardcoded year here is
// deliberate rather than derived from the clock.
const YEAR = 2026;

test("a position with no quantity at all counts as exactly one opening", () => {
  // The request's "existing hiring positions without a quantity value must
  // safely default to 1" — this is the pre-migration row, and the reason both
  // columns are NOT NULL DEFAULT rather than nullable.
  assert.equal(openingsFor({}), 1);
  assert.equal(openingsFor({ quantity: null, filledCount: null }), 1);
  assert.equal(countOpenings([{}, {}, {}]), 3);
});

test("quantity 2 is two openings, not one row", () => {
  assert.equal(openingsFor({ quantity: 2, filledCount: 0 }), 2);
  assert.equal(countOpenings([{ quantity: 2 }, { quantity: 1 }]), 3);
});

test("filling one opening on a quantity-2 position leaves one remaining", () => {
  assert.equal(openingsFor({ quantity: 2, filledCount: 1 }), 1);
});

test("filling every opening leaves zero — which is what closes the position", () => {
  assert.equal(openingsFor({ quantity: 2, filledCount: 2 }), 0);
  // And it contributes nothing to a total, so the requirement disappears from
  // hiring counts without the row being deleted or its status rewritten.
  assert.equal(countOpenings([{ quantity: 2, filledCount: 2 }]), 0);
});

test("remainingQuantity wins when present, so a real HiringPosition is never re-derived", () => {
  // hiring-positions.ts computes and clamps remainingQuantity; openingsFor must
  // trust it rather than recompute, or the two could disagree.
  assert.equal(openingsFor({ quantity: 5, filledCount: 1, remainingQuantity: 4 }), 4);
});

test("nonsense values clamp instead of poisoning a total", () => {
  // These should be impossible — hiring-actions.ts validates on write — but a
  // NaN or a negative reaching a sum would corrupt every figure on the page
  // rather than just this row, so they are floored here too.
  assert.equal(openingsFor({ quantity: 0 }), 1, "quantity 0 is meaningless; a row is at least one opening");
  assert.equal(openingsFor({ quantity: -3 }), 1);
  assert.equal(openingsFor({ quantity: 2, filledCount: 99 }), 0, "cannot fill more than were asked for");
  assert.equal(openingsFor({ quantity: 2, filledCount: -1 }), 2);
  assert.equal(openingsFor({ quantity: Number.NaN }), 1);
});

test("capacity hours for a quantity-N position are exactly N times one person's", () => {
  // The request's formula: "Capacity for 1 person based on start date x Quantity".
  const one = hiringPositionCapacityHours(null, YEAR, 1);
  assert.equal(one, annualCapacityHours(YEAR));
  assert.equal(hiringPositionCapacityHours(null, YEAR, 2), one * 2);
  assert.equal(hiringPositionCapacityHours(null, YEAR, 7), one * 7);
});

test("a mid-year start date is prorated FIRST, then multiplied", () => {
  // Not the other way around, and not a multiply of an already-rounded figure:
  // a x7 position has to equal 7x the single-opening number shown beside it.
  const start = new Date(Date.UTC(YEAR, 6, 1)); // July
  const one = hiringPositionCapacityHours(start, YEAR, 1);
  assert.ok(one > 0 && one < annualCapacityHours(YEAR), "a July start is part of a year, not all or none of it");
  assert.equal(hiringPositionCapacityHours(start, YEAR, 3), Math.round(one * 3 * 10) / 10);
});

test("hiringCapacityHours weights each position by its REMAINING openings", () => {
  const one = annualCapacityHours(YEAR);
  // 2 openings, 1 filled -> 1 remaining. The filled one is a real employee now
  // and is counted under Current capacity; counting it here too would double it.
  assert.equal(hiringCapacityHours([{ expectedStartDate: null, remainingQuantity: 1 }], YEAR), one);
  assert.equal(hiringCapacityHours([{ expectedStartDate: null, remainingQuantity: 2 }], YEAR), one * 2);
});

test("hiringCapacityHours treats a position with no remainingQuantity as one opening", () => {
  // Keeps every pre-quantity caller — and any caller holding a plain
  // {expectedStartDate} shape — behaving exactly as it did before.
  assert.equal(hiringCapacityHours([{ expectedStartDate: null }], YEAR), annualCapacityHours(YEAR));
  assert.equal(
    hiringCapacityHours([{ expectedStartDate: null }, { expectedStartDate: null }], YEAR),
    hiringCapacityHours([{ expectedStartDate: null, remainingQuantity: 2 }], YEAR),
    "two single-opening positions must equal one position of quantity 2",
  );
});

test("a fully filled position contributes no capacity hours", () => {
  assert.equal(hiringCapacityHours([{ expectedStartDate: null, remainingQuantity: 0 }], YEAR), 0);
});

test("the display suffix marks multi-opening positions and stays silent on ordinary ones", () => {
  // "Show the quantity clearly when greater than 1" — a "x1" on every row
  // would make the multi-opening ones harder to spot, not easier.
  assert.equal(openingsSuffix(1), "");
  assert.equal(openingsSuffix(null), "");
  assert.equal(openingsSuffix(undefined), "");
  assert.equal(openingsSuffix(2), " ×2");
  assert.equal(openingsSuffix(12), " ×12");
});

test("the long summary reports filled and remaining once anything is filled", () => {
  assert.equal(openingsSummary({ quantity: 1, filledCount: 0 }), "", "nothing interesting to say about a single opening");
  assert.equal(openingsSummary({ quantity: 2, filledCount: 0 }), "2 openings");
  assert.equal(openingsSummary({ quantity: 2, filledCount: 1 }), "2 openings · 1 filled · 1 remaining");
  assert.equal(openingsSummary({ quantity: 3, filledCount: 3 }), "3 openings · 3 filled · 0 remaining");
});

// ── The request's own verification list, as one end-to-end arithmetic check ──
test("verification: one Mechanical Engineer position with Quantity 2", () => {
  const positions = [{ expectedStartDate: null, quantity: 2, filledCount: 0, remainingQuantity: 2 }];

  // 2. one record, not two
  assert.equal(positions.length, 1, "one hiring-position record");
  // 3. hiring totals increase by 2, not 1
  assert.equal(countOpenings(positions), 2);
  // 4. capacity equals 2x one Mechanical Engineer
  assert.equal(hiringCapacityHours(positions, YEAR), annualCapacityHours(YEAR) * 2);

  // 5. hire one -> remaining becomes 1, and the record still exists
  const afterOne = [{ ...positions[0], filledCount: 1, remainingQuantity: 1 }];
  assert.equal(countOpenings(afterOne), 1);
  assert.equal(hiringCapacityHours(afterOne, YEAR), annualCapacityHours(YEAR));

  // 6. fill the second -> the requirement closes out entirely
  const afterBoth = [{ ...positions[0], filledCount: 2, remainingQuantity: 0 }];
  assert.equal(countOpenings(afterBoth), 0);
  assert.equal(hiringCapacityHours(afterBoth, YEAR), 0);

  // 7. a quantity-1 position behaves exactly as before.
  //
  // Typed as the intersection rather than left inferred: HasOpenings is an
  // all-optional ("weak") type, so TypeScript rejects a bare
  // {expectedStartDate} object as having nothing in common with it. That check
  // is worth keeping — it is what stops an unrelated array being summed as
  // openings — so the annotation says "this is a position that happens to carry
  // no quantity fields", which is exactly the pre-migration row being modelled.
  const single: (HasOpenings & { expectedStartDate: Date | null })[] = [{ expectedStartDate: null }];
  assert.equal(countOpenings(single), 1);
  assert.equal(hiringCapacityHours(single, YEAR), annualCapacityHours(YEAR));
});
