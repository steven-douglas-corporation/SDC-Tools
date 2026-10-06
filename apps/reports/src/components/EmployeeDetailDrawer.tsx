"use client";

import { useState, useTransition } from "react";
import { BuildReadinessDrawer } from "@/components/build-readiness/BuildReadinessDrawer";
import { DASH, isPaylocityId, type EmployeeRow } from "@/lib/employee-row";
import { workforceGroupTitle, type WorkforceGroupKey } from "@/lib/employee-workforce-groups";
import { setEmployeeActive, setEmployeeSupervisor, setEmployeeTeamOverride } from "@/lib/employee-actions";
import { TEAM_CODES, TEAM_NAME } from "@/lib/team-names";

// Level 3 of the Employees tab (2026-08-19, by request) — net new; there was
// no per-employee detail view before this. Reuses the same generic drawer
// shell Build Readiness's own drilldowns share (BuildReadinessDrawer) rather
// than inventing a second drawer pattern, and shows ONLY fields that already
// exist on `EmployeeRow` — no field here is computed or guessed for this
// view; see EmployeesCards.tsx / lib/employee-row.ts for where each one
// actually comes from.
//
// Show / Hide (2026-09-30): the Paylocity roster sync adds every new person
// HIDDEN (see lib/paylocity-roster-parse.ts), so this is where someone puts a
// new hire on the boards — or takes a person off them. It is the existing
// soft-delete (Employee.active); hours history stays linked either way.

function Field({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-sdc-border-soft px-4 py-2.5">
      <span className="text-xs font-semibold uppercase tracking-wide text-sdc-muted">{label}</span>
      <span className="flex min-w-0 flex-col items-end">
        <span className="max-w-full truncate text-sm text-sdc-navy" title={value}>
          {value}
        </span>
        {note && <span className="text-label text-sdc-muted">{note}</span>}
      </span>
    </div>
  );
}

// Supervisor and title are written only by the hourly roster sync, so the
// drawer says where to change them rather than offering an edit.
const FROM_PAYLOCITY = "From Paylocity — change it there";

// For someone not in Paylocity (2026-10-02) no sync owns the supervisor, and the
// Org Chart places people by who they report to, so it is picked here instead.
// The team a person sits on (2026-10-06). It follows the reporting line, so for
// nearly everyone this just says so; for the occasional person whose manager is
// in a different department it is set by hand here, and "Automatic" hands it
// back to the rule. Takes effect at once: the card moves with the next refresh
// of this page, not the next hourly sync.
function TeamPicker({ employeeId, current, shown }: { employeeId: number; current: string | null; shown: string | null }) {
  const [value, setValue] = useState<string | null>(current);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function change(next: string | null) {
    const before = value;
    setValue(next);
    setError(null);
    startTransition(async () => {
      try {
        await setEmployeeTeamOverride(employeeId, next);
      } catch (err) {
        setValue(before);
        setError(err instanceof Error ? err.message : "Could not save.");
      }
    });
  }

  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-sdc-border-soft px-4 py-2.5">
      <label htmlFor={`team-${employeeId}`} className="text-xs font-semibold uppercase tracking-wide text-sdc-muted">
        Team
      </label>
      <span className="flex min-w-0 flex-col items-end gap-0.5">
        <select
          id={`team-${employeeId}`}
          value={value ?? ""}
          disabled={pending}
          onChange={(e) => change(e.target.value || null)}
          className="max-w-[14rem] rounded-md border border-sdc-border bg-white px-2 py-1 text-sm text-sdc-navy disabled:opacity-50"
        >
          <option value="">Automatic{value === null && shown ? ` — ${TEAM_NAME[shown] ?? shown}` : ""}</option>
          {TEAM_CODES.map((code) => (
            <option key={code} value={code}>
              {TEAM_NAME[code] ?? code}
            </option>
          ))}
        </select>
        <span className="text-label text-sdc-muted">
          {pending ? "Saving…" : value === null ? "Follows the reporting line" : "Set by hand — choose Automatic to follow the reporting line again"}
        </span>
        {error && <span className="text-label text-red-700">{error}</span>}
      </span>
    </div>
  );
}

function SupervisorPicker({
  employeeId,
  current,
  options,
}: {
  employeeId: number;
  current: number | null;
  options: { id: number; name: string }[];
}) {
  const [value, setValue] = useState<number | null>(current);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function change(next: number | null) {
    const before = value;
    setValue(next);
    setError(null);
    startTransition(async () => {
      try {
        await setEmployeeSupervisor(employeeId, next);
      } catch (err) {
        setValue(before);
        setError(err instanceof Error ? err.message : "Could not save.");
      }
    });
  }

  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-sdc-border-soft px-4 py-2.5">
      <label htmlFor={`supervisor-${employeeId}`} className="text-xs font-semibold uppercase tracking-wide text-sdc-muted">
        Supervisor
      </label>
      <span className="flex min-w-0 flex-col items-end gap-0.5">
        <select
          id={`supervisor-${employeeId}`}
          value={value ?? ""}
          disabled={pending}
          onChange={(e) => change(e.target.value ? Number(e.target.value) : null)}
          className="max-w-[14rem] rounded-md border border-sdc-border bg-white px-2 py-1 text-sm text-sdc-navy disabled:opacity-50"
        >
          <option value="">No supervisor</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
        <span className="text-label text-sdc-muted">{pending ? "Saving…" : "Not in Paylocity — set here"}</span>
        {error && <span className="text-label text-red-700">{error}</span>}
      </span>
    </div>
  );
}

export function EmployeeDetailDrawer({
  employee,
  departmentTitle,
  workforceGroup,
  canEdit,
  supervisorOptions = [],
  onClose,
}: {
  employee: EmployeeRow;
  /** The Level-2 department card title this person is filed under (may differ from the raw Paylocity `department` string — e.g. two spellings share one card). */
  departmentTitle: string;
  workforceGroup: WorkforceGroupKey;
  /** employees:edit — the same permission setEmployeeActive enforces server-side. */
  canEdit: boolean;
  /** Shown people to pick a supervisor from — used only for someone not in Paylocity. */
  supervisorOptions?: { id: number; name: string }[];
  onClose: () => void;
}) {
  // Local, because `employee` is the snapshot taken when the drawer opened; the
  // page's rows refresh underneath via revalidatePath, this keeps the drawer
  // honest in the meantime.
  const [active, setActive] = useState(employee.active);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function toggle() {
    const next = !active;
    setError(null);
    startTransition(async () => {
      try {
        await setEmployeeActive(employee.id, next, new FormData());
        setActive(next);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not save.");
      }
    });
  }

  return (
    <BuildReadinessDrawer
      title={employee.name}
      subtitle={`${departmentTitle} · ${workforceGroupTitle(workforceGroup)}`}
      badge={active ? undefined : { label: "HIDDEN", cls: "bg-sdc-gray-100 text-sdc-muted" }}
      breadcrumb={[employee.name]}
      onBreadcrumbClick={() => {}}
      onClose={onClose}
    >
      <div className="flex flex-col">
        {canEdit ? (
          <TeamPicker employeeId={employee.id} current={employee.teamOverride ?? null} shown={employee.team} />
        ) : (
          <Field
            label="Team"
            value={(employee.team && TEAM_NAME[employee.team]) || DASH}
            note={employee.teamOverride ? "Set by hand" : "Follows the reporting line"}
          />
        )}
        <Field label="Workforce Group" value={workforceGroupTitle(workforceGroup)} />
        <Field label="Department" value={departmentTitle} />
        <Field label="Title" value={employee.positionTitle} note={employee.paylocityId ? FROM_PAYLOCITY : undefined} />
        <Field label="Discipline" value={employee.discipline} />
        {canEdit && !isPaylocityId(employee.paylocityId) ? (
          <SupervisorPicker
            employeeId={employee.id}
            current={employee.supervisorId ?? null}
            options={supervisorOptions.filter((o) => o.id !== employee.id)}
          />
        ) : (
          <Field label="Supervisor" value={employee.supervisor} note={isPaylocityId(employee.paylocityId) ? FROM_PAYLOCITY : undefined} />
        )}
        <Field label="Level / Specialty" value={employee.specialty ?? DASH} />
        <Field label="Status" value={active ? "Shown" : "Hidden"} />
        {employee.isLead && <Field label="Department Lead" value="Yes" />}
        <Field label="Paylocity ID" value={employee.paylocityId || DASH} />
        {canEdit && (
          <div className="px-4 py-3">
            <button
              type="button"
              onClick={toggle}
              disabled={pending}
              className="rounded-md border border-sdc-border bg-white px-3 py-1.5 text-sm font-semibold text-sdc-navy hover:bg-sdc-gray-50 disabled:opacity-50"
            >
              {pending ? "Saving…" : active ? "Hide" : "Show"}
            </button>
            <p className="mt-1.5 text-label text-sdc-muted">
              {active
                ? "Hidden people are left off the Employees page and headcounts; their hours history stays. SDC Scheduler's board is managed in Scheduler."
                : "Shows them on the Employees page and in headcounts. They reach SDC Scheduler's board once they're on a team."}
            </p>
            {error && <p className="mt-1.5 text-label text-red-700">{error}</p>}
          </div>
        )}
      </div>
    </BuildReadinessDrawer>
  );
}
