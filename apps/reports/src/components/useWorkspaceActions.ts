"use client";

import { useCallback, useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  EMPTY_WORKSPACE,
  MAX_TABS,
  duplicateTab as duplicateTabIn,
  enterSplit,
  mostRecentInstance,
  openTab,
  sidebarTarget,
  tabById,
  tabTitle,
  workspaceHref,
  type TabId,
  type Workspace,
} from "@/lib/workspace";
import {
  isExclusive,
  isSplittable,
  normalizePath,
  openInSplit,
  pairingRefusal,
  splitHref,
  splitRoute,
} from "@/lib/split-view";
import { applyWorkspace, useLiveWorkspace } from "@/lib/workspace-store";
import { isEtcDirty } from "@/lib/etc-dirty-tracker";

// ── The four tab actions, in one place ───────────────────────────────────────
//
// Requested 2026-09-04, in as many words: "Use the exact same centralized actions for
// both entry points. Do not create separate sidebar-specific tab logic."
//
// That instruction was aimed at a real problem rather than at tidiness. Before this
// file, three different things decided what a sidebar interaction did:
//
//   • a plain click ran openTab + applyWorkspace INLINE in Sidebar.tsx's onClick;
//   • middle-click and the context menu used href builders in useSplitNav
//     (newTabHrefFor / splitHrefFor) that navigated instead;
//   • the tab strip's own "+" and Duplicate called the model directly.
//
// So "open in a new tab" from the sidebar and "+" in the strip were two
// implementations of one idea, and only one of them knew about the live workspace.
// Adding a visible ⋮ menu as a third caller is exactly how those drift apart, which is
// why the actions moved here first and the menu was built on top of them.
//
// ── Why a hook and not a plain module ───────────────────────────────────────
//
// Each action needs the LIVE workspace (lib/workspace-store.ts), the router for the
// cases that genuinely have to navigate, and the current route's own params. Those are
// React-scoped. The DECISIONS are all in lib/workspace.ts, which is pure and tested;
// this file is only the wiring between them and a click.
//
// ── When an action navigates, and when it does not ─────────────────────────
//
// The distinction is "does a pane exist that has never been rendered":
//
//   resuming an open tab      no navigation — the pane is mounted behind <Activity>,
//                             so this is a visibility toggle
//   a new tab, or a duplicate router.replace, because /w has to render that pane
//
// `commit` below is the only place that decides, so no caller has to know.

export type TabInstance = {
  id: TabId;
  /** Detailed, so two instances of one page are told apart — see tabTitle. */
  title: string;
};

export function useWorkspaceActions() {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const workspace = useLiveWorkspace();

  const searchKey = search.toString();

  /** The current page's own params — what travels with it when it becomes the first tab. */
  const currentParams = useMemo(() => {
    const route = splitRoute(pathname);
    if (!route) return {};
    const sp = new URLSearchParams(searchKey);
    const out: Record<string, string> = {};
    for (const key of route.params) {
      const v = sp.get(key);
      if (v !== null) out[key] = v;
    }
    return out;
  }, [pathname, searchKey]);

  /**
   * Apply a workspace change, choosing the cheapest mechanism that can show it.
   *
   * `navigate` is set by the caller when `next` contains a pane /w has not rendered.
   * Everything else is local state plus history.replaceState and costs no fetch.
   */
  const commit = useCallback(
    (next: Workspace, opts?: { navigate?: boolean }) => {
      if (next === workspace) return true;
      if (applyWorkspace(next, opts?.navigate ? { navigate: true } : undefined)) return true;
      // No shell mounted (an ordinary route). A navigation is the only way in.
      router.push(workspaceHref(next));
      return true;
    },
    [workspace, router],
  );

  /**
   * A confirm before anything that leaves the current page for real.
   *
   * Only for genuine navigations away from a mounted grid: inside the workspace nothing
   * unmounts, so a tab switch cannot lose an unsaved ETC cell and must not nag.
   */
  const confirmLeaving = useCallback((): boolean => {
    if (!isEtcDirty()) return true;
    return window.confirm("You have unsaved New ETC changes that haven't been saved. Leave this page anyway?");
  }, []);

  /** Can this route be a tab at all? An admin screen cannot. */
  const canHost = useCallback((path: string) => isSplittable(path), []);

  /**
   * The open instances of `path`, most-recently-used first.
   *
   * Used by the menu to decide whether Split View can act immediately or has to ask
   * which instance — the requirement that "if multiple instances exist, allow the user
   * to select one or create a new instance".
   */
  const instancesOf = useCallback(
    (path: string): TabInstance[] => {
      if (!workspace) return [];
      const p = normalizePath(path);
      const ordered = [...workspace.mru, ...workspace.tabs.map((t) => t.id)];
      const seen = new Set<TabId>();
      const out: TabInstance[] = [];
      for (const id of ordered) {
        if (seen.has(id)) continue;
        seen.add(id);
        const tab = tabById(workspace, id);
        if (tab?.path === p) out.push({ id, title: tabTitle(workspace, id, { detailed: true }) });
      }
      return out;
    },
    [workspace],
  );

  /**
   * Why `path` cannot be opened right now, or null when it can.
   *
   * A string rather than a boolean because it is shown on the menu entry: a disabled
   * row with no explanation reads as a bug.
   */
  const refusalFor = useCallback(
    (path: string): string | null => {
      if (!canHost(path)) return "This page cannot be opened as a tab";
      if (!workspace) return null;
      if (workspace.tabs.length >= MAX_TABS && !workspace.tabs.some((t) => t.path === normalizePath(path))) {
        return `At the ${MAX_TABS}-tab limit — close a tab to open another`;
      }
      return pairingRefusal(path, tabById(workspace, sidebarTarget(workspace))?.path);
    },
    [canHost, workspace],
  );

  /** True when a second instance of this page is refused outright (Monthly ETC). */
  const refusesSecondInstance = useCallback(
    (path: string): boolean =>
      isExclusive(path) && (workspace?.tabs.some((t) => t.path === normalizePath(path)) ?? false),
    [workspace],
  );

  // ── The four actions ──────────────────────────────────────────────────────

  /**
   * What a plain sidebar click does: resume the most recently used instance of this
   * page, or open it as a normal tab when none is open.
   *
   * Unchanged behaviour, moved out of Sidebar's onClick. openTab already encodes the
   * resume-don't-duplicate rule, which is why this is three lines rather than a policy.
   */
  const openExistingTab = useCallback(
    (path: string): boolean => {
      if (!canHost(path)) return false;
      if (!workspace) {
        // No workspace on screen: this is an ordinary route, so an ordinary navigation
        // is right. The caller lets the <Link> handle it.
        return false;
      }
      const next = openTab(workspace, path);
      if (next === workspace) return true; // already the active tab; the click is a no-op
      // A brand-new tab needs a pane rendered; resuming one does not.
      const isNew = next.tabs.length !== workspace.tabs.length;
      return commit(next, isNew ? { navigate: true } : undefined);
    },
    [canHost, workspace, commit],
  );

  /**
   * Always a NEW instance, even when one is open — middle-click, and "Open in new tab".
   *
   * From an ordinary route this is also the only way INTO the workspace, since the tab
   * strip only exists on /w: it builds a two-tab workspace from the page you are on
   * plus the target.
   */
  const openNewTab = useCallback(
    (path: string): boolean => {
      if (!canHost(path) || refusesSecondInstance(path)) return false;

      if (workspace) {
        const next = openTab(workspace, path, {}, { newInstance: true });
        if (next === workspace) return false;
        return commit(next, { navigate: true });
      }

      // An unhostable current page would leave nothing to keep as the first tab.
      if (!canHost(pathname)) return false;
      if (!confirmLeaving()) return true; // handled: the user chose to stay
      const base = openTab(EMPTY_WORKSPACE, pathname, currentParams);
      const next = openTab(base, path, {}, { newInstance: true });
      router.push(workspaceHref(next));
      return true;
    },
    [canHost, refusesSecondInstance, workspace, commit, pathname, currentParams, confirmLeaving, router],
  );

  /**
   * Show `path` beside the tab you are working in.
   *
   * The requested contract: keep the current active tab on one side, put the requested
   * page on the other. `instance` names WHICH open instance to use when there is more
   * than one — the menu asks, this does not guess. Without it, an existing instance is
   * reused when there is exactly one, and otherwise a new one is opened.
   *
   * With no workspace at all, "simply open the requested page normally" — there is no
   * active tab to keep on one side, so there is no split to make.
   */
  const openInSplitView = useCallback(
    (path: string, opts?: { instance?: TabId; newInstance?: boolean }): boolean => {
      if (!canHost(path)) return false;

      // ── The legacy two-pane route ──────────────────────────────────────────
      //
      // /split predates the workspace and is still reachable from old links. Its own
      // model is kept rather than converted mid-click: aim at the pane you are NOT
      // working in, which is what it has always done.
      if (pathname === "/split") {
        if (!confirmLeaving()) return true;
        router.push(splitHref(openInSplit({ path: pathname, params: currentParams }, { path })));
        return true;
      }

      if (!workspace) {
        // No active tab. Build the pair from the page on screen when it can be hosted;
        // otherwise just open the requested page, as instructed.
        if (!canHost(pathname) || pairingRefusal(path, pathname)) {
          if (!confirmLeaving()) return true;
          router.push(path);
          return true;
        }
        if (!confirmLeaving()) return true;
        const base = openTab(EMPTY_WORKSPACE, pathname, currentParams);
        const opened = openTab(base, path, {}, { newInstance: true });
        router.push(workspaceHref(enterSplit({ ...opened, active: base.active }, opened.active)));
        return true;
      }

      const anchor = sidebarTarget(workspace);
      if (pairingRefusal(path, tabById(workspace, anchor)?.path)) return false;

      // Which tab goes on the other side.
      let target = opts?.instance ?? null;
      let next = workspace;
      if (target && !tabById(workspace, target)) target = null;
      if (!target && !opts?.newInstance) {
        const existing = instancesOf(path).filter((i) => i.id !== anchor);
        if (existing.length === 1) target = existing[0].id;
      }
      let navigate = false;
      if (!target) {
        next = openTab(workspace, path, {}, { newInstance: !refusesSecondInstance(path) });
        if (next === workspace) return false;
        target = next.active;
        navigate = next.tabs.length !== workspace.tabs.length;
      }
      if (target === anchor) return false; // a tab cannot be split against itself

      // `active: anchor` keeps the pane the user was working in as the left side, which
      // is the "keep the current active tab on one side" half of the contract.
      return commit(enterSplit({ ...next, active: anchor }, target), navigate ? { navigate: true } : undefined);
    },
    [
      canHost,
      pathname,
      workspace,
      currentParams,
      instancesOf,
      refusesSecondInstance,
      commit,
      confirmLeaving,
      router,
    ],
  );

  /**
   * A second tab on the same page, carrying the original's params — offered only when
   * an instance is already open, because there is otherwise nothing to duplicate.
   */
  const duplicateTab = useCallback(
    (id: TabId): boolean => {
      if (!workspace || !tabById(workspace, id)) return false;
      const next = duplicateTabIn(workspace, id);
      if (next === workspace) return false;
      return commit(next, { navigate: true });
    },
    [workspace, commit],
  );

  /** The instance a Duplicate offered next to `path` would copy, or null when none is open. */
  const duplicableInstance = useCallback(
    (path: string): TabId | null => (workspace ? mostRecentInstance(workspace, path) : null),
    [workspace],
  );

  return {
    workspace,
    canHost,
    instancesOf,
    refusalFor,
    refusesSecondInstance,
    duplicableInstance,
    openExistingTab,
    openNewTab,
    openInSplitView,
    duplicateTab,
  };
}
