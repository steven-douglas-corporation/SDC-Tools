import test from "node:test";
import assert from "node:assert/strict";
import {
  partsCostCellState,
  partsCostEffectiveNewEtc,
  isPartsCostDecided,
  partsCostDiff,
  newEtcSeedText,
  isNewEtcCellDecided,
  type NewEtcEntryLike,
  type PartsCostLive,
} from "@/lib/etc";
import { usesPartsApproval, showsPartsBreakout } from "@/lib/parts-breakout-scope";
import { calcLeftToPurchase, partsNewEtc } from "@/lib/left-to-invoice";

// Left to Purchase approval flow — November 2026 on (usesPartsApproval).

const row = (o: Partial<NewEtcEntryLike> = {}): NewEtcEntryLike => ({
  needsReview: true,
  newEtc: 0,
  newEtcDraft: null,
  newEtcClearedAt: null,
  submittedAt: null,
  priorEtc: 80_000,
  hoursWorked: 12_500,
  ...o,
});
const live = (breakoutSum: number | null, approval = true): PartsCostLive => ({ breakoutInScope: true, breakoutSum, approval });
const state = (e: NewEtcEntryLike, l: PartsCostLive) => partsCostCellState(e, l, { locked: false, monthComplete: true });

test("the approval flow starts in 2026-11 and applies to every later month", () => {
  assert.equal(usesPartsApproval("2026-10"), false);
  assert.equal(usesPartsApproval("2026-11"), true);
  assert.equal(usesPartsApproval("2026-12"), true);
  assert.equal(usesPartsApproval("2027-03"), true);
  assert.equal(usesPartsApproval("banana"), false);
  assert.equal(usesPartsApproval(null), false);
  // It is a refinement of the breakout months, never a way into them.
  for (const m of ["2026-11", "2027-06"]) assert.equal(showsPartsBreakout(m), true);
});

test("calculated Left to Purchase: Money Left − Left to Invoice, or the Prior carried forward when nothing was spent", () => {
  assert.equal(calcLeftToPurchase({ priorEtc: 80_000, spent: 12_500, leftToInvoice: 10_000 }), 57_500);
  // Over-spent: the formula is literal, so the figure is negative.
  assert.equal(calcLeftToPurchase({ priorEtc: 10_418, spent: 12_314, leftToInvoice: 2_268 }), -4_164);
  // A negative Left to Invoice adds to what is left to purchase.
  assert.equal(calcLeftToPurchase({ priorEtc: 10_512, spent: 104, leftToInvoice: -488 }), 10_896);
  // $0 spent: the Prior ETC straight across, whatever Left to Invoice says (or if it is unknown).
  assert.equal(calcLeftToPurchase({ priorEtc: 23_824, spent: 0, leftToInvoice: 5_000 }), 23_824);
  assert.equal(calcLeftToPurchase({ priorEtc: 23_824, spent: 0, leftToInvoice: null }), 23_824);
  // Nothing to subtract from: no calculation.
  assert.equal(calcLeftToPurchase({ priorEtc: 80_000, spent: 12_500, leftToInvoice: null }), null);
  // Cents are kept, floating-point residue is not.
  assert.equal(calcLeftToPurchase({ priorEtc: 100.1, spent: 0.2, leftToInvoice: 0.1 }), 99.8);
});

test("approved Left to Purchase makes an approved calculation leave New ETC equal to Money Left", () => {
  const invoice = 10_000;
  const calc = calcLeftToPurchase({ priorEtc: 80_000, spent: 12_500, leftToInvoice: invoice });
  const sum = partsNewEtc(invoice, calc);
  assert.equal(sum, 80_000 - 12_500);
  assert.equal(partsCostDiff(row(), live(sum)), 0);
});

test("approval month: New ETC is blank until Left to Purchase is approved — no draft, confirmed figure or carry-forward stands in", () => {
  // A saved draft and a confirmed figure are both ignored...
  const stale = row({ newEtcDraft: 60_000, submittedAt: new Date("2026-12-01T00:00:00Z"), newEtc: 59_000 });
  assert.equal(newEtcSeedText(state(stale, live(null))), "");
  assert.equal(isPartsCostDecided(stale, live(null)), false);
  assert.equal(partsCostEffectiveNewEtc(stale, live(null)), 0);
  assert.equal(partsCostDiff(stale, live(null)), 0);
  // ...and so is the zero-spend carry-forward: a $0 row is blank too, and needs an answer.
  const idle = row({ hoursWorked: 0, priorEtc: 23_824 });
  assert.equal(newEtcSeedText(state(idle, live(null))), "");
  assert.equal(isPartsCostDecided(idle, live(null)), false);
  assert.equal(isNewEtcCellDecided(state(idle, live(null)), ""), false);
  assert.equal(partsCostEffectiveNewEtc(idle, live(null)), 0);
});

test("approval month: once approved, New ETC is the live Left to Invoice + Left to Purchase and follows either half", () => {
  const e = row({ newEtcDraft: 60_000 });
  assert.equal(newEtcSeedText(state(e, live(61_705))), "61705");
  assert.equal(partsCostEffectiveNewEtc(e, live(61_705)), 61_705);
  assert.equal(isPartsCostDecided(e, live(61_705)), true);
  assert.equal(partsCostDiff(e, live(61_705)), 80_000 - 12_500 - 61_705);
  // A half moves later: the figure moves with it.
  assert.equal(partsCostEffectiveNewEtc(e, live(62_000)), 62_000);
  // A zero-spend row, once approved, is Left to Invoice + the approved figure.
  const idle = row({ hoursWorked: 0, priorEtc: 23_824 });
  assert.equal(partsCostEffectiveNewEtc(idle, live(23_824 + 0)), 23_824);
  assert.equal(isPartsCostDecided(idle, live(23_824)), true);
});

test("approval month: a frozen (submitted) row is its stored figure, whatever the halves say", () => {
  const frozen = row({ needsReview: false, newEtc: 59_000 });
  assert.equal(partsCostEffectiveNewEtc(frozen, live(1)), 59_000);
  assert.equal(partsCostEffectiveNewEtc(frozen, live(null)), 59_000);
});

test("before the approval month nothing changes: carry-forward and drafts still apply", () => {
  const idle = row({ hoursWorked: 0, priorEtc: 23_824 });
  assert.equal(newEtcSeedText(state(idle, live(null, false))), "23824");
  const stale = row({ newEtcDraft: 60_000 });
  assert.equal(partsCostEffectiveNewEtc(stale, live(null, false)), 60_000);
});
