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
import { Board } from "@/modules/tracker/components/Board";
import { ProjectViews } from "@/modules/tracker/components/ProjectViews";
import { SafeDateHelp } from "@/modules/tracker/components/HelpTip";
import { STALE_HOURS, hours, shortDate } from "@/modules/tracker/components/format";

const plural = (label: string) => (label.endsWith("y") ? `${label.slice(0, -1)}ies` : `${label}s`);

// One project's board. Thin on purpose, like ../page.tsx: permission, who is asking, the
// module's data, the module's component. What a manager changes about the project, and who is
// on it, are on the Settings tab (./settings/page.tsx), not under the board.
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
  const canEdit = hasPermission(session.user.role, "tracker:edit");
  const settings = (
    <Link href={`/tracker/${p.key}/settings`} className="font-semibold text-sdc-blue hover:underline">
      Settings
    </Link>
  );

  const state = p.state.replace("_", " ");
  const facts: [string, string][] = [
    ["State", p.state === "completed" ? "Finished" : state.charAt(0).toUpperCase() + state.slice(1)],
    ["Owner", p.ownerName],
    ["For", p.forDepartmentName ?? "Not set"],
    ["Done by", p.doneByDepartmentName ?? "Not set"],
    ["Value", p.valueLabel ?? "Not set"],
    ["Stack rank", p.portfolioRank?.toString() ?? "none"],
    ["Target", shortDate(p.targetDate)],
    ["Forecast", shortDate(p.forecastFinish)],
    ["Safe date", shortDate(p.p80Finish)],
    ["Hours left", hours(p.remainingHours)],
    // Cards that carry work: a card with cards under it is not counted on top of them.
    ["Done", `${p.doneCount} of ${p.taskCount}`],
    // One figure per kind the project uses, so an Epic or a Feature is counted as what it is.
    // Left out when the project uses a single kind: it would only repeat the figure above.
    ...(board.kindCounts.length > 1 ? board.kindCounts : []).map((k): [string, string] => [
      plural(k.label),
      `${k.done} of ${k.total}`,
    ]),
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
      <PageTitle className="mb-1">{p.name}</PageTitle>
      {/* Why the project exists, straight under its name: it is what its rank is argued from. */}
      <p className="mb-3 max-w-3xl text-sm text-sdc-gray-600">
        {p.justification ?? (
          <span className="italic">
            No justification yet. A manager adds one, with what the project is worth and who it is for, in {settings}.
          </span>
        )}
      </p>

      <dl className="mb-3 flex flex-wrap gap-x-6 gap-y-2 text-sm">
        {facts.map(([label, value]) => (
          <div key={label}>
            <dt className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-sdc-gray-600">
              {label}
              {label === "Safe date" && <SafeDateHelp />}
            </dt>
            <dd className="font-semibold text-sdc-navy">{value}</dd>
          </div>
        ))}
        {p.atRisk != null && (
          <div>
            <dt className="text-xs uppercase tracking-wider text-sdc-gray-600">Against target</dt>
            <dd className={`font-semibold ${p.atRisk ? "text-sdc-red-text" : "text-sdc-green-text"}`}>
              {p.atRisk ? "At risk" : "On track"}
              <span className="font-normal text-sdc-gray-600">
                {" "}
                {p.atRiskBasis === "p80" ? "(judged on the safe date)" : "(judged on the forecast; no safe date yet)"}
              </span>
            </dd>
          </div>
        )}
      </dl>

      {p.portfolioRank == null || p.state !== "active" ? (
        <p className="mb-4 rounded-lg border border-sdc-border bg-sdc-yellow-bg px-3 py-2 text-sm text-sdc-yellow-text">
          {p.portfolioRank == null ? (
            "This project has no stack rank yet, so its work is not forecast. The portfolio owner sets the rank on the Project Tracker page."
          ) : p.state === "completed" || p.state === "cancelled" ? (
            `This project is ${p.state === "completed" ? "finished" : "cancelled"}, so its work is not forecast.`
          ) : (
            <>
              This project is {p.state.replace("_", " ")}. Make it active in {settings} when work starts.
            </>
          )}
        </p>
      ) : (
        (p.unscheduledTasks > 0 || p.staleTasks > 0) && (
          <p className="mb-4 rounded-lg border border-sdc-border bg-sdc-yellow-bg px-3 py-2 text-sm text-sdc-yellow-text">
            {p.unscheduledTasks > 0 && (
              <>
                The forecast above leaves out {p.unscheduledTasks} card{p.unscheduledTasks === 1 ? "" : "s"}
                {p.unestimatedTasks > 0 ? ` (${p.unestimatedTasks} with no estimate)` : ""}, so the real finish is
                later. Each card says why.{" "}
              </>
            )}
            {p.staleTasks > 0 && (
              <>
                {STALE_HOURS(p.staleTasks)}: open {p.staleTasks === 1 ? "it" : "each"} and update the hours, or confirm
                they are still right.
              </>
            )}
          </p>
        )
      )}

      <ProjectViews projectKey={p.key} current="board" />
      <Board board={board} canEdit={canEdit} />

      {board.forecastAsOf && (
        <p className="mt-3 text-xs text-sdc-gray-600">Forecast made for {shortDate(board.forecastAsOf)}.</p>
      )}
    </div>
  );
}
