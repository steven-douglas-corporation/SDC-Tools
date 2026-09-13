import { test } from "node:test";
import assert from "node:assert/strict";
import { newEtcSeedText, isNewEtcCellDecided, type NewEtcCellState } from "../src/lib/etc";

// The yellow "needs attention" New ETC cell, and what the box seeds with.
//
//     yellow  <=>  a decision is required here (hours/money booked)  AND  it is blank
//
// One rule, and only about the colour. It used to answer a second question too —
// which cells the Clear ETC button emptied — and that forced it to call a reopened
// month's carried-over figure "undecided", so cells with values in them rendered
// yellow. Reported as a bug, split apart, and the button has since been removed
// outright (§14), leaving this rule with one job.
//
// The seeding cases are the subtle half: a deliberately cleared cell must stay blank,
// a zero-hours cell carries the prior forward, and a reopened cell arrives holding
// what it was submitted with.

const cell = (over: Partial<NewEtcCellState> = {}): NewEtcCellState => ({
  priorEtc: 100,
  hoursWorked: 40,
  draft: null,
  confirmed: null,
  cleared: false,
  locked: false,
  monthComplete: true,
  ...over,
});

test("no hours worked is decided — New ETC just carries the prior forward", () => {
  const s = cell({ hoursWorked: 0 });
  // Nothing to decide, so never yellow, even though the box seeds with the
  // carry-forward figure.
  assert.equal(newEtcSeedText(s), "100");
  assert.equal(isNewEtcCellDecided(s, newEtcSeedText(s)), true);
});

test("a typed-and-saved draft is decided", () => {
  const s = cell({ draft: 55, confirmed: null });
  assert.equal(newEtcSeedText(s), "55");
  assert.equal(isNewEtcCellDecided(s, "55"), true);
});

test("reopened + untouched is NOT yellow — it has a value in it", () => {
  // Seeds from the confirmed value because submittedAt is set.
  const s = cell({ draft: null, confirmed: 96 });
  assert.equal(newEtcSeedText(s), "96");
  // NOT painted yellow, because it is not blank. This is the
  // 2026-08-04 fix: "some New ETC cells remain yellow even when they already
  // contain a value" was exactly this state, across a whole reopened grid.
  assert.equal(isNewEtcCellDecided(s, "96"), true);
});

test("clearing a reopened cell brings the yellow straight back", () => {
  // The colour follows the LIVE text, so emptying the box re-arms the highlight
  // without a save, a refresh or a remount — and the cleared marker keeps it empty
  // on the next render (see newEtcSeedText).
  const s = cell({ draft: null, confirmed: 96 });
  assert.equal(isNewEtcCellDecided(s, ""), false);
  const afterSave = cell({ draft: null, confirmed: 96, cleared: true });
  assert.equal(newEtcSeedText(afterSave), "");
  assert.equal(isNewEtcCellDecided(afterSave, ""), false);
});

test("reopened + genuinely retyped is decided", () => {
  const s = cell({ draft: 120, confirmed: 95.5 });
  assert.equal(isNewEtcCellDecided(s, "120"), true);
});

test("a locked month is never yellow — a closed book isn't asking anything", () => {
  const s = cell({ draft: null, confirmed: 96, locked: true });
  assert.equal(isNewEtcCellDecided(s, "96"), true);
});

// ── Zero is a value, not a blank ────────────────────────────────────────────
// The distinction the whole requirement turns on: "Do not treat 0 as an empty
// value." A cell planned at 0 has been answered — no further hours needed — and
// painting it yellow would ask the manager to answer it again.

test("a typed 0 is answered, so the cell is not yellow", () => {
  const s = cell({ draft: 0 });
  assert.equal(newEtcSeedText(s), "0");
  assert.equal(isNewEtcCellDecided(s, "0"), true);
  // Not just the seed — the live text, in every shape a number input can hand back.
  assert.equal(isNewEtcCellDecided(s, "0.0"), true);
  assert.equal(isNewEtcCellDecided(s, "-0"), true);
});

test("whitespace is blank, and blank with hours worked is yellow", () => {
  const s = cell();
  assert.equal(isNewEtcCellDecided(s, ""), false);
  assert.equal(isNewEtcCellDecided(s, "   "), false);
});

test("cleared beats confirmed — the whole reason newEtcClearedAt exists", () => {
  // Nulling the draft alone would re-seed from `confirmed` and the clear would look
  // like it never happened.
  const s = cell({ draft: null, confirmed: 96, cleared: true });
  assert.equal(newEtcSeedText(s), "");
  // Still yellow — that is the point, so the grid reads as a checklist.
  assert.equal(isNewEtcCellDecided(s, ""), false);
  // And nothing is left in it to bring back.
});

test("entering a value after a clear wins over the cleared marker", () => {
  const s = cell({ draft: 70, confirmed: 96, cleared: true });
  assert.equal(newEtcSeedText(s), "70");
  assert.equal(isNewEtcCellDecided(s, "70"), true);
});

// ── Zero hours worked always shows a figure ─────────────────────────────────
// 2026-08-03, by request. These cells used to render blank, which left stretches of
// the grid at Prior 0 / Worked 0 / Hours Left 0 with an empty New ETC and Diff,
// reading as missing data. They were blanked because a literal "0" made ~350
// unquoted sections post a value and Submit timed out creating them all — now
// blocked at the source by parseNewEtcCreateFields dropping a 0.

test("a section with no row yet shows 0 rather than a blank box", () => {
  // Prior 0, Worked 0 — the carry-forward IS 0, and it is shown.
  const s = cell({ hoursWorked: 0, priorEtc: 0 });
  assert.equal(newEtcSeedText(s), "0");
  // Still decided (no hours worked = no decision asked for), so it is grey rather
  // than a flood of ~350 new yellow cells.
  assert.equal(isNewEtcCellDecided(s, "0"), true);
});

test("a ZERO carry-forward shows even mid-month", () => {
  // monthComplete guards against a partial figure looking final; 0 cannot.
  const s = cell({ hoursWorked: 0, priorEtc: 0, monthComplete: false });
  assert.equal(newEtcSeedText(s), "0");
  assert.equal(isNewEtcCellDecided(s, "0"), true);
});

test("a NON-zero carry-forward still waits for the month's actuals", () => {
  // Prior 100 mid-month is a real figure, and showing it before the hours are in
  // would state a plan the month has not finished measuring.
  const s = cell({ hoursWorked: 0, priorEtc: 100, monthComplete: false });
  assert.equal(newEtcSeedText(s), "");
  // Still decided: no hours worked means no decision is being asked for.
  assert.equal(isNewEtcCellDecided(s, ""), true);
});

test("a complete month fills the non-zero carry-forward", () => {
  const s = cell({ hoursWorked: 0, priorEtc: 100, monthComplete: true });
  assert.equal(newEtcSeedText(s), "100");
});

// ── Parts Cost is money, and keeps its cents ────────────────────────────────
// The hours seed rounds to whole deliberately (display == submission). Applying
// that to dollars would drop cents from what a no-changes resubmit writes, so the
// column declares its precision.

test("exact precision keeps cents in the seed", () => {
  const s = cell({ draft: 50000.25, confirmed: null, precision: "exact" });
  assert.equal(newEtcSeedText(s), "50000.25");
});

// ── Parts Cost answers the same question, in dollars ────────────────────────
// Requested 2026-08-04: "do not automatically fill the New ETC cells when there is
// a value in the Money Spent Month column — highlight those cells in yellow so
// managers can enter the values manually, just like they do for the hours cells."
//
// That reverses the 2026-08-03 request that the column ALWAYS show a figure (which
// this block used to assert, and which reopenAsksAgain:false implemented). The
// column is built with the DEFAULT flags now, so the only difference left from an
// hours cell is `precision` — dollars keep their cents.
const partsCell = (over: Partial<NewEtcCellState> = {}): NewEtcCellState =>
  cell({ precision: "exact", ...over });

test("Parts Cost with money spent and nothing entered is YELLOW and blank", () => {
  // The requirement, stated directly: spend but no decision means the manager is
  // asked, and nothing is put in the box for them.
  const s = partsCell({ hoursWorked: 2604.43, draft: null, confirmed: null });
  assert.equal(newEtcSeedText(s), "");
  assert.equal(isNewEtcCellDecided(s, ""), false);
});

test("Parts Cost reopened + untouched arrives holding last submission's figure", () => {
  const s = partsCell({ hoursWorked: 2604.43, draft: null, confirmed: 12395.57 });
  // It ARRIVES holding last submission's figure, the same as an hours cell on a
  // reopened month.
  assert.equal(newEtcSeedText(s), "12395.57");
  // Cents are preserved: dollars seed at "exact" precision.
  // And it is NOT yellow while it holds that figure — same fix as the hours cells.
  assert.equal(isNewEtcCellDecided(s, "12395.57"), true);
});

test("Parts Cost is yellow only while the box is empty", () => {
  // "Once a value is entered, the yellow highlight should disappear." Judged from
  // the LIVE text, so it happens as the manager types — no save required.
  const s = partsCell({ hoursWorked: 2604.43, draft: null, confirmed: null });
  assert.equal(isNewEtcCellDecided(s, ""), false);
  assert.equal(isNewEtcCellDecided(s, "9000"), true);
  // A $0 parts plan is an answer like any other.
  assert.equal(isNewEtcCellDecided(s, "0"), true);
});

test("a Parts Cost figure the manager actually saved is decided", () => {
  const s = partsCell({ hoursWorked: 500, draft: 4200, confirmed: 5819.03 });
  assert.equal(newEtcSeedText(s), "4200");
  assert.equal(isNewEtcCellDecided(s, "4200"), true);
});

test("Parts Cost with NO money spent still carries forward automatically", () => {
  // The half of the old behaviour that stays: no spend, no question. The balance
  // carries and the cell reads as settled.
  const s = partsCell({ hoursWorked: 0, priorEtc: 8600, confirmed: 500 });
  assert.equal(isNewEtcCellDecided(s, newEtcSeedText(s)), true);
});

