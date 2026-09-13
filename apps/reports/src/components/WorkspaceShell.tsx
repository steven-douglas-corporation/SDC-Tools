"use client";

import { Activity, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { WorkspaceTabBar } from "@/components/WorkspaceTabBar";
import { TabScrollMemory } from "@/components/TabScrollMemory";
import { DEFAULT_RATIO, MIN_PANE_PX, clampRatio, ratioBounds } from "@/lib/split-view";
import { publishWorkspace, registerWorkspaceApply } from "@/lib/workspace-store";
import {
  activateTab,
  exitSplit,
  hasTab,
  tabTitle,
  workspaceHref,
  type TabId,
  type Workspace,
} from "@/lib/workspace";

// ── The workspace's chrome: the tab bar, and the split beneath it ────────────
//
// ── Every open tab stays MOUNTED; switching is a visibility toggle ──────────
//
// Rewritten 2026-09-04. This used to render only the visible tab(s), and a tab switch
// was a `router.push` — a server navigation that re-ran the target page's whole render
// and remounted its client tree. Reported as "switching tabs is too slow", and it was:
// getPartsCostForJobs over 49 jobs is 547ms on its own, before Monthly ETC's Prisma
// reads, and the remount is why scroll position, open drill-downs and half-typed
// filters all reset on the way back.
//
// The old header argued that mounting all eight was "the only way to make a tab switch
// truly instant" and rejected it on cost, because /w re-ran every mounted tab's data
// loads on EVERY navigation. That reasoning was right about the mechanism and wrong
// about the conclusion: the cost only exists if switching is still a navigation. Take
// the navigation away and the panes are rendered once, on load, and never again.
//
// So: /w renders every open tab, and each one lives inside React's <Activity>.
//
//     <Activity mode="visible">  the tab you are looking at
//     <Activity mode="hidden">   every other open tab — display:none, state intact
//
// Activity keeps the DOM in the document and the component state alive while hiding it
// (React 19.2; Next 16 uses the same primitive for its own cross-navigation state
// preservation — see node_modules/next/dist/docs/01-app/02-guides/preserving-ui-state.md).
// So a switch is a CSS toggle: no fetch, no render, no remount, and scroll position,
// filters, expanded sections, search text and drill state are all simply still there
// because they never went away.
//
// ── Which actions still touch the server ───────────────────────────────────
//
// Only the ones that need pane content that does not exist yet:
//
//     activate / close / reorder / split / ratio   local state, history.replaceState
//     open a new tab / duplicate / re-route a tab  router.replace — a pane must render
//
// `apply()` below is the single place that decides, so no caller has to know.

export function WorkspaceShell({
  ws: serverWs,
  panes,
}: {
  /** Decoded on the server, so the first paint is already the right layout — no post-hydration snap. */
  ws: Workspace;
  /**
   * Rendered content for EVERY open tab, keyed by tab id — not just the visible ones.
   * That is what lets this component keep them all mounted; see the header.
   */
  panes: Record<TabId, React.ReactNode>;
}) {
  const router = useRouter();
  const rowRef = useRef<HTMLDivElement | null>(null);

  // ── Local state is the live workspace; the server prop re-seeds it ────────
  //
  // Activating a tab must not wait for a server round-trip, so `ws` lives here. The
  // prop wins whenever the server sends a genuinely different SET of tabs — which only
  // happens on the navigations listed in the header, plus a reload. Comparing the
  // id~path signature rather than object identity is what keeps a re-render caused by
  // something else from throwing away the user's current tab.
  const signature = serverWs.tabs.map((t) => `${t.id}~${t.path}`).join(",");
  const [seen, setSeen] = useState(signature);
  const [ws, setWs] = useState(serverWs);
  if (seen !== signature) {
    // The documented derive-state-from-props pattern: a guarded setState during render,
    // which React applies before committing rather than as a second pass.
    setSeen(signature);
    setWs(serverWs);
  }

  const [ratio, setRatio] = useState(() => clampRatio(serverWs.split?.ratio ?? DEFAULT_RATIO));
  const [dragging, setDragging] = useState(false);

  /**
   * Commit a workspace change.
   *
   * `navigate` means "a pane exists in `next` that has never been rendered", which is
   * the only reason to involve the router at all. Everything else updates local state
   * and rewrites the address bar in place — history.replaceState does NOT notify the
   * router, so there is no RSC request and no refetch.
   */
  const apply = useCallback(
    (next: Workspace, opts?: { navigate?: boolean }) => {
      setWs(next);
      const href = workspaceHref(next);
      if (opts?.navigate) {
        router.replace(href);
        return;
      }
      if (typeof window !== "undefined") window.history.replaceState(null, "", href);
    },
    [router],
  );

  // ── Publish, so the sidebar is never reading a stale workspace ───────────
  //
  // The sidebar lives in the (app) layout, above this page, and used to decode the
  // workspace from useSearchParams(). Since a tab switch is now history.replaceState —
  // which does not notify the router — those params go stale the moment anyone
  // switches a tab, and a sidebar click was resolving against an out-of-date tab list.
  // That is the reported "clicking a page in the sidebar does not reliably switch to
  // its open tab". See lib/workspace-store.ts.
  useEffect(() => {
    publishWorkspace(ws);
  }, [ws]);

  // The browser tab's own title follows the active workspace tab. Without this every
  // tab reads "SDC Projects Reports" (the layout's static metadata), because /w is one
  // route and switching tabs is no longer a navigation for Next to retitle on.
  useEffect(() => {
    if (!ws.tabs.length) return;
    const name = tabTitle(ws, ws.active, { detailed: true });
    if (name) document.title = `${name} · SDC Projects Reports`;
  }, [ws]);

  // Registered separately from the value: this must survive every re-render and be
  // torn down exactly once, so a sidebar click can never call into an unmounted tree.
  useEffect(() => registerWorkspaceApply(apply), [apply]);

  const syncRatio = useCallback(
    (r: number) => {
      if (!ws.split) return;
      apply({ ...ws, split: { ...ws.split, ratio: clampRatio(r) } });
    },
    [apply, ws],
  );

  // Ctrl+\ leaves the split, keeping the pane you were in — the toggle's "off"
  // direction. Turning it ON needs a target tab, which a shortcut cannot guess; that
  // is what the Split View picker is for.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key !== "\\" || !ws.split) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      e.preventDefault();
      apply(exitSplit(ws, ws.active));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [apply, ws]);

  // ── Responsive collapse ──────────────────────────────────────────────────
  //
  // Measured, not guessed from a media query: the panes live inside <main>, whose width
  // is the viewport minus a sidebar the user can collapse or drag. A viewport
  // breakpoint would be wrong by exactly the sidebar's width — the difference between
  // two readable panes and two unreadable ones. `null` until measured, so the server's
  // own two-pane markup renders first and nothing collapses-then-expands on hydration.
  const [available, setAvailable] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setAvailable(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const bar = <WorkspaceTabBar ws={ws} apply={apply} />;

  if (ws.tabs.length === 0) {
    return (
      <div className="flex min-h-[var(--app-vh)] flex-col">
        {bar}
        <div className="flex flex-1 items-center justify-center p-8">
          <p className="text-body text-sdc-muted">
            No tabs open. Pick a page from the sidebar, or use{" "}
            <span className="font-semibold text-sdc-gray-700">+</span> above.
          </p>
        </div>
      </div>
    );
  }

  const bounds = available == null ? null : ratioBounds(available);
  // Too narrow for two panes: show only the active one, full width, and say so. The
  // split is NOT closed — the URL still holds both tabs, so widening the window (or
  // collapsing the sidebar) brings the other one straight back. Requirement: never
  // create unreadable 200px-wide Monthly ETC tables.
  const collapsed = ws.split != null && available != null && bounds == null;
  const effectiveRatio = bounds ? Math.min(bounds.max, Math.max(bounds.min, ratio)) : ratio;

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (collapsed) return;
    e.preventDefault();
    const row = rowRef.current;
    if (!row) return;
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    setDragging(true);

    const rect = row.getBoundingClientRect();
    let last = ratio;
    const move = (ev: PointerEvent) => {
      const pct = ((ev.clientX - rect.left) / rect.width) * 100;
      const b = ratioBounds(rect.width);
      last = b ? Math.min(b.max, Math.max(b.min, Math.round(pct))) : clampRatio(pct);
      // Local state only while dragging — the URL is written once, on release, so a
      // drag produces one history.replaceState rather than sixty.
      setRatio(last);
    };
    const up = (ev: PointerEvent) => {
      handle.releasePointerCapture?.(ev.pointerId);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      setDragging(false);
      syncRatio(last);
    };
    // setPointerCapture means the drag keeps tracking when the cursor crosses into a
    // pane or leaves the window. The failure mode of mousemove-on-document is a
    // divider that sticks to the cursor after release.
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  };

  const nudge = (n: number) => {
    const b = bounds ?? { min: 20, max: 80 };
    const r = Math.min(b.max, Math.max(b.min, n));
    setRatio(r);
    syncRatio(r);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 10 : 2;
    const b = bounds ?? { min: 20, max: 80 };
    const at = (n: number) => {
      e.preventDefault();
      nudge(n);
    };
    if (e.key === "ArrowLeft") at(effectiveRatio - step);
    else if (e.key === "ArrowRight") at(effectiveRatio + step);
    else if (e.key === "Home") at(b.min);
    else if (e.key === "End") at(b.max);
    else if (e.key === "Enter" || e.key === " ") at(DEFAULT_RATIO);
  };

  const split = ws.split;
  // ── Visual order without moving DOM nodes ────────────────────────────────
  //
  // The panes are emitted in TAB order and always in the same position in the tree, so
  // React never has to move a mounted pane's DOM. Flex `order` puts the split's left
  // and right where they belong visually. Reordering the children instead would move
  // the nodes, and moving a scroll container's node is exactly what resets its
  // scrollTop — the thing this whole change exists to stop.
  const orderOf = (id: TabId): number => {
    if (!split) return 0;
    if (id === split.left) return 0;
    if (id === split.right) return 2;
    return 0;
  };
  const isVisible = (id: TabId): boolean => {
    if (!split) return id === ws.active;
    if (collapsed) return id === ws.active || (ws.active !== split.left && ws.active !== split.right && id === split.left);
    return id === split.left || id === split.right;
  };
  const widthOf = (id: TabId): string => {
    if (!split || collapsed) return "100%";
    return id === split.left ? `${effectiveRatio}%` : `${100 - effectiveRatio}%`;
  };

  return (
    <div className="flex min-h-[var(--app-vh)] flex-col">
      {bar}
      <div
        ref={rowRef}
        className="flex min-h-0 flex-1 items-stretch"
        style={dragging ? { userSelect: "none", cursor: "col-resize" } : undefined}
      >
        {ws.tabs.map((tab) => (
          // key is the tab's own id, so a reorder, a close or a duplicate never makes
          // React reconcile one tab's pane into another's slot.
          <Activity key={tab.id} mode={isVisible(tab.id) ? "visible" : "hidden"}>
            <PaneHost
              ws={ws}
              id={tab.id}
              order={orderOf(tab.id)}
              width={widthOf(tab.id)}
              showHeader={split != null && !collapsed}
              collapsed={collapsed}
              apply={apply}
            >
              {panes[tab.id] ?? <PanePending />}
            </PaneHost>
          </Activity>
        ))}

        {split && !collapsed && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the split. Arrow keys adjust, Enter resets to an even split."
            aria-valuenow={effectiveRatio}
            aria-valuemin={bounds?.min ?? 20}
            aria-valuemax={bounds?.max ?? 80}
            tabIndex={0}
            onPointerDown={onPointerDown}
            onDoubleClick={() => nudge(DEFAULT_RATIO)}
            onKeyDown={onKeyDown}
            title="Drag to resize · double-click for an even split"
            style={{ touchAction: "none", order: 1 }}
            // 9px of hit area around a 1px rule: easy to grab, without a fat visible
            // seam. `group` drives the inner rule's hover colour, so the target and
            // the thing that looks like the target are the same element.
            className={`group relative z-10 w-[9px] shrink-0 cursor-col-resize touch-none focus:outline-none ${
              dragging ? "bg-sdc-blue/10" : "hover:bg-sdc-blue/5"
            }`}
          >
            <span
              aria-hidden
              className={`motion-interactive pointer-events-none absolute inset-y-0 left-1/2 -ml-px w-0.5 ${
                dragging ? "bg-sdc-blue" : "bg-sdc-border group-hover:bg-sdc-blue/60 group-focus:bg-sdc-blue"
              }`}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * A tab whose server content has not arrived yet.
 *
 * Only ever seen for the few hundred ms between opening a brand-new tab and its pane
 * streaming in — every already-open tab has its content mounted. Deliberately quiet:
 * a spinner here would be the "add a loading spinner" non-fix the report ruled out.
 */
function PanePending() {
  return <div className="p-6 text-body text-sdc-muted">Opening…</div>;
}

/** A tab's scroll identity: its route AND its params, so a new month starts at the top. */

function PaneHost({
  ws,
  id,
  order,
  width,
  showHeader,
  collapsed,
  apply,
  children,
}: {
  ws: Workspace;
  id: TabId;
  order: number;
  width: string;
  showHeader: boolean;
  collapsed: boolean;
  apply: (next: Workspace, opts?: { navigate?: boolean }) => void;
  children: React.ReactNode;
}) {
  const isActive = ws.active === id;
  const label = tabTitle(ws, id, { detailed: true });
  if (!hasTab(ws, id)) return null;

  // Activating is local state now, so this is free — which is what makes clicking into
  // the other pane feel like clicking into a pane rather than like a navigation.
  const activate = () => {
    if (!isActive) apply(activateTab(ws, id));
  };

  return (
    // onFocusCapture alongside the mousedown: tabbing into a pane makes it active too,
    // so a keyboard user is never navigating with the sidebar into a pane they cannot
    // tell they are in. Capture phase, because the focus lands on a descendant.
    <section
      onMouseDown={activate}
      onFocusCapture={activate}
      aria-label={`${label} pane`}
      // min-w-0 is what lets a dense page scroll horizontally INSIDE its pane rather
      // than forcing the pane wider than its share, which would push the divider off
      // the ratio the user set.
      className="flex min-w-0 flex-col"
      style={{ width, order, minWidth: collapsed || !showHeader ? undefined : MIN_PANE_PX }}
    >
      {/* Thin (h-7, one line): two of these are on screen at once, above pages that
          already have their own titles and toolbars. The tab strip above names both
          pages, so this bar carries only what the strip cannot — WHICH pane the
          sidebar will open into. Not rendered at all outside the split, where the strip
          alone names the page and a second title bar would be chrome competing with
          the page's own. */}
      {showHeader && (
        <header
          className={`flex h-7 shrink-0 items-center gap-1.5 border-b px-2 ${
            isActive ? "border-sdc-blue/40 bg-sdc-blue-light/40" : "border-sdc-border bg-sdc-gray-50"
          }`}
        >
          <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${isActive ? "bg-sdc-blue" : "bg-sdc-gray-300"}`} />
          <span className={`truncate text-label font-semibold ${isActive ? "text-sdc-navy" : "text-sdc-gray-600"}`}>
            {label}
          </span>
          {isActive && (
            // Says WHY the highlight matters, which an active-pane outline on its own
            // never manages to communicate.
            <span className="hidden whitespace-nowrap text-micro text-sdc-blue-dark sm:inline">· sidebar opens here</span>
          )}
        </header>
      )}
      {/* Each pane its own scroll container: scrolling Monthly ETC on the left must not
          move Job Details on the right. */}
      {/* Keyed by the TAB, not by route+params: two Monthly ETC tabs on the same
          month must not share a position. See lib/tab-scroll-state.ts. */}
      <TabScrollMemory tabId={id}>{children}</TabScrollMemory>
    </section>
  );
}
