import Link from "next/link";
import { PAGE_SHELL } from "@/components/ui/classnames";
import { PageTitle } from "@/components/ui/Typography";
import { EmptyState } from "@/components/ui/EmptyState";
import { requirePagePermission } from "@/lib/require-permission";
import { hasPermission } from "@/lib/permissions";
import { trackerConfigured, trackerDb } from "@/modules/tracker/db";
import { trackerActor } from "@/modules/tracker/current-actor";
import { listProjects } from "@/modules/tracker/service/queries";
import { ProjectList } from "@/modules/tracker/components/ProjectList";
import { PortfolioViews } from "@/modules/tracker/components/ProjectViews";

// The Project Tracker's front page. This file is deliberately thin (docs/MODULES.md): it checks
// the app permission, works out who is asking, and hands the module's own data to the module's
// own component. Everything else lives in src/modules/tracker.
export default async function TrackerPage() {
  const session = await requirePagePermission("tracker:view");

  if (!trackerConfigured()) {
    return (
      <div className={PAGE_SHELL}>
        <PageTitle className="mb-4">Project Tracker</PageTitle>
        <EmptyState
          tone="warning"
          title="The Project Tracker is not set up on this server"
          message="It keeps its data in PostgreSQL, and TRACKER_DATABASE_URL is not set. Nothing is wrong with your account."
        />
      </div>
    );
  }

  const actor = await trackerActor(session);
  const projects = await listProjects(trackerDb, actor);

  return (
    <div className={PAGE_SHELL}>
      <PageTitle className="mb-1">Project Tracker</PageTitle>
      <p className="mb-4 max-w-3xl text-sm text-sdc-gray-600">
        Projects in company priority order. <strong>Forecast</strong> is when the work is expected to finish, worked out
        from the hours left, who is assigned and what waits on what. It is shown beside the target, with the work it
        leaves out, so a date is never better than it looks.{" "}
        <Link href="/tracker/people" className="font-semibold text-sdc-blue hover:underline">
          People and time
        </Link>{" "}
        is where each person&apos;s hours, time off and the company holidays are set.
      </p>
      <PortfolioViews current="list" />
      <ProjectList
        projects={projects}
        canEdit={hasPermission(session.user.role, "tracker:edit")}
        canRank={actor.admin === true}
      />
    </div>
  );
}
