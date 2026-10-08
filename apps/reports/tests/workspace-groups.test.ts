import test from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_WORKSPACE,
  MAX_TABS,
  activateTab,
  closeOtherTabs,
  closeTab,
  decodeWorkspace,
  dropOnSide,
  duplicateTab,
  encodeWorkspace,
  enterSplit,
  exitSplit,
  focusedSide,
  groupOf,
  groupTabs,
  moveTabTo,
  openTab,
  placePage,
  sidebarClick,
  splitWithTab,
  tabById,
  visibleIn,
  type Workspace,
} from "../src/lib/workspace";

// ── Split view as two groups of tabs (2026-10-08) ────────────────────────────
//
// Requested: the tab strip belongs to each side of a split; pages can be dragged from
// the sidebar into either side, or onto the edge of the screen to start a split; and
// closing every tab of one side puts the other side back as the whole workspace.
//
// The model keeps ONE flat `tabs` list (every pane stays mounted, see WorkspaceShell)
// and rides group membership on `split.rightTabs`. These tests pin the rules; the
// invariant checker at the bottom runs them against hundreds of random operations.

const ids = (ws: Workspace) => ws.tabs.map((t) => t.id);
const strip = (ws: Workspace, side: "left" | "right") => groupTabs(ws, side).map((t) => t.id);

/** Four tabs t1..t4 (ETC, Hours, Job Details, Quoted), no split, t4 active. */
function four(): Workspace {
  let ws = openTab(EMPTY_WORKSPACE, "/etc", { month: "2026-08" });
  ws = openTab(ws, "/hours", {}, { newInstance: true });
  ws = openTab(ws, "/job-hours", { jobs: "1101" }, { newInstance: true });
  ws = openTab(ws, "/quoted", {}, { newInstance: true });
  return ws;
}

/** t1 t2 | t3 t4 — left shows t2, right shows t4, left focused. */
function twoByTwo(): Workspace {
  let ws = four();
  ws = enterSplit(activateTab(ws, "t2"), "t3");
  ws = moveTabTo(ws, "t4", "right");
  return activateTab(ws, "t2");
}

/** Everything the model promises about a split. Returns the first violation, or null. */
function violation(ws: Workspace): string | null {
  const live = new Set(ids(ws));
  if (live.size !== ws.tabs.length) return "duplicate tab id";
  if (ws.tabs.length === 0) return ws.split ? "split with no tabs" : null;
  if (!live.has(ws.active)) return "active is not a tab";
  if (ws.mru.some((m) => !live.has(m))) return "mru names a closed tab";
  if (!ws.split) return null;
  const { left, right, rightTabs } = ws.split;
  if (!live.has(left) || !live.has(right)) return "a group shows a tab that does not exist";
  if (rightTabs.some((r) => !live.has(r))) return "rightTabs names a closed tab";
  if (new Set(rightTabs).size !== rightTabs.length) return "rightTabs repeats an id";
  if (!rightTabs.includes(right)) return "right is not in the right group";
  if (rightTabs.includes(left)) return "left is in the right group";
  if (ws.active !== left && ws.active !== right) return "active is not on screen";
  if (strip(ws, "left").length === 0 || strip(ws, "right").length === 0) return "an empty group";
  return null;
}

test("entering a split makes the chosen tab a group of its own and keeps the rest together", () => {
  const ws = enterSplit(activateTab(four(), "t2"), "t3");
  assert.deepEqual(strip(ws, "left"), ["t1", "t2", "t4"]);
  assert.deepEqual(strip(ws, "right"), ["t3"]);
  assert.equal(visibleIn(ws, "left"), "t2");
  assert.equal(visibleIn(ws, "right"), "t3");
  assert.equal(groupOf(ws, "t3"), "right");
  assert.equal(focusedSide(ws), "left");
  assert.equal(violation(ws), null);
});

test("outside a split there is one group holding every tab", () => {
  const ws = four();
  assert.deepEqual(strip(ws, "left"), ids(ws));
  assert.deepEqual(strip(ws, "right"), []);
  assert.equal(visibleIn(ws, "left"), ws.active);
  assert.equal(enterSplit(enterSplit(ws, "t1"), "t2").split!.right, "t1", "a second enterSplit is ignored");
});

// ── Closing ─────────────────────────────────────────────────────────────────

test("closing the last tab of the RIGHT group ends the split and the left group fills the page", () => {
  let ws = enterSplit(activateTab(four(), "t2"), "t3");
  ws = closeTab(ws, "t3");
  assert.equal(ws.split, null);
  assert.deepEqual(ids(ws), ["t1", "t2", "t4"], "every tab of the surviving group is still there");
  assert.equal(ws.active, "t2", "and it shows what it was showing");
  assert.equal(violation(ws), null);
});

test("closing the last tab of the LEFT group ends the split and the right group fills the page", () => {
  let ws = enterSplit(activateTab(four(), "t1"), "t2");
  ws = moveTabTo(ws, "t3", "right");
  ws = moveTabTo(ws, "t4", "right"); // left: t1 | right: t2 t3 t4 (t4 shown, focused)
  assert.deepEqual(strip(ws, "left"), ["t1"]);
  ws = closeTab(ws, "t1");
  assert.equal(ws.split, null);
  assert.deepEqual(ids(ws), ["t2", "t3", "t4"]);
  assert.equal(ws.active, "t4", "the right group keeps showing its own visible tab");
  assert.equal(violation(ws), null);
});

test("closing one of several tabs in a group keeps the split", () => {
  const ws = closeTab(twoByTwo(), "t1");
  assert.ok(ws.split);
  assert.deepEqual(strip(ws, "left"), ["t2"]);
  assert.deepEqual(strip(ws, "right"), ["t3", "t4"]);
  assert.equal(violation(ws), null);
});

test("closing the tab a group is showing lands on that group's most recently used tab, not the other group's", () => {
  let ws = twoByTwo(); // left t1 t2 (t2 shown, focused), right t3 t4 (t4 shown)
  ws = activateTab(ws, "t1");
  ws = activateTab(ws, "t2"); // MRU: t2, t1, t4, t3
  ws = closeTab(ws, "t2");
  assert.equal(ws.split!.left, "t1");
  assert.equal(ws.active, "t1");
  assert.equal(ws.split!.right, "t4", "the other group did not move");
  assert.equal(violation(ws), null);
});

test("closing a tab in the UNFOCUSED group leaves focus where it was", () => {
  let ws = twoByTwo();
  assert.equal(ws.active, "t2");
  ws = closeTab(ws, "t4"); // the right group's visible tab; focus is in the left group
  assert.equal(ws.active, "t2");
  assert.equal(ws.split!.right, "t3");
  assert.equal(violation(ws), null);
});

test("closing a background tab changes nothing on screen", () => {
  let ws = twoByTwo();
  ws = closeTab(ws, "t1");
  assert.equal(ws.split!.left, "t2");
  assert.equal(ws.active, "t2");
});

// ── Activating ──────────────────────────────────────────────────────────────

test("activating a tab hiding in a group shows it there and focuses that group", () => {
  const ws = activateTab(twoByTwo(), "t3");
  assert.equal(ws.split!.right, "t3");
  assert.equal(ws.split!.left, "t2", "the other group is untouched");
  assert.equal(ws.active, "t3");
  assert.equal(focusedSide(ws), "right");
});

test("activating what is already active returns the same workspace", () => {
  const ws = twoByTwo();
  assert.equal(activateTab(ws, ws.active), ws);
});

// ── Opening ─────────────────────────────────────────────────────────────────

test("a new tab opens in the focused group", () => {
  let ws = activateTab(twoByTwo(), "t4"); // right focused
  ws = openTab(ws, "/cash-flow", {}, { newInstance: true });
  assert.equal(groupOf(ws, ws.active), "right");
  assert.equal(ws.split!.right, ws.active);
  assert.equal(ws.split!.left, "t2");
  assert.equal(violation(ws), null);
});

test("duplicating a tab puts the copy in the SOURCE's group even when the other group is focused", () => {
  let ws = twoByTwo(); // left focused
  ws = duplicateTab(ws, "t3"); // t3 is in the right group
  assert.equal(groupOf(ws, ws.active), "right");
  assert.equal(ws.split!.right, ws.active);
  assert.deepEqual(strip(ws, "right").slice(0, 2), ["t3", ws.active], "right beside its source");
  assert.equal(violation(ws), null);
});

test("a sidebar click resumes the page wherever it is open, otherwise opens it in the focused group", () => {
  const ws = twoByTwo(); // left focused
  const resumed = sidebarClick(ws, "/job-hours"); // t3, in the right group
  assert.equal(resumed.tabs.length, ws.tabs.length, "no copy");
  assert.equal(resumed.active, "t3");
  assert.equal(focusedSide(resumed), "right");

  const opened = sidebarClick(ws, "/cash-flow");
  assert.equal(groupOf(opened, opened.active), "left");
});

// ── Moving ──────────────────────────────────────────────────────────────────

test("moving a tab to the other group shows it there and focuses it", () => {
  const ws = moveTabTo(twoByTwo(), "t1", "right");
  assert.deepEqual(strip(ws, "left"), ["t2"]);
  assert.deepEqual(strip(ws, "right"), ["t3", "t4", "t1"], "at the end when dropped on the strip, not on a tab");
  assert.equal(ws.split!.right, "t1");
  assert.equal(ws.active, "t1");
  assert.equal(violation(ws), null);
});

test("moving a tab before a specific tab in the other group lands there", () => {
  const ws = moveTabTo(twoByTwo(), "t1", "right", "t4");
  assert.deepEqual(strip(ws, "right"), ["t3", "t1", "t4"]);
});

test("moving the tab a group was showing hands that group its best remaining tab", () => {
  let ws = twoByTwo(); // left shows t2
  ws = moveTabTo(ws, "t2", "right");
  assert.equal(ws.split!.left, "t1");
  assert.equal(ws.split!.right, "t2");
  assert.equal(violation(ws), null);
});

test("moving the only tab out of a group ends the split — the other group is the whole workspace", () => {
  let ws = enterSplit(activateTab(four(), "t1"), "t2");
  ws = moveTabTo(ws, "t3", "right");
  ws = moveTabTo(ws, "t4", "right"); // left: t1 alone
  ws = moveTabTo(ws, "t1", "right");
  assert.equal(ws.split, null);
  assert.equal(ws.tabs.length, 4);
  assert.equal(ws.active, "t1", "the tab that was just dropped is the one in front");
  assert.equal(violation(ws), null);
});

test("reordering inside a group touches only the order", () => {
  const ws = twoByTwo();
  const next = moveTabTo(ws, "t4", "right", "t3");
  assert.deepEqual(strip(next, "right"), ["t4", "t3"]);
  assert.equal(next.active, ws.active, "no focus change");
  assert.equal(next.split!.right, ws.split!.right);
  assert.deepEqual(strip(next, "left"), strip(ws, "left"));
});

test("with no split, moveTabTo is a plain reorder", () => {
  const ws = moveTabTo(four(), "t4", "left", "t1");
  assert.deepEqual(ids(ws), ["t4", "t1", "t2", "t3"]);
  assert.equal(ws.split, null);
  const same = four();
  assert.equal(moveTabTo(same, "t4", "left"), same, "already last: unchanged");
});

// ── Splitting off ───────────────────────────────────────────────────────────

test("splitWithTab to the right: the tab becomes its own group, the rest stay together", () => {
  const ws = splitWithTab(four(), "t2", "right");
  assert.deepEqual(strip(ws, "right"), ["t2"]);
  assert.deepEqual(strip(ws, "left"), ["t1", "t3", "t4"]);
  assert.equal(ws.split!.left, "t4", "the left group keeps showing what the user was in");
  assert.equal(ws.active, "t2");
  assert.equal(violation(ws), null);
});

test("splitWithTab to the left puts the tab on the left and the rest on the right", () => {
  const ws = splitWithTab(four(), "t2", "left");
  assert.deepEqual(strip(ws, "left"), ["t2"]);
  assert.deepEqual(strip(ws, "right"), ["t1", "t3", "t4"]);
  assert.equal(ws.split!.left, "t2");
  assert.equal(ws.split!.right, "t4");
  assert.equal(violation(ws), null);
});

test("splitWithTab needs a second tab and refuses to nest", () => {
  const one = openTab(EMPTY_WORKSPACE, "/etc");
  assert.equal(splitWithTab(one, one.active, "right"), one);
  const split = twoByTwo();
  assert.equal(splitWithTab(split, "t1", "right"), split);
  assert.equal(splitWithTab(four(), "t99", "right").split, null);
});

test("exiting a split appends the right group's tabs to the left group's strip and loses none", () => {
  const ws = exitSplit(twoByTwo(), "t4");
  assert.equal(ws.split, null);
  assert.deepEqual(ids(ws), ["t1", "t2", "t3", "t4"]);
  assert.equal(ws.active, "t4");
  const interleaved = moveTabTo(twoByTwo(), "t1", "right", "t3"); // right: t1 t3 t4
  assert.deepEqual(ids(exitSplit(interleaved)), ["t2", "t1", "t3", "t4"]);
});

test("Close Other Tabs inside a split closes that strip's tabs only", () => {
  const ws = closeOtherTabs(twoByTwo(), "t2");
  assert.deepEqual(strip(ws, "left"), ["t2"]);
  assert.deepEqual(strip(ws, "right"), ["t3", "t4"]);
  assert.equal(violation(ws), null);
});

// ── Dropping a page from the sidebar ────────────────────────────────────────

test("dropping a new page on the right edge opens it in a new right group", () => {
  const ws = placePage(four(), "/cash-flow", {}, "right");
  assert.equal(ws.tabs.length, 5);
  assert.deepEqual(strip(ws, "right"), ["t5"]);
  assert.equal(tabById(ws, "t5")?.path, "/cash-flow");
  assert.equal(ws.active, "t5");
  assert.equal(violation(ws), null);
});

test("dropping a new page on the left edge puts it on the left", () => {
  const ws = placePage(four(), "/cash-flow", {}, "left");
  assert.deepEqual(strip(ws, "left"), ["t5"]);
  assert.equal(strip(ws, "right").length, 4);
  assert.equal(violation(ws), null);
});

test("dropping a page that is already open moves that tab instead of opening a copy", () => {
  const ws = placePage(four(), "/job-hours", {}, "right");
  assert.equal(ws.tabs.length, 4);
  assert.deepEqual(strip(ws, "right"), ["t3"]);
  assert.equal(violation(ws), null);
});

test("dropping Monthly ETC moves the one ETC tab, never opens a second", () => {
  let ws = placePage(four(), "/etc", {}, "right");
  assert.equal(ws.tabs.filter((t) => t.path === "/etc").length, 1);
  assert.deepEqual(strip(ws, "right"), ["t1"]);
  ws = placePage(ws, "/etc", { month: "2026-09" }, "left");
  assert.equal(ws.tabs.filter((t) => t.path === "/etc").length, 1);
  assert.equal(tabById(ws, "t1")?.params.month, "2026-09", "a named month is carried onto the open tab");
  assert.equal(violation(ws), null);
});

test("dropping a page on a group of an existing split joins that group", () => {
  const ws = placePage(twoByTwo(), "/cash-flow", {}, "right");
  assert.equal(ws.tabs.length, 5);
  assert.equal(groupOf(ws, "t5"), "right");
  assert.equal(ws.split!.right, "t5");
  assert.equal(ws.split!.left, "t2", "the left group is untouched");
  assert.equal(violation(ws), null);
});

test("dropping a page onto the single tab's own page does not manufacture a split", () => {
  const one = openTab(EMPTY_WORKSPACE, "/etc");
  assert.equal(placePage(one, "/etc", {}, "right").split, null);
  // A page that cannot be a tab is ignored.
  assert.equal(placePage(four(), "/users", {}, "right").tabs.length, 4);
});

test("dropping a new page at the tab limit still works by closing a tab nobody is looking at", () => {
  let ws = EMPTY_WORKSPACE;
  const routes = ["/etc", "/hours", "/job-hours", "/quoted", "/cash-flow", "/jobs", "/employees", "/tm"];
  for (const r of routes.slice(0, MAX_TABS)) ws = openTab(ws, r, {}, { newInstance: true });
  assert.equal(ws.tabs.length, MAX_TABS);
  const next = placePage(ws, "/feedback", {}, "right");
  assert.equal(next.tabs.length, MAX_TABS);
  assert.equal(tabById(next, next.active)?.path, "/feedback");
  assert.equal(violation(next), null);
});

// ── One rule for every drop target ──────────────────────────────────────────

test("dropOnSide: a page starts a split with no split, and joins a side with one", () => {
  const started = dropOnSide(four(), { kind: "page", path: "/cash-flow" }, "right");
  assert.deepEqual(strip(started, "right"), ["t5"]);
  const joined = dropOnSide(twoByTwo(), { kind: "page", path: "/cash-flow" }, "left");
  assert.equal(groupOf(joined, "t5"), "left");
});

test("dropOnSide: a tab splits off with no split, and moves across with one", () => {
  const started = dropOnSide(four(), { kind: "tab", id: "t2" }, "left");
  assert.deepEqual(strip(started, "left"), ["t2"]);
  const moved = dropOnSide(twoByTwo(), { kind: "tab", id: "t1" }, "right");
  assert.equal(groupOf(moved, "t1"), "right");
});

test("dropOnSide: a tab dropped on the body of its OWN group changes nothing", () => {
  const ws = twoByTwo();
  assert.equal(dropOnSide(ws, { kind: "tab", id: "t1" }, "left"), ws);
});

// ── The URL ─────────────────────────────────────────────────────────────────

const raw = (qs: string) => {
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(qs)) out[k] = v;
  return out;
};

test("a split's groups survive the round trip through the URL", () => {
  const ws = twoByTwo();
  const back = decodeWorkspace(raw(encodeWorkspace(ws)));
  assert.deepEqual(back.split, ws.split);
  assert.equal(back.active, ws.active);
  assert.deepEqual(ids(back), ids(ws));
});

test("a split whose focused tab is the right one round-trips too", () => {
  const ws = activateTab(twoByTwo(), "t4");
  const back = decodeWorkspace(raw(encodeWorkspace(ws)));
  assert.equal(back.active, "t4");
  assert.equal(back.split!.right, "t4");
});

test("an old split URL, with no group list, becomes a one-tab right group and a left group of the rest", () => {
  const back = decodeWorkspace(raw("t=t1~/etc,t2~/hours,t3~/job-hours&s=t2:t3&r=40"));
  assert.deepEqual(back.split!.rightTabs, ["t3"]);
  assert.deepEqual(strip(back, "left"), ["t1", "t2"]);
  assert.equal(back.split!.ratio, 40);
  assert.equal(violation(back), null);
});

test("a hand-edited URL cannot break the invariants", () => {
  // g names the visible left tab, a tab that does not exist, and repeats an id.
  const a = decodeWorkspace(raw("t=t1~/etc,t2~/hours,t3~/job-hours&s=t1:t3&g=t1,t3,t3,t9"));
  assert.equal(violation(a), null);
  assert.ok(!a.split!.rightTabs.includes("t1"));
  // `a` names a hidden tab: it comes forward in its group.
  const b = decodeWorkspace(raw("t=t1~/etc,t2~/hours,t3~/job-hours,t4~/quoted&s=t1:t3&g=t3,t4&a=t4"));
  assert.equal(b.active, "t4");
  assert.equal(b.split!.right, "t4");
  assert.equal(violation(b), null);
  // No `a`: the left group's visible tab, even when it is not the first tab.
  const c = decodeWorkspace(raw("t=t1~/etc,t2~/hours,t3~/job-hours&s=t2:t3&g=t3"));
  assert.equal(c.active, "t2");
});

// ── Invariants under random use ─────────────────────────────────────────────

test("the invariants hold after every step of a long random sequence of operations", () => {
  // Seeded, so a failure is reproducible: the message names the seed and the step.
  let splitSteps = 0;
  let endedSplits = 0;
  for (let seed = 1; seed <= 40; seed++) {
    let s = seed * 2654435761;
    const rnd = (n: number) => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s % n;
    };
    const routes = ["/etc", "/hours", "/job-hours", "/quoted", "/cash-flow", "/jobs", "/employees", "/tm", "/feedback"];
    let ws: Workspace = EMPTY_WORKSPACE;
    for (let step = 0; step < 60; step++) {
      const tab = ws.tabs.length ? ws.tabs[rnd(ws.tabs.length)].id : "t1";
      const side = rnd(2) ? "left" : "right";
      const route = routes[rnd(routes.length)];
      const op = rnd(11);
      const prev = ws;
      const label = `seed ${seed} step ${step} op ${op}`;
      if (op === 0) ws = openTab(ws, route, {}, { newInstance: true });
      else if (op === 1) ws = closeTab(ws, tab);
      else if (op === 2) ws = activateTab(ws, tab);
      else if (op === 3) ws = moveTabTo(ws, tab, side, ws.tabs[rnd(ws.tabs.length || 1)]?.id ?? null);
      else if (op === 4) ws = splitWithTab(ws, tab, side);
      else if (op === 5) ws = placePage(ws, route, {}, side);
      else if (op === 6) ws = exitSplit(ws, tab);
      else if (op === 7) ws = sidebarClick(ws, route);
      else if (op === 8) ws = closeOtherTabs(ws, tab);
      else if (op === 9) ws = duplicateTab(ws, tab);
      else ws = enterSplit(ws, tab);
      const wasSplit = prev.split != null;
      if (ws.split) splitSteps++;
      if (wasSplit && !ws.split) endedSplits++;
      assert.equal(violation(ws), null, label);
      assert.ok(ws.tabs.length <= MAX_TABS, `${label}: over the tab cap`);
      // And the URL carries all of it.
      const back = decodeWorkspace(raw(encodeWorkspace(ws)));
      assert.deepEqual(back.split, ws.split, `${label}: split lost in the URL`);
      assert.equal(back.active, ws.active, `${label}: active lost in the URL`);
    }
  }
  // The run has to actually spend time in splits and end some, or it proves nothing.
  assert.ok(splitSteps > 400, `only ${splitSteps} steps were in a split`);
  assert.ok(endedSplits > 20, `only ${endedSplits} splits ended`);
});
