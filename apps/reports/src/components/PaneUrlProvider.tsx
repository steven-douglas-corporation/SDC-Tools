"use client";

import { createContext, useCallback, useContext, useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { applyWorkspace, useLiveWorkspace } from "@/lib/workspace-store";
import { decodeSplit, type Pane } from "@/lib/split-view";
import type { TabId } from "@/lib/workspace";
import {
  inferSplitPane,
  paneHrefFor,
  paneParamsFromHost,
  rawParams,
  workspaceWithPaneParams,
  type PaneScope,
  type ParamsInput,
} from "@/lib/pane-url";

// ── The pane-aware URL writer every in-pane control uses ─────────────────────
//
// lib/pane-url.ts carries the bug report and the encoding. This file is the React
// half: a context that says WHICH pane a control is rendered in (provided by
// PaneView around each page body), and one hook — usePaneUrl() — that every control
// calls instead of usePathname()/useSearchParams()/router.push().
//
// On an ordinary page there is no provider, and the hook behaves exactly as those
// three did: the page's own path, its own params, bare keys pushed at its own route.
// Nothing about a stand-alone page changes; the whole point is that a control does
// not have to know where it is.
//
// ── Where a push goes, per scope ─────────────────────────────────────────────
//
//   page        router.push / router.replace, as before.
//   workspace   applyWorkspace(next, { navigate: true }) — the shell's own commit
//               point (WorkspaceShell.apply), which updates the LIVE workspace and
//               router.replaces the encoded /w URL so the pane re-renders with its
//               new params. Going through the store rather than router.push is
//               load-bearing: it is what keeps the live workspace and the URL in
//               step, so the next tab switch cannot write the OLD params back.
//   split       router.push(/split?…) with only this pane's `l.`/`r.` keys changed.
//
// `replaceState` is for view preferences (hidden columns) that must not navigate:
// in the workspace it commits to the live store WITHOUT navigate, which is a
// setState plus history.replaceState in the shell — the same no-fetch path a tab
// switch takes.

type PaneCtx = {
  scope: Exclude<PaneScope, { kind: "page" }>;
  /** The page's own route. */
  path: string;
  /** The params the server rendered this pane with — the fallback when the host URL cannot say. */
  params: Record<string, string>;
};

const PaneUrlContext = createContext<PaneCtx | null>(null);

export function PaneUrlProvider({
  path,
  params,
  tabId,
  pane,
  children,
}: {
  path: string;
  params: Record<string, string>;
  /** Set for a workspace tab. */
  tabId?: TabId;
  /** Set for a /split pane. Inferred from the URL when absent — see inferSplitPane. */
  pane?: Pane;
  children: React.ReactNode;
}) {
  const hostPath = usePathname();
  const hostSearch = useSearchParams();
  const hostKey = hostSearch.toString();
  // `params` is a fresh object per server render; the memo is keyed by its content.
  const paramsKey = JSON.stringify(params);

  const value = useMemo<PaneCtx | null>(() => {
    const p = JSON.parse(paramsKey) as Record<string, string>;
    if (tabId) return { scope: { kind: "workspace", tabId }, path, params: p };
    if (pane) return { scope: { kind: "split", pane }, path, params: p };
    if (hostPath === "/split") {
      const inferred = inferSplitPane(decodeSplit(rawParams(hostKey)), path, p);
      return { scope: { kind: "split", pane: inferred }, path, params: p };
    }
    // Rendered somewhere with no namespace to speak of: behave as a plain page.
    return null;
  }, [tabId, pane, path, hostPath, hostKey, paramsKey]);

  return <PaneUrlContext.Provider value={value}>{children}</PaneUrlContext.Provider>;
}

export type PaneUrl = {
  /** The page's own route — "/hours" even when the document is at "/w". */
  pathname: string;
  /** The page's own current params, de-namespaced. A fresh instance per render, like useSearchParams. */
  searchParams: URLSearchParams;
  /** `searchParams.toString()`, for dependency lists and the url-params overlay. */
  searchKey: string;
  /** True inside a workspace tab or a split pane. */
  inPane: boolean;
  scope: PaneScope;
  /** The href for `next` — the page's own next query — wherever this control lives. For <Link>. */
  hrefFor: (next: ParamsInput) => string;
  push: (next: ParamsInput, opts?: { scroll?: boolean }) => void;
  replace: (next: ParamsInput, opts?: { scroll?: boolean }) => void;
  /** Rewrite the address bar for `next` with no navigation — view preferences. */
  replaceState: (next: ParamsInput) => void;
};

export function usePaneUrl(): PaneUrl {
  const ctx = useContext(PaneUrlContext);
  const router = useRouter();
  const hostPath = usePathname();
  const hostSearch = useSearchParams();
  const live = useLiveWorkspace();
  const hostKey = hostSearch.toString();

  const scope: PaneScope = useMemo(() => ctx?.scope ?? { kind: "page" }, [ctx]);
  const pathname = ctx?.path ?? hostPath;

  // The pane's own params. In the workspace these come from the LIVE tab, for the
  // reason lib/workspace-store.ts gives: a control that wrote hidden columns with
  // replaceState updated the live workspace, not the router's params, and the next
  // control must build on that or it drops them. On a plain page this is exactly
  // useSearchParams().
  const searchKey = useMemo(() => {
    const params = paneParamsFromHost(scope, { pagePath: pathname, hostSearch: hostKey, workspace: live }) ?? ctx?.params ?? {};
    return new URLSearchParams(params).toString();
  }, [scope, ctx, pathname, hostKey, live]);

  const host = useMemo(
    () => ({ pagePath: pathname, hostSearch: hostKey, workspace: live }),
    [pathname, hostKey, live],
  );

  const hrefFor = useCallback((next: ParamsInput) => paneHrefFor(scope, host, next), [scope, host]);

  const go = useCallback(
    (mode: "push" | "replace", next: ParamsInput, opts?: { scroll?: boolean }) => {
      if (scope.kind === "workspace") {
        const ws = workspaceWithPaneParams(scope, host, next);
        // The shell decides how to show it (router.replace, because a pane has to
        // re-render with the new params). No shell mounted: navigate ourselves.
        if (applyWorkspace(ws, { navigate: true })) return;
      }
      const href = paneHrefFor(scope, host, next);
      if (mode === "push") router.push(href, opts);
      else router.replace(href, opts);
    },
    [scope, host, router],
  );

  const push = useCallback((next: ParamsInput, opts?: { scroll?: boolean }) => go("push", next, opts), [go]);
  const replace = useCallback((next: ParamsInput, opts?: { scroll?: boolean }) => go("replace", next, opts), [go]);

  const replaceState = useCallback(
    (next: ParamsInput) => {
      if (typeof window === "undefined") return;
      if (scope.kind === "workspace") {
        // Through the live store, so the workspace the next tab switch writes back
        // to the URL already carries this change. The shell's non-navigating apply
        // is a setState plus history.replaceState — no fetch, no render of the pane.
        if (applyWorkspace(workspaceWithPaneParams(scope, host, next))) return;
      }
      const href = paneHrefFor(scope, host, next);
      if (href !== window.location.pathname + window.location.search) window.history.replaceState(null, "", href);
    },
    [scope, host],
  );

  return {
    pathname,
    searchParams: new URLSearchParams(searchKey),
    searchKey,
    inPane: ctx != null,
    scope,
    hrefFor,
    push,
    replace,
    replaceState,
  };
}
