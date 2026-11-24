import Link from "next/link";
import { PAGE_SHELL } from "@/components/ui/classnames";
import { PageTitle } from "@/components/ui/Typography";
import { EmptyState } from "@/components/ui/EmptyState";
import { requirePagePermission } from "@/lib/require-permission";
import { hasPermission } from "@/lib/permissions";
import { trackerConfigured, trackerDb } from "@/modules/tracker/db";
import { syncDepartmentsFromOrg, trackerActor } from "@/modules/tracker/current-actor";
import { departmentsScope, listDepartments } from "@/modules/tracker/service/departments";
import { ProjectListControls } from "@/modules/tracker/components/DepartmentPicker";
import {
  ONLY_LABEL,
  assigneeFilterOptions,
  groupingOf,
  inDepartments,
  isIncomplete,
  isOpen,
  listHref,
  listView,
  narrowProjects,
  ranksLocked,
  valueFilterOptions,
} from "@/modules/tracker/components/format";
import { listProjects, throughLens } from "@/modules/tracker/service/queries";
import { ProjectList } from "@/modules/tracker/components/ProjectList";
import { PortfolioSummary } from "@/modules/tracker/components/PortfolioSummary";
import { TrackerTabs } from "@/modules/tracker/components/TrackerTabs";

// The Internal Projects's front page. This file is deliberately thin (docs/MODULES.md): it checks
// the app permission, works out who is asking, and hands the module's own data to the module's
// own component. Everything else lives in src/modules/tracker.
export default async function TrackerPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requirePagePermission("tracker:view");

  if (!trackerConfigured()) {
    return (
      <div className={PAGE_SHELL}>
        <PageTitle className="mb-4">Internal Projects</PageTitle>
        <EmptyState
          tone="warning"
          title="The Internal Projects is not set up on this server"
          message="It keeps its data in PostgreSQL, and TRACKER_DATABASE_URL is not set. Nothing is wrong with your account."
        />
      </div>
    );
  }

  const actor = await trackerActor(session);
  // Everything about how the list is narrowed and ordered is in the address (see listView), so
  // the page is drawn on the server with figures to match and any view can be sent to someone.
  const view = listView(await searchParams);
  // The departments are the company's own, copied from the roster before they are offered.
  await syncDepartmentsFromOrg();
  const departments = await listDepartments(trackerDb);
  // Filtered on the two departments as they are, then looked at through the grouping, which
  // decides which of the two a row sits under.
  // The full list before any filter: the forecast's view of every project the person can see. The
  // column filters' choices (which value ranges, which assignees) are drawn from it, so they never
  // offer something no project has, and never drop an option just because another filter hid its row.
  const allProjects = await listProjects(trackerDb, actor);
  const valueOptions = valueFilterOptions(allProjects);
  const assigneeOptions = assigneeFilterOptions(allProjects);
  const everyProject = throughLens(
    inDepartments(allProjects, departmentsScope(departments, view.forIds), departmentsScope(departments, view.byIds)),
    view.lens,
    view.grouped ? view.level : "group",
  );
  // `described` is what the figures describe; `projects` is that, narrowed to a chosen figure,
  // sorted and grouped. Choosing a figure does not change the figures.
  const { described, shown: projects } = narrowProjects(everyProject, view, null);
  const locked = ranksLocked(view);
  const withinDepartment = view.grouped && !locked;
  const incomplete = described.filter((p) => isOpen(p) && isIncomplete(p)).length;

  return (
    <div className={PAGE_SHELL}>
      <PageTitle className="mb-1">Internal Projects</PageTitle>
      <TrackerTabs active="projects" />
      <p className="mb-4 max-w-3xl text-sm text-sdc-gray-600">
        Projects in stack-rank order. <strong>Forecast</strong> is when the work is expected to finish;{" "}
        <strong>Safe date</strong> allows for work running over, and is the one to promise.{" "}
        <Link href="/tracker/people" className="font-semibold text-sdc-blue hover:underline">
          People and time
        </Link>{" "}
        sets each person&apos;s hours, time off and the company holidays.
      </p>
      <div className="mb-4">
        <ProjectListControls grouping={groupingOf(view)} />
      </div>
      <PortfolioSummary projects={described} only={view.only} hrefFor={(only) => listHref(view, { only })} />

      {/* What is missing, said once and with a way to see which: every project is asked for a
          justification, a value and a department, and the ones made before that have none. */}
      {incomplete > 0 && view.only !== "incomplete" && (
        <p className="mb-4 rounded-lg border border-sdc-border bg-sdc-yellow-bg px-3 py-2 text-sm text-sdc-yellow-text">
          {incomplete} open project{incomplete === 1 ? " is" : "s are"} missing a justification, a value or a
          department, and cannot be made active without them.{" "}
          <Link
            href={listHref(view, { only: "incomplete" })}
            scroll={false}
            className="font-semibold underline hover:no-underline"
          >
            Show {incomplete === 1 ? "it" : "them"}
          </Link>
        </p>
      )}
      {view.only && (
        <p className="mb-3 text-sm text-sdc-navy">
          Showing only <strong>{ONLY_LABEL[view.only]}</strong>.{" "}
          <Link
            href={listHref(view, { only: null })}
            scroll={false}
            className="font-semibold text-sdc-blue hover:underline"
          >
            Show all
          </Link>
        </p>
      )}

      <ProjectList
        projects={projects}
        view={view}
        departments={departments}
        valueOptions={valueOptions}
        assigneeOptions={assigneeOptions}
        grouped={view.grouped}
        // No project at all is a different thing from none matching, and is said differently.
        narrowed={everyProject.length > 0}
        clearHref="/tracker"
        canEdit={hasPermission(session.user.role, "tracker:edit")}
        // A rank is a place among every project, so it is only changed with all of them in
        // view and in rank order.
        //
        // Grouped with every department in view, a project is moved among its own
        // department's projects instead: they trade the ranks that department already holds.
        canRank={actor.admin === true && !locked}
        rankWithinDepartment={withinDepartment}
        rankNote={
          actor.admin !== true
            ? undefined
            : locked
              ? "Ranks are shown, not changed, while the list is filtered, searched or sorted. Show every project in rank order to change them."
              : withinDepartment
                ? "Grouped, a project is moved among its own department's projects. There is still one company rank: to set a project against another department's, ungroup the list."
                : undefined
        }
      />
    </div>
  );
}
