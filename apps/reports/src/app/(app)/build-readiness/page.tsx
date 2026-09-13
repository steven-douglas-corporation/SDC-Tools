import { PageTitle } from "@/components/ui/Typography";
import { PAGE_SHELL } from "@/components/ui/classnames";
import { getBuildReadinessData, triggerBuildReadinessRefresh } from "@/lib/build-readiness-actions";
import { listBuildReadinessViews } from "@/lib/build-readiness-views-actions";
import { BuildReadinessDashboard } from "@/components/build-readiness/BuildReadinessDashboard";
import { requirePagePermission } from "@/lib/require-permission";

// "Build Readiness" — cross-project view of what can actually be built right
// now, across every active billable job, backed by the exact same
// getJobBom()/job-bom-rules.ts readiness logic Job Hour Details -> Procurement
// already uses (see build-readiness-sync.ts's own header). Numbers here are
// never a second formula — a job's readiness % is only ever as current as its
// last live Build Readiness pass, same as Procurement is only as current as
// the page load that fetched it.
//
// The page itself kicks off a live refresh on first load if the cached
// snapshot is missing or stale (see triggerBuildReadinessRefresh) — the
// client then polls for progress. This starts it BEFORE the first paint so a
// cold cache doesn't wait an extra client round-trip to begin.
export async function BuildReadinessView() {
  await requirePagePermission("build-readiness:view");
  await triggerBuildReadinessRefresh(false);
  const [data, views] = await Promise.all([getBuildReadinessData(), listBuildReadinessViews()]);

  return (
    // `w-full p-8` — the same outer-wrapper padding etc/page.tsx and the other Reports
    // tabs already carry (see job-cost-explorer/page.tsx's note): AppShell's <main> has
    // no padding of its own by design, so every page supplies its own breathing room.
    // This page simply hadn't, which is why it sat flush against the sidebar.
    <div className={PAGE_SHELL}>
      <div className="flex flex-col gap-4">
        <PageTitle>Build Readiness</PageTitle>
        <p className="-mt-2 text-note text-sdc-gray-400">
          What can be built right now, what&apos;s blocked and why, and what upcoming deliveries unlock next — across every active billable project.
        </p>
        <BuildReadinessDashboard initialData={data} initialViews={views} />
      </div>
    </div>
  );
}


// -- Route entry point --
//
// The page's body lives in `BuildReadinessView` above so that BOTH this route and the split
// view can render it. Split view renders two views in ONE document (see
// lib/split-view.ts for why one document rather than two frames), which means a
// pane cannot be a route and therefore cannot read `searchParams` - there is only
// one URL and two panes would collide in it. So the body takes its context as a
// plain argument, and the two callers differ only in where they read that context
// from: this wrapper reads the URL, a pane reads its own `l.`/`r.` namespace.
export default async function BuildReadinessPage() {
  return <BuildReadinessView />;
}
