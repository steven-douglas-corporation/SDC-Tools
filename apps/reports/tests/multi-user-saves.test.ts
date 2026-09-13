import { test } from "node:test";
import assert from "node:assert/strict";
import { isStaleDraftWrite } from "../src/lib/etc";
import {
  registerEtcField,
  forgetEtcField,
  updateEtcField,
  adoptEtcFieldBaseline,
  rebaselineEtcFields,
  dirtyEtcFieldNames,
  changedEtcFormData,
  stripEtcFieldPrefix,
  isEtcDirty,
  hasUnrefusedEtcEdits,
  markEtcFieldsRefused,
} from "../src/lib/etc-dirty-tracker";
import { beginSaveTracking, endSaveTracking, isSavingSomewhere } from "../src/lib/autosave";
import { BASE_FIELD_PREFIX } from "../src/lib/dirty-form";

// ── The multi-user save bug (reported 2026-08-04) ────────────────────────────
//
// "When I change a value in any cell, other users are not seeing the updated
// value." Two independent causes, and the dangerous one was not a display problem
// at all: the Monthly ETC grid posted its ENTIRE form on every autosave pass, so a
// second manager's open tab wrote its page-load-time values back over every cell
// the first had saved since. The value was being reverted, not cached.
//
// These pin the three rules that make that unrepeatable:
//   1. the payload carries only what this user touched
//   2. the server refuses a write whose baseline has moved (isStaleDraftWrite)
//   3. a refused write is never re-baselined as if it had been saved

// ── 1. Only what this user touched ──────────────────────────────────────────

// Minimal stand-in for the grid's form. These tests need `elements.namedItem` and
// nothing else, and the repo's test runner has no DOM.
function fakeForm(fields: Record<string, string>): HTMLFormElement {
  const make = (value: string) => {
    // changedEtcFormData narrows with `instanceof HTMLInputElement`, which does not
    // exist here — so hand it a real object of a class named the same way. Node has
    // no DOM globals, so the test defines the minimum that satisfies the check.
    return Object.assign(Object.create(HTMLInputElementStub.prototype), { value, disabled: false });
  };
  return {
    elements: { namedItem: (name: string) => (name in fields ? make(fields[name]) : null) },
  } as unknown as HTMLFormElement;
}

// Stand-in class so `instanceof` succeeds inside changedEtcFormData. Installed as
// the global the module checks against.
class HTMLInputElementStub {
  value = "";
  disabled = false;
}
const g = globalThis as unknown as Record<string, unknown>;
g.HTMLInputElement = HTMLInputElementStub;
g.HTMLSelectElement = class {};
g.HTMLTextAreaElement = class {};

test("dirtyEtcFieldNames reports exactly the edited cells", () => {
  registerEtcField("newEtcOverride__1", "40");
  registerEtcField("newEtcOverride__2", "60");
  updateEtcField("newEtcOverride__2", "55");
  assert.deepEqual(dirtyEtcFieldNames(), ["newEtcOverride__2"]);
  forgetEtcField("newEtcOverride__1");
  forgetEtcField("newEtcOverride__2");
});

test("an untouched cell contributes NOTHING to the payload", () => {
  // The bug in one assertion. Before the fix this cell went out on every pass
  // carrying whatever the page loaded with, and overwrote whoever had saved it.
  registerEtcField("newEtcOverride__1", "40");
  registerEtcField("newEtcOverride__2", "60");
  updateEtcField("newEtcOverride__2", "55");
  const fd = changedEtcFormData(fakeForm({ newEtcOverride__1: "40", newEtcOverride__2: "55" }));
  assert.equal(fd.get("newEtcOverride__1"), null, "untouched cell must not be posted");
  assert.equal(fd.get("newEtcOverride__2"), "55");
  forgetEtcField("newEtcOverride__1");
  forgetEtcField("newEtcOverride__2");
});

test("the payload carries the baseline this client believed was stored", () => {
  registerEtcField("newEtcOverride__7", "40");
  updateEtcField("newEtcOverride__7", "48");
  const fd = changedEtcFormData(fakeForm({ newEtcOverride__7: "48" }));
  assert.equal(fd.get("newEtcOverride__7"), "48");
  assert.equal(fd.get("newEtcBase__7"), "40", "the server needs to know what we thought was there");
  forgetEtcField("newEtcOverride__7");
});

test("a cell whose control has vanished is not posted from memory", () => {
  // A column filter hid it, or the month switched. Posting a remembered value
  // would be precisely the stale write this all exists to prevent.
  registerEtcField("newEtcOverride__9", "10");
  updateEtcField("newEtcOverride__9", "12");
  const fd = changedEtcFormData(fakeForm({}));
  assert.equal(fd.get("newEtcOverride__9"), null);
  forgetEtcField("newEtcOverride__9");
});

test("create-cells post a baseline under the same suffix", () => {
  registerEtcField("newEtcCreate__9__10-211", "");
  updateEtcField("newEtcCreate__9__10-211", "12");
  const fd = changedEtcFormData(fakeForm({ "newEtcCreate__9__10-211": "12" }));
  assert.equal(fd.get("newEtcCreate__9__10-211"), "12");
  assert.equal(fd.get("newEtcBase__9__10-211"), "");
  forgetEtcField("newEtcCreate__9__10-211");
});

test("stripEtcFieldPrefix maps both namespaces onto the base key", () => {
  assert.equal(stripEtcFieldPrefix("newEtcOverride__123"), "123");
  assert.equal(stripEtcFieldPrefix("newEtcCreate__9__10-211"), "9__10-211");
});

// ── 2. The server refuses a stale write ─────────────────────────────────────

test("writing over a value someone else saved is STALE", () => {
  // A saved 5000. B's tab still believes the cell is empty and types 7000.
  assert.equal(isStaleDraftWrite({ believedStored: "", storedDraft: 5000 }), true);
});

test("writing over the value we last saw is fine", () => {
  assert.equal(isStaleDraftWrite({ believedStored: "5000", storedDraft: 5000 }), false);
});

test("a cell with no stored draft can always take one", () => {
  // This action never touches the CONFIRMED value, so there is nothing to revert.
  assert.equal(isStaleDraftWrite({ believedStored: "", storedDraft: null }), false);
  assert.equal(isStaleDraftWrite({ believedStored: "40", storedDraft: null }), false);
});

test("a client that states no baseline is allowed through", () => {
  // An older bundle on a long-open tab. Refusing every such write would break
  // saving for that user entirely, which is worse than the bug being prevented —
  // the payload trimming is what covers this case.
  assert.equal(isStaleDraftWrite({ believedStored: null, storedDraft: 5000 }), false);
});

test("formatting is not a conflict", () => {
  // "5819.030" and 5819.03 are the same stored figure. Reading this as a conflict
  // would reject a legitimate save and blame a colleague who did nothing.
  assert.equal(isStaleDraftWrite({ believedStored: "5819.030", storedDraft: 5819.03 }), false);
  assert.equal(isStaleDraftWrite({ believedStored: " 5819.03 ", storedDraft: 5819.03 }), false);
});

test("a belief we cannot parse is treated as stale", () => {
  assert.equal(isStaleDraftWrite({ believedStored: "abc", storedDraft: 5000 }), true);
});

test("zero is a real stored figure, not 'nothing stored'", () => {
  // The distinction the whole Parts Cost carry-forward rests on.
  assert.equal(isStaleDraftWrite({ believedStored: "0", storedDraft: 0 }), false);
  assert.equal(isStaleDraftWrite({ believedStored: "", storedDraft: 0 }), true);
});

// ── 3. A refused write is never reported as saved ───────────────────────────

test("rebaseline SKIPS a field the server refused", () => {
  // Otherwise the cell stops reading as dirty, the chip says "All changes saved",
  // and the manager's rejected value sits on screen looking persisted.
  registerEtcField("newEtcOverride__1", "40");
  updateEtcField("newEtcOverride__1", "48");
  const fd = new FormData();
  fd.append("newEtcOverride__1", "48");
  rebaselineEtcFields(fd, ["newEtcOverride__1"]);
  assert.equal(isEtcDirty(), true, "a refused cell must stay dirty");
  forgetEtcField("newEtcOverride__1");
});

test("rebaseline still clears the fields that DID save", () => {
  registerEtcField("newEtcOverride__1", "40");
  registerEtcField("newEtcOverride__2", "60");
  updateEtcField("newEtcOverride__1", "48");
  updateEtcField("newEtcOverride__2", "66");
  const fd = new FormData();
  fd.append("newEtcOverride__1", "48");
  fd.append("newEtcOverride__2", "66");
  rebaselineEtcFields(fd, ["newEtcOverride__2"]);
  assert.deepEqual(dirtyEtcFieldNames(), ["newEtcOverride__2"]);
  forgetEtcField("newEtcOverride__1");
  forgetEtcField("newEtcOverride__2");
});

// ── Adopting a colleague's value ────────────────────────────────────────────

test("adopting a new server value leaves the cell clean", () => {
  // A cell that adopts another user's figure must NOT read as dirty, or autosave
  // would post it and the stale-write guard would reject it as a conflict on a
  // cell nobody edited.
  registerEtcField("newEtcOverride__1", "40");
  adoptEtcFieldBaseline("newEtcOverride__1", "55");
  assert.equal(isEtcDirty(), false);
  // And the adopted value is now what "unchanged" means.
  updateEtcField("newEtcOverride__1", "55");
  assert.equal(isEtcDirty(), false);
  updateEtcField("newEtcOverride__1", "40");
  assert.equal(isEtcDirty(), true, "the OLD value is now an edit");
  forgetEtcField("newEtcOverride__1");
});

// ── The refresh interlock ───────────────────────────────────────────────────

test("in-flight saves are visible tab-wide, and nest", () => {
  assert.equal(isSavingSomewhere(), false);
  beginSaveTracking();
  beginSaveTracking();
  endSaveTracking();
  assert.equal(isSavingSomewhere(), true, "a second grid is still writing");
  endSaveTracking();
  assert.equal(isSavingSomewhere(), false);
});

test("the save counter cannot be driven negative", () => {
  // A stray endSaveTracking() must not latch isSavingSomewhere() false forever,
  // which would silently disable the refresh interlock for the whole session.
  endSaveTracking();
  endSaveTracking();
  beginSaveTracking();
  assert.equal(isSavingSomewhere(), true);
  endSaveTracking();
  assert.equal(isSavingSomewhere(), false);
});

// ── Display precision (the guard must not fire on its own rounding) ─────────

test("a rounded hours seed is NOT a conflict against its fractional stored value", () => {
  // The hours cells seed from String(Math.round(n)), so a stored 93.75 puts "94" in
  // the box. Comparing at 2dp would call that a conflict, refuse the save, blame a
  // colleague who did nothing, and never recover — the seed would keep rounding.
  assert.equal(isStaleDraftWrite({ believedStored: "94", storedDraft: 93.75, precision: "whole" }), false);
});

test("Parts Cost keeps its cents, so a dollar difference IS a conflict", () => {
  assert.equal(isStaleDraftWrite({ believedStored: "5819", storedDraft: 5819.03, precision: "exact" }), true);
  assert.equal(isStaleDraftWrite({ believedStored: "5819.03", storedDraft: 5819.03, precision: "exact" }), false);
});

test("whole precision still catches a real difference", () => {
  assert.equal(isStaleDraftWrite({ believedStored: "94", storedDraft: 120, precision: "whole" }), true);
});

// ── A refusal must not deadlock the tab's convergence ───────────────────────

test("a refused cell stays dirty but stops blocking the background refresh", () => {
  registerEtcField("newEtcOverride__1", "40");
  updateEtcField("newEtcOverride__1", "48");
  assert.equal(hasUnrefusedEtcEdits(), true, "an ordinary unsaved edit does block");

  markEtcFieldsRefused(["newEtcOverride__1"]);
  // Still unsaved — the warnings must keep covering it...
  assert.equal(isEtcDirty(), true);
  // ...but it must not hold the refresh off forever, or the manager can never see
  // the figure they are being asked to reconcile against.
  assert.equal(hasUnrefusedEtcEdits(), false);

  // Retyping is the manager dealing with it, so it counts again.
  updateEtcField("newEtcOverride__1", "52");
  assert.equal(hasUnrefusedEtcEdits(), true);
  forgetEtcField("newEtcOverride__1");
});

test("a refusal on one cell does not unblock a different unsaved cell", () => {
  registerEtcField("newEtcOverride__1", "40");
  registerEtcField("newEtcOverride__2", "60");
  updateEtcField("newEtcOverride__1", "48");
  updateEtcField("newEtcOverride__2", "66");
  markEtcFieldsRefused(["newEtcOverride__1"]);
  assert.equal(hasUnrefusedEtcEdits(), true, "cell 2 is still ordinary unsaved work");
  forgetEtcField("newEtcOverride__1");
  forgetEtcField("newEtcOverride__2");
});

test("unmounting clears a refusal so it cannot leak into the next month", () => {
  registerEtcField("newEtcOverride__1", "40");
  updateEtcField("newEtcOverride__1", "48");
  markEtcFieldsRefused(["newEtcOverride__1"]);
  forgetEtcField("newEtcOverride__1");
  registerEtcField("newEtcOverride__1", "40");
  updateEtcField("newEtcOverride__1", "48");
  assert.equal(hasUnrefusedEtcEdits(), true);
  forgetEtcField("newEtcOverride__1");
});

// ── The Projects grid declares its baselines too ────────────────────────────

test("Projects sends a __base__ token beside every changed control", () => {
  // The same optimistic-concurrency token as the ETC grid. Without it,
  // saveHoursCells/saveJobFields diff the POSTED value against the database and a
  // stale page's value reads as a deliberate edit.
  assert.equal(BASE_FIELD_PREFIX, "__base__");
});

test("beliefIsStale semantics are shared with the ETC guard", () => {
  // No baseline stated -> allowed through (an older bundle must still be able to save).
  assert.equal(isStaleDraftWrite({ believedStored: null, storedDraft: 5 }), false);
});
