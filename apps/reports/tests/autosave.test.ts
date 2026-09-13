import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldAutosave, needsFollowUpSave, autosaveLabel, AUTOSAVE_DELAY_MS } from "../src/lib/autosave";

// Autosave writes to live production figures with nobody clicking anything, so
// the rules that decide WHETHER to write are pinned here. Every one of these
// corresponds to a way autosave is known to go wrong: bypassing a gate, racing
// itself, losing an edit made mid-save, or claiming "saved" when it isn't.

const base = { enabled: true, hasChanges: true, inFlight: false, hasUnsavedNewRows: false };

test("autosaves when enabled and something changed", () => {
  assert.equal(shouldAutosave(base), true);
});

test("never autosaves while the gate is closed", () => {
  // The one that matters most. The Parts Cost cell used to persist on blur and
  // skipped the ETC password entirely, which made that gate decorative for a
  // whole column. Autosave must not be a way past a gate Save respects.
  assert.equal(shouldAutosave({ ...base, enabled: false }), false);
});

test("never autosaves when nothing changed", () => {
  // Otherwise every keystroke that is then undone still costs a write, and the
  // grid saves itself in a loop while idle.
  assert.equal(shouldAutosave({ ...base, hasChanges: false }), false);
});

test("never starts a second save while one is in flight", () => {
  // Two overlapping saves of the same form can land out of order, and the
  // loser reinstates the values the winner had just replaced.
  assert.equal(shouldAutosave({ ...base, inFlight: true }), false);
});

test("never autosaves while an unsaved new row is on screen", () => {
  // New rows are validated as a batch — one blank Job Id rejects the WHOLE
  // submission — so autosaving mid-typing fails on every keystroke and buries
  // the real errors. They belong to the manual Save button.
  assert.equal(shouldAutosave({ ...base, hasUnsavedNewRows: true }), false);
});

test("an edit made DURING a save schedules exactly one follow-up", () => {
  // The classic autosave data-loss bug: the change event fired while inFlight
  // was true and was swallowed, so without this the edit sits unsaved until
  // the user happens to type again.
  assert.equal(needsFollowUpSave({ changedDuringSave: true, lastSaveOk: true }), true);
  assert.equal(needsFollowUpSave({ changedDuringSave: false, lastSaveOk: true }), false);
});

test("a failed save does NOT auto-retry", () => {
  // Retrying automatically against a server that just rejected the write is how
  // one bad value becomes a request loop. The chip offers a manual Retry.
  assert.equal(needsFollowUpSave({ changedDuringSave: true, lastSaveOk: false }), false);
});

test("the chip never says 'saved' for a state that isn't saved", () => {
  assert.equal(autosaveLabel("saved"), "All changes saved");
  for (const s of ["idle", "pending", "saving", "error"] as const) {
    assert.ok(!/all changes saved/i.test(autosaveLabel(s)), `${s} must not read as saved`);
  }
});

test("pending and error are both spelled out, not left blank", () => {
  // A silent chip is indistinguishable from a working one.
  assert.equal(autosaveLabel("pending"), "Unsaved changes");
  assert.equal(autosaveLabel("error"), "Save failed");
  assert.equal(autosaveLabel("idle"), ""); // nothing has happened yet — nothing to say
});

test("the debounce is long enough to coalesce typing, short enough to be safe", () => {
  // Typing "1420" must be one save, not four; and looking away must not leave
  // work unsaved for long. Anything outside this band means one of those broke.
  assert.ok(AUTOSAVE_DELAY_MS >= 800 && AUTOSAVE_DELAY_MS <= 3000, `${AUTOSAVE_DELAY_MS}ms is outside the sane band`);
});
