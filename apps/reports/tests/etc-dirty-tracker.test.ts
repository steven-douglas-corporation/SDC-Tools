import { test } from "node:test";
import assert from "node:assert/strict";
import {
  registerEtcField,
  forgetEtcField,
  updateEtcField,
  rebaselineEtcFields,
  isEtcDirty,
  registerPoolAutosaveFlush,
  flushPoolAutosave,
} from "../src/lib/etc-dirty-tracker";

// The tracker decides whether the Monthly ETC grid warns "you have unsaved
// changes" on a month switch, a refresh, Back, or Sign out. It replaced a
// single boolean latch that only ever went one way, which warned constantly on
// a grid nobody had touched (reported 2026-08-02). These pin the two-way
// behaviour, because the failure mode is silent: over-reporting trains people
// to click through the warning, and under-reporting loses their work.
//
// Module-scope store, so every test has to leave it empty — hence the explicit
// forget() at the end of each. A leaked field would make a later test pass or
// fail for the wrong reason.

test("a freshly registered field is not dirty", () => {
  registerEtcField("newEtcOverride__1", "40");
  assert.equal(isEtcDirty(), false);
  forgetEtcField("newEtcOverride__1");
});

test("changing a field's value makes it dirty", () => {
  registerEtcField("newEtcOverride__1", "40");
  updateEtcField("newEtcOverride__1", "48");
  assert.equal(isEtcDirty(), true);
  forgetEtcField("newEtcOverride__1");
});

test("typing a value and putting it back is NOT dirty", () => {
  // The whole point. The old latch stayed armed here for the rest of the
  // browser session.
  registerEtcField("newEtcOverride__1", "40");
  updateEtcField("newEtcOverride__1", "48");
  updateEtcField("newEtcOverride__1", "40");
  assert.equal(isEtcDirty(), false);
  forgetEtcField("newEtcOverride__1");
});

test("the same number typed differently is not an edit", () => {
  // <input type="number"> hands back whatever was keyed; "40.0" and " 40 " are
  // the value the cell already had, not a change the manager made.
  registerEtcField("newEtcOverride__1", "40");
  updateEtcField("newEtcOverride__1", "40.0");
  assert.equal(isEtcDirty(), false);
  updateEtcField("newEtcOverride__1", " 40 ");
  assert.equal(isEtcDirty(), false);
  forgetEtcField("newEtcOverride__1");
});

test("clearing a cell that had a value IS an edit", () => {
  registerEtcField("newEtcOverride__1", "40");
  updateEtcField("newEtcOverride__1", "");
  assert.equal(isEtcDirty(), true);
  forgetEtcField("newEtcOverride__1");
});

test("blank is not zero", () => {
  // An empty New ETC means "nobody has decided this yet"; 0 means "nothing
  // left to do". Collapsing them would hide a real edit in both directions.
  registerEtcField("newEtcOverride__1", "");
  updateEtcField("newEtcOverride__1", "0");
  assert.equal(isEtcDirty(), true);
  forgetEtcField("newEtcOverride__1");
});

test("one clean field does not mask another dirty one", () => {
  registerEtcField("newEtcOverride__1", "40");
  registerEtcField("newEtcOverride__2", "10");
  updateEtcField("newEtcOverride__1", "48");
  updateEtcField("newEtcOverride__2", "10"); // untouched in effect
  assert.equal(isEtcDirty(), true);
  updateEtcField("newEtcOverride__1", "40"); // and back
  assert.equal(isEtcDirty(), false);
  forgetEtcField("newEtcOverride__1");
  forgetEtcField("newEtcOverride__2");
});

test("unmounting the grid clears the warning — this is the month-switch reset", () => {
  // The grid form is keyed on the month, so switching months tears down every
  // cell. That teardown IS the reset; there is no separate reset call, and if
  // forget() stopped removing the dirty entry the warning would follow the
  // manager into a month they never typed in.
  registerEtcField("newEtcOverride__1", "40");
  updateEtcField("newEtcOverride__1", "48");
  assert.equal(isEtcDirty(), true);
  forgetEtcField("newEtcOverride__1");
  assert.equal(isEtcDirty(), false);
});

test("re-registering does not clobber a baseline that a save moved forward", () => {
  // React StrictMode double-invokes mount effects in dev. If the second
  // register reset the baseline to the page's original value, a saved cell
  // would immediately read as dirty again.
  registerEtcField("newEtcOverride__1", "40");
  const fd = new FormData();
  fd.set("newEtcOverride__1", "48");
  rebaselineEtcFields(fd);
  registerEtcField("newEtcOverride__1", "40"); // the double-invoke
  updateEtcField("newEtcOverride__1", "48");
  assert.equal(isEtcDirty(), false);
  forgetEtcField("newEtcOverride__1");
});

test("after a save, the saved values are the new baseline", () => {
  registerEtcField("newEtcOverride__1", "40");
  updateEtcField("newEtcOverride__1", "48");
  assert.equal(isEtcDirty(), true);

  const fd = new FormData();
  fd.set("newEtcOverride__1", "48");
  rebaselineEtcFields(fd);
  assert.equal(isEtcDirty(), false);

  // ...and typing back to the PRE-save value is now a real unsaved edit, not
  // a return to clean. A plain "clear the flag" would have got this backwards.
  updateEtcField("newEtcOverride__1", "40");
  assert.equal(isEtcDirty(), true);
  forgetEtcField("newEtcOverride__1");
});

test("a save leaves fields it didn't post alone", () => {
  // A department Columns filter means those inputs aren't in the form at all.
  // saveAllNewEtcDrafts skips them server-side; re-baselining them here would
  // silently drop an edit the manager still has pending in a hidden column.
  registerEtcField("newEtcOverride__1", "40");
  registerEtcField("newEtcOverride__hidden", "10");
  updateEtcField("newEtcOverride__hidden", "99");

  const fd = new FormData();
  fd.set("newEtcOverride__1", "48"); // only the visible one was posted
  rebaselineEtcFields(fd);

  assert.equal(isEtcDirty(), true);
  forgetEtcField("newEtcOverride__1");
  forgetEtcField("newEtcOverride__hidden");
});

test("a save cannot invent baselines for unrelated form fields", () => {
  // The posted FormData carries hours and passwords too. Only registered
  // names are baselined, so nothing else can end up tracked.
  const fd = new FormData();
  fd.set("hoursWorked__1", "8");
  fd.set("newEtcSavePassword", "hunter2");
  rebaselineEtcFields(fd);
  assert.equal(isEtcDirty(), false);
  updateEtcField("hoursWorked__1", "9");
  // Unregistered -> treated as an edit rather than ignored, then cleaned up.
  assert.equal(isEtcDirty(), true);
  forgetEtcField("hoursWorked__1");
  assert.equal(isEtcDirty(), false);
});

// ── The Standard Fees pool flush registry ───────────────────────────────────
//
// `Submit {Month} Report` calls this the same way it calls flushEtcAutosave — a
// SECOND, separate registry (PoolAutosave.tsx registers into it, not
// EtcAutosave.tsx) that used to not exist at all: the submission flushed the ETC
// grid's debounce and never the pool panel's, so a "Hours being pulled" edit still
// on its own 800ms debounce could be frozen over by loadStandardSheetRows reading
// whatever CategoryPool already had saved.

test("flushing with nothing registered is a safe no-op", async () => {
  // A locked month, or a session that never unlocked the Standard view, mounts
  // no PoolAutosave at all — the submission still has to be able to call this.
  await assert.doesNotReject(flushPoolAutosave());
});

test("flushing calls the registered function", async () => {
  let calls = 0;
  const unregister = registerPoolAutosaveFlush(async () => {
    calls++;
  });
  await flushPoolAutosave();
  assert.equal(calls, 1);
  unregister();
});

test("unregistering stops it from being called again", async () => {
  let calls = 0;
  const unregister = registerPoolAutosaveFlush(async () => {
    calls++;
  });
  unregister();
  await flushPoolAutosave();
  assert.equal(calls, 0);
});

test("an unregister call cannot clobber a NEWER registration", async () => {
  // Same guard as registerEtcAutosaveFlush, and for the same reason: a panel
  // that unmounts while a second one (a fast month switch) has already
  // registered its own flush must not silence the one still mounted.
  let firstCalls = 0;
  let secondCalls = 0;
  const unregisterFirst = registerPoolAutosaveFlush(async () => {
    firstCalls++;
  });
  const unregisterSecond = registerPoolAutosaveFlush(async () => {
    secondCalls++;
  });
  unregisterFirst(); // stale — the second registration already replaced it
  await flushPoolAutosave();
  assert.equal(firstCalls, 0);
  assert.equal(secondCalls, 1);
  unregisterSecond();
});
