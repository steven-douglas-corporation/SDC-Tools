import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { heldToReannounce, suspendHeld, type HeldCell } from "../src/lib/presence-held";

// ── Presence across a hide/show of the browser tab ──────────────────────────
//
// REPORTED 2026-09-14: hide the tab with a cell focused, come back, and the editing
// indicator is gone for everyone else until the cell is blurred and refocused.
// RealtimeProvider released every held cell on hide (correct) and re-claimed nothing
// on show. The re-claim rule is pure and pinned here.

const cell = (cellKey: string): HeldCell => ({ tab: "Monthly ETC", rowRef: "1148", columnName: "New ETC", cellKey });

test("suspending copies the held set, so releasing the live set cannot empty the memory", () => {
  const live = new Map([["a", cell("a")], ["b", cell("b")]]);
  const suspended = suspendHeld(live);
  live.clear(); // what releaseEverything does
  assert.equal(suspended.size, 2);
});

test("focus still in one of the held cells: re-announce exactly that one", () => {
  const suspended = suspendHeld(new Map([["a", cell("a")], ["b", cell("b")]]));
  assert.deepEqual(heldToReannounce(suspended, "b"), [cell("b")]);
});

test("nothing focused, or focus on something with no cell name: re-announce them all", () => {
  const suspended = suspendHeld(new Map([["a", cell("a")], ["b", cell("b")]]));
  assert.deepEqual(heldToReannounce(suspended, null), [cell("a"), cell("b")]);
});

test("focus moved to a DIFFERENT cell: announce nothing — that cell's own focus handler will", () => {
  const suspended = suspendHeld(new Map([["a", cell("a")]]));
  assert.deepEqual(heldToReannounce(suspended, "z"), []);
});

test("nothing was held: nothing to re-announce", () => {
  assert.deepEqual(heldToReannounce(new Map(), null), []);
  assert.deepEqual(heldToReannounce(new Map(), "a"), []);
});

test("the provider remembers on hide and re-claims on show, and mints an id per connection", () => {
  const raw = readFileSync(join(process.cwd(), "src", "components", "RealtimeProvider.tsx"), "utf8");
  // Comments stripped: the file DISCUSSES the sessionStorage id it replaced.
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.match(src, /if \(document\.visibilityState === "hidden"\) suspendForHide\(true\);\s*else resumeAfterShow\(\);/);
  assert.match(src, /suspended = suspendHeld\(heldRefs\);/);
  assert.match(src, /for \(const ref of refs\) beginEditingCell\(ref\);/);
  // Finding 4c: no sessionStorage-persisted id that a duplicated tab would copy.
  assert.ok(!src.includes("sessionStorage"), "the session id must not be persisted where Duplicate Tab copies it");
  assert.match(src, /mySessionId = mintSessionId\(\);/);
  // And the cells still held are re-claimed under the new connection's id.
  assert.match(src, /for \(const ref of heldRefs\.values\(\)\) post\(\{ action: "enter", \.\.\.ref \}\);/);
});
