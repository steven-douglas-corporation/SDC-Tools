"use client";

import Link from "next/link";
import { Fragment, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  BUTTON_COMPACT,
  BUTTON_PRIMARY,
  CARD_BASE,
  INPUT,
  LABEL,
  TABLE_HEADER_ROW,
  TABLE_ROW_HOVER,
} from "@/components/ui/classnames";
import { EmptyState } from "@/components/ui/EmptyState";
import {
  createProjectAction,
  moveProjectRankAction,
  moveProjectRankInDepartmentAction,
  setProjectRankAction,
  setProjectStateAction,
} from "../actions";
import type { DepartmentRankMove, RankClash } from "../service/projects";
import type { ProjectListItem, ValueBucket } from "../service/queries";
import type { Department } from "../service/departments";
import { DepartmentOptions } from "./DepartmentPicker";
import { departmentMoveEffect, hours, leftOutOfForecast, rankClashEffect, shortDate } from "./format";
import { SafeDateHelp } from "./HelpTip";

// The tracker's front page: every project the person can see, in stack-rank order, with the
// forecast beside the target and the work the forecast leaves out beside both.

const STATE_LABEL: Record<string, string> = {
  planned: "Planned",
  active: "Active",
  on_hold: "On hold",
  completed: "Completed",
  cancelled: "Cancelled",
};

function Risk({ p }: { p: ProjectListItem }) {
  if (p.atRisk == null) return <span className="text-sdc-gray-400">—</span>;
  return p.atRisk ? (
    <span className="rounded-full bg-sdc-red-bg px-2 py-0.5 text-xs font-semibold text-sdc-red-text">At risk</span>
  ) : (
    <span className="rounded-full bg-sdc-green-bg px-2 py-0.5 text-xs font-semibold text-sdc-green-text">On track</span>
  );
}

function RankCell({
  p,
  canRank,
  first,
  last,
}: {
  p: ProjectListItem;
  canRank: boolean;
  /** True when this is the top, or the bottom, of the ranked projects: that arrow does nothing. */
  first: boolean;
  last: boolean;
}) {
  const [value, setValue] = useState(p.portfolioRank?.toString() ?? "");
  const [error, setError] = useState("");
  // Set while the person is being asked whether to take a rank another project holds.
  const [ask, setAsk] = useState<{ rank: number; clash: RankClash } | null>(null);
  const [pending, start] = useTransition();
  if (!canRank) return <>{p.portfolioRank ?? "—"}</>;

  const reset = () => setValue(p.portfolioRank?.toString() ?? "");

  function save(replace = false) {
    const next = value.trim() === "" ? null : Number(value);
    if (next === p.portfolioRank) return;
    setError("");
    start(async () => {
      const res = await setProjectRankAction(p.id, next, replace);
      if (!res.ok) {
        setError(res.error);
        setAsk(null);
        return reset();
      }
      // Another project holds that rank: nothing has changed yet, and the person is asked first.
      setAsk(res.clash && next !== null ? { rank: next, clash: res.clash } : null);
    });
  }

  return (
    <span className="inline-flex flex-col items-center">
      <span className="inline-flex items-center gap-1">
        <input
          aria-label={`Stack rank for ${p.key}`}
          inputMode="numeric"
          value={value}
          disabled={pending || ask !== null}
          onChange={(e) => setValue(e.target.value.replace(/[^0-9]/g, ""))}
          onBlur={() => save()}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          className="w-12 rounded-md border border-sdc-border px-2 py-1 text-center text-sm focus:border-sdc-blue focus:outline-none"
        />
        {p.portfolioRank != null && (
          <span className="inline-flex flex-col">
            {(["up", "down"] as const).map((direction) => (
              <button
                key={direction}
                type="button"
                aria-label={`Move ${p.key} ${direction} one place`}
                title={`Move ${direction} one place`}
                disabled={pending || ask !== null || (direction === "up" ? first : last)}
                onClick={() => {
                  setError("");
                  start(async () => {
                    const res = await moveProjectRankAction(p.id, direction);
                    if (!res.ok) setError(res.error);
                  });
                }}
                className="h-4 w-5 rounded text-micro leading-none text-sdc-gray-600 hover:bg-sdc-gray-100 hover:text-sdc-blue disabled:opacity-30 disabled:hover:bg-transparent"
              >
                {direction === "up" ? "▲" : "▼"}
              </button>
            ))}
          </span>
        )}
      </span>
      {ask && (
        <span
          role="alertdialog"
          aria-label={`Rank ${ask.rank} is taken`}
          className="mt-2 flex w-56 flex-col gap-2 rounded-md border border-sdc-border bg-white p-2 text-left text-xs text-sdc-navy shadow-sm"
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            setAsk(null);
            reset();
          }}
        >
          <span>
            <strong>
              {ask.clash.holderKey} ({ask.clash.holderName})
            </strong>{" "}
            is at rank {ask.rank}. Put {p.key} there instead? {rankClashEffect(ask.clash)}
          </span>
          <span className="flex justify-end gap-2">
            <button
              type="button"
              autoFocus
              disabled={pending}
              className={BUTTON_COMPACT}
              onClick={() => {
                setAsk(null);
                reset();
              }}
            >
              Cancel
            </button>
            <button type="button" disabled={pending} className={BUTTON_COMPACT} onClick={() => save(true)}>
              {pending ? "Moving…" : `Yes, make ${p.key} rank ${ask.rank}`}
            </button>
          </span>
        </span>
      )}
      {error && <span className="mt-1 max-w-[12rem] text-xs text-sdc-red-text">{error}</span>}
    </span>
  );
}

function StateCell({ p, canEdit }: { p: ProjectListItem; canEdit: boolean }) {
  const [error, setError] = useState("");
  const [pending, start] = useTransition();
  const label = STATE_LABEL[p.state] ?? p.state;
  if (!canEdit || p.myRole !== "manager" || p.state !== "planned") return <>{label}</>;
  return (
    <span className="inline-flex flex-col items-center gap-1">
      <span>{label}</span>
      <button
        type="button"
        disabled={pending}
        className={BUTTON_COMPACT}
        onClick={() =>
          start(async () => {
            setError("");
            const res = await setProjectStateAction(p.id, p.key, "active");
            if (!res.ok) setError(res.error);
          })
        }
      >
        Make active
      </button>
      {error && <span className="max-w-[12rem] text-xs text-sdc-red-text">{error}</span>}
    </span>
  );
}

/**
 * The rank cell when the list is grouped by department: the project's place among its own
 * department's projects, with arrows to change it, and its company-wide rank beside it. There
 * is one rank, the company's; the arrows trade it with the next project of the same department.
 */
function DepartmentRankCell({
  p,
  place,
  count,
  canRank,
}: {
  p: ProjectListItem;
  /** 1 for the department's highest-ranked project. Null when the project has no rank yet. */
  place: number | null;
  /** How many of the department's projects hold a rank. */
  count: number;
  canRank: boolean;
}) {
  const [error, setError] = useState("");
  // Set while the person is being asked about a move that passes other departments' projects.
  const [ask, setAsk] = useState<{ direction: "up" | "down"; move: DepartmentRankMove } | null>(null);
  const [pending, start] = useTransition();

  if (place == null) {
    return (
      <span className="text-xs text-sdc-gray-600" title="Give it a company rank in the full list, ungrouped, first.">
        Not ranked
      </span>
    );
  }

  function move(direction: "up" | "down", confirmed: boolean) {
    setError("");
    start(async () => {
      const res = await moveProjectRankInDepartmentAction(p.id, direction, confirmed);
      if (!res.ok) return setError(res.error);
      setAsk(res.move && !res.move.done ? { direction, move: res.move } : null);
    });
  }

  return (
    <span className="inline-flex flex-col items-center">
      <span className="inline-flex items-center gap-1">
        <span className="whitespace-nowrap font-semibold text-sdc-navy">
          {place} of {count}
        </span>
        {canRank && (
          <span className="inline-flex flex-col">
            {(["up", "down"] as const).map((direction) => (
              <button
                key={direction}
                type="button"
                aria-label={`Move ${p.key} ${direction} one place in its department`}
                title={`Move ${direction} one place in ${p.forGroupName ?? "this group"}`}
                disabled={pending || ask !== null || (direction === "up" ? place === 1 : place === count)}
                onClick={() => move(direction, false)}
                className="h-4 w-5 rounded text-micro leading-none text-sdc-gray-600 hover:bg-sdc-gray-100 hover:text-sdc-blue disabled:opacity-30 disabled:hover:bg-transparent"
              >
                {direction === "up" ? "▲" : "▼"}
              </button>
            ))}
          </span>
        )}
      </span>
      <span className="whitespace-nowrap text-xs text-sdc-gray-600">Company rank {p.portfolioRank}</span>
      {ask && (
        <span
          role="alertdialog"
          aria-label={`Move ${p.key} past other departments' projects`}
          className="mt-2 flex w-60 flex-col gap-2 rounded-md border border-sdc-border bg-white p-2 text-left text-xs text-sdc-navy shadow-sm"
          onKeyDown={(e) => {
            if (e.key === "Escape") setAsk(null);
          }}
        >
          <span>{departmentMoveEffect(ask.move)}</span>
          <span className="flex justify-end gap-2">
            <button type="button" autoFocus disabled={pending} className={BUTTON_COMPACT} onClick={() => setAsk(null)}>
              Cancel
            </button>
            <button
              type="button"
              disabled={pending}
              className={BUTTON_COMPACT}
              onClick={() => move(ask.direction, true)}
            >
              {pending ? "Moving…" : `Yes, move ${p.key}`}
            </button>
          </span>
        </span>
      )}
      {error && <span className="mt-1 max-w-[12rem] text-xs text-sdc-red-text">{error}</span>}
    </span>
  );
}

function NewProject({ valueBuckets, departments }: { valueBuckets: ValueBucket[]; departments: Department[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [targetDate, setTargetDate] = useState("");
  const [justification, setJustification] = useState("");
  const [valueBucketId, setValueBucketId] = useState("");
  const [forDepartmentId, setForDepartmentId] = useState("");
  const [error, setError] = useState("");
  const [pending, start] = useTransition();

  if (!open) {
    return (
      <button type="button" className={BUTTON_PRIMARY} onClick={() => setOpen(true)}>
        New project
      </button>
    );
  }

  return (
    <form
      className={`${CARD_BASE} flex w-full flex-wrap items-end gap-4 p-4`}
      onSubmit={(e) => {
        e.preventDefault();
        setError("");
        start(async () => {
          const res = await createProjectAction({
            key,
            name,
            justification,
            valueBucketId: valueBucketId ? Number(valueBucketId) : null,
            forDepartmentId: forDepartmentId ? Number(forDepartmentId) : null,
            targetDate: targetDate || null,
          });
          if (!res.ok) return setError(res.error);
          router.push(`/tracker/${res.key}`);
        });
      }}
    >
      <label className="flex flex-col gap-1">
        <span className={LABEL}>Key</span>
        <input
          required
          autoFocus
          maxLength={8}
          placeholder="BIN"
          value={key}
          onChange={(e) => setKey(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
          className={`${INPUT} w-28 uppercase`}
        />
        <span className="text-xs text-sdc-gray-600">Prefix for card numbers, e.g. BIN-42</span>
      </label>
      <label className="flex min-w-[16rem] flex-1 flex-col gap-1">
        <span className={LABEL}>Name</span>
        <input required value={name} onChange={(e) => setName(e.target.value)} className={INPUT} />
        <span className="text-xs text-sdc-gray-600">&nbsp;</span>
      </label>
      <label className="flex flex-col gap-1">
        <span className={LABEL}>Target date</span>
        <input type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} className={INPUT} />
        <span className="text-xs text-sdc-gray-600">Optional</span>
      </label>
      <label className="flex w-full flex-col gap-1">
        <span className={LABEL}>Justification</span>
        <textarea
          required
          rows={2}
          value={justification}
          onChange={(e) => setJustification(e.target.value)}
          className={INPUT}
          placeholder="Cuts the monthly roll-up from two days to two hours"
        />
        <span className="text-xs text-sdc-gray-600">
          Why this is worth doing: what it saves, earns or prevents. The stack rank is argued from it.
        </span>
      </label>
      <label className="flex min-w-[16rem] flex-col gap-1">
        <span className={LABEL}>For department</span>
        <select required value={forDepartmentId} onChange={(e) => setForDepartmentId(e.target.value)} className={INPUT}>
          <option value="">Choose a department</option>
          <DepartmentOptions departments={departments} />
        </select>
        <span className="text-xs text-sdc-gray-600">Who benefits, not who does the work.</span>
      </label>
      <label className="flex min-w-[16rem] flex-col gap-1">
        <span className={LABEL}>Value to the bottom line</span>
        <select required value={valueBucketId} onChange={(e) => setValueBucketId(e.target.value)} className={INPUT}>
          <option value="">Choose a range</option>
          {valueBuckets.map((b) => (
            <option key={b.id} value={b.id}>
              {b.label}
            </option>
          ))}
        </select>
        <span className="text-xs text-sdc-gray-600">
          The best honest range for a year: savings, added profit or cost avoided.
        </span>
      </label>
      <div className="flex gap-2 pb-6">
        <button type="submit" disabled={pending} className={BUTTON_PRIMARY}>
          {pending ? "Creating…" : "Create project"}
        </button>
        <button type="button" disabled={pending} className={BUTTON_COMPACT} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      {error && <p className="w-full text-sm text-sdc-red-text">{error}</p>}
    </form>
  );
}

export function ProjectList({
  projects,
  valueBuckets,
  departments,
  grouped = false,
  rankNote,
  rankWithinDepartment = false,
  canEdit,
  canRank,
}: {
  projects: ProjectListItem[];
  /** The ranges a new project's yearly value is chosen from. */
  valueBuckets: ValueBucket[];
  /** The departments a new project can be for. */
  departments: Department[];
  /** Whether to draw a heading above each department's projects. They arrive already in that order. */
  grouped?: boolean;
  /** Why ranks cannot be changed in this view, when they cannot. */
  rankNote?: string;
  /**
   * Grouped, with every department in view: the rank cell shows a project's place in its own
   * department, and its arrows move it among that department's projects.
   */
  rankWithinDepartment?: boolean;
  /** Holds tracker:edit. */
  canEdit: boolean;
  /** May set the company-wide stack rank (in this app: ELT). */
  canRank: boolean;
}) {
  // The open projects that hold a rank, top first: the ends are where an arrow has nowhere to go.
  const ranked = projects
    .filter((p) => p.portfolioRank != null && p.state !== "completed" && p.state !== "cancelled")
    .sort((a, b) => (a.portfolioRank as number) - (b.portfolioRank as number))
    .map((p) => p.id);
  return (
    <div className="space-y-4">
      {canEdit && (
        <div className="flex justify-end">
          <NewProject valueBuckets={valueBuckets} departments={departments} />
        </div>
      )}

      {projects.length === 0 ? (
        <EmptyState
          title="No projects yet"
          message={
            canEdit
              ? "Create the first one with New project. It starts as planned, and is forecast once it has a stack rank and is made active."
              : "You are not a member of any project yet. A project's manager can add you."
          }
        />
      ) : (
        <>
          {rankNote && <p className="text-xs text-sdc-gray-600">{rankNote}</p>}
          <div className={`${CARD_BASE} overflow-x-auto`}>
            <table className="w-full min-w-[64rem] text-sm">
              <thead>
                <tr className={TABLE_HEADER_ROW}>
                  <th className="px-3 py-2.5">Rank</th>
                  <th className="px-3 py-2.5 text-left">Project</th>
                  <th className="px-3 py-2.5">State</th>
                  <th className="px-3 py-2.5">Cards done</th>
                  <th className="px-3 py-2.5">Remaining</th>
                  <th className="px-3 py-2.5">Target</th>
                  <th className="px-3 py-2.5">Forecast</th>
                  <th className="px-3 py-2.5">
                    <span className="inline-flex items-center gap-1.5">
                      Safe date <SafeDateHelp />
                    </span>
                  </th>
                  <th className="px-3 py-2.5">Against target</th>
                  <th className="px-3 py-2.5 text-left">Left out of the forecast</th>
                </tr>
              </thead>
              <tbody>
                {projects.map((p, i) => {
                  const leftOut = leftOutOfForecast(p.unscheduledTasks, p.unestimatedTasks, p.staleTasks);
                  // A heading where the department changes. The rows arrive a department at a time.
                  const heads = grouped && (i === 0 || projects[i - 1]!.forGroupId !== p.forGroupId);
                  const inGroup = projects.filter((x) => x.forGroupId === p.forGroupId).length;
                  // The department's ranked projects, top first: its places in the company's order.
                  const inDepartment = ranked.filter(
                    (id) => projects.find((x) => x.id === id)?.forGroupId === p.forGroupId,
                  );
                  return (
                    <Fragment key={p.id}>
                      {heads && (
                        <tr className="border-b border-sdc-border bg-sdc-gray-100">
                          <th
                            colSpan={10}
                            scope="colgroup"
                            className="px-3 py-2 text-left text-sm font-semibold text-sdc-navy"
                          >
                            {p.forGroupName ?? "No department yet"}
                            <span className="ml-2 font-normal text-sdc-gray-600">
                              {inGroup} project{inGroup === 1 ? "" : "s"}
                            </span>
                          </th>
                        </tr>
                      )}
                      <tr className={`border-b border-sdc-border-soft text-center ${TABLE_ROW_HOVER}`}>
                        <td className="px-3 py-2.5 tabular-nums">
                          {/* A project with no rank yet has no place in its department to move from, so it
                              is given a company rank here, in the same box as the ungrouped list. */}
                          {rankWithinDepartment && p.portfolioRank != null ? (
                            <DepartmentRankCell
                              key={`${p.id}:${p.portfolioRank}`}
                              p={p}
                              place={inDepartment.indexOf(p.id) >= 0 ? inDepartment.indexOf(p.id) + 1 : null}
                              count={inDepartment.length}
                              canRank={canRank && canEdit}
                            />
                          ) : (
                            <>
                              <RankCell
                                // Remount when the rank changes: moving one project renumbers the others.
                                key={`${p.id}:${p.portfolioRank}`}
                                p={p}
                                canRank={canRank && canEdit}
                                first={p.id === ranked[0]}
                                last={p.id === ranked[ranked.length - 1]}
                              />
                              {rankWithinDepartment && canRank && canEdit && (
                                <span className="mt-1 block whitespace-nowrap text-xs text-sdc-gray-600">
                                  Company rank
                                </span>
                              )}
                            </>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-left">
                          <Link href={`/tracker/${p.key}`} className="font-semibold text-sdc-blue hover:underline">
                            {p.key}
                          </Link>
                          {/* The reason is one hover away for whoever is setting the ranks. */}
                          <span className="ml-2 text-sdc-navy" title={p.justification ?? undefined}>
                            {p.name}
                          </span>
                          <div className="text-xs text-sdc-gray-600">
                            For {p.forDepartmentName ?? "no department yet"} · {p.valueLabel ?? "No value set"} · Owner:{" "}
                            {p.ownerName}
                            {p.nextMilestone ? ` · Next milestone: ${p.nextMilestone}` : ""}
                          </div>
                        </td>
                        <td className="px-3 py-2.5">
                          <StateCell p={p} canEdit={canEdit} />
                        </td>
                        <td className="px-3 py-2.5 tabular-nums">
                          {p.doneCount} of {p.taskCount}
                        </td>
                        <td className="px-3 py-2.5 tabular-nums">{hours(p.remainingHours)}</td>
                        <td className="px-3 py-2.5">{shortDate(p.targetDate)}</td>
                        <td className="px-3 py-2.5">{shortDate(p.forecastFinish)}</td>
                        <td className="px-3 py-2.5">{shortDate(p.p80Finish)}</td>
                        <td className="px-3 py-2.5">
                          <Risk p={p} />
                        </td>
                        <td className="px-3 py-2.5 text-left text-xs text-sdc-gray-600">
                          {leftOut.length ? leftOut.map((line) => <div key={line}>{line}</div>) : "Nothing"}
                        </td>
                      </tr>
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
