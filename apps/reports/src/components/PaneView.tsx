import { DashboardView } from "@/app/(app)/page";
import { JobHoursView } from "@/app/(app)/job-hours/page";
import { MonthlyEtcView } from "@/app/(app)/etc/page";
import { ProjectsView } from "@/app/(app)/quoted/page";
import { HoursView } from "@/app/(app)/hours/page";
import { TmView } from "@/app/(app)/tm/page";
import { BuildReadinessView } from "@/app/(app)/build-readiness/page";
import { JobsView } from "@/app/(app)/jobs/page";
import { ProfitabilityView } from "@/app/(app)/job-cost-explorer/page";
import { CashFlowView } from "@/app/(app)/cash-flow/page";
import { EmployeesView } from "@/app/(app)/employees/page";
import { AuditLogView } from "@/app/(app)/audit-log/page";
import { FeedbackView } from "@/app/(app)/feedback/page";
import { EmptyState } from "@/components/ui/EmptyState";
import { PaneUrlProvider } from "@/components/PaneUrlProvider";
import { auth } from "@/lib/auth";
import { paneAllowed, permittedRoutePaths } from "@/lib/pane-permissions";
import { splitRoute, type Pane, type PaneState } from "@/lib/split-view";
import type { TabId } from "@/lib/workspace";

// ── One pane's content: a route path resolved to that page's own view ─────────
//
// The twelve views are the exact same components the twelve routes render (each
// page's body, extracted — see any page's "Route entry point" comment). So a pane
// is not a copy of a page, a re-implementation of one, or a frame containing one:
// it IS the page's own body, called with params from its `l.`/`r.` namespace
// instead of from the URL directly. That is what keeps split view from drifting
// away from the real pages as they change.
//
// ── Why the views are imported statically, all twelve ────────────────────────
//
// A dynamic import keyed on the path would ship less code per render, and it is
// the wrong trade here: these are SERVER components. Nothing in this file reaches
// the browser, so "all twelve imported" costs server module graph, not bundle
// size, and the pages are already all in that graph as routes. A static map also
// means a typo in a path cannot become a runtime import failure — `PANE_VIEWS`
// below has to name a real export or the build fails.
//
// ── Permissions ─────────────────────────────────────────────────────────────
//
// The GATE is not here. Every view begins with its own `requirePagePermission(...)`
// (or `requireEltOnly()`), which is the same server call it makes as a route, and it
// runs on the server whether the view is reached as a route or as a pane. A user
// without monthly-etc:view who hand-crafts `?t=t1~/etc` still meets that check from
// inside the view.
//
// What IS here (2026-09-14) is a pre-check that decides what the refusal LOOKS like.
// requirePagePermission refuses with redirect(), and a redirect from inside one pane
// does not refuse one tab — it navigates the whole document away from /w, taking
// every other open tab with it. Reported twice over: a workspace URL carrying a tab
// the role cannot see ejected the user from all their tabs on load, and a
// `permissions` realtime event (router.refresh re-running every pane) did the same
// to anyone who had just lost a page. So a tab the role cannot see renders a message
// in ITS pane, and the other tabs stay exactly where they were. The list it checks
// is the same one the sidebar filters on (lib/pane-permissions.ts), so a page is
// never offered in one place and refused in the other.
//
// This is deliberately NOT a second copy of the permission mapping: it reads
// ROUTE_PERMISSIONS, the one map every surface already uses.

const PANE_VIEWS = {
  "/": DashboardView,
  "/job-hours": JobHoursView,
  "/etc": MonthlyEtcView,
  "/quoted": ProjectsView,
  "/hours": HoursView,
  "/tm": TmView,
  "/build-readiness": BuildReadinessView,
  "/jobs": JobsView,
  "/job-cost-explorer": ProfitabilityView,
  "/cash-flow": CashFlowView,
  "/employees": EmployeesView,
  "/audit-log": AuditLogView,
  "/feedback": FeedbackView,
} as const;

export function isPaneRoute(path: string): path is keyof typeof PANE_VIEWS {
  return path in PANE_VIEWS;
}

/**
 * Which URL namespace this pane's controls write into. /w passes its Tab (which
 * carries `id`); /split passes a bare PaneState and the client works out the side
 * from the URL (see PaneUrlProvider). An explicit `scope` wins over both.
 */
export type PaneScopeHint = { tabId: TabId } | { pane: Pane };

export async function PaneView({ pane, scope }: { pane: PaneState & { id?: TabId }; scope?: PaneScopeHint }) {
  if (!isPaneRoute(pane.path)) {
    // decodeSplit already refuses an unsplittable path, so this is unreachable from
    // a URL — it exists so that adding a route to SPLIT_ROUTES without adding it
    // here degrades to a readable message instead of a crashed pane.
    return (
      <EmptyState
        title="This page cannot be opened in split view"
        message={`No pane view is registered for ${pane.path}.`}
      />
    );
  }

  // The in-pane refusal — see the Permissions note above. The role comes from the
  // same session the (app) layout already resolved for this request.
  const session = await auth();
  if (!paneAllowed(pane.path, permittedRoutePaths(session?.user?.role))) {
    const label = splitRoute(pane.path)?.label ?? pane.path;
    return (
      <div className="p-6">
        <EmptyState
          title="You no longer have access to this page"
          message={
            `${label} is not available to your role any more. Your other tabs are unaffected — ` +
            `close this one, or pick a different page for it from the sidebar.`
          }
        />
      </div>
    );
  }

  const View = PANE_VIEWS[pane.path];
  // `params` is typed per view, and each view's own params type is narrower than
  // the string record a URL produces. The cast is at this one boundary rather than
  // spread across twelve call sites: `readPaneParams` has already filtered the keys
  // to the ones the route declares (and tests/split-view.test.ts pins that list to
  // the page files in both directions), so what arrives is the right SHAPE of
  // object with every value a string — which is exactly what `searchParams` hands a
  // route anyway.
  const Component = View as (props: { params: Record<string, string> }) => Promise<React.ReactElement>;

  const tabId = scope && "tabId" in scope ? scope.tabId : pane.id;
  const side = scope && "pane" in scope ? scope.pane : undefined;
  // Every client control inside the body writes the URL through this provider, so
  // "clear filters" in a tab clears THAT tab's params in the /w URL rather than
  // pushing bare keys at the workspace route. See lib/pane-url.ts.
  return (
    <PaneUrlProvider path={pane.path} params={pane.params} tabId={tabId} pane={side}>
      <Component params={pane.params} />
    </PaneUrlProvider>
  );
}
