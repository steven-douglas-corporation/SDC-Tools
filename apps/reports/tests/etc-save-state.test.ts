import { test } from "node:test";
import assert from "node:assert/strict";
import {
  setCellSaveState,
  readCellSaveState,
  clearCellSaveState,
  resetCellSaveStates,
  cellSaveStateStyle,
  setCellInvalid,
  readCellInvalidMessage,
  hasInvalidCells,
  invalidCellNames,
} from "../src/lib/etc-save-state";

// Per-cell save state (§17: editing / saving / saved / failed / conflict).
//
// The property that matters is that a cell never claims to be saved when it is not.
// The page had one toolbar chip, which could say "All changes saved" while a single
// refused cell sat on screen looking identical to its saved neighbours — and with 1,180
// inputs, "one cell failed" is not an answer anybody can act on.

test("a batch is one state change for every cell in it", () => {
  resetCellSaveStates();
  setCellSaveState(["a", "b", "c"], "saving");
  assert.equal(readCellSaveState("a"), "saving");
  assert.equal(readCellSaveState("b"), "saving");
  assert.equal(readCellSaveState("c"), "saving");
});

test("a refused cell is a CONFLICT, not a save", () => {
  resetCellSaveStates();
  // Exactly what EtcAutosave does with a save that partly landed: the cells that were
  // written say saved, and the one the server refused says conflict. Both on screen at
  // once is the honest picture and the old single chip could not draw it.
  setCellSaveState(["kept", "refused"], "saving");
  setCellSaveState(["kept"], "saved");
  setCellSaveState(["refused"], "conflict");
  assert.equal(readCellSaveState("kept"), "saved");
  assert.equal(readCellSaveState("refused"), "conflict");
});

test("an invalid value reads as failed, and keeps reading that way", () => {
  resetCellSaveStates();
  setCellSaveState(["bad"], "failed");
  assert.equal(readCellSaveState("bad"), "failed");
  // Not cleared by an unrelated batch — the cell is still wrong until somebody fixes it.
  setCellSaveState(["other"], "saved");
  assert.equal(readCellSaveState("bad"), "failed");
});

test("a cell with nothing to say has no state and no ring", () => {
  resetCellSaveStates();
  assert.equal(readCellSaveState("untouched"), null);
  assert.equal(cellSaveStateStyle(null), null);
  // "editing" is deliberately undecorated: a value differing from the saved one is the
  // normal state of a cell somebody is working in.
  assert.equal(cellSaveStateStyle("editing"), null);
});

test("unmounting a cell forgets its state", () => {
  resetCellSaveStates();
  setCellSaveState(["gone"], "saved");
  clearCellSaveState("gone");
  assert.equal(readCellSaveState("gone"), null);
});

test("failed and conflict are visually distinct, and both say what to do", () => {
  const failed = cellSaveStateStyle("failed");
  const conflict = cellSaveStateStyle("conflict");
  assert.ok(failed && conflict);
  assert.notEqual(failed.ring, conflict.ring);
  // The tooltip has to tell a manager what happened to their value — "failed" means it
  // is still theirs to retry, "conflict" means somebody else's value is now stored.
  assert.match(failed.title, /still here|retr/i);
  assert.match(conflict.title, /another user/i);
});

// ── An invalid cell (§27.9, added 2026-08-04) ───────────────────────────────
//
// A value the column will not accept is NOT a failed save — nothing was even
// attempted, because there was nothing valid to send. The distinction matters on
// screen: "Save failed" invites a Retry, and retrying will never help.

test("an invalid cell reports the rule it broke, not just that it is wrong", () => {
  resetCellSaveStates();
  setCellInvalid("newEtcOverride__1", "New ETC must be a whole number greater than or equal to 0.");
  assert.equal(readCellSaveState("newEtcOverride__1"), "invalid");
  assert.match(readCellInvalidMessage("newEtcOverride__1") ?? "", /whole number/);
});

test("invalid cells are counted, because one-of-1180 is not actionable", () => {
  resetCellSaveStates();
  assert.equal(hasInvalidCells(), false);
  setCellInvalid("a", "nope");
  setCellInvalid("b", "nope");
  assert.equal(hasInvalidCells(), true);
  assert.deepEqual(invalidCellNames().sort(), ["a", "b"]);
});

test("fixing the value clears both the state and its message", () => {
  resetCellSaveStates();
  setCellInvalid("a", "nope");
  clearCellSaveState("a");
  assert.equal(readCellSaveState("a"), null);
  assert.equal(readCellInvalidMessage("a"), null);
  assert.equal(hasInvalidCells(), false);
});

test("an invalid cell does not expire the way a saved one does", () => {
  // "saved" fades after a few seconds; this must not. The cell is wrong until
  // somebody fixes it, and a red ring that quietly disappeared would be worse than
  // never showing one.
  resetCellSaveStates();
  setCellInvalid("a", "nope");
  setCellSaveState(["b"], "saved");
  assert.equal(readCellSaveState("a"), "invalid");
});

test("a month switch clears invalid cells with everything else", () => {
  resetCellSaveStates();
  setCellInvalid("a", "nope");
  resetCellSaveStates();
  assert.equal(hasInvalidCells(), false);
  assert.equal(readCellSaveState("a"), null);
});

test("the invalid ring says the value is neither saved nor counted", () => {
  const style = cellSaveStateStyle("invalid");
  assert.ok(style, "invalid must have a visible style");
  assert.match(style!.ring, /ring-sdc-red/);
  assert.match(style!.title, /not been saved/i);
  assert.match(style!.title, /not counted/i);
});
