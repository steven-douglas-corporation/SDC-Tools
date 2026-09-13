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
import { EmptyState } from "@/components/ui/EmptyState";
import type { PaneState } from "@/lib/split-view";

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
// Deliberately NOT re-checked here. Every view begins with its own
// `requirePagePermission(...)` (or `requireEltOnly()`), which is the same server
// call it makes as a route, and it runs on the server whether the view is reached
// as a route or as a pane. So a user without monthly-etc:view who hand-crafts
// `/split?r=/etc` gets that permission's own redirect from inside the view — the
// restriction cannot be bypassed by opening a page in the second pane, because the
// second pane runs the identical server-enforced check.
//
// Adding a check here as well would be worse than redundant: this component does
// not know which permission each path needs without a second copy of that mapping,
// and a second copy is how a route ends up gated in one place and not the other.

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
} as const;

export function isPaneRoute(path: string): path is keyof typeof PANE_VIEWS {
  return path in PANE_VIEWS;
}

export async function PaneView({ pane }: { pane: PaneState }) {
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

  const View = PANE_VIEWS[pane.path];
  // `params` is typed per view, and each view's own params type is narrower than
  // the string record a URL produces. The cast is at this one boundary rather than
  // spread across twelve call sites: `readPaneParams` has already filtered the keys
  // to the ones the route declares (and tests/split-view.test.ts pins that list to
  // the page files in both directions), so what arrives is the right SHAPE of
  // object with every value a string — which is exactly what `searchParams` hands a
  // route anyway.
  const Component = View as (props: { params: Record<string, string> }) => Promise<React.ReactElement>;
  return <Component params={pane.params} />;
}
