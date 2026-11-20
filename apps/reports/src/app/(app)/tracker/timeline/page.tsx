import Link from "next/link";
import { notFound } from "next/navigation";
import { PAGE_SHELL } from "@/components/ui/classnames";
import { PageTitle } from "@/components/ui/Typography";
import { requirePagePermission } from "@/lib/require-permission";
import { trackerConfigured, trackerDb } from "@/modules/tracker/db";
import { syncDepartmentsFromOrg, trackerActor } from "@/modules/tracker/current-actor";
import { getPortfolioTimeline } from "@/modules/tracker/service/timeline";
import { departmentScope, listDepartments } from "@/modules/tracker/service/departments";
import { DepartmentFilter } from "@/modules/tracker/components/DepartmentPicker";
import { departmentView } from "@/modules/tracker/components/format";
import { Timeline } from "@/modules/tracker/components/Timeline";

// Every open project on one timeline, at /tracker/timeline. "TIMELINE" is a reserved project
// key (service/projects.ts) so this page can never be shadowed by a project's board.
export default async function TrackerPortfolioTimelinePage({
  searchParams,
}: {
  searchParams: Promise<{
    for?: string | string[];
    group?: string | string[];
    closed?: string | string[];
    done?: string | string[];
  }>;
}) {
  const session = await requirePagePermission("tracker:view");
  if (!trackerConfigured()) notFound();
  // The same two choices as the project list, read from the address the same way.
  const params = await searchParams;
  const view = departmentView(params);
  const finished = (Array.isArray(params.done) ? params.done[0] : params.done) === "1";
  await syncDepartmentsFromOrg();
  const departments = await listDepartments(trackerDb);
  const chosen = departments.find((d) => d.id === view.forId) ?? null;
  const timeline = await getPortfolioTimeline(trackerDb, await trackerActor(session), {
    scope: chosen ? departmentScope(departments, chosen.id) : null,
    grouped: view.grouped,
    lens: view.lens,
    level: view.level,
    finished,
  });
  // ?closed=-3,-7: the departments whose projects are hidden. A department's row has a negative id.
  const closed = (Array.isArray(params.closed) ? params.closed.join(",") : (params.closed ?? ""))
    .split(",")
    .map(Number)
    .filter((n) => Number.isInteger(n) && n < 0);
  const address = (ids: number[]) => {
    const query = new URLSearchParams();
    if (chosen) query.set("for", String(chosen.id));
    if (view.grouped) query.set("group", view.level === "team" ? "team" : "1");
    if (view.lens === "by") query.set("dept", "by");
    if (finished) query.set("done", "1");
    if (ids.length) query.set("closed", ids.join(","));
    const text = query.toString();
    return text ? `/tracker/timeline?${text}` : "/tracker/timeline";
  };

  return (
    <div className={PAGE_SHELL}>
      <p className="mb-1 text-sm">
        <Link href="/tracker" className="text-sdc-blue hover:underline">
          Project Tracker
        </Link>
        <span className="text-sdc-gray-400"> / </span>
        <span className="text-sdc-gray-600">Timeline</span>
      </p>
      <PageTitle className="mb-3">Timeline of all projects</PageTitle>
      <p className="mb-3 text-sm">
        <Link
          href={(() => {
            const query = new URLSearchParams();
            if (chosen) query.set("for", String(chosen.id));
            if (view.grouped) query.set("group", view.level === "team" ? "team" : "1");
            if (view.lens === "by") query.set("dept", "by");
            if (!finished) query.set("done", "1");
            const text = query.toString();
            return text ? `/tracker/timeline?${text}` : "/tracker/timeline";
          })()}
          scroll={false}
          className="font-semibold text-sdc-blue hover:underline"
        >
          {finished ? "Hide finished projects" : "Show finished projects"}
        </Link>
      </p>
      <div className="mb-4">
        <DepartmentFilter
          departments={departments}
          selected={chosen?.id ?? null}
          grouped={view.grouped}
          lens={view.lens}
          level={view.level}
        />
      </div>
      <Timeline
        timeline={timeline}
        closed={closed}
        toggleHref={view.grouped ? address : undefined}
        hrefFor={(row) => `/tracker/${row.key}/timeline`}
        emptyText={chosen ? `No open project is for ${chosen.name}.` : "There are no open projects to show."}
        of="projects"
        finished={finished}
      />
    </div>
  );
}
