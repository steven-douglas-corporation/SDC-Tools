import { decodeSplit, hasExclusiveClash, paneHref, splitRoute, type RawParams } from "@/lib/split-view";
import { EmptyState } from "@/components/ui/EmptyState";
import { PaneView } from "@/components/PaneView";
import { SplitViewShell } from "@/components/SplitViewShell";
import { redirect } from "next/navigation";

// ── /split — two Reports App views side by side in one document ──────────────
//
// Everything about WHY this is one route rather than two frames or two routers is
// in lib/split-view.ts. What this file adds is the render: decode the URL, render
// both panes' own view components on the server, and hand them to the client shell
// that draws the divider and tracks the active pane.
//
// ── What this route deliberately does NOT do ────────────────────────────────
//
// No auth() call, no permission check, no data loading of its own. Each pane's view
// is the page's own body and still starts with its own requirePagePermission(), so
// authorization stays server-enforced per pane and cannot be widened by being
// rendered here (see PaneView's own note). The (app) layout above still supplies the
// sidebar, RealtimeProvider, LiveRefresh and the toast host — ONE of each, shared by
// both panes, which is the whole performance argument for a single document: one SSE
// connection, one heartbeat, one refresh pipeline, one autosave client.
//
// ── Two panes, one server render ────────────────────────────────────────────
//
// Both views run in the SAME request, so anything they share that is
// request-scoped is fetched once rather than twice: Prisma's connection, and any
// per-request memoized loader either page uses. Two panes on the same page (Job
// Hour Details beside Job Hour Details) therefore cost one round of shared queries
// plus each pane's own job-specific ones, not two of everything.
//
// They are also rendered as siblings, so React streams them independently — a slow
// live Total ETO call in the right pane does not hold up the left pane's first
// paint.

export default async function SplitPage({ searchParams }: { searchParams: Promise<RawParams> }) {
  const state = decodeSplit(await searchParams);

  // A /split with no second pane is not a split. Rather than render one pane inside
  // split chrome — which would leave the user on a split-shaped URL with a Close
  // button and nothing to close — send them to that pane's own route, with its
  // context intact. This is the state a hand-edited URL or a stale link produces;
  // Close and Expand both navigate straight to the real route already.
  if (!state.r) redirect(paneHref(state.l));

  // ── The one pairing this route refuses (2026-09-03) ───────────────────────
  //
  // Monthly ETC in BOTH panes. lib/split-view.ts's `exclusive` flag carries the
  // whole reason (module-scope autosave state keyed by a field name that contains
  // no month, so two grids share one baseline and can post into each other's
  // month). Enforced HERE as well as in the sidebar menu because the menu is only
  // one way in: a hand-edited URL, an old bookmark, or a link someone shared all
  // arrive straight at this route, and the guard has to be where the render is.
  //
  // The refused pane renders the reason instead of the grid, rather than being
  // silently dropped: the URL asked for something specific, and a pane that just
  // vanishes reads as a bug. The left pane is unaffected and fully usable.
  const clash = hasExclusiveClash(state);

  return (
    <SplitViewShell
      state={state}
      left={<PaneView pane={state.l} />}
      right={
        clash ? (
          <div className="p-6">
            <EmptyState
              title={`${splitRoute(state.r.path)?.label ?? "This page"} is already open in the other pane`}
              message={
                `${splitRoute(state.r.path)?.label ?? "It"} can only be open in one pane at a time — its unsaved-edit tracking is ` +
                `shared across the page, so two copies could save over each other. Pick a different page for this pane, ` +
                `or close this pane to go back to a single full-width view.`
              }
            />
          </div>
        ) : (
          <PaneView pane={state.r} />
        )
      }
    />
  );
}
