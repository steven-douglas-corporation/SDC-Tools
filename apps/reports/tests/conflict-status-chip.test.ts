import { test } from "node:test";
import assert from "node:assert/strict";
import {
  setCellSaveState,
  setCellInvalid,
  conflictCellNames,
  invalidCellNames,
  resetCellSaveStates,
  clearCellSaveState,
} from "../src/lib/etc-save-state";

// ── "All changes saved" must not survive a refused write (2026-08-31) ───────
//
// Found by driving two browser tabs at the same cell: tab B's baseline went stale,
// saveAllNewEtcDrafts correctly refused its write, the cell correctly took its
// conflict ring — and the toolbar chip still read "All changes saved". The chip only
// ever escalated on `invalid`, so the one state that means "somebody else's value is
// stored, not yours" was the one it stayed green through.
//
// §27.9's rule for invalid cells is the rule here too: a cell whose value was not
// written is not clean, and the chip may not claim otherwise. conflictCellNames() is
// what lets SaveStatusChip ask that question, so these pin its contract rather than
// the JSX — the same way invalidCellNames() is pinned.

test("a refused cell is reported as a conflict, so the chip can stop saying 'saved'", () => {
  resetCellSaveStates();
  setCellSaveState(["newEtcOverride__1"], "conflict");
  assert.deepEqual(conflictCellNames(), ["newEtcOverride__1"]);
});

test("only conflicts count — saving/saved/editing/failed are not refusals of this kind", () => {
  resetCellSaveStates();
  setCellSaveState(["a"], "saving");
  setCellSaveState(["b"], "saved");
  setCellSaveState(["c"], "editing");
  setCellSaveState(["d"], "failed");
  assert.deepEqual(conflictCellNames(), [], "none of these mean 'someone else wrote this cell first'");
});

test("conflicts and invalid cells are counted separately — they ask for different responses", () => {
  resetCellSaveStates();
  setCellSaveState(["conflicted"], "conflict");
  setCellInvalid("wrong", "New ETC must be a whole number greater than or equal to 0.");
  assert.deepEqual(conflictCellNames(), ["conflicted"]);
  assert.deepEqual(invalidCellNames(), ["wrong"]);
});

test("re-saving the cell successfully clears the conflict, so the chip can go green again", () => {
  resetCellSaveStates();
  setCellSaveState(["newEtcOverride__1"], "conflict");
  assert.equal(conflictCellNames().length, 1);
  setCellSaveState(["newEtcOverride__1"], "saved");
  assert.deepEqual(conflictCellNames(), [], "the manager retyped against the stored figure and it landed");
});

test("a month switch clears conflicts — they belong to the fields that just unmounted", () => {
  resetCellSaveStates();
  setCellSaveState(["newEtcOverride__1", "newEtcOverride__2"], "conflict");
  assert.equal(conflictCellNames().length, 2);
  resetCellSaveStates();
  assert.deepEqual(conflictCellNames(), []);
});

test("clearing one cell leaves the other conflicts standing", () => {
  resetCellSaveStates();
  setCellSaveState(["one", "two"], "conflict");
  clearCellSaveState("one");
  assert.deepEqual(conflictCellNames(), ["two"]);
});
