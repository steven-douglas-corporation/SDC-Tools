import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { clearTabScrollState, staleScrollScopes, tabScrollScope, tabScrollStorageKey } from "../src/lib/tab-scroll-state";
import { EMPTY_WORKSPACE, activateTab, closeTab, moveTab, navigateTab, openTab, setTabParams } from "../src/lib/workspace";

// ── The scroll identity is the tab AND what it is showing (2026-09-14) ───────
//
// REPORTED: re-route a tab (Hours → Projects in the same tab, which a sidebar click
// does while split) and Projects opened at Hours' old offsets; change the month on
// Monthly ETC and August's horizontal position was applied to September. The store
// was keyed by tab id alone and nothing cleared it on a route change.
//
// Extends tests/tab-scroll-state.test.ts.

test("the scope names the tab, the route and the instance param", () => {
  assert.equal(tabScrollScope({ id: "t2", path: "/etc", params: { month: "2026-08", dept: "ME" } }), "t2:/etc@2026-08");
  assert.equal(tabScrollScope({ id: "t1", path: "/hours", params: { page: "3" } }), "t1:/hours", "a filter is not an instance");
  assert.equal(tabScrollScope({ id: "t3", path: "/job-hours", params: { jobs: "1101,1148" } }), "t3:/job-hours@1101,1148");
  assert.equal(tabScrollScope({ id: "t4", path: "/etc", params: {} }), "t4:/etc", "no instance yet");
  assert.equal(tabScrollScope({ id: "t4", path: "/etc", params: { month: "" } }), "t4:/etc", "cleared reads as none");
});

test("two tabs on the same month still have different scopes — the earlier fix, kept", () => {
  const a = tabScrollScope({ id: "t1", path: "/etc", params: { month: "2026-08" } });
  const b = tabScrollScope({ id: "t2", path: "/etc", params: { month: "2026-08" } });
  assert.notEqual(a, b);
  assert.notEqual(tabScrollStorageKey(a), tabScrollStorageKey(b));
});

test("a re-routed tab changes scope; a filter change on the same page does not", () => {
  const ws = openTab(EMPTY_WORKSPACE, "/hours", { page: "1" }, { newInstance: true });
  const id = ws.active;
  assert.notEqual(tabScrollScope(ws.tabs[0]), tabScrollScope(navigateTab(ws, id, "/quoted").tabs[0]));
  assert.equal(tabScrollScope(ws.tabs[0]), tabScrollScope(setTabParams(ws, id, { page: "2", sort: "job" }).tabs[0]));
});

test("a new month starts at the top: the scope changes with the instance param", () => {
  const ws = openTab(EMPTY_WORKSPACE, "/etc", { month: "2026-08" }, { newInstance: true });
  const sep = setTabParams(ws, ws.active, { month: "2026-09" });
  assert.notEqual(tabScrollScope(ws.tabs[0]), tabScrollScope(sep.tabs[0]));
  assert.deepEqual(staleScrollScopes(ws, sep), ["t1:/etc@2026-08"], "August's offsets are forgotten");
});

test("staleScrollScopes: closing and re-routing leave scopes to forget; switching and reordering do not", () => {
  let ws = openTab(EMPTY_WORKSPACE, "/hours", {}, { newInstance: true });
  ws = openTab(ws, "/etc", { month: "2026-08" }, { newInstance: true });
  ws = openTab(ws, "/quoted", {}, { newInstance: true });
  assert.deepEqual(staleScrollScopes(ws, closeTab(ws, "t2")), ["t2:/etc@2026-08"]);
  assert.deepEqual(staleScrollScopes(ws, navigateTab(ws, "t1", "/tm")), ["t1:/hours"]);
  assert.deepEqual(staleScrollScopes(ws, activateTab(ws, "t1")), []);
  assert.deepEqual(staleScrollScopes(ws, moveTab(ws, "t3", 0)), []);
  assert.deepEqual(staleScrollScopes(ws, ws), []);
  assert.deepEqual(staleScrollScopes(ws, EMPTY_WORKSPACE), ["t1:/hours", "t2:/etc@2026-08", "t3:/quoted"]);
});

test("clearTabScrollState removes exactly that scope's key, and survives a throwing store", () => {
  const removed: string[] = [];
  clearTabScrollState("t1:/hours", { removeItem: (k) => void removed.push(k) });
  assert.deepEqual(removed, [tabScrollStorageKey("t1:/hours")]);
  assert.doesNotThrow(() =>
    clearTabScrollState("t1:/hours", {
      removeItem: () => {
        throw new Error("SecurityError");
      },
    }),
  );
  assert.doesNotThrow(() => clearTabScrollState("t1:/hours", null));
});

test("the component is scoped, and re-seeds when the scope changes", () => {
  const component = readFileSync(join(process.cwd(), "src", "components", "TabScrollMemory.tsx"), "utf8");
  assert.match(component, /const storageKey = tabScrollStorageKey\(scope\);/);
  assert.match(component, /if \(loadedScope\.current !== null && loadedScope\.current !== scope\) \{\s*loaded\.current = false;\s*state\.current = \{\};/);
  assert.match(component, /\}, \[tabId, scope\]\);/);
  const shell = readFileSync(join(process.cwd(), "src", "components", "WorkspaceShell.tsx"), "utf8");
  assert.match(shell, /<TabScrollMemory tabId=\{id\} scope=\{tabScrollScope\(tabById\(ws, id\)!\)\}>/);
  assert.match(shell, /for \(const scope of staleScrollScopes\(prevWs\.current, ws\)\) clearTabScrollState\(scope, storage\);/);
});
