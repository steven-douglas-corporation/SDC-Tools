import Link from "next/link";
import { notFound } from "next/navigation";
import { PAGE_SHELL } from "@/components/ui/classnames";
import { PageTitle } from "@/components/ui/Typography";
import { requirePagePermission } from "@/lib/require-permission";
import { hasPermission } from "@/lib/permissions";
import { trackerConfigured, trackerDb } from "@/modules/tracker/db";
import { syncPeopleFromUsers, trackerActor } from "@/modules/tracker/current-actor";
import { getCapacityOverview } from "@/modules/tracker/service/people";
import { Capacity } from "@/modules/tracker/components/Capacity";

// People and their time, as the forecast sees them. "PEOPLE" is a reserved project key
// (service/projects.ts) so this page can never be shadowed by a project's board.
export default async function TrackerPeoplePage() {
  const session = await requirePagePermission("tracker:view");
  if (!trackerConfigured()) notFound();
  const actor = await trackerActor(session);
  await syncPeopleFromUsers();
  const overview = await getCapacityOverview(trackerDb, actor);

  return (
    <div className={PAGE_SHELL}>
      <p className="mb-1 text-sm">
        <Link href="/tracker" className="text-sdc-blue hover:underline">
          Project Tracker
        </Link>
        <span className="text-sdc-gray-400"> / </span>
        <span className="text-sdc-gray-600">People and time</span>
      </p>
      <PageTitle className="mb-1">People and time</PageTitle>
      <p className="mb-4 max-w-3xl text-sm text-sdc-gray-600">
        The forecast books each task against its assignee&apos;s free hours, day by day. This page is where those hours
        come from: the length of a normal project day, anyone whose day is shorter, time off, and company holidays.
      </p>
      {/* Backlog M-15: replace typing with a daily import from Paylocity. */}
      <p className="mb-4 max-w-3xl text-sm text-sdc-gray-600">
        Time off is typed in here for now. The plan is to bring approved time off in from Paylocity, so nobody enters it
        twice.
      </p>
      <Capacity
        // Remount after a change so each field shows the saved value, not what was typed.
        key={JSON.stringify([
          overview.globalHoursPerDay,
          overview.people.map((p) => [p.ownHoursPerDay, p.timeOff.length]),
        ])}
        overview={overview}
        canEdit={hasPermission(session.user.role, "tracker:edit")}
      />
    </div>
  );
}
