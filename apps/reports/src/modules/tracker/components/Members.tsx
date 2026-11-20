"use client";

import { useState, useTransition } from "react";
import { BUTTON_COMPACT, CARD_BASE } from "@/components/ui/classnames";
import { setMemberAction } from "../actions";
import type { Member } from "../service/people";

// Who is on a project and what each may do. A manager adds people here; without a role on a
// project a person cannot see it at all (ELT aside).

const SMALL_INPUT =
  "rounded-md border border-sdc-border bg-white px-2 py-1.5 text-sm text-sdc-navy focus:border-sdc-blue focus:outline-none";

// What each role may do, least first. Each one can do everything the one before it can. All
// three are always shown, to everyone: whoever is choosing a role needs to see what the others
// are, and whoever is on the project should be able to tell what their own allows.
const ROLES: { role: Member["role"]; label: string; can: string }[] = [
  {
    role: "viewer",
    label: "Viewer",
    can: "Sees the project: its board, timeline, cards and settings. Changes nothing.",
  },
  { role: "contributor", label: "Contributor", can: "Also adds, edits and moves cards, and comments on them." },
  {
    role: "manager",
    label: "Manager",
    can: "Also changes the project's settings, adds and removes people, and archives cards.",
  },
];

export function Members({
  projectId,
  projectKey,
  members,
  people,
  canManage,
  open = false,
}: {
  projectId: number;
  projectKey: string;
  members: Member[];
  /** Everyone who could be added. */
  people: { id: number; name: string }[];
  canManage: boolean;
  /** Shown open to begin with, where it is a main part of the page. */
  open?: boolean;
}) {
  const [personId, setPersonId] = useState("");
  const [role, setRole] = useState<Member["role"]>("contributor");
  const [error, setError] = useState("");
  const [pending, start] = useTransition();
  const addable = people.filter((p) => !members.some((m) => m.personId === p.id));

  function change(id: number, next: Member["role"] | null, done?: () => void) {
    setError("");
    start(async () => {
      const res = await setMemberAction({ projectId, projectKey, personId: id, role: next });
      if (!res.ok) return setError(res.error);
      done?.();
    });
  }

  return (
    <details open={open} className={`${CARD_BASE} p-4`}>
      <summary className="cursor-pointer text-sm font-semibold text-sdc-navy">
        People on this project ({members.length})
      </summary>
      <dl className="mt-3 grid gap-x-4 gap-y-1 text-xs text-sdc-gray-600 sm:grid-cols-[auto_1fr]">
        {ROLES.map((r) => (
          <div key={r.role} className="contents">
            <dt className="font-semibold text-sdc-navy">{r.label}</dt>
            <dd>{r.can}</dd>
          </div>
        ))}
      </dl>
      <ul className="mt-3 divide-y divide-sdc-border-soft text-sm">
        {members.map((m) => (
          <li key={m.personId} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span>
              <span className="font-semibold text-sdc-navy">{m.name}</span>
              <span className="ml-2 text-xs text-sdc-gray-600">{m.email}</span>
            </span>
            {canManage ? (
              <span className="flex items-center gap-2">
                <select
                  aria-label={`Role for ${m.name}`}
                  value={m.role}
                  disabled={pending}
                  onChange={(e) => change(m.personId, e.target.value as Member["role"])}
                  className={SMALL_INPUT}
                >
                  <option value="viewer">Viewer</option>
                  <option value="contributor">Contributor</option>
                  <option value="manager">Manager</option>
                </select>
                <button
                  type="button"
                  disabled={pending}
                  className={BUTTON_COMPACT}
                  onClick={() => change(m.personId, null)}
                >
                  Remove
                </button>
              </span>
            ) : (
              <span className="capitalize text-sdc-gray-600">{m.role}</span>
            )}
          </li>
        ))}
      </ul>

      {canManage && (
        <form
          className="mt-3 flex flex-wrap items-end gap-2 border-t border-sdc-border-soft pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (personId) change(Number(personId), role, () => setPersonId(""));
          }}
        >
          <label className="flex min-w-[12rem] flex-1 flex-col gap-1 text-xs text-sdc-gray-600">
            Add someone
            <select required value={personId} onChange={(e) => setPersonId(e.target.value)} className={SMALL_INPUT}>
              <option value="">Choose a person</option>
              {addable.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-sdc-gray-600">
            As
            <select value={role} onChange={(e) => setRole(e.target.value as Member["role"])} className={SMALL_INPUT}>
              <option value="viewer">Viewer</option>
              <option value="contributor">Contributor</option>
              <option value="manager">Manager</option>
            </select>
          </label>
          <button type="submit" disabled={pending || !personId} className={BUTTON_COMPACT}>
            Add
          </button>
        </form>
      )}
      {error && <p className="mt-2 text-sm text-sdc-red-text">{error}</p>}
    </details>
  );
}
