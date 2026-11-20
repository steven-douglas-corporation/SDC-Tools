"use client";

import { useState, useTransition } from "react";
import { BUTTON_PRIMARY, CARD_BASE, INPUT, LABEL } from "@/components/ui/classnames";
import { updateProjectAction } from "../actions";
import type { ProjectChanges, ProjectState } from "../service/projects";
import type { ValueBucket } from "../service/queries";
import type { Department } from "../service/departments";
import { DepartmentOptions } from "./DepartmentPicker";

// What a manager can change about a project after it is created: its name, why it is being done and
// what it is worth, when it is due, who owns it, and where it stands. Finishing or cancelling
// a project is a change of state made here. It is the main part of the project's Settings tab.

const STATES: { value: ProjectState; label: string; note: string }[] = [
  { value: "planned", label: "Planned", note: "Not started. Its work is forecast once it has a stack rank." },
  {
    value: "active",
    label: "Active",
    note: "Being worked on. Needs a stack rank, a justification, a value and both departments.",
  },
  { value: "on_hold", label: "On hold", note: "Paused. Its cards stay, and are left out of the forecast." },
  { value: "completed", label: "Finished", note: "Done. It leaves the forecast and frees its people." },
  { value: "cancelled", label: "Cancelled", note: "Stopped for good. It leaves the forecast and frees its people." },
];

export function ProjectSettings({
  projectId,
  projectKey,
  name,
  justification,
  valueBucketId,
  valueBuckets,
  forDepartmentId,
  doneByDepartmentId,
  departments,
  targetDate,
  startDate,
  ownerPersonId,
  state,
  openCards,
  people,
  readOnly = false,
}: {
  projectId: number;
  projectKey: string;
  name: string;
  justification: string | null;
  valueBucketId: number | null;
  valueBuckets: ValueBucket[];
  forDepartmentId: number | null;
  doneByDepartmentId: number | null;
  departments: Department[];
  targetDate: string | null;
  startDate: string | null;
  ownerPersonId: number;
  state: ProjectState;
  /** Cards that carry work and are not done yet. */
  openCards: number;
  people: { id: number; name: string }[];
  /** Shown, not changed: for someone on the project who is not a manager of it. */
  readOnly?: boolean;
}) {
  const [title, setTitle] = useState(name);
  const [why, setWhy] = useState(justification ?? "");
  const [value, setValue] = useState(valueBucketId?.toString() ?? "");
  const [forId, setForId] = useState(forDepartmentId?.toString() ?? "");
  const [byId, setById] = useState(doneByDepartmentId?.toString() ?? "");
  const [target, setTarget] = useState(targetDate ?? "");
  const [started, setStarted] = useState(startDate ?? "");
  const [owner, setOwner] = useState(ownerPersonId.toString());
  const [next, setNext] = useState<ProjectState>(state);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [pending, start] = useTransition();

  const closing = (next === "completed" || next === "cancelled") && next !== state;
  const changes: ProjectChanges = {};
  if (title.trim() !== name) changes.name = title;
  if (why.trim() !== (justification ?? "")) changes.justification = why;
  if (value !== "" && value !== (valueBucketId?.toString() ?? "")) changes.valueBucketId = Number(value);
  if (forId !== "" && forId !== (forDepartmentId?.toString() ?? "")) changes.forDepartmentId = Number(forId);
  if (byId !== "" && byId !== (doneByDepartmentId?.toString() ?? "")) changes.doneByDepartmentId = Number(byId);
  if ((target || null) !== targetDate) changes.targetDate = target || null;
  if ((started || null) !== startDate) changes.startDate = started || null;
  if (Number(owner) !== ownerPersonId) changes.ownerPersonId = Number(owner);
  if (next !== state) changes.state = next;
  const changed = Object.keys(changes).length > 0;

  function save() {
    setError("");
    setSaved("");
    start(async () => {
      const res = await updateProjectAction({ projectId, projectKey, changes, reason });
      if (!res.ok) return setError(res.error);
      setReason("");
      setSaved("Saved.");
    });
  }

  return (
    <section className={`${CARD_BASE} p-4`}>
      <h2 className="text-sm font-semibold text-sdc-navy">Project settings</h2>
      {/* One switch for every field: someone who is not a manager reads the same form, locked. */}
      <fieldset disabled={readOnly} className="m-0 min-w-0 border-0 p-0">
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <label className="flex flex-col gap-1 sm:col-span-3">
            <span className={LABEL}>Name</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} className={INPUT} />
            <span className="text-xs text-sdc-gray-600">
              The key ({projectKey}) and the project&apos;s address stay the same when the name changes.
            </span>
          </label>
          <label className="flex flex-col gap-1 sm:col-span-2">
            <span className={LABEL}>Justification</span>
            <textarea
              rows={3}
              value={why}
              onChange={(e) => setWhy(e.target.value)}
              className={INPUT}
              placeholder="Cuts the monthly roll-up from two days to two hours"
            />
            <span className="text-xs text-sdc-gray-600">
              Why this is worth doing: what it saves, earns or prevents. The stack rank is argued from it.
            </span>
          </label>
          <label className="flex flex-col gap-1">
            <span className={LABEL}>Value to the bottom line</span>
            <select value={value} onChange={(e) => setValue(e.target.value)} className={INPUT}>
              {valueBucketId == null && <option value="">Not set yet</option>}
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
          <label className="flex flex-col gap-1">
            <span className={LABEL}>For department</span>
            <select value={forId} onChange={(e) => setForId(e.target.value)} className={INPUT}>
              {(forDepartmentId == null || !departments.some((d) => d.id === forDepartmentId)) && (
                <option value="">{forDepartmentId == null ? "Not set yet" : "A department no longer in use"}</option>
              )}
              <DepartmentOptions departments={departments} />
            </select>
            <span className="text-xs text-sdc-gray-600">Who benefits, not who does the work.</span>
          </label>
          <label className="flex flex-col gap-1">
            <span className={LABEL}>Done by department</span>
            <select value={byId} onChange={(e) => setById(e.target.value)} className={INPUT}>
              {(doneByDepartmentId == null || !departments.some((d) => d.id === doneByDepartmentId)) && (
                <option value="">{doneByDepartmentId == null ? "Not set yet" : "A department no longer in use"}</option>
              )}
              <DepartmentOptions departments={departments} />
            </select>
            <span className="text-xs text-sdc-gray-600">Who does the work.</span>
          </label>
          <label className="flex flex-col gap-1">
            <span className={LABEL}>Started on</span>
            <input type="date" value={started} onChange={(e) => setStarted(e.target.value)} className={INPUT} />
            <span className="text-xs text-sdc-gray-600">
              When the work began, if that was before its first card. Blank lets the cards decide.
            </span>
          </label>
          <label className="flex flex-col gap-1">
            <span className={LABEL}>Target date</span>
            <input type="date" value={target} onChange={(e) => setTarget(e.target.value)} className={INPUT} />
            <span className="text-xs text-sdc-gray-600">The date the forecast is judged against. Blank for none.</span>
          </label>
          <label className="flex flex-col gap-1">
            <span className={LABEL}>Owner</span>
            <select value={owner} onChange={(e) => setOwner(e.target.value)} className={INPUT}>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <span className="text-xs text-sdc-gray-600">A new owner is made a manager of the project.</span>
          </label>
          <label className="flex flex-col gap-1">
            <span className={LABEL}>State</span>
            <select value={next} onChange={(e) => setNext(e.target.value as ProjectState)} className={INPUT}>
              {STATES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
            <span className="text-xs text-sdc-gray-600">{STATES.find((s) => s.value === next)?.note}</span>
          </label>
        </div>
        {closing && openCards > 0 && (
          <p role="status" className="mt-3 text-sm font-semibold text-sdc-yellow-text">
            {openCards} card{openCards === 1 ? " is" : "s are"} not done yet.{" "}
            {openCards === 1 ? "It stays" : "They stay"} as {openCards === 1 ? "it is" : "they are"}, and no longer{" "}
            {openCards === 1 ? "counts" : "count"} in the forecast.
          </p>
        )}
        {!readOnly && (
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <label className="flex min-w-[14rem] flex-1 flex-col gap-1">
              <span className={LABEL}>Reason for the change (optional)</span>
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className={INPUT}
                placeholder="Kept in the history"
              />
            </label>
            <button type="button" disabled={pending || !changed} className={BUTTON_PRIMARY} onClick={save}>
              {pending ? "Saving…" : "Save settings"}
            </button>
            {error && (
              <span role="alert" className="text-sm font-semibold text-sdc-red-text">
                {error}
              </span>
            )}
            {saved && !changed && <span className="text-sm text-sdc-green-text">{saved}</span>}
          </div>
        )}
      </fieldset>
    </section>
  );
}
