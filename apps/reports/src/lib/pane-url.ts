import {
  decodeSplit,
  setPaneParams,
  splitHref,
  splitRoute,
  type Pane,
  type SplitState,
} from "@/lib/split-view";
import {
  decodeWorkspace,
  setTabParams,
  tabById,
  workspaceHref,
  type TabId,
  type Workspace,
} from "@/lib/workspace";

// ── One URL writer for every in-pane control ─────────────────────────────────
//
// REPORTED 2026-09-14: inside the workspace, Hours' "Clear filters" wiped every
// tab; a month change on the Monthly ETC tab left /w for /etc; filters silently
// did nothing; hidden columns came back on the next refresh.
//
// All one bug. A pane's page body receives its params from the tab's namespace
// (`t1.month`, `l.jobs`), but every client control inside it still wrote the URL
// the way a stand-alone page does:
//
//     router.push(`${usePathname()}?${qs}`)        // pathname is "/w" in a pane
//
// so `qs` — the page's OWN keys, un-namespaced — was pushed at the WORKSPACE route,
// where decodeWorkspace reads `t=` (absent) and produces the empty workspace. "Clear
// filters" pushed a bare `/w` and the strip emptied; a month change pushed
// `/etc?month=` and left the workspace altogether. Both looked like data loss.
//
// This module is the fix: the pure half of it. Given WHICH pane a control lives in,
// and the page's own next query, it produces the URL the host route actually needs —
// the same `t1.`/`l.`/`r.` encoding lib/workspace.ts and lib/split-view.ts already
// define, reused rather than re-implemented. There is deliberately no second
// encoding here: setTabParams and setPaneParams ARE the encoders, and they also
// filter to the keys the route declares, which is what keeps a stale key from
// following a tab to a route that has no use for it.
//
// The React half — reading the live workspace, choosing push/replace/replaceState,
// falling back to plain navigation on an ordinary page — is components/PaneUrlProvider.tsx.

/**
 * Where a control lives.
 *
 *   page       an ordinary route: `/hours?jobs=…`. Keys are written bare, on the
 *              page's own path, exactly as every control did before this existed.
 *   workspace  a tab in /w — keys are written under `<tabId>.` and every other tab
 *              is carried across untouched.
 *   split      one side of the legacy two-pane /split — keys under `l.`/`r.`.
 */
export type PaneScope =
  | { kind: "page" }
  | { kind: "workspace"; tabId: TabId }
  | { kind: "split"; pane: Pane };

/** The page's own next query, however the control likes to build it. */
export type ParamsInput = URLSearchParams | Record<string, string> | string;

/** `Object.fromEntries(new URLSearchParams(...))` — the shape decodeWorkspace/decodeSplit take. */
export function rawParams(search: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(search));
}

export function toParamRecord(input: ParamsInput): Record<string, string> {
  if (typeof input === "string") return rawParams(input);
  if (input instanceof URLSearchParams) return Object.fromEntries(input);
  return { ...input };
}

/** A plain page's own URL for `params` — bare keys on its own path. */
export function pageHref(pagePath: string, params: ParamsInput): string {
  const sp = new URLSearchParams(toParamRecord(params));
  const q = sp.toString();
  return q ? `${pagePath}?${q}` : pagePath;
}

/**
 * What a control needs to know about the URL it is embedded in.
 *
 * `hostSearch` is the host route's WHOLE query (`useSearchParams().toString()` on
 * /w or /split); `workspace`, when given, is the live workspace and wins over the
 * decoded URL, for the reason lib/workspace-store.ts explains — tab switches are
 * history.replaceState, so the router's copy of the params can be stale.
 */
export type PaneHost = {
  pagePath: string;
  hostSearch: string;
  workspace?: Workspace | null;
};

/** The workspace after this pane's params change — every OTHER tab is carried by reference. */
export function workspaceWithPaneParams(
  scope: { tabId: TabId },
  host: PaneHost,
  params: ParamsInput,
): Workspace {
  const ws = host.workspace ?? decodeWorkspace(rawParams(host.hostSearch));
  return setTabParams(ws, scope.tabId, toParamRecord(params));
}

/** The split after this pane's params change — the other pane is carried by reference. */
export function splitWithPaneParams(scope: { pane: Pane }, host: PaneHost, params: ParamsInput): SplitState {
  const state = decodeSplit(rawParams(host.hostSearch));
  return setPaneParams(state, scope.pane, toParamRecord(params));
}

/**
 * The href a pane control should navigate to for `params` — the page's own next
 * query, un-namespaced.
 *
 * Total, like the decoders it sits on: a workspace scope whose tab is no longer
 * open (a stale closure firing after the tab closed) falls back to the page's own
 * href rather than writing into a tab that does not exist.
 */
export function paneHrefFor(scope: PaneScope, host: PaneHost, params: ParamsInput): string {
  switch (scope.kind) {
    case "page":
      return pageHref(host.pagePath, params);
    case "workspace": {
      const ws = host.workspace ?? decodeWorkspace(rawParams(host.hostSearch));
      if (!tabById(ws, scope.tabId)) return pageHref(host.pagePath, params);
      return workspaceHref(setTabParams(ws, scope.tabId, toParamRecord(params)));
    }
    case "split":
      return splitHref(splitWithPaneParams(scope, host, params));
  }
}

/**
 * This pane's OWN current params, lifted out of the host URL — what a control
 * should read instead of `useSearchParams()`, which on /w holds every tab's keys.
 *
 * Null when the scope cannot be resolved from the host (the tab has gone), so the
 * caller can fall back to the params the server rendered the pane with.
 */
export function paneParamsFromHost(scope: PaneScope, host: PaneHost): Record<string, string> | null {
  switch (scope.kind) {
    case "page":
      return rawParams(host.hostSearch);
    case "workspace": {
      const ws = host.workspace ?? decodeWorkspace(rawParams(host.hostSearch));
      return tabById(ws, scope.tabId)?.params ?? null;
    }
    case "split": {
      const state = decodeSplit(rawParams(host.hostSearch));
      const pane = scope.pane === "l" ? state.l : state.r;
      return pane?.params ?? null;
    }
  }
}

/**
 * Which side of /split a pane is, when the caller was not told.
 *
 * /split's page renders `<PaneView pane={state.l} />` and `<PaneView pane={state.r} />`
 * with nothing on the PaneState saying which is which, so the client works it out by
 * matching the pane's own path and params against the decoded URL. Left first: when
 * both panes are identical the choice is immaterial for reading, and writing to the
 * left is the documented default for every other ambiguous case in split-view.ts.
 */
export function inferSplitPane(state: SplitState, path: string, params: Record<string, string>): Pane {
  const same = (p: { path: string; params: Record<string, string> } | null) =>
    p != null && p.path === path && sameParams(p.params, params);
  if (same(state.l)) return "l";
  if (same(state.r)) return "r";
  // Neither matches exactly (a param drifted between server render and now): prefer
  // the side on the same ROUTE, then the left.
  if (state.r && state.r.path === path && state.l.path !== path) return "r";
  return "l";
}

function sameParams(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => a[k] === b[k]);
}

/**
 * The keys a route declares — so a control can check, in development, that the
 * param it is about to write will survive the namespace. A key missing from
 * SPLIT_ROUTES is silently dropped by setTabParams/setPaneParams (deliberately —
 * see split-view.ts), which inside a pane reads as "the filter did nothing".
 */
export function declaredParamKeys(pagePath: string): readonly string[] {
  return splitRoute(pagePath)?.params ?? [];
}
