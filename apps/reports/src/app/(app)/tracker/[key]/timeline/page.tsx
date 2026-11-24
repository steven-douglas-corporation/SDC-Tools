import Link from "next/link";
import { notFound } from "next/navigation";
import { PAGE_SHELL } from "@/components/ui/classnames";
import { PageTitle } from "@/components/ui/Typography";
import { requirePagePermission } from "@/lib/require-permission";
import { trackerConfigured, trackerDb } from "@/modules/tracker/db";
import { trackerActor } from "@/modules/tracker/current-actor";
import { TrackerError } from "@/modules/tracker/service/database";
import { getTimeline, type Timeline as TimelineData } from "@/modules/tracker/service/timeline";
import { Timeline } from "@/modules/tracker/components/Timeline";
import { ProjectViews } from "@/modules/tracker/components/ProjectViews";

// One project's timeline, at /tracker/BIN/timeline. Read-only: cards are changed on the board
// or on their own page. Thin, like the other tracker pages.
export default async function TrackerTimelinePage({
  params,
  searchParams,
}: {
  params: Promise<{ key: string }>;
  searchParams: Promise<{ closed?: string | string[]; done?: string | string[] }>;
}) {
  const session = await requirePagePermission("tracker:view");
  if (!trackerConfigured()) notFound();
  const { key } = await params;

  let timeline: TimelineData;
  try {
    timeline = await getTimeline(trackerDb, await trackerActor(session), key);
  } catch (e) {
    // "No such project" and "not one of yours" look the same from outside, on purpose.
    if (e instanceof TrackerError && e.code === "not_found") notFound();
    throw e;
  }
  const p = timeline.project;
  // ?closed=12,40: the rows whose cards under them are hidden. In the address, so a collapsed
  // view can be bookmarked or sent to someone.
  const query = await searchParams;
  const asked = query.closed;
  const finished = (Array.isArray(query.done) ? query.done[0] : query.done) === "1";
  const address = (ids: number[], done = finished) => {
    const q = new URLSearchParams();
    if (done) q.set("done", "1");
    if (ids.length) q.set("closed", ids.join(","));
    const text = q.toString();
    return `/tracker/${p.key}/timeline${text ? `?${text}` : ""}`;
  };
  const closed = (Array.isArray(asked) ? asked.join(",") : (asked ?? ""))
    .split(",")
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);

  return (
    <div className={PAGE_SHELL}>
      <p className="mb-1 text-sm">
        <Link href="/tracker" className="text-sdc-blue hover:underline">
          Internal Projects
        </Link>
        <span className="text-sdc-gray-400"> / </span>
        <Link href={`/tracker/${p.key}`} className="text-sdc-blue hover:underline">
          {p.key}
        </Link>
        <span className="text-sdc-gray-400"> / </span>
        <span className="text-sdc-gray-600">Timeline</span>
      </p>
      <PageTitle className="mb-3">{p.name}</PageTitle>
      <ProjectViews projectKey={p.key} current="timeline" />
      <p className="mb-3 text-sm">
        <Link href={address(closed, !finished)} scroll={false} className="font-semibold text-sdc-blue hover:underline">
          {finished ? "Show recent work only" : "Show all finished work"}
        </Link>
      </p>
      <Timeline
        timeline={timeline}
        targetDate={p.targetDate}
        closed={closed}
        toggleHref={(ids) => address(ids)}
        finished={finished}
      />
    </div>
  );
}
