import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyRemoteEtcValues,
  readRemoteEtcValue,
  forgetRemoteEtcValue,
  clearRemoteEtcValues,
  subscribeRemoteEtcValues,
} from "../src/lib/etc-remote-values";
import { formatNewEtcText, etcCreateCellLiveKey } from "../src/lib/etc";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ── Incremental realtime updates ────────────────────────────────────────────
//
// The performance fix behind these tests (DEVLOG §17): a colleague's saved value used
// to reach other browsers by asking the server to render the whole route again —
// 854 KB and ~600ms for one number on Monthly ETC, per event, in every open tab. Now
// the event names the cell and the value goes straight into it.
//
// What has to hold for that to be SAFE rather than just fast:
//   * a value must reach the cell under either of the two names it can have
//   * "cleared" must survive the trip as cleared, not as "no information"
//   * an event that names no cell must be reported as unapplied, so the caller still
//     falls back to a refetch instead of silently dropping the change
//   * a full server render must always win over a cached event

test("a change reaches the cell under either of its two names", () => {
  clearRemoteEtcValues();
  // An existing row is addressed by entry id; a section with no row yet by
  // job+section. Two browsers can be holding different ones for the same cell.
  const applied = applyRemoteEtcValues([
    { cellKey: "newEtcOverride__50337", altCellKey: "newEtcCreate__12__10-311", newValue: "88" },
  ]);
  assert.equal(applied, 1);
  assert.equal(readRemoteEtcValue("newEtcOverride__50337"), "88");
  assert.equal(readRemoteEtcValue("newEtcCreate__12__10-311"), "88");
});

test("a removal arrives as CLEARED, not as 'nothing to say'", () => {
  clearRemoteEtcValues();
  applyRemoteEtcValues([{ cellKey: "c1", newValue: null }]);
  // "" is the announcement that the cell is empty. `null` from readRemoteEtcValue
  // would mean the opposite — no announcement at all — and the cell would keep
  // showing the value the page loaded with. That difference IS the clearing bug
  // (DEVLOG §16) reappearing through the cache, so it is asserted directly.
  assert.equal(readRemoteEtcValue("c1"), "");
  assert.notEqual(readRemoteEtcValue("c1"), null);
});

test("an event that names no cell is reported as unapplied", () => {
  clearRemoteEtcValues();
  // A bulk sync, a change on another tab, or an event from a server build that
  // predates cellKey. The caller uses the count to decide whether it still needs a
  // full refetch — returning 1 here would silently drop the change.
  const applied = applyRemoteEtcValues([
    { newValue: "5" },
    { cellKey: "", altCellKey: null, newValue: "5" },
  ]);
  assert.equal(applied, 0);
});

test("a mixed batch reports only the addressable ones", () => {
  clearRemoteEtcValues();
  const applied = applyRemoteEtcValues([
    { cellKey: "c1", newValue: "1" },
    { newValue: "2" },
    { cellKey: "c3", newValue: "3" },
  ]);
  assert.equal(applied, 2, "so the caller still refetches for the third");
});

test("a fresh server render retires the cached event", () => {
  clearRemoteEtcValues();
  applyRemoteEtcValues([{ cellKey: "c1", newValue: "88" }]);
  assert.equal(readRemoteEtcValue("c1"), "88");
  // The cell calls this when its server-rendered value moves: a full payload is
  // newer and more complete than any single event (it may carry changes whose events
  // this tab never received), so it wins. This is what stops a cached event from
  // reinstating a value the database no longer holds.
  forgetRemoteEtcValue("c1");
  assert.equal(readRemoteEtcValue("c1"), null);
});

test("subscribers are notified only when something actually changed", () => {
  clearRemoteEtcValues();
  // Every notification wakes EVERY mounted cell (~1,180 on this grid) to re-read its
  // own key. They each get the same string back and React skips them, but the point
  // of the fix is not doing avoidable work, so a no-op republish must not notify at
  // all — and a re-delivered event (SSE replays on reconnect) is exactly that.
  let notifications = 0;
  const unsub = subscribeRemoteEtcValues(() => notifications++);
  applyRemoteEtcValues([{ cellKey: "c1", newValue: "5" }]);
  assert.equal(notifications, 1);
  applyRemoteEtcValues([{ cellKey: "c1", newValue: "5" }]);
  assert.equal(notifications, 1, "the same value again is not news");
  applyRemoteEtcValues([{ cellKey: "c1", newValue: "6" }]);
  assert.equal(notifications, 2);
  // A whole batch is one notification, not one per cell — twenty cells saved in one
  // pass must cost a single render, which is the other half of the same fix.
  applyRemoteEtcValues([
    { cellKey: "c2", newValue: "1" },
    { cellKey: "c3", newValue: "2" },
    { cellKey: "c4", newValue: "3" },
  ]);
  assert.equal(notifications, 3);
  unsub();
});

// ── The value has to arrive FORMATTED like the cell ─────────────────────────
//
// The change log stores what was written (93.75), while an hours cell displays whole
// numbers (94). Pushing the raw string into the box would both look wrong and read as
// an unsaved edit to the dirty tracker, which would then post it back. So the
// receiving cell formats with the same function the seed uses.

test("an hours value is formatted whole, a Parts Cost value keeps its cents", () => {
  assert.equal(formatNewEtcText("93.75"), "94");
  assert.equal(formatNewEtcText("93.75", "whole"), "94");
  assert.equal(formatNewEtcText("5819.03", "exact"), "5819.03");
});

test("a cleared announcement formats to an empty box", () => {
  assert.equal(formatNewEtcText(""), "");
  assert.equal(formatNewEtcText(null), "");
  assert.equal(formatNewEtcText("   "), "");
  // Junk cannot become a number, and must not become "NaN" in a box either.
  assert.equal(formatNewEtcText("abc"), "");
});

test("zero survives the trip as zero", () => {
  // The one value most likely to be lost by a falsy check on the way through.
  assert.equal(formatNewEtcText("0"), "0");
  clearRemoteEtcValues();
  applyRemoteEtcValues([{ cellKey: "c1", newValue: "0" }]);
  assert.equal(readRemoteEtcValue("c1"), "0");
});

// ── A cell with no row yet is addressed WITH its month (2026-09-11) ─────────
//
// The form-field name `newEtcCreate__<jobPk>__<section>` has no month in it, on
// purpose (split-view.ts). It was also the key a colleague's value arrived under, so a
// September save to a not-yet-created cell named the SAME cell in a tab showing August
// — and a clean August cell adopted it. The live key now carries the month; the form
// field name does not, so the split-view guard's premise still holds.

test("the live key of a not-yet-created cell differs between months", () => {
  assert.notEqual(etcCreateCellLiveKey(9, "10-211", "2026-08"), etcCreateCellLiveKey(9, "10-211", "2026-09"));
  assert.equal(etcCreateCellLiveKey(9, "10-211", "2026-08"), "newEtcCreate__9__10-211__2026-08");
  clearRemoteEtcValues();
  applyRemoteEtcValues([{ cellKey: "newEtcOverride__777", altCellKey: etcCreateCellLiveKey(9, "10-211", "2026-09"), newValue: "40" }]);
  assert.equal(readRemoteEtcValue(etcCreateCellLiveKey(9, "10-211", "2026-09")), "40");
  assert.equal(readRemoteEtcValue(etcCreateCellLiveKey(9, "10-211", "2026-08")), null, "August's cell hears nothing");
  assert.equal(readRemoteEtcValue("newEtcCreate__9__10-211"), null, "and nothing is published under the bare field name");
});

test("both ends use the shared key — the server announcing, the cell listening", () => {
  const actions = readFileSync(join(process.cwd(), "src", "lib", "etc-actions.ts"), "utf8");
  assert.match(actions, /altCellKey: etcCreateCellLiveKey\(jobPk, section, month\)/);
  const cells = readFileSync(join(process.cwd(), "src", "components", "EtcSectionCells.tsx"), "utf8");
  assert.match(cells, /const liveKey = entryId != null \? fieldName : etcCreateCellLiveKey\(jobId, sectionCode, month\);/);
  assert.match(cells, /useRemoteEtcValue\(liveKey\)/);
  assert.match(cells, /forgetRemoteEtcValue\(liveKey\)/);
  assert.match(cells, /<CellPresence cellKey=\{liveKey\} \/>/);
  // The FORM field name is untouched — the dirty tracker, the server parser and the
  // split-view exclusivity guard all still key on it.
  assert.match(cells, /const fieldName = entryId != null \? `newEtcOverride__\$\{entryId\}` : `newEtcCreate__\$\{jobId\}__\$\{sectionCode\}`;/);
});
