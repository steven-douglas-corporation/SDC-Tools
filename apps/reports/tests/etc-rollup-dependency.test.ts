import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calcHoursLeft,
  hasNewEtcValue,
  isNewEtcCellDecided,
  newEtcSeedText,
  rollupNewEtc,
  type NewEtcCellState,
  type NewEtcRollupCell,
} from "../src/lib/etc";

// ── The TOTAL (NEW ETC) rollup is all-or-nothing (§51) ───────────────────────
//
// The ENG and SHOP blocks print Total New ETC and Diff only when every section in the
// group that needs a New ETC has one. §51 asks for tests over blanks, nulls, zeros,
// partial completion, full completion, clearing and rapid edits; those are all
// properties of `rollupNewEtc` plus the cell rule that feeds it, so they are all here.
//
// The multi-user half is not a property of a pure function — the rollup is recomputed
// from the same published cells whoever typed into them, and the live path is covered
// by the realtime tests plus the browser verification in DEVLOG §37.

const cell = (over: Partial<NewEtcRollupCell> = {}): NewEtcRollupCell => ({
  decided: true,
  hoursLeft: 0,
  newEtc: 0,
  ...over,
});

// ── Partial completion ──────────────────────────────────────────────────────

test("one unanswered section blanks the whole group", () => {
  const r = rollupNewEtc([
    cell({ decided: true, hoursLeft: 50, newEtc: 50 }),
    cell({ decided: true, hoursLeft: 20, newEtc: 20 }),
    cell({ decided: false, hoursLeft: 30, newEtc: 30 }),
  ]);
  assert.equal(r.complete, false);
  assert.equal(r.newEtc, null);
  assert.equal(r.diff, null);
});

test("Hours Left still prints while the rollup is blank", () => {
  // Prior and Worked are synced facts, not decisions — §51 leaves them alone, and a
  // block with three empty columns would read as a broken row rather than an
  // outstanding one.
  const r = rollupNewEtc([cell({ decided: false, hoursLeft: 30 }), cell({ hoursLeft: 12 })]);
  assert.equal(r.complete, false);
  assert.equal(r.hoursLeft, 42);
});

test("§51's worked example, step by step", () => {
  // ME = 50, CE = 20, GE = blank -> Total New ETC blank, Diff blank.
  const partial = [
    cell({ decided: true, hoursLeft: 60, newEtc: 50 }),
    cell({ decided: true, hoursLeft: 25, newEtc: 20 }),
    cell({ decided: false, hoursLeft: 15, newEtc: 0 }),
  ];
  assert.equal(rollupNewEtc(partial).newEtc, null);
  assert.equal(rollupNewEtc(partial).diff, null);

  // GE entered as 0 -> Total New ETC 70, Diff = Hours Left - 70.
  const full = [...partial.slice(0, 2), cell({ decided: true, hoursLeft: 15, newEtc: 0 })];
  const r = rollupNewEtc(full);
  assert.equal(r.complete, true);
  assert.equal(r.newEtc, 70);
  assert.equal(r.diff, 100 - 70);
});

// ── Zero is an answer; blank is not ─────────────────────────────────────────

test("a required cell holding 0 does not block", () => {
  const r = rollupNewEtc([cell({ decided: true, hoursLeft: 40, newEtc: 0 }), cell({ decided: true, hoursLeft: 10, newEtc: 10 })]);
  assert.equal(r.complete, true);
  assert.equal(r.newEtc, 10);
  assert.equal(r.diff, 40);
});

test('"0" and 0 are both answers; blank, spaces and null are not', () => {
  // The distinction §51 turns on, and it already had one home — hasNewEtcValue. Pinned
  // here too because the rollup is now the loudest consumer of it: get this wrong and
  // an entire block disappears.
  for (const answered of [0, "0", "0.00", "-0", 7, "7"]) {
    assert.equal(hasNewEtcValue(answered), true, `${JSON.stringify(answered)} is an answer`);
  }
  for (const blank of [null, undefined, "", "   "]) {
    assert.equal(hasNewEtcValue(blank), false, `${JSON.stringify(blank)} is not an answer`);
  }
});

// ── What counts as "required" ───────────────────────────────────────────────

const state = (over: Partial<NewEtcCellState> = {}): NewEtcCellState => ({
  priorEtc: 0,
  hoursWorked: 0,
  draft: null,
  confirmed: null,
  cleared: false,
  locked: false,
  monthComplete: true,
  precision: "whole",
  ...over,
});

test("a section with no hours booked never blocks the rollup", () => {
  // Otherwise the ~350 sections no job was ever quoted for would hold every block
  // hostage forever, and nobody could ever see a total.
  const s = state({ priorEtc: 0, hoursWorked: 0 });
  assert.equal(isNewEtcCellDecided(s, newEtcSeedText(s)), true);
});

test("a section with hours booked and a blank box blocks it", () => {
  const s = state({ priorEtc: 100, hoursWorked: 40 });
  assert.equal(newEtcSeedText(s), "", "the box seeds blank — this is the yellow cell");
  assert.equal(isNewEtcCellDecided(s, newEtcSeedText(s)), false);
});

test("a saved draft of 0 answers a required section", () => {
  const s = state({ priorEtc: 100, hoursWorked: 40, draft: 0 });
  assert.equal(newEtcSeedText(s), "0");
  assert.equal(isNewEtcCellDecided(s, newEtcSeedText(s)), true);
});

test("clearing a required section takes the rollup away again", () => {
  // §51 #6. `cleared` beats a confirmed value, which is the whole reason
  // newEtcClearedAt exists — so a reopened month's carried figure does not silently
  // re-complete a block somebody deliberately emptied.
  const s = state({ priorEtc: 100, hoursWorked: 40, confirmed: 60, cleared: true });
  assert.equal(newEtcSeedText(s), "");
  assert.equal(isNewEtcCellDecided(s, newEtcSeedText(s)), false);
});

test("the blocking set is exactly the submission gate's missing-New-ETC set", () => {
  // validateMonthlyReport counts a cell as missing when hours were booked and
  // newEtcSeedText is blank. That is this same expression, so "the block is blank" and
  // "the month cannot be submitted" are one fact — a manager clearing every blank
  // rollup has, by construction, cleared every submission blocker too.
  const cases = [
    state({ priorEtc: 100, hoursWorked: 40 }),
    state({ priorEtc: 100, hoursWorked: 40, draft: 0 }),
    state({ priorEtc: 100, hoursWorked: 0 }),
    state({ priorEtc: 100, hoursWorked: 40, confirmed: 60, cleared: true }),
  ];
  for (const s of cases) {
    const missingByGate = s.hoursWorked !== 0 && newEtcSeedText(s).trim() === "";
    assert.equal(isNewEtcCellDecided(s, newEtcSeedText(s)), !missingByGate);
  }
});

// ── The arithmetic, once complete ───────────────────────────────────────────

test("Diff is Hours Left minus Total New ETC, plainly", () => {
  const r = rollupNewEtc([
    cell({ hoursLeft: 1017, newEtc: 205 }),
    cell({ hoursLeft: 0, newEtc: 0 }),
  ]);
  assert.equal(r.diff, 1017 - 205);
});

test("a complete group's Diff equals the old per-cell sum", () => {
  // The equivalence that lets this change drop the per-cell rollup without moving any
  // completed figure: with every cell decided, Σ(hoursLeft − max(newEtc,0)) is the same
  // number as ΣhoursLeft − Σmax(newEtc,0). If this ever fails, a completed row's Diff
  // has silently changed meaning.
  const cells = [
    cell({ hoursLeft: -22, newEtc: 0 }),
    cell({ hoursLeft: 40, newEtc: 40 }),
    cell({ hoursLeft: 80, newEtc: 80 }),
    cell({ hoursLeft: 85, newEtc: 85 }),
    cell({ hoursLeft: 793, newEtc: 700 }),
  ];
  const perCell = cells.reduce((s, c) => s + (c.hoursLeft - Math.max(c.newEtc, 0)), 0);
  assert.equal(rollupNewEtc(cells).diff, perCell);
});

test("a negative New ETC is clamped, matching the cell", () => {
  const r = rollupNewEtc([cell({ hoursLeft: 10, newEtc: -5 })]);
  assert.equal(r.newEtc, 0);
  assert.equal(r.diff, 10);
});

test("an empty group is complete, not blank", () => {
  // A job with no sections in a billing group has nothing outstanding. Blanking it
  // would put a permanent hole in the column for every job that is engineering-only.
  const r = rollupNewEtc([]);
  assert.deepEqual(r, { complete: true, hoursLeft: 0, newEtc: 0, diff: 0 });
});

// ── Bottom totals: only completed rows contribute (§51 #7, #8) ──────────────

test("the grand total sums completed rows only, with no fallback for the rest", () => {
  const rows = [
    rollupNewEtc([cell({ hoursLeft: 100, newEtc: 60 })]), // complete
    rollupNewEtc([cell({ decided: false, hoursLeft: 500, newEtc: 400 })]), // outstanding
    rollupNewEtc([cell({ hoursLeft: 30, newEtc: 30 })]), // complete
  ];
  let newEtc = 0;
  let diff = 0;
  for (const r of rows) {
    if (r.newEtc != null) newEtc += r.newEtc;
    if (r.diff != null) diff += r.diff;
  }
  assert.equal(newEtc, 90, "the outstanding row contributes nothing — not 400");
  assert.equal(diff, 40, "…and not its Hours Left either");
});

test("completing one row adds only that row to the totals", () => {
  const before = [rollupNewEtc([cell({ hoursLeft: 100, newEtc: 60 })]), rollupNewEtc([cell({ decided: false, hoursLeft: 50, newEtc: 20 })])];
  const after = [before[0], rollupNewEtc([cell({ decided: true, hoursLeft: 50, newEtc: 20 })])];
  const sum = (rs: typeof before) => rs.reduce((s, r) => s + (r.newEtc ?? 0), 0);
  assert.equal(sum(after) - sum(before), 20);
});

// ── Rapid edits ─────────────────────────────────────────────────────────────

test("the rollup is a pure function of the cells, so edit order cannot matter", () => {
  // §51 asks for rapid-edit coverage. The live store recomputes from scratch on every
  // publish rather than accumulating, so "rapid edits" reduces to: the same set of
  // cells always produces the same answer, whatever order they arrived in.
  const cells = [
    cell({ hoursLeft: 10, newEtc: 4 }),
    cell({ hoursLeft: 20, newEtc: 9 }),
    cell({ hoursLeft: 5, newEtc: 0 }),
  ];
  const forward = rollupNewEtc(cells);
  const reversed = rollupNewEtc([...cells].reverse());
  assert.deepEqual(forward, reversed);
  // And a single un-answered cell dominates regardless of where it sits.
  for (let i = 0; i < 3; i++) {
    const withGap = cells.map((c, k) => (k === i ? { ...c, decided: false } : c));
    assert.equal(rollupNewEtc(withGap).newEtc, null, `gap at ${i}`);
  }
});

test("hoursLeft in the rollup matches calcHoursLeft over the same cells", () => {
  const rows = [
    { prior: 100, worked: 40 },
    { prior: 10, worked: 30 },
  ];
  const r = rollupNewEtc(rows.map((x) => cell({ hoursLeft: calcHoursLeft(x.prior, x.worked) })));
  assert.equal(r.hoursLeft, 100 - 40 + (10 - 30));
});
