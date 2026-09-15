import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { shouldFlushOnDeactivate, shouldRearmOnReactivate } from "../src/lib/autosave-lifecycle";

// ── Hidden behind <Activity>, and shown again (2026-09-14) ───────────────────
//
// REPORTED: type in a Monthly ETC cell, switch tabs within 800ms, and the edit is
// never saved. Activity destroys effects on hide; useAutosave's cleanup cleared the
// pending timer and removed the visibilitychange flush, and nothing rescheduled it.
//
// Extends tests/autosave.test.ts.

test("deactivating with a save pending on the timer flushes it rather than dropping it", () => {
  assert.equal(shouldFlushOnDeactivate({ timerPending: true, inFlight: false }), true);
});

test("deactivating with nothing pending does nothing", () => {
  assert.equal(shouldFlushOnDeactivate({ timerPending: false, inFlight: false }), false);
});

test("deactivating mid-save does not start a second save — the running one's follow-up owns it", () => {
  assert.equal(shouldFlushOnDeactivate({ timerPending: true, inFlight: true }), false);
});

test("reactivating a still-dirty grid re-arms the debounce", () => {
  assert.equal(shouldRearmOnReactivate({ enabled: true, dirty: true, inFlight: false, lastSaveOk: null }), true);
  assert.equal(shouldRearmOnReactivate({ enabled: true, dirty: true, inFlight: false, lastSaveOk: true }), true);
});

test("reactivating does NOT re-arm when clean, disabled, in flight, or after a refused write", () => {
  assert.equal(shouldRearmOnReactivate({ enabled: true, dirty: false, inFlight: false, lastSaveOk: null }), false);
  assert.equal(shouldRearmOnReactivate({ enabled: false, dirty: true, inFlight: false, lastSaveOk: null }), false, "the gate");
  assert.equal(shouldRearmOnReactivate({ enabled: true, dirty: true, inFlight: true, lastSaveOk: null }), false);
  // Same rule as needsFollowUpSave: never auto-retry a failure.
  assert.equal(shouldRearmOnReactivate({ enabled: true, dirty: true, inFlight: false, lastSaveOk: false }), false);
});

test("the hook applies both rules in its mount/unmount effect", () => {
  const src = readFileSync(join(process.cwd(), "src", "components", "useAutosave.ts"), "utf8");
  assert.match(src, /if \(shouldFlushOnDeactivate\(\{ timerPending: pending, inFlight: inFlight\.current \}\)\) void run\(\);/);
  assert.match(
    src,
    /shouldRearmOnReactivate\(\{ enabled: on, dirty: dirty\(\), inFlight: inFlight\.current, lastSaveOk: lastSaveOk\.current \}\)/,
  );
  // The old cleanup — clear and forget — is gone.
  assert.ok(!/return \(\) => \{\s*if \(t\.current\) clearTimeout\(t\.current\);\s*\};/.test(src), "the timer must not simply be dropped");
  // And the timer is nulled when it fires, or "pending" would read true forever.
  assert.match(src, /timer\.current = setTimeout\(\(\) => \{\s*timer\.current = null;\s*void run\(\);/);
});
