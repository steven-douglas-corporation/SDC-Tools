import Link from "next/link";
import { notFound } from "next/navigation";
import { PAGE_SHELL } from "@/components/ui/classnames";
import { PageTitle } from "@/components/ui/Typography";
import { requirePagePermission } from "@/lib/require-permission";
import { hasPermission } from "@/lib/permissions";
import { trackerConfigured, trackerDb } from "@/modules/tracker/db";
import { syncPeopleFromUsers, trackerActor } from "@/modules/tracker/current-actor";
import { TrackerError } from "@/modules/tracker/service/database";
import { getBoard, type Board as BoardData } from "@/modules/tracker/service/queries";
import { listMembers } from "@/modules/tracker/service/people";
import { Board } from "@/modules/tracker/components/Board";
import { Members } from "@/modules/tracker/components/Members";
import { hours, shortDate } from "@/modules/tracker/components/format";

// One project's board. Thin on purpose, like ../page.tsx: permission, who is asking, the
// module's data, the module's component.
export default async function TrackerBoardPage({ params }: { params: Promise<{ key: string }> }) {
  const session = await requirePagePermission("tracker:view");
  if (!trackerConfigured()) notFound();
  const { key } = await params;

  const actor = await trackerActor(session);
  // So anyone with an account here can be picked as an assignee, whether or not they have
  // opened the tracker themselves.
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
  const canEdit = hasPermission(session.user.role, "tracker:edit");

  const state = p.state.replace("_", " ");
  const facts: [string, string][] = [
    ["State", state.charAt(0).toUpperCase() + state.slice(1)],
    ["Stack rank", p.portfolioRank?.toString() ?? "none"],
    ["Target", shortDate(p.targetDate)],
    ["Forecast", shortDate(p.forecastFinish)],
    ["P80", shortDate(p.p80Finish)],
    ["Hours left", hours(p.remainingHours)],
    ["Done", `${p.doneCount} of ${p.taskCount}`],
  ];

  return (
    <div className={PAGE_SHELL}>
      <p className="mb-1 text-sm">
        <Link href="/tracker" className="text-sdc-blue hover:underline">
          Project Tracker
        </Link>
        <span className="text-sdc-gray-400"> / </span>
        <span className="text-sdc-gray-600">{p.key}</span>
      </p>
      <PageTitle className="mb-3">{p.name}</PageTitle>

      <dl className="mb-3 flex flex-wrap gap-x-6 gap-y-2 text-sm">
        {facts.map(([label, value]) => (
          <div key={label}>
            <dt className="text-xs uppercase tracking-wider text-sdc-gray-600">{label}</dt>
            <dd className="font-semibold text-sdc-navy">{value}</dd>
          </div>
        ))}
        {p.atRisk != null && (
          <div>
            <dt className="text-xs uppercase tracking-wider text-sdc-gray-600">Against target</dt>
            <dd className={`font-semibold ${p.atRisk ? "text-sdc-red-text" : "text-sdc-green-text"}`}>
              {p.atRisk ? "At risk" : "On track"}
              <span className="font-normal text-sdc-gray-600"> (by {p.atRiskBasis})</span>
            </dd>
          </div>
        )}
      </dl>

      {p.portfolioRank == null || p.state !== "active" ? (
        <p className="mb-4 rounded-lg border border-sdc-border bg-sdc-yellow-bg px-3 py-2 text-sm text-sdc-yellow-text">
          {p.portfolioRank == null
            ? "This project has no stack rank yet, so its work is not forecast. The portfolio owner sets the rank on the Project Tracker page."
            : `This project is ${p.state.replace("_", " ")}. Make it active on the Project Tracker page when work starts.`}
        </p>
      ) : (
        (p.unscheduledTasks > 0 || p.staleTasks > 0) && (
          <p className="mb-4 rounded-lg border border-sdc-border bg-sdc-yellow-bg px-3 py-2 text-sm text-sdc-yellow-text">
            The forecast above leaves out {p.unscheduledTasks} task{p.unscheduledTasks === 1 ? "" : "s"}
            {p.unestimatedTasks > 0 ? ` (${p.unestimatedTasks} with no estimate)` : ""}
            {p.staleTasks > 0
              ? `, and ${p.staleTasks} task${p.staleTasks === 1 ? " has" : "s have"} hours left that nobody has confirmed lately`
              : ""}
            . Each card says why.
          </p>
        )
      )}

      <Board board={board} canEdit={canEdit} />

      <div className="mt-4">
        <Members
          projectId={p.id}
          projectKey={p.key}
          members={members}
          people={board.people}
          canManage={canEdit && p.myRole === "manager"}
        />
      </div>

      {board.forecastAsOf && (
        <p className="mt-3 text-xs text-sdc-gray-600">Forecast made for {shortDate(board.forecastAsOf)}.</p>
      )}
    </div>
  );
}
