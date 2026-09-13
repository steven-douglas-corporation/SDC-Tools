import { test } from "node:test";
import assert from "node:assert/strict";
import {
  publishEtcCell,
  publishPartsCell,
  forgetEtcCell,
  forgetPartsCell,
  readEtcLiveTotals,
  readEtcLiveFooterTotals,
  flushEtcLiveTotals,
} from "../src/lib/etc-live-totals";

// ── The delta equation (§44) ────────────────────────────────────────────────
//
//     newTotal − prevTotal === newCellValue − prevCellValue
//
// Reported live: the Parts Cost footer read $4,059,839, a manager typed $1 into one
// blank yellow cell, and it fell to $3,878,474 — down $181,365 on a $1 edit.
//
// The summation was never wrong. A BLANK cell published its suggestion (Money Left,
// $181,366 on that row) into the total, so the footer counted a figure the cell did not
// display, and typing $1 replaced $181,366 with $1.
//
// That is what these tests pin: a total may only contain what its column shows. The
// cells publish `decided ? value : 0`, so blank contributes nothing and every edit moves
// the total by exactly its own delta.
//
// Written against the STORE rather than the components, because the store is what every
// footer, KPI card and export reads — a component test would prove one caller.

const ETC = (over: Partial<Parameters<typeof publishEtcCell>[1]> = {}) => ({
  jobId: 1,
  billingGroup: "Engineering" as const,
  sectionCode: "10-211",
  prior: 100,
  worked: 20,
  hoursLeft: 80,
  effective: 0,
  diff: 0,
  decided: false,
  ...over,
});

function engNewEtc(): number {
  return readEtcLiveTotals().get(1)?.engineering.newEtc ?? 0;
}

function reset(keys: string[], jobs: number[] = []) {
  for (const k of keys) forgetEtcCell(k);
  for (const j of jobs) forgetPartsCell(j);
  flushEtcLiveTotals();
}

test("a blank cell contributes NOTHING, not its suggestion (§44 root cause)", () => {
  // The cell displays nothing, so the total must count nothing. Publishing the
  // suggestion here is the exact defect: 80 hours left would have been summed under a
  // box the manager can see is empty.
  publishEtcCell("a", ETC({ decided: false, effective: 0 }));
  flushEtcLiveTotals();
  assert.equal(engNewEtc(), 0);
  reset(["a"]);
});

test("blank -> 1 moves the total by exactly 1", () => {
  publishEtcCell("a", ETC({ decided: false, effective: 0 }));
  flushEtcLiveTotals();
  const before = engNewEtc();
  publishEtcCell("a", ETC({ decided: true, effective: 1, diff: 79 }));
  flushEtcLiveTotals();
  assert.equal(engNewEtc() - before, 1, "typing 1 into a blank cell must move the total by 1");
  reset(["a"]);
});

test("one edit never disturbs another row's contribution", () => {
  // The failure mode the report describes: editing one cell appearing to remove another
  // row's value. Two cells, one edited, the other must be untouched.
  publishEtcCell("a", ETC({ decided: true, effective: 500 }));
  publishEtcCell("b", ETC({ decided: false, effective: 0 }));
  flushEtcLiveTotals();
  const before = engNewEtc();
  assert.equal(before, 500);
  publishEtcCell("b", ETC({ decided: true, effective: 1 }));
  flushEtcLiveTotals();
  assert.equal(engNewEtc(), 501, "the untouched row must still contribute its 500");
  assert.equal(engNewEtc() - before, 1);
  reset(["a", "b"]);
});

test("every transition in §44 satisfies the delta equation", () => {
  // blank->1, 1->10, 10->0, 10->blank, 100->75. Each asserted as a DELTA, which is the
  // property a reader checks by eye.
  const steps: { decided: boolean; value: number; expectedDelta: number }[] = [
    { decided: true, value: 1, expectedDelta: 1 }, // blank -> 1
    { decided: true, value: 10, expectedDelta: 9 }, // 1 -> 10
    { decided: true, value: 0, expectedDelta: -10 }, // 10 -> 0  (zero is a VALUE)
    { decided: true, value: 10, expectedDelta: 10 }, // 0 -> 10
    { decided: false, value: 0, expectedDelta: -10 }, // 10 -> blank
    { decided: true, value: 100, expectedDelta: 100 }, // blank -> 100
    { decided: true, value: 75, expectedDelta: -25 }, // 100 -> 75
  ];
  publishEtcCell("a", ETC({ decided: false, effective: 0 }));
  flushEtcLiveTotals();
  for (const s of steps) {
    const before = engNewEtc();
    publishEtcCell("a", ETC({ decided: s.decided, effective: s.value }));
    flushEtcLiveTotals();
    assert.equal(engNewEtc() - before, s.expectedDelta, `transition to ${s.decided ? s.value : "blank"}`);
  }
  reset(["a"]);
});

test("zero is a decided value, distinct from blank", () => {
  // "a section planned at zero has been answered" — so 0 counts as decided and
  // contributes 0, while blank contributes 0 but is NOT decided. The totals agree; the
  // distinction matters to the yellow rule and to Diff.
  publishEtcCell("a", ETC({ decided: true, effective: 0, diff: 80 }));
  flushEtcLiveTotals();
  const t = readEtcLiveTotals().get(1)!.engineering;
  assert.equal(t.newEtc, 0);
  assert.equal(t.diff, 80, "a decided zero DOES contribute a variance");
  reset(["a"]);
});

test("Parts Cost obeys the same equation, on the reported numbers", () => {
  // The live case: Money Left $181,366, blank cell, then $1 typed.
  publishPartsCell(7, { prior: 200000, spent: 18634, left: 181366, newEtc: 0, diff: 0, decided: false });
  flushEtcLiveTotals();
  const before = readEtcLiveFooterTotals().parts.newEtc;
  assert.equal(before, 0, "a blank Parts cell must not contribute Money Left");

  publishPartsCell(7, { prior: 200000, spent: 18634, left: 181366, newEtc: 1, diff: 181365, decided: true });
  flushEtcLiveTotals();
  const after = readEtcLiveFooterTotals();
  assert.equal(after.parts.newEtc - before, 1, "typing $1 must move the New ETC total by $1");
  assert.equal(after.parts.diff, 181365, "and the Diff total by the row's own Diff");
  reset([], [7]);
});

test("clearing removes only that cell's value", () => {
  publishEtcCell("a", ETC({ decided: true, effective: 40 }));
  publishEtcCell("b", ETC({ decided: true, effective: 60 }));
  flushEtcLiveTotals();
  assert.equal(engNewEtc(), 100);
  publishEtcCell("b", ETC({ decided: false, effective: 0 }));
  flushEtcLiveTotals();
  assert.equal(engNewEtc(), 40, "clearing b must leave a's 40 intact");
  reset(["a", "b"]);
});

test("a cell unmounting takes only its own contribution", () => {
  // Month switch / filter change: cells tear down. The remaining rows must be unchanged.
  publishEtcCell("a", ETC({ decided: true, effective: 40 }));
  publishEtcCell("b", ETC({ decided: true, effective: 60 }));
  flushEtcLiveTotals();
  forgetEtcCell("b");
  flushEtcLiveTotals();
  assert.equal(engNewEtc(), 40);
  reset(["a"]);
});

test("republishing the same value is a no-op, so repeats cannot double-count", () => {
  publishEtcCell("a", ETC({ decided: true, effective: 25 }));
  flushEtcLiveTotals();
  for (let i = 0; i < 5; i++) publishEtcCell("a", ETC({ decided: true, effective: 25 }));
  flushEtcLiveTotals();
  assert.equal(engNewEtc(), 25, "rapid repeated edits of the same value must not accumulate");
  reset(["a"]);
});

test("totals are keyed by job, not by insertion order or index", () => {
  // §44's stable-identity requirement. Two jobs, published out of order, each keeps its
  // own contribution.
  publishEtcCell("x", ETC({ jobId: 2, decided: true, effective: 7 }));
  publishEtcCell("y", ETC({ jobId: 1, decided: true, effective: 3 }));
  flushEtcLiveTotals();
  const totals = readEtcLiveTotals();
  assert.equal(totals.get(1)!.engineering.newEtc, 3);
  assert.equal(totals.get(2)!.engineering.newEtc, 7);
  reset(["x", "y"]);
});
