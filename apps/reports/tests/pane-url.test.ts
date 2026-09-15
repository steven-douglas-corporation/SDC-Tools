import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  declaredParamKeys,
  inferSplitPane,
  pageHref,
  paneHrefFor,
  paneParamsFromHost,
  rawParams,
  splitWithPaneParams,
  toParamRecord,
  workspaceWithPaneParams,
} from "../src/lib/pane-url";
import { EMPTY_WORKSPACE, decodeWorkspace, enterSplit, openTab, tabById, workspaceHref } from "../src/lib/workspace";
import { decodeSplit, encodeSplit, openInSplit } from "../src/lib/split-view";

// ── The pane-aware URL writer ────────────────────────────────────────────────
//
// REPORTED 2026-09-14: inside the workspace, every in-pane control wrote the URL as a
// stand-alone page would — bare keys at `usePathname()`, which on /w is "/w". Hours'
// "Clear filters" pushed a bare `/w` (decodes to NO tabs: the strip emptied); a month
// change pushed `/etc?month=` and left the workspace; a filter's `jobs=` at /w was a
// key the workspace never reads, so it did nothing; hidden columns written the same
// way came back on the next refresh.
//
// lib/pane-url.ts re-encodes a control's own next query into the host URL. These
// tests pin the three reported outcomes as behaviours of that pure helper, and then
// that a plain page is untouched.

/** A three-tab workspace: Hours (t1), Monthly ETC (t2), Projects (t3); ETC active. */
function threeTabs() {
  let ws = openTab(EMPTY_WORKSPACE, "/hours", { jobs: "1101", employees: "7", page: "3" }, { newInstance: true });
  ws = openTab(ws, "/etc", { month: "2026-08", dept: "ME" }, { newInstance: true });
  ws = openTab(ws, "/quoted", { sort: "job", dir: "asc" }, { newInstance: true });
  return ws;
}

test("clear filters inside /w clears THAT tab's params and keeps every other tab", () => {
  const ws = threeTabs();
  const host = { pagePath: "/hours", hostSearch: workspaceHref(ws).slice(3), workspace: ws };
  const href = paneHrefFor({ kind: "workspace", tabId: "t1" }, host, {});

  assert.ok(href.startsWith("/w?"), `stays on the workspace route, got ${href}`);
  const after = decodeWorkspace(rawParams(href.slice(3)));
  assert.equal(after.tabs.length, 3, "no tab is lost");
  assert.deepEqual(tabById(after, "t1")?.params, {}, "the Hours tab is back to its default view");
  assert.deepEqual(tabById(after, "t2")?.params, { month: "2026-08", dept: "ME" }, "Monthly ETC untouched");
  assert.deepEqual(tabById(after, "t3")?.params, { sort: "job", dir: "asc" }, "Projects untouched");
  assert.equal(after.active, ws.active, "the active tab does not move");
});

test("the bug itself: what a bare `/w` decodes to is the EMPTY workspace", () => {
  // The old code pushed `router.push(pathname)` with pathname === "/w". Pinned so the
  // failure mode stays legible: this is why the strip emptied.
  assert.deepEqual(decodeWorkspace(rawParams("")), EMPTY_WORKSPACE);
});

test("a month change inside /w stays on /w and changes only t2.month", () => {
  const ws = threeTabs();
  const host = { pagePath: "/etc", hostSearch: workspaceHref(ws).slice(3), workspace: ws };
  const href = paneHrefFor({ kind: "workspace", tabId: "t2" }, host, { month: "2026-09" });

  assert.ok(href.startsWith("/w?"), `must not leave the workspace for /etc, got ${href}`);
  const raw = rawParams(href.slice(3));
  assert.equal(raw["t2.month"], "2026-09");
  assert.equal(raw["t2.dept"], undefined, "a month change resets the ETC page's other params, as it always did");
  assert.equal(raw["t1.jobs"], "1101", "the Hours tab's params ride along untouched");
  assert.equal(raw["t3.sort"], "job");
  assert.equal(raw.month, undefined, "and nothing is written bare");
  const after = decodeWorkspace(raw);
  assert.equal(after.tabs.length, 3);
  assert.equal(after.active, ws.active);
});

test("hide= inside a Projects pane round-trips through decode", () => {
  const ws = threeTabs();
  const host = { pagePath: "/quoted", hostSearch: workspaceHref(ws).slice(3), workspace: ws };
  const qs = new URLSearchParams({ sort: "job", dir: "asc", hide: "customer,type" });
  const next = workspaceWithPaneParams({ tabId: "t3" }, host, qs);

  assert.equal(tabById(next, "t3")?.params.hide, "customer,type");
  // Encode → decode, exactly what a router.refresh() would do to the URL.
  const reread = decodeWorkspace(rawParams(workspaceHref(next).slice(3)));
  assert.equal(tabById(reread, "t3")?.params.hide, "customer,type", "hidden columns survive a re-decode");
  assert.equal(tabById(reread, "t3")?.params.sort, "job");
  // And reading the pane's own params back gives the un-namespaced form.
  assert.deepEqual(paneParamsFromHost({ kind: "workspace", tabId: "t3" }, { ...host, workspace: next }), {
    sort: "job",
    dir: "asc",
    hide: "customer,type",
  });
});

test("a key the route does not declare is dropped, not smuggled in bare", () => {
  const ws = threeTabs();
  const host = { pagePath: "/etc", hostSearch: workspaceHref(ws).slice(3), workspace: ws };
  const href = paneHrefFor({ kind: "workspace", tabId: "t2" }, host, { month: "2026-09", bogus: "1" });
  const raw = rawParams(href.slice(3));
  assert.equal(raw["t2.bogus"], undefined);
  assert.equal(raw.bogus, undefined);
});

test("the live workspace wins over the host URL", () => {
  // The URL can be several tab operations stale (tab switches are replaceState).
  const stale = threeTabs();
  const live = enterSplit(stale, "t1");
  const host = { pagePath: "/etc", hostSearch: workspaceHref(stale).slice(3), workspace: live };
  const after = decodeWorkspace(rawParams(paneHrefFor({ kind: "workspace", tabId: "t2" }, host, { month: "2026-09" }).slice(3)));
  assert.ok(after.split, "the split the URL did not know about is preserved");
});

test("a tab that has since closed falls back to the page's own href rather than writing into nothing", () => {
  const ws = threeTabs();
  const host = { pagePath: "/etc", hostSearch: workspaceHref(ws).slice(3), workspace: ws };
  assert.equal(paneHrefFor({ kind: "workspace", tabId: "t9" }, host, { month: "2026-09" }), "/etc?month=2026-09");
  assert.equal(paneParamsFromHost({ kind: "workspace", tabId: "t9" }, host), null);
});

// ── A plain page behaves exactly as before ──────────────────────────────────

test("on a plain page the writer is bare keys on the page's own path", () => {
  const host = { pagePath: "/hours", hostSearch: "jobs=1101&page=2" };
  assert.equal(paneHrefFor({ kind: "page" }, host, {}), "/hours");
  assert.equal(paneHrefFor({ kind: "page" }, host, { jobs: "1101", page: "3" }), "/hours?jobs=1101&page=3");
  assert.deepEqual(paneParamsFromHost({ kind: "page" }, host), { jobs: "1101", page: "2" });
  assert.equal(pageHref("/etc", "month=2026-08"), "/etc?month=2026-08");
  assert.equal(pageHref("/etc", new URLSearchParams()), "/etc");
});

test("a plain page does NOT filter to declared keys — the page reads whatever it reads", () => {
  // The namespace filter is what protects a workspace URL from stale keys; a
  // stand-alone page has always been handed its raw query and must stay that way.
  assert.equal(paneHrefFor({ kind: "page" }, { pagePath: "/hours", hostSearch: "" }, { anything: "x" }), "/hours?anything=x");
});

// ── The legacy two-pane /split ──────────────────────────────────────────────

test("inside /split only the addressed pane's namespace changes", () => {
  const state = openInSplit({ path: "/etc", params: { month: "2026-08" } }, { path: "/job-hours", params: { jobs: "1101" } });
  const hostSearch = encodeSplit(state);
  const href = paneHrefFor({ kind: "split", pane: "r" }, { pagePath: "/job-hours", hostSearch }, { jobs: "1148" });
  assert.ok(href.startsWith("/split?"));
  const after = decodeSplit(rawParams(href.slice("/split?".length)));
  assert.equal(after.r?.params.jobs, "1148");
  assert.equal(after.l.params.month, "2026-08", "the left pane is untouched");
  const viaHelper = splitWithPaneParams({ pane: "l" }, { pagePath: "/etc", hostSearch }, { month: "2026-09" });
  assert.equal(viaHelper.l.params.month, "2026-09");
  assert.equal(viaHelper.r?.params.jobs, "1101");
});

test("which /split pane a body is in is inferred from its own path and params", () => {
  const state = openInSplit({ path: "/job-hours", params: { jobs: "1101" } }, { path: "/job-hours", params: { jobs: "1148" } });
  assert.equal(inferSplitPane(state, "/job-hours", { jobs: "1101" }), "l");
  assert.equal(inferSplitPane(state, "/job-hours", { jobs: "1148" }), "r");
  // Same route both sides, params drifted: the left is the documented default.
  assert.equal(inferSplitPane(state, "/job-hours", { jobs: "9" }), "l");
  // Different routes: the side on the same route, whatever the params.
  const mixed = openInSplit({ path: "/etc", params: { month: "2026-08" } }, { path: "/hours", params: {} });
  assert.equal(inferSplitPane(mixed, "/hours", { page: "2" }), "r");
  assert.equal(inferSplitPane(mixed, "/etc", { month: "2026-09" }), "l");
});

// ── Input shapes ────────────────────────────────────────────────────────────

test("params may arrive as URLSearchParams, a record or a query string", () => {
  assert.deepEqual(toParamRecord(new URLSearchParams("a=1&b=2")), { a: "1", b: "2" });
  assert.deepEqual(toParamRecord({ a: "1" }), { a: "1" });
  assert.deepEqual(toParamRecord("a=1&b=%20x"), { a: "1", b: " x" });
  assert.deepEqual(declaredParamKeys("/etc"), ["month", "dept", "jobname", "billables"]);
  assert.deepEqual(declaredParamKeys("/nope"), []);
});

// ── Every URL-writing control goes through the one writer ───────────────────
//
// The conversion is only complete while it stays complete. A control that goes back
// to `router.push(\`${pathname}?…\`)` reintroduces the bug for whichever page it is on.

test("no client control under src/components writes a same-page URL past usePaneUrl", () => {
  const root = join(process.cwd(), "src", "components");
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      if (entry.name === "PaneUrlProvider.tsx") continue;
      const code = strip(readFileSync(full, "utf8"));
      // The shape of the bug: a push/replace whose target is built from usePathname().
      if (/router\.(push|replace)\(\s*`\$\{pathname\}/.test(code) || /router\.(push|replace)\(\s*pathname\b/.test(code)) {
        offenders.push(entry.name);
      }
    }
  };
  walk(root);
  // Every control must be clean — useDashboardMonth.tsx was the last hold-out and
  // was converted the same day.
  const known = new Set<string>();
  assert.deepEqual(
    offenders.filter((f) => !known.has(f)),
    [],
    `these controls still push bare keys at usePathname(): ${offenders.join(", ")} — use usePaneUrl()`,
  );
});
