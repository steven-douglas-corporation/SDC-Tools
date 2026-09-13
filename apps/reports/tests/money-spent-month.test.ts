import { test } from "node:test";
import assert from "node:assert/strict";
import { monthWindowUtc, effectiveNewEtc, isNewEtcDecided, newEtcDiff, calcHoursLeft, round2 } from "../src/lib/etc";

// Money Spent Month (§41.28). The SQL itself needs a live TotalETO connection and is
// proven by scripts/parts-spent-recon.ts against the Total ETO pivot (31 of 35 jobs to
// the dollar, $420,616 vs $420,656). What is unit-testable — and what actually broke in
// the past — is the month WINDOW and the blank-New-ETC arithmetic on top of the figure.

test("the window is half-open, so the 1st is in and the next 1st is out", () => {
  // §41.3's rule verbatim: PurchaseDate >= July 1 AND < August 1.
  const { start, endExclusive } = monthWindowUtc("2026-07");
  assert.equal(start.toISOString(), "2026-07-01T00:00:00.000Z");
  assert.equal(endExclusive.toISOString(), "2026-08-01T00:00:00.000Z");

  const inMonth = (iso: string) => {
    const d = new Date(iso);
    return d >= start && d < endExclusive;
  };
  assert.ok(inMonth("2026-07-01T00:00:00.000Z"), "midnight on the 1st belongs to the month");
  assert.ok(inMonth("2026-07-31T23:59:59.999Z"), "the last instant of the 31st belongs to the month");
  assert.ok(!inMonth("2026-08-01T00:00:00.000Z"), "midnight on the 1st of the NEXT month does not");
  assert.ok(!inMonth("2026-06-30T23:59:59.999Z"), "the last instant of June does not");
});

test("December rolls into the next YEAR, not month 13", () => {
  // The case an inline `new Date(Date.UTC(y, m, 1))` gets right by accident and a
  // hand-rolled `${y}-${m+1}` gets wrong.
  const { start, endExclusive } = monthWindowUtc("2026-12");
  assert.equal(start.toISOString(), "2026-12-01T00:00:00.000Z");
  assert.equal(endExclusive.toISOString(), "2027-01-01T00:00:00.000Z");
});

test("January's window starts the year, and every month is contiguous with the next", () => {
  const jan = monthWindowUtc("2026-01");
  assert.equal(jan.start.toISOString(), "2026-01-01T00:00:00.000Z");
  // No gaps and no overlaps across a whole year: one month's end IS the next one's start,
  // which is what guarantees a purchase lands in exactly one reporting month.
  for (let m = 1; m <= 11; m++) {
    const a = monthWindowUtc(`2026-${String(m).padStart(2, "0")}`);
    const b = monthWindowUtc(`2026-${String(m + 1).padStart(2, "0")}`);
    assert.equal(a.endExclusive.getTime(), b.start.getTime(), `month ${m} must abut month ${m + 1}`);
  }
});

test("an invalid month throws rather than producing a nonsense window", () => {
  // A malformed month reaching date arithmetic silently produces an Invalid Date and a
  // window that matches nothing — a month that reports $0 rather than an error.
  for (const bad of ["2026-13", "2026-00", "26-07", "2026-7", "", "July"]) {
    assert.throws(() => monthWindowUtc(bad), /not a valid month/, `${JSON.stringify(bad)} must throw`);
  }
});

// ── §41.10 — what sits on TOP of Money Spent Month ──────────────────────────
//
// The rule §41.10 asks for is the rule that ships: an undecided New ETC contributes
// NOTHING to Diff. `newEtcDiff` returns 0 for it (etc.ts, third and final revision of a
// rule that has been wrong in both directions), and the CELL tells 0-because-undecided
// apart from a real 0 by calling `isNewEtcDecided` itself — which is why the box prints
// empty rather than "0", and why Money Left is never shown in the Diff column.
//
// 0 rather than null is deliberate: every caller that SUMS this — row totals, grand
// totals, the KPI strip, the live store — stays on one numeric type, and "adds nothing"
// and "is nothing" are the same thing to a sum.
//
// Pinned here because this is money and the rule has been reverted twice.

test("Money Left is Prior minus Spent, and is not clamped at zero", () => {
  assert.equal(calcHoursLeft(10000, 2500), 7500);
  // Overspent is a real state and hiding it would be the point of the column lost.
  assert.equal(calcHoursLeft(1000, 2500), -1500);
});

test("a credit makes Money Spent negative, and Money Left exceeds the budget", () => {
  // The pivot nets credit memos ($2,584 across 7 jobs in July), so a job whose only
  // activity in a month is a return legitimately reports negative spend — and the
  // budget left goes UP.
  assert.equal(calcHoursLeft(1000, -300), 1300);
});

test("an undecided cell contributes nothing to Diff, and Diff is never Money Left", () => {
  // `needsReview: true` with no draft is the yellow, untouched cell.
  const blank = { needsReview: true, priorEtc: 10000, hoursWorked: 2500, newEtc: 0, newEtcDraft: null };
  assert.equal(isNewEtcDecided(blank), false);
  // effectiveNewEtc still answers "what would this month be if submitted as-is", which is
  // the suggestion — that is what carries forward into next month's Prior ETC.
  assert.equal(effectiveNewEtc(blank), 7500);
  // §41.10's requirement: NOT computed as though New ETC were zero (which would give
  // 7500 - 0 = 7500, i.e. Money Left printed as a variance), and NOT Money Left. It
  // contributes nothing, and the cell renders empty because isNewEtcDecided is false.
  assert.equal(round2(newEtcDiff(blank)), 0);
  assert.notEqual(round2(newEtcDiff(blank)), round2(calcHoursLeft(10000, 2500)), "Diff must never equal Money Left for a blank cell");
});

test("even an OVERSPENT undecided cell reports no variance", () => {
  // The trap this closes: comparing an undecided cell against the SUGGESTION turned every
  // overspent-but-untouched cell into an invented overrun. Measured 2026-07-31, that was
  // -1,065 of Engineering's -1,071 with exactly ONE of 241 cells actually decided.
  // A number nobody entered must not be reported as their overrun.
  const over = { needsReview: true, priorEtc: 160, hoursWorked: 167, newEtc: 0, newEtcDraft: null };
  assert.equal(round2(newEtcDiff(over)), 0);
});

test("a decided New ETC produces Diff = Money Left - New ETC", () => {
  const decided = { needsReview: true, priorEtc: 10000, hoursWorked: 2500, newEtc: 0, newEtcDraft: 5000 };
  assert.equal(isNewEtcDecided(decided), true);
  assert.equal(effectiveNewEtc(decided), 5000);
  assert.equal(round2(newEtcDiff(decided)), round2(calcHoursLeft(10000, 2500) - 5000));
  assert.equal(round2(newEtcDiff(decided)), 2500);
});

test("Diff goes negative when the plan exceeds what is left", () => {
  const over = { needsReview: true, priorEtc: 1000, hoursWorked: 900, newEtc: 0, newEtcDraft: 500 };
  assert.equal(round2(newEtcDiff(over)), -400, "planning 500 against 100 left is a 400 overrun");
});

test("a SUBMITTED cell reports its confirmed value, not a draft or a suggestion", () => {
  // needsReview false = the month was submitted; newEtc is the decided figure.
  const submitted = { needsReview: false, priorEtc: 10000, hoursWorked: 2500, newEtc: 4200, newEtcDraft: 9999 };
  assert.equal(isNewEtcDecided(submitted), true);
  assert.equal(effectiveNewEtc(submitted), 4200, "a stale draft must not outrank the submitted value");
});
