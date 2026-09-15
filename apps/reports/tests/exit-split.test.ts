import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { exitSplitPlan } from "../src/lib/exit-split";
import { EMPTY_WORKSPACE, activateTab, enterSplit, openTab } from "../src/lib/workspace";
import { openInSplit } from "../src/lib/split-view";

// ── Exit Split View, for either layout ──────────────────────────────────────
//
// REPORTED 2026-09-14: the sidebar's Exit Split View button threw a TypeError inside
// the workspace. It rendered because useSplitNav.isSplit is true for a /w split, and
// it always called closePaneHref(splitNav.state!, …) — but `state` exists only on
// /split. The decision is pure now, and pinned here for both layouts.

function split() {
  let ws = openTab(EMPTY_WORKSPACE, "/etc", { month: "2026-08" }, { newInstance: true });
  ws = openTab(ws, "/job-hours", { jobs: "1101" }, { newInstance: true });
  const right = ws.active;
  ws = activateTab(ws, ws.tabs[0].id);
  return enterSplit(ws, right); // ETC left (active), Job Details right
}

test("in the workspace: a state change that keeps the ACTIVE pane, not a navigation", () => {
  const ws = activateTab(split(), split().split!.right); // working in the right pane
  const plan = exitSplitPlan(ws, null);
  assert.ok(plan && plan.kind === "workspace");
  assert.equal(plan.next.split, null);
  assert.equal(plan.next.active, ws.split!.right, "the pane you were working in survives");
  assert.equal(plan.next.tabs.length, 2, "nothing is closed — the other tab stays open behind it");
});

test("in the workspace, with the left pane active, the left survives", () => {
  const ws = split();
  const plan = exitSplitPlan(ws, null);
  assert.ok(plan && plan.kind === "workspace");
  assert.equal(plan.next.active, ws.split!.left);
});

test("the workspace wins when both are somehow present", () => {
  const ws = split();
  const legacy = openInSplit({ path: "/etc", params: {} }, { path: "/hours" });
  const plan = exitSplitPlan(ws, legacy);
  assert.equal(plan?.kind, "workspace");
});

test("on /split: an href to the surviving pane's own route", () => {
  const state = openInSplit({ path: "/etc", params: { month: "2026-08" } }, { path: "/job-hours", params: { jobs: "1101" } });
  // openInSplit makes the RIGHT pane active; it survives.
  assert.deepEqual(exitSplitPlan(null, state), { kind: "split", href: "/job-hours?jobs=1101" });
  assert.deepEqual(exitSplitPlan(null, { ...state, active: "l" }), { kind: "split", href: "/etc?month=2026-08" });
});

test("nothing to exit: a one-tab workspace, a one-pane /split, or neither", () => {
  const ws = openTab(EMPTY_WORKSPACE, "/etc", {}, { newInstance: true });
  assert.equal(exitSplitPlan(ws, null), null);
  assert.equal(exitSplitPlan(null, { l: { path: "/etc", params: {} }, r: null, ratio: 50, active: "l" }), null);
  assert.equal(exitSplitPlan(null, null), null);
  assert.equal(exitSplitPlan(undefined, undefined), null);
});

test("the sidebar no longer dereferences splitNav.state unguarded", () => {
  const sidebar = readFileSync(join(process.cwd(), "src", "components", "Sidebar.tsx"), "utf8");
  assert.ok(!sidebar.includes("splitNav.state!"), "the non-null assertion is the TypeError");
  assert.match(sidebar, /exitSplitPlan\(splitNav\.workspace, splitNav\.state\)/, "one decision for both layouts");
  assert.match(sidebar, /tabs\.exitSplitView\(\)/, "the workspace case goes through the centralized action");
  const actions = readFileSync(join(process.cwd(), "src", "components", "useWorkspaceActions.ts"), "utf8");
  assert.match(actions, /const exitSplitView = useCallback/);
  assert.match(actions, /^    exitSplitView,$/m, "and it is returned");
  assert.match(actions, /exitSplit\(workspace, workspace\.active\)/, "keeping the active pane, like Ctrl+\\");
});
