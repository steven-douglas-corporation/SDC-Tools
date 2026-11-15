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
export default async function TrackerTimelinePage({ params }: { params: Promise<{ key: string }> }) {
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

  return (
    <div className={PAGE_SHELL}>
      <p className="mb-1 text-sm">
        <Link href="/tracker" className="text-sdc-blue hover:underline">
          Project Tracker
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
      <Timeline timeline={timeline} targetDate={p.targetDate} />
    </div>
  );
}
