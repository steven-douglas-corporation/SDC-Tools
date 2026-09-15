import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { settleRefreshRun } from "../src/lib/live-refresh-run";
import { changeVersionMoved } from "../src/lib/change-version";

// ── The marker moves only when the refresh runs (2026-09-14) ────────────────
//
// LiveRefresh recorded `syncedAtVersion = latest` BEFORE run(), and run() then bailed
// for a save in flight. The marker had moved, the refresh had not, and the next focus
// compared against the new marker and skipped too — a colleague's change stayed
// invisible until the five-minute backstop.
//
// Extends tests/live-refresh-gate.test.ts.

test("skipped for a save in flight: no refresh, and the marker stays where it was", () => {
  assert.deepEqual(settleRefreshRun({ saving: true, syncedAt: 10, latest: 12 }), { ran: false, syncedAtVersion: 10 });
  // So the next focus still sees 10 -> 12 as movement and refreshes.
  assert.equal(changeVersionMoved(10, 12), true);
});

test("not saving: the refresh runs and the marker moves to what the gate observed", () => {
  assert.deepEqual(settleRefreshRun({ saving: false, syncedAt: 10, latest: 12 }), { ran: true, syncedAtVersion: 12 });
});

test("a run that did not come through the gate learns nothing about the version", () => {
  assert.deepEqual(settleRefreshRun({ saving: false, syncedAt: 10, latest: undefined }), { ran: true, syncedAtVersion: 10 });
  assert.deepEqual(settleRefreshRun({ saving: true, syncedAt: null, latest: undefined }), { ran: false, syncedAtVersion: null });
});

test("a null version from the server (a 401) is still recorded when the refresh runs", () => {
  // changeVersionMoved treats null as "refresh", the safe direction; recording it keeps
  // that behaviour rather than freezing an older number in place.
  assert.deepEqual(settleRefreshRun({ saving: false, syncedAt: 10, latest: null }), { ran: true, syncedAtVersion: null });
});

test("LiveRefresh records the marker inside run(), not before it", () => {
  const src = readFileSync(join(process.cwd(), "src", "components", "LiveRefresh.tsx"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/syncedAtVersion = latest;\s*run\(\);/.test(code), "the record-then-maybe-bail order is the bug");
  assert.match(code, /run\(latest\);/);
  assert.match(
    code,
    /const outcome = settleRefreshRun\(\{ saving: isSavingSomewhere\(\), syncedAt: syncedAtVersion, latest \}\);\s*syncedAtVersion = outcome\.syncedAtVersion;\s*if \(!outcome\.ran\) return;/,
  );
});
