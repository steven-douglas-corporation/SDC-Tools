import Link from "next/link";
import { notFound } from "next/navigation";
import { PAGE_SHELL } from "@/components/ui/classnames";
import { PageTitle } from "@/components/ui/Typography";
import { requirePagePermission } from "@/lib/require-permission";
import { hasPermission } from "@/lib/permissions";
import { trackerConfigured, trackerDb } from "@/modules/tracker/db";
import { syncDepartmentsFromOrg, syncPeopleFromUsers, trackerActor } from "@/modules/tracker/current-actor";
import { listDepartments } from "@/modules/tracker/service/departments";
import { TrackerError } from "@/modules/tracker/service/database";
import { getBoard, listValueBuckets, type Board as BoardData } from "@/modules/tracker/service/queries";
import { listMembers } from "@/modules/tracker/service/people";
import type { ProjectState } from "@/modules/tracker/service/projects";
import { Members } from "@/modules/tracker/components/Members";
import { ProjectSettings } from "@/modules/tracker/components/ProjectSettings";
import { ProjectViews } from "@/modules/tracker/components/ProjectViews";

// One project's settings, at /tracker/BIN/settings: why it is being done and what it is worth,
// who it is for, when it is due, who owns it, where it stands, and who is on it. A tab beside
// Board and Timeline, so it is one click from either and exists once.
//
// Anyone on the project can read it. Only a manager can change anything; for everyone else the
// same form is shown with its fields locked, since "who owns this, and who is on it" is worth
// knowing whatever your role.
export default async function TrackerProjectSettingsPage({ params }: { params: Promise<{ key: string }> }) {
  const session = await requirePagePermission("tracker:view");
  if (!trackerConfigured()) notFound();
  const { key } = await params;

  const actor = await trackerActor(session);
  // The owner and the people who can be added are picked from everyone with an account here.
  await syncPeopleFromUsers();

  let board: BoardData;
  try {
    board = await getBoard(trackerDb, actor, key);
  } catch (e) {
    // "No such project" and "not one of yours" look the same from outside, on purpose.
    if (e instanceof TrackerError && e.code === "not_found") notFound();
    throw e;
  }
  const p = board.project;
  const members = await listMembers(trackerDb, actor, p.id);
  const valueBuckets = await listValueBuckets(trackerDb);
  await syncDepartmentsFromOrg();
  const departments = await listDepartments(trackerDb);
  const canManage = hasPermission(session.user.role, "tracker:edit") && p.myRole === "manager";

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
        <span className="text-sdc-gray-600">Settings</span>
      </p>
      <PageTitle className="mb-3">{p.name}</PageTitle>
      <ProjectViews projectKey={p.key} current="settings" />

      {!canManage && <p className="mb-3 text-sm text-sdc-gray-600">Only a manager of this project can change these.</p>}
      <div className="max-w-5xl space-y-4">
        <ProjectSettings
          projectId={p.id}
          projectKey={p.key}
          name={p.name}
          justification={p.justification}
          valueBucketId={p.valueBucketId}
          valueBuckets={valueBuckets}
          forDepartmentId={p.forDepartmentId}
          doneByDepartmentId={p.doneByDepartmentId}
          departments={departments}
          targetDate={p.targetDate}
          startDate={p.startDate}
          ownerPersonId={p.ownerPersonId}
          state={p.state as ProjectState}
          openCards={p.taskCount - p.doneCount}
          people={board.people}
          readOnly={!canManage}
        />
        <Members
          projectId={p.id}
          projectKey={p.key}
          members={members}
          people={board.people}
          canManage={canManage}
          open
        />
      </div>
    </div>
  );
}
