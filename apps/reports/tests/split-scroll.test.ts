import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ── Independent scrolling in a split, and a tab that can be re-entered (2026-10-08) ──
//
// Two reports, both about tabs that are kept mounted behind <Activity>:
//
//   1. "scroll down on one tab while keeping the second tab in place" — the workspace was
//      only ever `min-h`, so panes grew to full page height and the document scrolled
//      both of them together.
//   2. Monthly ETC "inoperable once you leave it, and you cannot enter that tab again" —
//      GridViewProvider rewrote the URL on every re-show from a stale workspace.
//
// Source-level, like tab-scroll-scope.test.ts: the layout and the effect guard are the
// things that regressed, and neither is reachable without a browser.

const read = (...p: string[]) => readFileSync(join(process.cwd(), "src", ...p), "utf8");

test("a two-pane split pins the workspace to the window, so each pane scrolls itself", () => {
  const shell = read("components", "WorkspaceShell.tsx");
  // Always on at /w (2026-10-09): the tab strip must stay put while a page scrolls.
  assert.match(shell, /const independentScroll = true;/);
  assert.match(shell, /independentScroll \? "h-\[var\(--app-vh\)\] overflow-hidden" : "min-h-\[var\(--app-vh\)\]"/);
  // A pane that cannot shrink below its content would out-grow the pinned workspace.
  // (`relative` is the anchor for the drop-target outline, and changes nothing here.)
  assert.match(shell, /className="relative flex min-h-0 min-w-0 flex-col"/);
});

test("the per-pane scroll container is bounded by its pane", () => {
  const memory = read("components", "TabScrollMemory.tsx");
  assert.match(memory, /className="min-h-0 flex-1 overflow-auto bg-background"/);
});

test("GridViewProvider writes the URL on a change, not on 'any pass after the first'", () => {
  const provider = read("components", "GridViewProvider.tsx");
  assert.match(provider, /const lastSynced = useRef\(viewSyncKey\(pathname, initialHidden\)\);/);
  assert.match(provider, /if \(key === lastSynced\.current\) return;/);
  assert.doesNotMatch(provider, /firstUrlSync/, "a first-pass flag is wrong under <Activity>, which re-runs effects on show");
});
