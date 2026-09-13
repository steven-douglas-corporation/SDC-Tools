import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EMPTY_WORKSPACE,
  MAX_TABS,
  activateTab,
  closeOtherTabs,
  closeTab,
  decodeWorkspace,
  duplicateTab,
  encodeWorkspace,
  enterSplit,
  exitSplit,
  moveTab,
  mostRecentInstance,
  navigateTab,
  nextTabId,
  openTab,
  openableRoutes,
  setSplitRatio,
  setTabParams,
  sidebarTarget,
  tabById,
  tabHref,
  tabIndex,
  tabInstanceHint,
  tabLabel,
  tabTitle,
  workspaceHref,
  type Workspace,
} from "../src/lib/workspace";
import { SPLIT_ROUTES, isExclusive } from "../src/lib/split-view";

// ── The workspace model ──────────────────────────────────────────────────────
//
// One centralized source of truth for open tab INSTANCES, the active tab, the split
// and the MRU. Pure, so every rule is provable here rather than only observable by
// clicking through eight tabs.
//
// Rewritten 2026-09-04 alongside the model itself. The first version keyed a tab by
// its index and matched "already open?" on path, which made one route = one tab. Two
// reports killed that: "I must be able to open Job Details three times", and tab
// switching being slow — the fix for which is keeping every tab MOUNTED, and a mounted
// pane needs an identity that survives reordering and closing. Hence ids.

const paths = (ws: Workspace) => ws.tabs.map((t) => t.path);
const ids = (ws: Workspace) => ws.tabs.map((t) => t.id);
/** The active tab's path — what most of these assertions are really about. */
const activePath = (ws: Workspace) => tabById(ws, ws.active)?.path;

test("the requested workflow, start to finish", () => {
  // Open Monthly ETC on August, open Job Details beside it, split them, resize.
  let ws = openTab(EMPTY_WORKSPACE, "/etc", { month: "2026-08" });
  assert.deepEqual(paths(ws), ["/etc"]);
  assert.equal(activePath(ws), "/etc");

  ws = openTab(ws, "/job-hours", { jobs: "1131" });
  assert.deepEqual(paths(ws), ["/etc", "/job-hours"]);
  assert.equal(activePath(ws), "/job-hours");

  const etc = ws.tabs[0].id;
  ws = enterSplit(ws, etc);
  assert.equal(ws.split?.left, ws.active);
  assert.equal(ws.split?.right, etc);

  ws = setSplitRatio(ws, 62);
  assert.equal(ws.split?.ratio, 62);

  // And it all survives the URL.
  assert.deepEqual(decodeWorkspace(Object.fromEntries(new URLSearchParams(encodeWorkspace(ws)))), ws);
});

// ── Instances ───────────────────────────────────────────────────────────────

test("a plain open RESUMES the existing instance rather than duplicating", () => {
  // "Do not make duplicate tabs accidental on every sidebar click."
  let ws = openTab(EMPTY_WORKSPACE, "/job-hours", { jobs: "1101" });
  const first = ws.tabs[0].id;
  ws = openTab(ws, "/quoted");
  ws = openTab(ws, "/job-hours");
  assert.equal(ws.tabs.length, 2, "no second Job Details tab");
  assert.equal(ws.active, first);
});

test("resuming carries the requested params in, so a named job is actually shown", () => {
  // A sidebar click that names a job must take you to the open tab AND show that job —
  // otherwise the click lands somewhere that looks unrelated to what was asked for.
  let ws = openTab(EMPTY_WORKSPACE, "/job-hours", { jobs: "1101" });
  ws = openTab(ws, "/job-hours", { jobs: "1148" });
  assert.equal(ws.tabs.length, 1);
  assert.equal(ws.tabs[0].params.jobs, "1148");
  // But an open with NO params is "just take me there" and leaves the view alone.
  ws = openTab(ws, "/job-hours");
  assert.equal(ws.tabs[0].params.jobs, "1148");
});

test("newInstance opens another one — three Job Details at once", () => {
  // The headline request. Each is an independent instance with its own params.
  let ws = openTab(EMPTY_WORKSPACE, "/job-hours", { jobs: "1101" }, { newInstance: true });
  ws = openTab(ws, "/job-hours", { jobs: "1148" }, { newInstance: true });
  ws = openTab(ws, "/job-hours", { jobs: "1158" }, { newInstance: true });

  assert.deepEqual(paths(ws), ["/job-hours", "/job-hours", "/job-hours"]);
  assert.deepEqual(ws.tabs.map((t) => t.params.jobs), ["1101", "1148", "1158"]);
  assert.equal(new Set(ids(ws)).size, 3, "three distinct instance ids");

  // Changing one leaves the other two alone — the point of separate instances.
  ws = setTabParams(ws, ws.tabs[1].id, { jobs: "1999" });
  assert.deepEqual(ws.tabs.map((t) => t.params.jobs), ["1101", "1999", "1158"]);
});

test("ids are unique among live tabs, and a closed tab leaves nothing behind", () => {
  // Ids are one past the highest CURRENTLY in use, so closing the last tab does free
  // its number for reuse. That is safe, and the reason is worth pinning: a closed tab
  // is gone from `tabs`, so WorkspaceShell stops rendering its <Activity> and React
  // unmounts the pane. There is no orphaned state for a later tab to inherit — the
  // guarantee that matters is uniqueness among LIVE tabs, which is what keeps two
  // mounted panes from sharing a key.
  let ws = openTab(EMPTY_WORKSPACE, "/quoted");
  ws = openTab(ws, "/hours", {}, { newInstance: true });
  ws = openTab(ws, "/tm", {}, { newInstance: true });
  assert.equal(new Set(ws.tabs.map((x) => x.id)).size, 3);
  assert.equal(nextTabId(ws), "t4");

  const gone = ws.tabs[1].id;
  ws = closeTab(ws, gone);
  assert.equal(tabById(ws, gone), undefined, "no trace of the closed tab");
  assert.ok(!ws.mru.includes(gone), "and none in the MRU either");

  ws = openTab(ws, "/cash-flow", {}, { newInstance: true });
  assert.equal(new Set(ws.tabs.map((x) => x.id)).size, ws.tabs.length, "still unique among live tabs");
});

test("Duplicate Tab clones params and lands beside its source", () => {
  let ws = openTab(EMPTY_WORKSPACE, "/job-hours", { jobs: "1101" });
  ws = openTab(ws, "/quoted", {}, { newInstance: true });
  const source = ws.tabs[0].id;

  ws = duplicateTab(ws, source);
  assert.deepEqual(paths(ws), ["/job-hours", "/job-hours", "/quoted"], "inserted immediately right of its source");
  assert.equal(ws.tabs[1].params.jobs, "1101", "carries the original's params as a starting point");
  assert.equal(ws.active, ws.tabs[1].id, "and becomes active");
  assert.notEqual(ws.tabs[1].id, source);

  // The copy is independent from the moment it exists.
  ws = setTabParams(ws, ws.tabs[1].id, { jobs: "1148" });
  assert.equal(ws.tabs[0].params.jobs, "1101");
});

test("Close Other Tabs keeps exactly one and ends the split", () => {
  let ws = openTab(EMPTY_WORKSPACE, "/etc");
  ws = openTab(ws, "/job-hours", {}, { newInstance: true });
  ws = openTab(ws, "/quoted", {}, { newInstance: true });
  const keep = ws.tabs[1].id;
  ws = enterSplit(ws, ws.tabs[0].id);

  ws = closeOtherTabs(ws, keep);
  assert.deepEqual(ids(ws), [keep]);
  assert.equal(ws.active, keep);
  assert.equal(ws.split, null, "a split whose panes were just closed is not a state worth defining");
  assert.deepEqual(ws.mru, [keep]);
  // Keeping a tab that does not exist changes nothing.
  assert.equal(closeOtherTabs(ws, "t99"), ws);
});

// ── Monthly ETC stays single-instance ───────────────────────────────────────

test("Monthly ETC refuses a second instance even when one is demanded", () => {
  // Not caution: etc-dirty-tracker keys unsaved cells by field NAME in module scope,
  // and a not-yet-created cell is `newEtcCreate__<jobId>__<sectionCode>` — no month in
  // it. Two live grids therefore share one baseline, and the documented consequence is
  // an empty create-draft posted into the wrong month. Keeping tabs mounted would make
  // both grids live all the time, so the refusal has to cover instances, not just the
  // two split panes. See lib/split-view.ts.
  assert.equal(isExclusive("/etc"), true);
  assert.equal(isExclusive("/job-hours"), false);

  let ws = openTab(EMPTY_WORKSPACE, "/etc", { month: "2026-08" });
  const only = ws.tabs[0].id;
  ws = openTab(ws, "/etc", { month: "2026-09" }, { newInstance: true });
  assert.equal(ws.tabs.length, 1, "still one Monthly ETC");
  assert.equal(ws.active, only, "and the request resumes it");
  assert.equal(ws.tabs[0].params.month, "2026-09", "showing the month that was asked for");

  ws = duplicateTab(ws, only);
  assert.equal(ws.tabs.length, 1, "Duplicate Tab is refused too");
});

test("a hand-edited URL cannot smuggle in a second Monthly ETC", () => {
  // openTab is not the only door: a bookmark or a typed URL arrives straight at
  // decodeWorkspace, so the guard has to be there as well.
  const ws = decodeWorkspace({ t: "t1~/etc,t2~/etc,t3~/quoted", "t1.month": "2026-08", "t2.month": "2026-09" });
  assert.deepEqual(paths(ws), ["/etc", "/quoted"]);
  assert.equal(ws.tabs[0].params.month, "2026-08", "the first one wins, params intact");
});

// ── MRU ─────────────────────────────────────────────────────────────────────

test("a sidebar click resumes the MOST RECENTLY USED instance", () => {
  let ws = openTab(EMPTY_WORKSPACE, "/job-hours", { jobs: "1101" }, { newInstance: true });
  const a = ws.tabs[0].id;
  ws = openTab(ws, "/job-hours", { jobs: "1148" }, { newInstance: true });
  const b = ws.tabs[1].id;
  ws = openTab(ws, "/quoted", {}, { newInstance: true });

  assert.equal(mostRecentInstance(ws, "/job-hours"), b, "b was used most recently");
  ws = activateTab(ws, a);
  ws = activateTab(ws, ws.tabs[2].id);
  assert.equal(mostRecentInstance(ws, "/job-hours"), a, "now a is");
  assert.equal(mostRecentInstance(ws, "/cash-flow"), null, "nothing open for that page");

  // And a plain open follows it.
  ws = openTab(ws, "/job-hours");
  assert.equal(ws.active, a);
});

test("reordering the strip does not change which instance a click resumes", () => {
  // Order is where a tab is filed; MRU is where the user was working. Conflating them
  // would make dragging a tab silently change what the sidebar does.
  let ws = openTab(EMPTY_WORKSPACE, "/job-hours", { jobs: "1101" }, { newInstance: true });
  const a = ws.tabs[0].id;
  ws = openTab(ws, "/job-hours", { jobs: "1148" }, { newInstance: true });
  ws = activateTab(ws, a);
  ws = openTab(ws, "/quoted", {}, { newInstance: true });

  const before = mostRecentInstance(ws, "/job-hours");
  ws = moveTab(ws, a, 2);
  assert.equal(mostRecentInstance(ws, "/job-hours"), before);
});

test("closing lands on the most recent survivor, not on the neighbour", () => {
  // With duplicates open the neighbour is very often another instance of the same
  // page, which makes closing look like nothing happened.
  let ws = openTab(EMPTY_WORKSPACE, "/job-hours", { jobs: "1101" }, { newInstance: true });
  const a = ws.tabs[0].id;
  ws = openTab(ws, "/quoted", {}, { newInstance: true });
  ws = openTab(ws, "/job-hours", { jobs: "1148" }, { newInstance: true });
  const c = ws.tabs[2].id;
  ws = activateTab(ws, a);
  ws = activateTab(ws, c);

  ws = closeTab(ws, c);
  assert.equal(ws.active, a, "back to where the user actually was");
});

// ── Opening, navigating, closing ────────────────────────────────────────────

test("a route that cannot be hosted is refused rather than half-opened", () => {
  assert.equal(openTab(EMPTY_WORKSPACE, "/users"), EMPTY_WORKSPACE);
  assert.equal(openTab(EMPTY_WORKSPACE, "/nope"), EMPTY_WORKSPACE);
});

test("params are filtered to what the route actually reads", () => {
  const ws = openTab(EMPTY_WORKSPACE, "/etc", { month: "2026-08", jobs: "1131", nonsense: "x" });
  assert.deepEqual(ws.tabs[0].params, { month: "2026-08" });
});

test("at the cap, the LEAST recently used tab that is not in use is dropped", () => {
  let ws: Workspace = EMPTY_WORKSPACE;
  const hosts = SPLIT_ROUTES.map((r) => r.path).slice(0, MAX_TABS);
  for (const p of hosts) ws = openTab(ws, p, {}, { newInstance: true });
  assert.equal(ws.tabs.length, MAX_TABS);

  const active = ws.active;
  const lru = ws.mru[ws.mru.length - 1];
  ws = openTab(ws, "/cash-flow", {}, { newInstance: true });
  assert.equal(ws.tabs.length, MAX_TABS, "still at the cap");
  assert.equal(activePath(ws), "/cash-flow");
  assert.ok(!ids(ws).includes(lru), "the least recently used tab is what went");
  assert.ok(ids(ws).includes(active) || active === lru);
});

test("navigating a tab keeps its position, its id and the split intact", () => {
  let ws = openTab(EMPTY_WORKSPACE, "/etc");
  ws = openTab(ws, "/job-hours", {}, { newInstance: true });
  ws = openTab(ws, "/quoted", {}, { newInstance: true });
  const middle = ws.tabs[1].id;
  ws = enterSplit(ws, ws.tabs[0].id);

  const next = navigateTab(ws, middle, "/hours");
  assert.deepEqual(paths(next), ["/etc", "/hours", "/quoted"]);
  assert.equal(next.tabs[1].id, middle, "the instance survives a re-route");
  assert.deepEqual(next.split, ws.split);
});

test("navigating drops the params of the route being left", () => {
  let ws = openTab(EMPTY_WORKSPACE, "/etc", { month: "2026-08" });
  ws = navigateTab(ws, ws.tabs[0].id, "/quoted");
  assert.deepEqual(ws.tabs[0].params, {});
});

test("navigating to an unhostable route, or a tab that does not exist, changes nothing", () => {
  const ws = openTab(EMPTY_WORKSPACE, "/etc");
  assert.equal(navigateTab(ws, ws.tabs[0].id, "/users"), ws);
  assert.equal(navigateTab(ws, "t99", "/quoted"), ws);
});

test("closing the last tab leaves an empty workspace, not a dangling id", () => {
  const ws = openTab(EMPTY_WORKSPACE, "/etc");
  assert.deepEqual(closeTab(ws, ws.tabs[0].id), EMPTY_WORKSPACE);
});

test("closing a tab that is IN the split ends the split, keeping the survivor", () => {
  let ws = openTab(EMPTY_WORKSPACE, "/etc");
  ws = openTab(ws, "/job-hours", {}, { newInstance: true });
  ws = openTab(ws, "/quoted", {}, { newInstance: true });
  const etc = ws.tabs[0].id;
  const quoted = ws.tabs[2].id;
  ws = enterSplit(ws, etc);

  const next = closeTab(ws, etc);
  assert.equal(next.split, null);
  assert.equal(next.active, quoted, "the other pane becomes the ordinary active tab");
});

test("closing a tab OUTSIDE the split leaves the split pointing at the same pages", () => {
  let ws = openTab(EMPTY_WORKSPACE, "/etc");
  ws = openTab(ws, "/job-hours", {}, { newInstance: true });
  ws = openTab(ws, "/quoted", {}, { newInstance: true });
  const etc = ws.tabs[0].id;
  const jobs = ws.tabs[1].id;
  ws = activateTab(ws, jobs);
  ws = enterSplit(ws, etc);

  const next = closeTab(ws, ws.tabs[2].id);
  assert.deepEqual(next.split, ws.split, "ids do not shift, so nothing needs repairing");
  assert.equal(tabById(next, next.split!.left)?.path, "/job-hours");
  assert.equal(tabById(next, next.split!.right)?.path, "/etc");
});

test("closing out of range changes nothing", () => {
  const ws = openTab(EMPTY_WORKSPACE, "/etc");
  assert.equal(closeTab(ws, "t99"), ws);
});

// ── Reordering ──────────────────────────────────────────────────────────────

test("a reorder moves the tab and repoints nothing, because nothing points by position", () => {
  let ws = openTab(EMPTY_WORKSPACE, "/etc");
  ws = openTab(ws, "/job-hours", {}, { newInstance: true });
  ws = openTab(ws, "/quoted", {}, { newInstance: true });
  const etc = ws.tabs[0].id;
  ws = activateTab(ws, etc);
  ws = enterSplit(ws, ws.tabs[2].id);

  const moved = moveTab(ws, etc, 2);
  assert.deepEqual(paths(moved), ["/job-hours", "/quoted", "/etc"]);
  assert.equal(moved.active, etc);
  assert.deepEqual(moved.split, ws.split, "the split still names the same two instances");
});

test("moveTab clamps a target past the end, and a no-op is a no-op", () => {
  let ws = openTab(EMPTY_WORKSPACE, "/etc");
  ws = openTab(ws, "/job-hours", {}, { newInstance: true });
  assert.deepEqual(paths(moveTab(ws, ws.tabs[0].id, 99)), ["/job-hours", "/etc"]);
  assert.equal(moveTab(ws, ws.tabs[0].id, 0), ws);
  assert.equal(moveTab(ws, "t99", 1), ws);
});

// ── Split ───────────────────────────────────────────────────────────────────

test("a tab cannot be split against itself, or against one that does not exist", () => {
  const ws = openTab(EMPTY_WORKSPACE, "/etc");
  assert.equal(enterSplit(ws, ws.active), ws);
  assert.equal(enterSplit(ws, "t99"), ws);
});

test("two INSTANCES of one page are a valid split", () => {
  // The requirement in as many words: `Job Details [A] | Job Details [B]`. It works
  // because the split holds ids, not paths.
  let ws = openTab(EMPTY_WORKSPACE, "/job-hours", { jobs: "1101" }, { newInstance: true });
  ws = openTab(ws, "/job-hours", { jobs: "1148" }, { newInstance: true });
  const [a, b] = ids(ws);
  ws = activateTab(ws, b);
  ws = enterSplit(ws, a);
  assert.equal(ws.split?.left, b);
  assert.equal(ws.split?.right, a);
  assert.equal(tabById(ws, ws.split!.left)?.params.jobs, "1148");
  assert.equal(tabById(ws, ws.split!.right)?.params.jobs, "1101");
});

test("the ratio is clamped, so a pane can never become an unusable sliver", () => {
  let ws = openTab(EMPTY_WORKSPACE, "/etc");
  ws = openTab(ws, "/quoted", {}, { newInstance: true });
  ws = enterSplit(ws, ws.tabs[0].id, 2);
  assert.ok(ws.split!.ratio >= 20 && ws.split!.ratio <= 80);
  assert.ok(setSplitRatio(ws, 999).split!.ratio <= 80);
});

test("exiting the split can keep either pane", () => {
  let ws = openTab(EMPTY_WORKSPACE, "/etc");
  ws = openTab(ws, "/quoted", {}, { newInstance: true });
  const etc = ws.tabs[0].id;
  ws = enterSplit(ws, etc);
  assert.equal(exitSplit(ws).active, ws.split!.left);
  assert.equal(exitSplit(ws, etc).active, etc);
  assert.equal(exitSplit(ws).split, null);
});

test("the sidebar targets the tab the user was last in, split or not", () => {
  let ws = openTab(EMPTY_WORKSPACE, "/etc");
  ws = openTab(ws, "/quoted", {}, { newInstance: true });
  assert.equal(sidebarTarget(ws), ws.active);
  ws = enterSplit(ws, ws.tabs[0].id);
  assert.equal(sidebarTarget(ws), ws.active, "one pane changes and the other is left alone");
});

test("changing one tab's params leaves every other tab alone", () => {
  let ws = openTab(EMPTY_WORKSPACE, "/etc", { month: "2026-08" });
  ws = openTab(ws, "/job-hours", { jobs: "1131" }, { newInstance: true });
  const next = setTabParams(ws, ws.tabs[1].id, { jobs: "1148" });
  assert.deepEqual(next.tabs[0].params, { month: "2026-08" });
  assert.deepEqual(next.tabs[1].params, { jobs: "1148" });
  assert.equal(setTabParams(ws, "t99", { jobs: "1" }), ws);
});

// ── Labels ──────────────────────────────────────────────────────────────────

test("a lone tab keeps its plain name; duplicates say which one they are", () => {
  let ws = openTab(EMPTY_WORKSPACE, "/job-hours", { jobs: "1101" }, { newInstance: true });
  assert.equal(tabTitle(ws, ws.tabs[0].id), "Job Details", "no qualifier when there is nothing to disambiguate");

  ws = openTab(ws, "/job-hours", { jobs: "1148" }, { newInstance: true });
  assert.equal(tabTitle(ws, ws.tabs[0].id), "Job Details — 1101");
  assert.equal(tabTitle(ws, ws.tabs[1].id), "Job Details — 1148");

  // The Split View picker always asks for the detail — telling two otherwise
  // identical entries apart is the whole job of a label there.
  const solo = openTab(EMPTY_WORKSPACE, "/etc", { month: "2026-08" });
  assert.equal(tabTitle(solo, solo.tabs[0].id), "Monthly ETC");
  assert.equal(tabTitle(solo, solo.tabs[0].id, { detailed: true }), "Monthly ETC — August 2026");
});

test("the instance hint is readable, and absent rather than dangling", () => {
  assert.equal(tabInstanceHint({ id: "t1", path: "/etc", params: { month: "2026-08" } }), "August 2026");
  assert.equal(tabInstanceHint({ id: "t1", path: "/job-hours", params: { jobs: "1101" } }), "1101");
  assert.equal(tabInstanceHint({ id: "t1", path: "/job-hours", params: { jobs: "1101,1148,1158" } }), "1101 +2");
  // No param set, param blank, or a route with no such notion — all null, so a label
  // never renders as "Job Details — ".
  assert.equal(tabInstanceHint({ id: "t1", path: "/job-hours", params: {} }), null);
  assert.equal(tabInstanceHint({ id: "t1", path: "/job-hours", params: { jobs: "  " } }), null);
  assert.equal(tabInstanceHint({ id: "t1", path: "/build-readiness", params: {} }), null);
  assert.equal(tabTitle(EMPTY_WORKSPACE, "t1"), "");
});

// ── URL ─────────────────────────────────────────────────────────────────────

const roundTrip = (ws: Workspace): Workspace =>
  decodeWorkspace(Object.fromEntries(new URLSearchParams(encodeWorkspace(ws))));

test("a workspace round-trips through the URL unchanged", () => {
  let ws = openTab(EMPTY_WORKSPACE, "/etc", { month: "2026-08", dept: "ME" });
  ws = openTab(ws, "/job-hours", { jobs: "1131" }, { newInstance: true });
  ws = openTab(ws, "/quoted", { sort: "jobId", dir: "asc" }, { newInstance: true });
  ws = activateTab(ws, ws.tabs[1].id);
  ws = enterSplit(ws, ws.tabs[2].id, 55);
  assert.deepEqual(roundTrip(ws), ws);
});

test("two INSTANCES of one route keep separate params in one URL", () => {
  // The property the id namespace exists for. With index namespacing this survived a
  // round trip but not a reorder; with ids it survives both.
  let ws = openTab(EMPTY_WORKSPACE, "/job-hours", { jobs: "1101" }, { newInstance: true });
  ws = openTab(ws, "/job-hours", { jobs: "1148" }, { newInstance: true });
  ws = openTab(ws, "/job-hours", { jobs: "1158" }, { newInstance: true });

  const back = roundTrip(ws);
  assert.deepEqual(back.tabs.map((t) => t.params.jobs), ["1101", "1148", "1158"]);

  const reordered = roundTrip(moveTab(ws, ws.tabs[0].id, 2));
  assert.deepEqual(reordered.tabs.map((t) => t.params.jobs), ["1148", "1158", "1101"]);
  assert.equal(tabById(reordered, ws.tabs[0].id)?.params.jobs, "1101", "params followed their own tab");
});

test("the commonest workspace carries no URL noise", () => {
  let ws = openTab(EMPTY_WORKSPACE, "/etc");
  ws = openTab(ws, "/quoted", {}, { newInstance: true });
  ws = activateTab(ws, ws.tabs[0].id);
  // Active is the first tab and the MRU says nothing the order does not.
  const q = new URLSearchParams(encodeWorkspace(ws));
  assert.equal(q.get("a"), null);
  assert.equal(q.get("s"), null);
  assert.equal(q.get("r"), null);
});

test("decoding is total — no URL can produce a blank app or a dangling id", () => {
  const cases: Record<string, string | string[] | undefined>[] = [
    {},
    { t: "" },
    { t: "," },
    { t: "/nope" },
    { t: "t1~/etc", a: "t9" },
    { t: "t1~/etc", a: "-1" },
    { t: "t1~/etc,t2~/quoted", s: "t1:t1" },
    { t: "t1~/etc,t2~/quoted", s: "t1:t9" },
    { t: "t1~/etc,t2~/quoted", s: "garbage" },
    { t: "t1~/etc,t2~/quoted", s: "t1:t2", r: "999" },
    { t: "t1~/etc,t1~/quoted" },
    { t: "~/etc,~~/quoted" },
    { t: "t1~/etc", m: "t9,t1" },
    { t: ["t1~/etc", "t2~/quoted"] },
  ];
  for (const raw of cases) {
    const ws = decodeWorkspace(raw);
    assert.ok(ws.tabs.length === 0 || tabById(ws, ws.active), `active must exist: ${JSON.stringify(raw)}`);
    if (ws.split) {
      assert.ok(tabById(ws, ws.split.left) && tabById(ws, ws.split.right), JSON.stringify(raw));
      assert.notEqual(ws.split.left, ws.split.right);
      assert.ok(ws.split.ratio >= 20 && ws.split.ratio <= 80);
    }
    assert.equal(new Set(ids(ws)).size, ws.tabs.length, "ids must be unique");
    for (const m of ws.mru) assert.ok(tabById(ws, m), "MRU must name live tabs only");
  }
});

test("the OLD index-based URL still decodes, so bookmarks keep working", () => {
  // /w URLs are shared and bookmarked, and the SDC Tools shell links to them. A
  // workspace that silently lost its params would read as data loss.
  const ws = decodeWorkspace({ t: "/etc,/job-hours", a: "1", "t0.month": "2026-08", "t1.jobs": "1131", s: "0:1", r: "60" });
  assert.deepEqual(paths(ws), ["/etc", "/job-hours"]);
  assert.equal(ws.tabs[0].params.month, "2026-08");
  assert.equal(ws.tabs[1].params.jobs, "1131");
  assert.equal(ws.active, ws.tabs[1].id);
  assert.equal(ws.split?.left, ws.tabs[0].id);
  assert.equal(ws.split?.right, ws.tabs[1].id);
  assert.equal(ws.split?.ratio, 60);
});

test("present-but-empty params survive, because a page distinguishes them from absent", () => {
  const ws = decodeWorkspace({ t: "t1~/job-hours", "t1.jobs": "" });
  assert.deepEqual(ws.tabs[0].params, { jobs: "" });
});

test("a tab's own href is the page it would be on alone", () => {
  assert.equal(tabHref({ id: "t1", path: "/etc", params: { month: "2026-08" } }), "/etc?month=2026-08");
  assert.equal(tabHref({ id: "t1", path: "/quoted", params: {} }), "/quoted");
});

test("workspaceHref and tab labels are what the tab bar renders", () => {
  assert.equal(workspaceHref(EMPTY_WORKSPACE), "/w");
  const ws = openTab(EMPTY_WORKSPACE, "/etc", { month: "2026-08" });
  assert.ok(workspaceHref(ws).startsWith("/w?"));
  assert.equal(tabLabel(ws.tabs[0]), "Monthly ETC");
  assert.equal(tabLabel({ id: "t1", path: "/nope", params: {} }), "/nope");
  assert.equal(tabIndex(ws, ws.tabs[0].id), 0);
  assert.equal(tabIndex(ws, "t99"), -1);
});

test("every route's full param set survives the URL, on any tab", () => {
  for (const route of SPLIT_ROUTES) {
    const params = Object.fromEntries(route.params.map((p, i) => [p, `v${i}`]));
    let ws = openTab(EMPTY_WORKSPACE, "/build-readiness", {}, { newInstance: true });
    ws = openTab(ws, route.path, params, { newInstance: true });
    const back = roundTrip(ws);
    const tab = back.tabs.find((t) => t.path === route.path)!;
    assert.deepEqual(tab.params, params, `${route.path} lost params through the URL`);
  }
});

test("a full workspace at the cap round-trips with its split intact", () => {
  let ws: Workspace = EMPTY_WORKSPACE;
  for (const r of SPLIT_ROUTES.slice(0, MAX_TABS)) ws = openTab(ws, r.path, {}, { newInstance: true });
  ws = enterSplit(ws, ws.tabs[0].id, 40);
  assert.equal(ws.tabs.length, MAX_TABS);
  assert.deepEqual(roundTrip(ws), ws);
});

test("the tab bar can offer every route the workspace can host", () => {
  const offered = openableRoutes().map((r) => r.path);
  assert.deepEqual(offered, SPLIT_ROUTES.map((r) => r.path));
  for (const p of offered) assert.ok(openTab(EMPTY_WORKSPACE, p).tabs.length === 1, `${p} must open`);
});

// ── The shell: mounted panes, not navigations ───────────────────────────────
//
// The performance half of the report, asserted structurally because the behaviour it
// describes ("already-open tab visible in ~100ms") is a property of the ARCHITECTURE:
// there is no fetch and no render on the path, so there is nothing to be slow.

/** Source with comments removed - these assertions are about code, not prose. */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const SHELL = readFileSync(join(process.cwd(), "src", "components", "WorkspaceShell.tsx"), "utf8");
const TABBAR = readFileSync(join(process.cwd(), "src", "components", "WorkspaceTabBar.tsx"), "utf8");
const WROUTE = readFileSync(join(process.cwd(), "src", "app", "(app)", "w", "page.tsx"), "utf8");

test("every open tab is rendered and kept mounted behind Activity", () => {
  // The root cause of the slowness was that a switch re-ran the target page on the
  // server. Both halves of the fix have to hold: the route renders them all, and the
  // shell hides rather than unmounts.
  assert.match(WROUTE, /const rendered = ws\.tabs\.map\(\(t\) => t\.id\);/);
  assert.ok(!/const visible = /.test(WROUTE), "the visible-only render is what made switching slow");
  assert.match(SHELL, /import \{ Activity[^}]*\} from "react";/);
  assert.match(SHELL, /<Activity key=\{tab\.id\} mode=\{isVisible\(tab\.id\) \? "visible" : "hidden"\}>/);
  assert.match(SHELL, /\{ws\.tabs\.map\(\(tab\) => \(/, "every tab, not just the active one");
});

test("switching a tab does not touch the router", () => {
  // router.replace is reserved for the two actions that need a pane nobody has
  // rendered yet. If activate/close/reorder ever go through it again, the reported
  // slowness comes straight back.
  assert.match(SHELL, /if \(opts\?\.navigate\) \{\s*router\.replace\(href\);/);
  assert.match(SHELL, /window\.history\.replaceState\(null, "", href\);/);
  // Comments stripped first: both files DISCUSS the router.push this replaced, and
  // matching prose would make this assertion pass or fail on the documentation.
  const shellCode = stripComments(SHELL);
  const barCode = stripComments(TABBAR);
  assert.ok(!/router\.push/.test(shellCode), "no push path left in the shell");
  assert.ok(!/router\.push/.test(barCode), "no push path left in the tab bar");
  // Only opening and duplicating ask to navigate.
  const navCalls = TABBAR.match(/goOpen\(/g) ?? [];
  assert.equal(navCalls.length, 2, `expected open + duplicate to navigate, found ${navCalls.length}`);
});

test("panes are keyed by instance id, so a reorder never remounts one", () => {
  assert.match(WROUTE, /const panes: Record<string, React\.ReactNode> = \{\};/);
  assert.match(SHELL, /panes: Record<TabId, React\.ReactNode>;/);
  assert.match(SHELL, /panes\[tab\.id\]/);
  // Flex `order`, not a reordered child list: moving a scroll container's DOM node is
  // what resets its scrollTop, which is the thing this change exists to stop.
  assert.match(SHELL, /style=\{\{ width, order, minWidth/);
});

test("the tab strip offers Duplicate, Close and Close Other Tabs", () => {
  for (const item of ["Duplicate Tab", "Close Other Tabs"]) {
    assert.ok(TABBAR.includes(item), `${item} must be in the tab context menu`);
  }
  assert.match(TABBAR, /onContextMenu=\{\(e\) => \{[\s\S]{0,120}setCtxMenu\(/);
  assert.match(TABBAR, /onAuxClick=\{\(e\) => \{[\s\S]{0,200}closeTab\(ws, id\)/, "middle-click closes a tab");
  assert.match(TABBAR, /goOpen\(duplicateTab\(ws, id\)\)/);
  assert.match(TABBAR, /go\(closeOtherTabs\(ws, id\)\)/);
});

test("a duplicate is explicit — the sidebar's plain click still resumes", () => {
  const sidebar = readFileSync(join(process.cwd(), "src", "components", "Sidebar.tsx"), "utf8");
  // The two actions differ by exactly one flag, and that flag is the whole rule:
  // openNewTab asks for a new instance, openExistingTab does not — so a plain click
  // can never produce a duplicate. Asserted where they now live.
  assert.match(ACTIONS, /const next = openTab\(workspace, path, \{\}, \{ newInstance: true \}\);/);
  assert.match(ACTIONS, /const next = openTab\(workspace, path\);/, "a plain click resumes");
  const aux = sidebar.slice(sidebar.indexOf("onAuxClick="), sidebar.indexOf("onContextMenu="));
  assert.ok(aux.includes("tabs.openNewTab(item.href)"), "middle-click must ask for a new instance");
  assert.ok(aux.includes("e.button !== 1"), "and only on the middle button");
});

test("each pane streams on its own, so a hidden tab cannot hold up the active one", () => {
  // Load-bearing, and easy to delete by accident. PaneView is an async server component
  // with no boundary of its own: without one per pane, React cannot flush ANY pane
  // until the slowest resolves, and a cold load of eight tabs would wait on a hidden
  // tab before showing the one you are looking at. This is what makes rendering every
  // open tab affordable.
  assert.match(WROUTE, /import \{ Suspense \} from "react";/);
  // The boundary and its contents, matched separately: a lifecycle probe now sits inside
  // it too (2026-09-04, for diagnosing the tab-switch scroll bug), and pinning the exact
  // markup would fail on anything else legitimately joining it. What has to hold is that
  // there is one boundary PER PANE and that PaneView renders inside it.
  assert.match(WROUTE, /<Suspense key=\{id\} fallback=\{<PaneLoading \/>\}>/, "every pane needs its own boundary");
  const boundary = WROUTE.slice(
    WROUTE.indexOf("<Suspense key={id}"),
    WROUTE.indexOf("</Suspense>", WROUTE.indexOf("<Suspense key={id}")),
  );
  assert.match(boundary, /<PaneView pane=\{tab\} \/>/, "and the pane must render inside it");
});

// ── The sidebar/tab-strip interaction audit ─────────────────────────────────
//
// REPORTED 2026-09-04: "a page is already open as a top tab; clicking it in the
// sidebar does not reliably switch to that tab."
//
// The word that mattered was RELIABLY. The sidebar sits in the (app) layout and the
// tab strip in /w's page, so they had no shared state and both read the workspace out
// of the URL. That held while every tab action was a navigation — and broke the moment
// switching became instant, because instant means history.replaceState, which
// deliberately does not notify the Next router. useSearchParams() therefore kept
// returning the params from the last REAL navigation, so the sidebar resolved
// "already open?" against a tab list that could be several operations out of date.
// How wrong it was depended on how many tabs had been switched since — hence
// "not reliably" rather than "never".

const STORE = readFileSync(join(process.cwd(), "src", "lib", "workspace-store.ts"), "utf8");
const SIDEBAR = readFileSync(join(process.cwd(), "src", "components", "Sidebar.tsx"), "utf8");
const NAV = readFileSync(join(process.cwd(), "src", "components", "useSplitNav.ts"), "utf8");
const sidebarClickHandler = SIDEBAR.slice(SIDEBAR.indexOf("onClick={(e) => {"), SIDEBAR.indexOf("onAuxClick="));
// The tab decisions moved OUT of Sidebar on 2026-09-04, into the one place both the
// visible ⋮ menu and right-click also call. The sidebar keeps only the gesture
// handling; the rule itself is asserted against the actions hook. See
// tests/nav-item-menu.test.ts for why that separation is guarded.
const ACTIONS = readFileSync(join(process.cwd(), "src", "components", "useWorkspaceActions.ts"), "utf8");

test("the sidebar reads the LIVE workspace, never only the URL", () => {
  // The fix. Both halves have to hold: the shell publishes, and the hook prefers it.
  assert.match(SHELL, /publishWorkspace\(ws\);/);
  assert.match(SHELL, /useEffect\(\(\) => registerWorkspaceApply\(apply\), \[apply\]\);/);
  assert.match(NAV, /const live = useLiveWorkspace\(\);/);
  assert.match(NAV, /const workspace: Workspace \| null = live \?\? fromUrl;/);
  // Unregistering matters: a stale apply would let a sidebar click call into an
  // unmounted tree after leaving /w.
  assert.match(STORE, /export function registerWorkspaceApply/);
  assert.match(STORE, /if \(applyFn === fn\) \{\s*applyFn = null;\s*current = null;/);
});

test("a sidebar click activates the open instance without navigating", () => {
  // The performance half of the requirement: "simply activate the existing tab
  // instance and restore its preserved state" — no remount, no refetch, no recreate.
  assert.match(ACTIONS, /const next = openTab\(workspace, path\);/, "resolves through the model");
  assert.ok(
    sidebarClickHandler.includes("tabs.openExistingTab(item.href)"),
    "the sidebar must reach that through the centralized action, not its own copy",
  );
  assert.ok(sidebarClickHandler.includes("e.preventDefault()"), "and cancels the Link navigation");
  // Only a plain left click: modified clicks are the browser's own
  // open-in-new-window gestures and must keep working.
  for (const guard of ["e.metaKey", "e.ctrlKey", "e.shiftKey", "e.button === 0"]) {
    assert.ok(sidebarClickHandler.includes(guard), `plain-click guard missing: ${guard}`);
  }
  // Resuming an existing tab must NOT navigate; only a genuinely new tab needs a pane.
  assert.match(ACTIONS, /isNew \? \{ navigate: true \} : undefined/, "resuming must not navigate");
});

test("the sidebar highlights the ACTIVE TAB's page, not the /w pathname", () => {
  // In the workspace the pathname is always "/w", so isActive(pathname) matched
  // nothing and no sidebar item was ever highlighted.
  assert.match(SIDEBAR, /const active = item\.isActive\(sidebarPath\);/);
  assert.match(SIDEBAR, /tabById\(splitNav\.workspace, splitNav\.workspace\.active\)\?\.path \?\? pathname/);
  assert.ok(!/item\.isActive\(pathname\)/.test(SIDEBAR), "the pathname version must be gone");
});

test("the browser tab title follows the active workspace tab", () => {
  assert.match(SHELL, /document\.title = /);
  assert.match(SHELL, /tabTitle\(ws, ws\.active, \{ detailed: true \}\)/);
});

test("the sidebar resolution rule, for every page the sidebar offers", () => {
  // The requested rule, exercised against every hostable route rather than only the
  // one that was reported:
  //   none open    -> open a new tab, make it active
  //   exactly one  -> switch to it, no duplicate
  //   several open -> switch to the most recently ACTIVE one, never a random pick
  for (const route of SPLIT_ROUTES) {
    const p = route.path;

    // 1. Nothing of this page open yet.
    let ws = openTab(EMPTY_WORKSPACE, "/build-readiness", {}, { newInstance: true });
    const anchor = ws.tabs[0].id;
    const opened = openTab(ws, p);
    if (p === "/build-readiness") {
      assert.equal(opened.tabs.length, 1, `${p}: already open, must resume`);
      assert.equal(opened.active, anchor);
      continue;
    }
    assert.equal(opened.tabs.length, 2, `${p}: must open a tab when none is open`);
    assert.equal(tabById(opened, opened.active)?.path, p, `${p}: and become active`);

    // 2. Exactly one open, and the user is somewhere else.
    ws = activateTab(opened, anchor);
    const resumed = openTab(ws, p);
    assert.equal(resumed.tabs.length, 2, `${p}: must not duplicate`);
    assert.equal(tabById(resumed, resumed.active)?.path, p, `${p}: must switch to it`);

    // 3. Several open — the MRU one wins. Monthly ETC refuses a second instance, so it
    //    has nothing to disambiguate; that refusal is asserted separately.
    if (isExclusive(p)) continue;
    let many = openTab(EMPTY_WORKSPACE, p, {}, { newInstance: true });
    const first = many.tabs[0].id;
    many = openTab(many, p, {}, { newInstance: true });
    const second = many.tabs[1].id;
    many = openTab(many, "/build-readiness", {}, { newInstance: true });

    assert.equal(openTab(many, p).active, second, `${p}: most recent of several`);
    many = activateTab(many, first);
    many = openTab(many, "/build-readiness");
    assert.equal(openTab(many, p).active, first, `${p}: MRU moved, so the answer moves`);
  }
});

test("the worked example from the report", () => {
  // Job Details [A], Monthly ETC, Hours, Job Details [B]; B used most recently;
  // clicking Job Details activates B.
  let ws = openTab(EMPTY_WORKSPACE, "/job-hours", { jobs: "1101" }, { newInstance: true });
  const A = ws.tabs[0].id;
  ws = openTab(ws, "/etc", {}, { newInstance: true });
  ws = openTab(ws, "/hours", {}, { newInstance: true });
  ws = openTab(ws, "/job-hours", { jobs: "1148" }, { newInstance: true });
  const B = ws.tabs[3].id;

  ws = activateTab(ws, ws.tabs[1].id); // wander off to Monthly ETC
  assert.equal(mostRecentInstance(ws, "/job-hours"), B);
  const clicked = openTab(ws, "/job-hours");
  assert.equal(clicked.active, B);
  assert.equal(clicked.tabs.length, 4, "no new tab");

  // And after using A, the same click resolves to A instead — "most recently used",
  // not "last opened".
  const afterA = openTab(activateTab(clicked, A), "/job-hours");
  assert.equal(afterA.active, A);
});

test("clicking the page already on screen is a no-op", () => {
  let ws = openTab(EMPTY_WORKSPACE, "/hours", {}, { newInstance: true });
  const before = ws;
  ws = openTab(ws, "/hours");
  assert.equal(ws.active, before.active);
  assert.equal(ws.tabs.length, 1);
  // And re-activating the active tab must not churn the MRU either.
  assert.deepEqual(activateTab(ws, ws.active).mru, ws.mru);
});

test("a page the sidebar cannot host still navigates normally", () => {
  // Admin routes (Users & Roles, Role Permissions, Data Management) and the external
  // Project Scheduler link are not hostable, so openTab refuses them and the click
  // must fall through to an ordinary navigation rather than doing nothing.
  for (const href of ["/admin/users", "/admin/permissions", "/admin/data-management"]) {
    assert.equal(openTab(EMPTY_WORKSPACE, href), EMPTY_WORKSPACE, `${href} must not become a tab`);
  }
  assert.ok(sidebarClickHandler.includes("handleNavClick(e);"), "unhostable pages keep the normal navigation");
});

test("permission-hidden pages cannot be reached through stale tab state", () => {
  // The tab strip is chrome: it never widens what a user may see. Each pane renders the
  // page body, which still starts with its own requirePagePermission, so a tab restored
  // from a URL for a page the user has since lost renders that page's refusal rather
  // than its content.
  assert.match(WROUTE, /requirePagePermission\(\)/);
  const paneView = readFileSync(join(process.cwd(), "src", "components", "PaneView.tsx"), "utf8");
  assert.ok(
    !/requirePagePermission|assertPermission/.test(stripComments(paneView)),
    "PaneView must not add its own check — the page body is the one gate",
  );
});
