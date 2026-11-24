import Link from "next/link";
import { notFound } from "next/navigation";
import { PAGE_SHELL } from "@/components/ui/classnames";
import { PageTitle } from "@/components/ui/Typography";
import { requirePagePermission } from "@/lib/require-permission";
import { trackerConfigured, trackerDb } from "@/modules/tracker/db";
import { syncDepartmentsFromOrg, trackerActor } from "@/modules/tracker/current-actor";
import { getPortfolioTimeline } from "@/modules/tracker/service/timeline";
import { departmentsScope, listDepartments } from "@/modules/tracker/service/departments";
import { DepartmentFilter } from "@/modules/tracker/components/DepartmentPicker";
import { departmentView, groupingOf } from "@/modules/tracker/components/format";
import { Timeline, type TimelineScale } from "@/modules/tracker/components/Timeline";
import { DueDateTimeline } from "@/modules/tracker/components/DueDateTimeline";
import { TrackerTabs } from "@/modules/tracker/components/TrackerTabs";

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
    scale?: string | string[];
    mode?: string | string[];
  }>;
}) {
  const session = await requirePagePermission("tracker:view");
  if (!trackerConfigured()) notFound();
  // The same two choices as the project list, read from the address the same way.
  const params = await searchParams;
  const view = departmentView(params);
  const finished = (Array.isArray(params.done) ? params.done[0] : params.done) === "1";
  const scaleParam = Array.isArray(params.scale) ? params.scale[0] : params.scale;
  const scale: TimelineScale = scaleParam === "quarter" || scaleParam === "year" ? scaleParam : "fit";
  // "bars" is the Gantt-style view; "dates" is the by-completion-date view.
  const mode: "bars" | "dates" = (Array.isArray(params.mode) ? params.mode[0] : params.mode) === "dates" ? "dates" : "bars";
  await syncDepartmentsFromOrg();
  const departments = await listDepartments(trackerDb);
  const filtered = view.forIds.length > 0 || view.byIds.length > 0;
  const timeline = await getPortfolioTimeline(trackerDb, await trackerActor(session), {
    scope: departmentsScope(departments, view.forIds),
    byScope: departmentsScope(departments, view.byIds),
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
  // The department choices, written into an address the same way wherever one is built here.
  const setDepartments = (query: URLSearchParams) => {
    if (view.forIds.length) query.set("for", view.forIds.join(","));
    if (view.byIds.length) query.set("by", view.byIds.join(","));
    if (view.grouped) query.set("group", groupingOf(view));
  };
  // Every link here keeps the current zoom, departments, grouping and collapsed state, changing
  // only the one thing it is for.
  const build = (opts: { closed?: number[]; scale?: TimelineScale; mode?: "bars" | "dates" } = {}) => {
    const query = new URLSearchParams();
    setDepartments(query);
    if (finished) query.set("done", "1");
    const c = opts.closed ?? closed;
    if (c.length) query.set("closed", c.join(","));
    const s = opts.scale ?? scale;
    if (s !== "fit") query.set("scale", s);
    const m = opts.mode ?? mode;
    if (m !== "bars") query.set("mode", m);
    const text = query.toString();
    return text ? `/tracker/timeline?${text}` : "/tracker/timeline";
  };
  const address = (ids: number[]) => build({ closed: ids });
  const scaleHref = (s: TimelineScale) => build({ scale: s });
  const modeHref = (m: "bars" | "dates") => build({ mode: m });

  return (
    <div className={PAGE_SHELL}>
      <PageTitle className="mb-1">Internal Projects</PageTitle>
      <TrackerTabs active="timeline" />
      <div className="mb-3 inline-flex overflow-hidden rounded-md border border-sdc-border text-sm">
        {(
          [
            ["bars", "Bars"],
            ["dates", "Due dates"],
          ] as const
        ).map(([m, lbl]) => (
          <Link
            key={m}
            href={modeHref(m)}
            scroll={false}
            aria-current={mode === m ? "true" : undefined}
            className={`px-3 py-1.5 font-semibold ${
              mode === m ? "bg-sdc-blue text-white" : "bg-white text-sdc-navy hover:bg-sdc-gray-100"
            }`}
          >
            {lbl}
          </Link>
        ))}
      </div>
      <p className="mb-3 text-sm">
        <Link
          href={(() => {
            const query = new URLSearchParams();
            setDepartments(query);
            if (!finished) query.set("done", "1");
            if (scale !== "fit") query.set("scale", scale);
            if (mode !== "bars") query.set("mode", mode);
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
          forIds={view.forIds}
          byIds={view.byIds}
          grouping={groupingOf(view)}
        />
      </div>
      {mode === "dates" ? (
        <DueDateTimeline
          timeline={timeline}
          scale={scale}
          scaleHref={scaleHref}
          emptyText={filtered ? "No project with a date fits the departments chosen." : "No project has a date to show yet."}
        />
      ) : (
        <Timeline
          timeline={timeline}
          closed={closed}
          toggleHref={view.grouped ? address : undefined}
          hrefFor={(row) => `/tracker/${row.key}/timeline`}
          emptyText={filtered ? "No open project fits the departments chosen." : "There are no open projects to show."}
          of="projects"
          finished={finished}
          scale={scale}
          scaleHref={scaleHref}
        />
      )}
    </div>
  );
}
