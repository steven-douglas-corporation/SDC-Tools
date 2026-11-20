import Link from "next/link";
import { PAGE_SHELL } from "@/components/ui/classnames";
import { PageTitle } from "@/components/ui/Typography";
import { EmptyState } from "@/components/ui/EmptyState";
import { requirePagePermission } from "@/lib/require-permission";
import { hasPermission } from "@/lib/permissions";
import { trackerConfigured, trackerDb } from "@/modules/tracker/db";
import { syncDepartmentsFromOrg, trackerActor } from "@/modules/tracker/current-actor";
import { departmentScope, listDepartments } from "@/modules/tracker/service/departments";
import { DepartmentFilter } from "@/modules/tracker/components/DepartmentPicker";
import { byDepartment, departmentView, projectsFor } from "@/modules/tracker/components/format";
import { listProjects, listValueBuckets } from "@/modules/tracker/service/queries";
import { ProjectList } from "@/modules/tracker/components/ProjectList";
import { PortfolioSummary } from "@/modules/tracker/components/PortfolioSummary";

// The Project Tracker's front page. This file is deliberately thin (docs/MODULES.md): it checks
// the app permission, works out who is asking, and hands the module's own data to the module's
// own component. Everything else lives in src/modules/tracker.
export default async function TrackerPage({
  searchParams,
}: {
  searchParams: Promise<{ for?: string | string[]; group?: string | string[] }>;
}) {
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
  const everyProject = await listProjects(trackerDb, actor);
  const valueBuckets = await listValueBuckets(trackerDb);
  // The departments are the company's own, copied from the roster before they are offered.
  await syncDepartmentsFromOrg();
  const departments = await listDepartments(trackerDb);

  // ?for=12&group=1: which department's projects, and whether under a heading each. The
  // figures above the table are of the projects shown, so they follow the filter.
  const view = departmentView(await searchParams);
  const chosen = departments.find((d) => d.id === view.forId) ?? null;
  const shown = projectsFor(everyProject, chosen ? departmentScope(departments, chosen.id) : null);
  const projects = view.grouped ? byDepartment(shown) : shown;
  const partial = chosen != null || view.grouped;
  const withinDepartment = view.grouped && chosen == null;

  return (
    <div className={PAGE_SHELL}>
      <PageTitle className="mb-1">Project Tracker</PageTitle>
      <p className="mb-4 max-w-3xl text-sm text-sdc-gray-600">
        Projects in stack-rank order. <strong>Forecast</strong> is when the work is expected to finish;{" "}
        <strong>Safe date</strong> allows for work running over, and is the one to promise.{" "}
        <Link href="/tracker/people" className="font-semibold text-sdc-blue hover:underline">
          People and time
        </Link>{" "}
        sets each person&apos;s hours, time off and the company holidays.
      </p>
      <div className="mb-4">
        <DepartmentFilter departments={departments} selected={chosen?.id ?? null} grouped={view.grouped} />
      </div>
      <PortfolioSummary projects={projects} />
      <ProjectList
        projects={projects}
        valueBuckets={valueBuckets}
        departments={departments}
        grouped={view.grouped}
        canEdit={hasPermission(session.user.role, "tracker:edit")}
        // A rank is a place among every project, so it is only changed with all of them in
        // view and in rank order.
        //
        // Grouped with every department in view, a project is moved among its own
        // department's projects instead: they trade the ranks that department already holds.
        canRank={actor.admin === true && (!partial || withinDepartment)}
        rankWithinDepartment={withinDepartment}
        rankNote={
          actor.admin !== true || !partial
            ? undefined
            : withinDepartment
              ? "Grouped, the arrows move a project among its own department's projects. There is still one company rank: to set a project against another department's, ungroup the list."
              : "Ranks are shown, not changed, while the list is filtered. Show all departments to change them."
        }
      />
    </div>
  );
}
