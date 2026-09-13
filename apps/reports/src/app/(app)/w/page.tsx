import { Suspense } from "react";
import { redirect } from "next/navigation";
import { EmptyState } from "@/components/ui/EmptyState";
import { PaneView } from "@/components/PaneView";
import { WorkspaceShell } from "@/components/WorkspaceShell";
import { PaneLifecycleProbe } from "@/components/PaneLifecycleProbe";
import { decodeWorkspace, tabHref, tabLabel, type RawParams } from "@/lib/workspace";
import { pairingRefusal, splitRoute } from "@/lib/split-view";

// ── /w — the workspace: browser-style tabs over the Reports App ──────────────
//
// Everything about WHY this is one route with a namespaced URL rather than iframes or
// a client-side cache is in lib/workspace.ts and lib/split-view.ts. What this file adds
// is the render: decode the URL, render the VISIBLE tabs' own view components on the
// server, and hand them to the client shell that draws the strip and the divider.
//
// ── What this route deliberately does NOT do ────────────────────────────────
//
// No auth() call, no permission check, no data loading of its own. Each tab's view is
// the page's own body and still starts with its own requirePagePermission(), so
// authorization stays server-enforced per tab and cannot be widened by being rendered
// here — see PaneView's note. The (app) layout above still supplies the sidebar,
// RealtimeProvider, LiveRefresh and the toast host: ONE of each, shared by every tab,
// which is the whole argument for a single document. One SSE connection, one heartbeat,
// one refresh pipeline, one autosave client, however many tabs are open.
//
// ── EVERY open tab is rendered, and stays mounted (rewritten 2026-09-04) ────
//
// This used to render only the visible tab(s) — one, or two when split — and a tab
// switch was a server navigation. Reported as "switching tabs is too slow", and the
// measurement agrees: a switch re-ran the target page's whole server render, of which
// getPartsCostForJobs over 49 jobs alone is 547ms, before its Prisma reads and KPIs.
// It also remounted the client tree, which is why scroll position, open drill-downs and
// half-typed filters all reset.
//
// So every open tab is rendered here, and WorkspaceShell keeps them all mounted behind
// React's <Activity> — switching is then a visibility toggle with no navigation, no
// fetch and no remount. That is the architecture the request asked for in as many
// words: "open tab instance -> mounted/cached page state -> hide/show when switching".
//
// ── What that costs, honestly ───────────────────────────────────────────────
//
// A workspace with N tabs renders N pages on FIRST load. They are siblings under
// independent Suspense boundaries, so React streams them concurrently — wall clock is
// roughly the slowest tab, not the sum — and the active one paints first regardless.
// The cost lands on a cold load (including App Refresh, which is a full reload) and is
// paid once; every switch afterwards is free, which is the trade the report asked for.
// MAX_TABS is 8, and only one of them can ever be Monthly ETC.

export default async function WorkspacePage({ searchParams }: { searchParams: Promise<RawParams> }) {
  const ws = decodeWorkspace(await searchParams);

  // ── One tab is not a workspace ─────────────────────────────────────────────
  //
  // Same reasoning as /split redirecting a one-pane URL to that pane's own route: the
  // app's twelve routes keep working as themselves, deep links and bookmarks keep
  // resolving, and the SDC Tools shell's tiles keep working. /w earns its URL once
  // there is something a single route cannot express — a second tab, or a split.
  //
  // Note this is NOT the empty case: zero tabs renders the shell with an empty strip,
  // because redirecting that would make "/w" itself unreachable.
  if (ws.tabs.length === 1 && !ws.split) redirect(tabHref(ws.tabs[0]));

  // Every tab, not just the visible ones — see the header.
  const rendered = ws.tabs.map((t) => t.id);

  // ── The one pairing this route refuses ────────────────────────────────────
  //
  // Monthly ETC in both panes of the split. lib/split-view.ts's `exclusive` flag carries
  // the whole reason (module-scope autosave state keyed by a field name containing no
  // month, so two grids share one baseline and can post into each other's month).
  // Enforced HERE as well as in the picker, because the picker is only one way in: a
  // hand-edited URL, an old bookmark or a shared link all arrive straight at this route,
  // and the guard has to be where the render is.
  const clash =
    ws.split != null
      ? pairingRefusal(
          ws.tabs.find((t) => t.id === ws.split!.right)?.path ?? "",
          ws.tabs.find((t) => t.id === ws.split!.left)?.path,
        )
      : null;

  const panes: Record<string, React.ReactNode> = {};
  for (const id of rendered) {
    const tab = ws.tabs.find((t) => t.id === id);
    if (!tab) continue;
    // The refused pane shows the reason instead of the grid, rather than being silently
    // dropped: the URL asked for something specific, and a pane that just vanishes reads
    // as a bug. The other pane is unaffected and fully usable.
    if (clash && ws.split && id === ws.split.right) {
      const label = splitRoute(tab.path)?.label ?? tabLabel(tab);
      panes[id] = (
        <div className="p-6">
          <EmptyState
            title={`${label} is already open in the other pane`}
            message={
              `${label} can only be shown once at a time — its unsaved-edit tracking is shared across the page, ` +
              `so two copies could save over each other. Pick a different tab for this side of the split, or exit ` +
              `the split to go back to one full-width view.`
            }
          />
        </div>
      );
      continue;
    }
    // ── One Suspense boundary EACH, and it is load-bearing ──────────────────
    //
    // PaneView is an async server component with no boundary of its own. Siblings do
    // render concurrently, so their awaits overlap — but without a boundary React
    // cannot flush ANY of them until the slowest resolves, which on a cold load of
    // eight tabs would mean waiting on a hidden tab before seeing the active one.
    //
    // A boundary per pane makes each one stream on its own: the shell and the tab
    // strip paint immediately, the active tab lands as soon as its own data does, and
    // the tabs nobody is looking at fill in behind it. That is what makes "render every
    // open tab" affordable, and it is the difference between max() and "everything".
    panes[id] = (
      <Suspense key={id} fallback={<PaneLoading />}>
        {/* Inside the pane's CONTENT, so it is destroyed with it — which is what makes
            it able to answer "is this remounting on every switch, or only hidden?".
            Renders nothing and logs nothing unless ?tabdebug=1. See
            components/PaneLifecycleProbe.tsx. */}
        <PaneLifecycleProbe tabId={id} page={tab.path} />
        <PaneView pane={tab} />
      </Suspense>
    );
  }

  return <WorkspaceShell ws={ws} panes={panes} />;
}

/**
 * A pane that has not finished loading yet.
 *
 * Deliberately near-silent. This is only ever seen on a cold load, and mostly by tabs
 * that are hidden anyway — a spinner per hidden tab would be eight spinners for a
 * workspace nobody is waiting on.
 */
function PaneLoading() {
  return <div className="p-6 text-body text-sdc-muted">Loading…</div>;
}
