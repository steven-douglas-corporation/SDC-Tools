import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DATA_MANAGEMENT_TABS,
  DEFAULT_DATA_MANAGEMENT_TAB,
  dataManagementTab,
} from "../src/lib/data-management-tabs";
import { SPLIT_ROUTES, decodeSplit, encodeSplit, isSplittable, setPaneParams, splitRoute } from "../src/lib/split-view";
import { EMPTY_WORKSPACE, openTab } from "../src/lib/workspace";

// ── Data Management: one tab per band, and a pane again (2026-10-21) ─────────
//
// Two things went wrong silently before and would again: the page lost its split-view
// entry when Data Quality moved onto it from the Dashboard (nothing failed, the option
// just stopped being offered), and a `?tab=` the page does not know would be a blank
// panel. These pin both.

const SRC = join(import.meta.dirname, "..", "src");
const read = (...p: string[]) => readFileSync(join(SRC, ...p), "utf8");

test("the three tabs are Data quality, Data sources and Employee roster, in that order", () => {
  assert.deepEqual(
    DATA_MANAGEMENT_TABS.map((t) => t.label),
    ["Data quality", "Data sources", "Employee roster"],
  );
  assert.equal(new Set(DATA_MANAGEMENT_TABS.map((t) => t.id)).size, DATA_MANAGEMENT_TABS.length, "tab ids are unique");
});

test("a known tab id is itself; anything else is the default tab", () => {
  for (const t of DATA_MANAGEMENT_TABS) assert.equal(dataManagementTab(t.id), t.id);
  assert.equal(DEFAULT_DATA_MANAGEMENT_TAB, DATA_MANAGEMENT_TABS[0].id, "the first tab is the default");
  assert.equal(DEFAULT_DATA_MANAGEMENT_TAB, "quality", "Data quality is the tab the page opens on");
  for (const junk of [undefined, null, "", "Quality", "finances", "../etc", "quality,roster"]) {
    assert.equal(dataManagementTab(junk), DEFAULT_DATA_MANAGEMENT_TAB, `${JSON.stringify(junk)} falls back`);
  }
});

test("the page builds only the open tab, and every tab has a branch", () => {
  const page = read("app", "(app)", "admin", "data-management", "page.tsx");
  for (const t of DATA_MANAGEMENT_TABS) {
    assert.match(page, new RegExp(`tab === "${t.id}" &&`), `no branch renders the "${t.id}" tab`);
  }
  // The punch explorer reads every punch: it must live in the Data quality tab only,
  // never in the shared body that every tab pays for.
  const view = /export async function DataManagementView[\s\S]*?\n}\n/.exec(page)?.[0] ?? "";
  assert.ok(view.length > 0, "found DataManagementView");
  assert.doesNotMatch(view, /getPunchExplorer|getDataQuality|getRosterQuality|recentRefreshRuns/, "the body must not query for every tab");
});

test("the tab strip writes no param for the default tab and leaves the other tabs' params alone", () => {
  const strip = read("components", "DataManagementTabs.tsx");
  assert.match(strip, /next === DEFAULT_DATA_MANAGEMENT_TAB\) qs\.delete\("tab"\)/);
  assert.match(strip, /else qs\.set\("tab", next\)/);
  // Pane-aware, so a split pane switches ITS tab and not its neighbour's.
  assert.match(strip, /usePaneUrl\(\)/);
  const code = strip.replace(/\/\/[^\n]*/g, "");
  assert.doesNotMatch(code, /useRouter|useSearchParams|usePathname/);
});

// ── Split view ──────────────────────────────────────────────────────────────

test("Data Management is a splittable route that carries its tab, month and slicers", () => {
  assert.equal(isSplittable("/admin/data-management"), true);
  const route = splitRoute("/admin/data-management")!;
  assert.equal(route.label, "Data Management");
  for (const key of ["tab", "m", "dqFrom", "dqTo", "dqEmp", "dqFn", "dqMtd"]) assert.ok(route.params.includes(key), key);
  // Not exclusive: unlike Monthly ETC it holds no module-scope editing state.
  assert.equal(route.exclusive, undefined);
});

test("every splittable route has a pane view — a missing one only shows a message at runtime", () => {
  const paneView = read("components", "PaneView.tsx");
  for (const r of SPLIT_ROUTES) {
    assert.ok(paneView.includes(`"${r.path}":`), `${r.path} is in SPLIT_ROUTES but PaneView.PANE_VIEWS has no entry`);
  }
});

test("the page exports the body a pane renders, and the route reuses it", () => {
  const page = read("app", "(app)", "admin", "data-management", "page.tsx");
  assert.match(page, /export async function DataManagementView\(\{ params \}/);
  assert.match(page, /<DataManagementView params=\{await searchParams\} \/>/);
  assert.match(read("components", "PaneView.tsx"), /DataManagementView \} from "@\/app\/\(app\)\/admin\/data-management\/page"/);
});

test("it opens as a workspace tab", () => {
  const ws = openTab(EMPTY_WORKSPACE, "/admin/data-management", { tab: "quality" });
  assert.notEqual(ws, EMPTY_WORKSPACE, "openTab must accept it");
  assert.equal(ws.tabs.length, 1);
});

test("each pane keeps its own tab: Data Management beside the Dashboard, and beside itself", () => {
  const split = decodeSplit({ l: "/", "l.m": "2026-08", r: "/admin/data-management", "r.tab": "quality", "r.m": "2026-07" });
  assert.equal(split.r?.path, "/admin/data-management");
  assert.deepEqual(split.r?.params, { tab: "quality", m: "2026-07" });
  assert.deepEqual(split.l.params, { m: "2026-08" }, "the Dashboard's month is untouched");

  // Switching the right pane's tab rewrites r.tab and nothing on the left.
  const switched = setPaneParams(split, "r", { tab: "roster", m: "2026-07" });
  assert.equal(switched.l, split.l, "the other pane is carried by reference");
  assert.match(encodeSplit(switched), /r\.tab=roster/);

  // Two Data Management panes (not exclusive) hold two different tabs.
  const both = decodeSplit({ l: "/admin/data-management", "l.tab": "sources", r: "/admin/data-management", "r.tab": "quality" });
  assert.equal(both.l.params.tab, "sources");
  assert.equal(both.r?.params.tab, "quality");
});
