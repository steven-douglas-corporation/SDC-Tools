import Link from "next/link";
import { notFound } from "next/navigation";
import { PAGE_SHELL } from "@/components/ui/classnames";
import { PageTitle } from "@/components/ui/Typography";
import { requirePagePermission } from "@/lib/require-permission";
import { hasPermission } from "@/lib/permissions";
import { trackerConfigured, trackerDb } from "@/modules/tracker/db";
import { trackerActor } from "@/modules/tracker/current-actor";
import { TrackerError } from "@/modules/tracker/service/database";
import { getTaskDetail, type TaskDetail } from "@/modules/tracker/service/task-detail";
import { TaskDetailView } from "@/modules/tracker/components/TaskDetailView";

// One task, at /tracker/BIN/42 for BIN-42. Thin, like the other tracker pages.
export default async function TrackerTaskPage({ params }: { params: Promise<{ key: string; number: string }> }) {
  const session = await requirePagePermission("tracker:view");
  if (!trackerConfigured()) notFound();
  const { key, number } = await params;
  if (!/^\d+$/.test(number)) notFound();

  const actor = await trackerActor(session);
  let task: TaskDetail;
  try {
    task = await getTaskDetail(trackerDb, actor, key, Number(number));
  } catch (e) {
    if (e instanceof TrackerError && e.code === "not_found") notFound();
    throw e;
  }

  return (
    <div className={PAGE_SHELL}>
      <p className="mb-1 text-sm">
        <Link href="/tracker" className="text-sdc-blue hover:underline">
          Project Tracker
        </Link>
        <span className="text-sdc-gray-400"> / </span>
        <Link href={`/tracker/${task.projectKey}`} className="text-sdc-blue hover:underline">
          {task.projectKey}
        </Link>
        {/* The cards this one sits under, top first, so the path reads Epic / Feature / Story. */}
        {task.ancestors.map((a) => (
          <span key={a.key}>
            <span className="text-sdc-gray-400"> / </span>
            <Link
              href={`/tracker/${task.projectKey}/${a.key.slice(a.key.lastIndexOf("-") + 1)}`}
              title={a.title}
              className="text-sdc-blue hover:underline"
            >
              {a.key}
            </Link>
          </span>
        ))}
        <span className="text-sdc-gray-400"> / </span>
        <span className="text-sdc-gray-600">{task.key}</span>
      </p>
      <PageTitle className="mb-4">
        <span className="font-mono text-sdc-gray-600">{task.key}</span> {task.title}
        <span className="ml-2 rounded-full bg-sdc-gray-100 px-2 py-0.5 align-middle text-xs font-bold uppercase text-sdc-gray-600">
          {task.kindLabel}
        </span>
        {task.archived && <span className="ml-2 text-sm font-normal text-sdc-gray-600">(archived)</span>}
      </PageTitle>
      {/* Keyed on the saved field values, so the form picks up what a save changed. A comment, a
          status move or a dependency changes none of them and leaves half-typed fields alone. */}
      <TaskDetailView
        key={JSON.stringify([
          task.title,
          task.description,
          task.kind,
          task.parentTaskId,
          task.assigneePersonId,
          task.requestedByPersonId,
          task.bucketId,
          task.remainingHours,
          task.priority,
          task.dueDate,
          task.estimatedCompletionDate,
          task.archived,
        ])}
        task={task}
        canEdit={hasPermission(session.user.role, "tracker:edit")}
      />
    </div>
  );
}
