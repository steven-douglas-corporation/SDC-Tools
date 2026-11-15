"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
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
import { createProjectAction, setProjectRankAction, setProjectStateAction } from "../actions";
import type { ProjectListItem } from "../service/queries";
import { hours, shortDate } from "./format";

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

function RankCell({ p, canRank }: { p: ProjectListItem; canRank: boolean }) {
  const [value, setValue] = useState(p.portfolioRank?.toString() ?? "");
  const [error, setError] = useState("");
  const [pending, start] = useTransition();
  if (!canRank) return <>{p.portfolioRank ?? "—"}</>;

  function save() {
    const next = value.trim() === "" ? null : Number(value);
    if (next === p.portfolioRank) return;
    setError("");
    start(async () => {
      const res = await setProjectRankAction(p.id, next);
      if (!res.ok) {
        setError(res.error);
        setValue(p.portfolioRank?.toString() ?? "");
      }
    });
  }

  return (
    <span className="inline-flex flex-col items-center">
      <input
        aria-label={`Stack rank for ${p.key}`}
        inputMode="numeric"
        value={value}
        disabled={pending}
        onChange={(e) => setValue(e.target.value.replace(/[^0-9]/g, ""))}
        onBlur={save}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        className="w-14 rounded-md border border-sdc-border px-2 py-1 text-center text-sm focus:border-sdc-blue focus:outline-none"
      />
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

function NewProject() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [targetDate, setTargetDate] = useState("");
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
          const res = await createProjectAction({ key, name, targetDate: targetDate || null });
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
  canEdit,
  canRank,
}: {
  projects: ProjectListItem[];
  /** Holds tracker:edit. */
  canEdit: boolean;
  /** May set the company-wide stack rank (in this app: ELT). */
  canRank: boolean;
}) {
  return (
    <div className="space-y-4">
      {canEdit && (
        <div className="flex justify-end">
          <NewProject />
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
                <th className="px-3 py-2.5">P80</th>
                <th className="px-3 py-2.5">Against target</th>
                <th className="px-3 py-2.5 text-left">Left out of the forecast</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => {
                const leftOut = [
                  p.unscheduledTasks > 0 && `${p.unscheduledTasks} not forecast`,
                  p.unestimatedTasks > 0 && `${p.unestimatedTasks} with no estimate`,
                  p.staleTasks > 0 && `${p.staleTasks} with stale remaining effort`,
                ].filter(Boolean);
                return (
                  <tr key={p.id} className={`border-b border-sdc-border-soft text-center ${TABLE_ROW_HOVER}`}>
                    <td className="px-3 py-2.5 tabular-nums">
                      <RankCell p={p} canRank={canRank && canEdit} />
                    </td>
                    <td className="px-3 py-2.5 text-left">
                      <Link href={`/tracker/${p.key}`} className="font-semibold text-sdc-blue hover:underline">
                        {p.key}
                      </Link>
                      <span className="ml-2 text-sdc-navy">{p.name}</span>
                      <div className="text-xs text-sdc-gray-600">
                        Owner: {p.ownerName}
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
                      {leftOut.length ? leftOut.join(" · ") : "Nothing"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
