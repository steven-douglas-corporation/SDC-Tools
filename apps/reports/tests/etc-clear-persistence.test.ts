import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseNewEtcField,
  isStaleDraftWrite,
  hasNewEtcValue,
  newEtcSeedText,
  isNewEtcCellDecided,
  type NewEtcCellState,
} from "../src/lib/etc";
import { describeChange } from "../src/lib/change-log";

// ── "I cleared a value, saved, refreshed, and it came back" ──────────────────
//
// Reported 2026-08-04, and it was three bugs wearing one coat. All three are about
// the same missing distinction: a New ETC that is EMPTY because nobody has filled
// it in, versus one that is empty because somebody emptied it.
//
//   1. An empty posted field had no agreed meaning on the way in. The save compared
//      the posted value against the stored DRAFT and skipped when they matched — so
//      clearing a cell whose figure came from anywhere else (a reopened month's
//      confirmed value, or the zero-hours carry-forward) posted "" against a stored
//      null, compared equal, and wrote NOTHING AT ALL.
//   2. Even when the draft WAS nulled, newEtcSeedText falls back to the confirmed
//      value and then to the carry-forward, so the removed figure was re-rendered
//      from the row's other columns.
//   3. A cell that had just been created in this page session keeps posting under
//      `newEtcCreate__*`, and that parser dropped empty fields outright.
//
// The fix is one idea in three places: parseNewEtcField gives an empty field an
// explicit meaning ("clear"), the write sets newEtcClearedAt alongside the null so
// the seed can tell the two empties apart, and the stale-write guard defends a
// clear from a page that predates it.

// ── parseNewEtcField: what a posted value MEANS ─────────────────────────────

test("a field that is not in the request means NO OPINION", () => {
  // The client posts only what this user edited, so an absent field is a cell they
  // never touched — or one a Columns filter hid. Reading it as "clear the value"
  // would delete other people's work on every save.
  assert.deepEqual(parseNewEtcField(null), { kind: "absent" });
  assert.deepEqual(parseNewEtcField(undefined), { kind: "absent" });
});

test("an EMPTY field is a deliberate clear, not an absent one", () => {
  assert.deepEqual(parseNewEtcField(""), { kind: "clear" });
  assert.deepEqual(parseNewEtcField("   "), { kind: "clear" });
});

test("zero is a VALUE — the distinction the whole bug turned on", () => {
  assert.deepEqual(parseNewEtcField("0"), { kind: "value", value: 0 });
  assert.deepEqual(parseNewEtcField("0.00"), { kind: "value", value: 0 });
  assert.deepEqual(parseNewEtcField(" 0 "), { kind: "value", value: 0 });
  // `if (value) save(value)` is exactly the shape of code this rules out: a falsy
  // check cannot tell 0 from blank, and both were being dropped.
  assert.notEqual(parseNewEtcField("0").kind, "clear");
});

test("ordinary values parse and round to cents", () => {
  assert.deepEqual(parseNewEtcField("40"), { kind: "value", value: 40 });
  assert.deepEqual(parseNewEtcField("93.756"), { kind: "value", value: 93.76 });
});

test("junk and negatives are INVALID — never coerced, never silently kept", () => {
  // Not turned into 0, and not replaced by the previous stored figure: the caller
  // reports them so the cell can say so while the typed text stays on screen.
  const junk = parseNewEtcField("abc");
  assert.equal(junk.kind, "invalid");
  assert.equal((junk as { raw: string }).raw, "abc");
  // And it now says what it wanted, rather than only that it refused (§27.9).
  assert.match((junk as { message?: string }).message ?? "", /must be/);
  assert.equal(parseNewEtcField("-5").kind, "invalid");
});

test("a figure pasted out of Excel parses, whichever grid the cell is in (§27.3)", () => {
  // CHANGED 2026-08-04. This used to assert that "1,000" was INVALID, on the reasoning
  // that "hours cells post raw digits" — which was true of the <input> and untrue of
  // the clipboard. The same figure was accepted by the Projects grid's money cells
  // (parseMoney stripped "$", spaces and commas) and refused here, so pasting one
  // column out of one spreadsheet gave two different answers depending on which grid
  // the cell was in. Both parsers are now lib/cell-rules.ts.
  assert.deepEqual(parseNewEtcField("1,000"), { kind: "value", value: 1000 });
  assert.deepEqual(parseNewEtcField("$1,234.50"), { kind: "value", value: 1234.5 });
  assert.deepEqual(parseNewEtcField("  42  "), { kind: "value", value: 42 });
  // Still refused, because it is genuinely ambiguous rather than merely decorated:
  // "1.234,56" is 1234.56 in Europe and 1.23456 if the comma is a grouping mark.
  assert.equal(parseNewEtcField("1.234,56").kind, "invalid");
});

test("negatives are allowed where a column allows them", () => {
  // Money spent genuinely goes negative (a credit note, a returned part). No New ETC
  // column takes one today; the flag exists so the rule is stated rather than
  // assumed.
  assert.deepEqual(parseNewEtcField("-5", { allowNegative: true }), { kind: "value", value: -5 });
});

// ── hasNewEtcValue: what "blank" means, everywhere ──────────────────────────

test("blank is null, undefined and whitespace — and nothing else", () => {
  assert.equal(hasNewEtcValue(null), false);
  assert.equal(hasNewEtcValue(undefined), false);
  assert.equal(hasNewEtcValue(""), false);
  assert.equal(hasNewEtcValue("  "), false);
  assert.equal(hasNewEtcValue(0), true);
  assert.equal(hasNewEtcValue("0"), true);
  assert.equal(hasNewEtcValue("0.0"), true);
  assert.equal(hasNewEtcValue(-3), true);
  assert.equal(hasNewEtcValue("40"), true);
});

// ── The seed after a clear, which is what "refresh" shows ───────────────────

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

test("clearing a REOPENED cell survives the reload", () => {
  // The exact reported case. Before the fix the save wrote nothing (stored draft was
  // already null) and the seed handed the confirmed figure straight back.
  const before = cell({ draft: null, confirmed: 96 });
  assert.equal(newEtcSeedText(before), "96");
  const afterClear = cell({ draft: null, confirmed: 96, cleared: true });
  assert.equal(newEtcSeedText(afterClear), "");
  // And it is yellow again, because a decision is required and the box is empty.
  assert.equal(isNewEtcCellDecided(afterClear, ""), false);
});

test("clearing a CARRY-FORWARD cell survives the reload", () => {
  // No hours worked, so the box arrives holding the Prior ETC. Nulling the draft
  // alone would re-seed it from priorEtc on the very next render.
  const before = cell({ hoursWorked: 0, priorEtc: 100 });
  assert.equal(newEtcSeedText(before), "100");
  const afterClear = cell({ hoursWorked: 0, priorEtc: 100, cleared: true });
  assert.equal(newEtcSeedText(afterClear), "");
  // Not yellow: no hours were booked here, so nothing is being asked of anybody.
  assert.equal(isNewEtcCellDecided(afterClear, ""), true);
});

test("clearing a plain typed draft survives the reload", () => {
  const afterClear = cell({ draft: null, confirmed: null, cleared: true });
  assert.equal(newEtcSeedText(afterClear), "");
});

test("re-entering a value un-clears the cell", () => {
  // The marker is spent the moment an answer is given, including an answer of 0 —
  // otherwise a cell saved as 0 would keep seeding blank.
  assert.equal(newEtcSeedText(cell({ draft: 70, cleared: true })), "70");
  assert.equal(newEtcSeedText(cell({ draft: 0, cleared: true })), "0");
});

// ── A clear must not be undone by an older save ─────────────────────────────

test("a page that predates the clear cannot restore the value", () => {
  // Two managers, one cell. A clears it; B's tab still shows 96 and B types 100.
  // B's write is refused: it is editing against a figure that no longer exists, and
  // silently reviving a removed value is the failure mode being designed out.
  assert.equal(isStaleDraftWrite({ believedStored: "96", storedDraft: null, storedCleared: true }), true);
});

test("two people clearing the same cell is not a conflict", () => {
  // Both want it blank, and it is blank. Refusing here would report a conflict on a
  // cell where nobody disagrees.
  assert.equal(isStaleDraftWrite({ believedStored: "", storedDraft: null, storedCleared: true }), false);
});

test("a cell that was never filled in is still free to take a value", () => {
  // The un-cleared null keeps its old meaning: nothing stored, nothing to revert.
  assert.equal(isStaleDraftWrite({ believedStored: "40", storedDraft: null, storedCleared: false }), false);
  assert.equal(isStaleDraftWrite({ believedStored: "40", storedDraft: null }), false);
});

test("an older bundle that declares no baseline is still allowed through", () => {
  // Unchanged from the original guard: refusing every belief-less write would break
  // saving outright for a long-open tab, which is worse than the bug prevented.
  assert.equal(isStaleDraftWrite({ believedStored: null, storedDraft: null, storedCleared: true }), false);
});

// ── What the audit row and the banner say ───────────────────────────────────

test("a removal names the figure that went", () => {
  // There is nothing left in the cell to look at, so this line is the whole record.
  assert.equal(
    describeChange(
      {
        tab: "Monthly ETC",
        rowRef: "1165",
        columnName: "New ETC",
        previousValue: "60",
        newValue: null,
        changeType: "removed",
      },
      "Abhi",
    ),
    "Abhi removed New ETC value 60 for 1165 in Monthly ETC",
  );
});

test("a removal of a zero still reads as a removal of 0, not of nothing", () => {
  assert.match(
    describeChange(
      {
        tab: "Monthly ETC",
        rowRef: "1148",
        columnName: "Parts Cost New ETC",
        previousValue: "0",
        newValue: null,
        changeType: "removed",
      },
      "Abhi",
    ),
    /removed Parts Cost New ETC value 0 /,
  );
});
