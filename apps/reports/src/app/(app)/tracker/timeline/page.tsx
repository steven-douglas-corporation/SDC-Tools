import Link from "next/link";
import { notFound } from "next/navigation";
import { PAGE_SHELL } from "@/components/ui/classnames";
import { PageTitle } from "@/components/ui/Typography";
import { requirePagePermission } from "@/lib/require-permission";
import { trackerConfigured, trackerDb } from "@/modules/tracker/db";
import { trackerActor } from "@/modules/tracker/current-actor";
import { getPortfolioTimeline } from "@/modules/tracker/service/timeline";
import { Timeline } from "@/modules/tracker/components/Timeline";
import { PortfolioViews } from "@/modules/tracker/components/ProjectViews";

// Every open project on one timeline, at /tracker/timeline. "TIMELINE" is a reserved project
// key (service/projects.ts) so this page can never be shadowed by a project's board.
export default async function TrackerPortfolioTimelinePage() {
  const session = await requirePagePermission("tracker:view");
  if (!trackerConfigured()) notFound();
  const timeline = await getPortfolioTimeline(trackerDb, await trackerActor(session));

  return (
    <div className={PAGE_SHELL}>
      <p className="mb-1 text-sm">
        <Link href="/tracker" className="text-sdc-blue hover:underline">
          Project Tracker
        </Link>
        <span className="text-sdc-gray-400"> / </span>
        <span className="text-sdc-gray-600">Timeline</span>
      </p>
      <PageTitle className="mb-3">Project Tracker</PageTitle>
      <PortfolioViews current="timeline" />
      <Timeline
        timeline={timeline}
        hrefFor={(row) => `/tracker/${row.key}/timeline`}
        emptyText="There are no open projects to show."
        legend={
          <p className="text-xs text-sdc-gray-600">
            One row for each open project, in stack-rank order. A bar runs from the first forecast start of its work to
            its forecast finish, with a paler tail out to its P80 when a simulation has run. The small upright line is
            the project&apos;s target date, red when the forecast is later. An arrow runs from a project to a project
            that has a card waiting on one of its cards. Click a project&apos;s key for its own timeline.
          </p>
        }
      />
    </div>
  );
}
