"use client";

import { useState, useTransition } from "react";
import { WORKFORCE_GROUPS, workforceGroupForCardKey, type WorkforceGroupKey } from "@/lib/employee-workforce-groups";
import { EMPLOYEE_TEAMS } from "@/lib/employee-teams";
import { assignHiringPosition, type AssignHiringPositionResult } from "@/lib/hiring-actions";

// The "clean Move to / Assign to control" the task asks for INSTEAD of
// drag-and-drop, by its own explicit preference ("reliability is more
// important than fancy drag behavior") — two cascading plain `<select>`s.
// Choosing a group always clears the department (a department from the OLD
// group would be invalid under the new one — hiring-actions.ts would reject
// it anyway, this just avoids ever submitting that combination in the first
// place). "Other" is deliberately not offered: it's the catch-all EVERY
// non-delivery-team department card already falls into on its own, not
// somewhere a hiring position is ever manually filed.
const ASSIGNABLE_GROUPS = WORKFORCE_GROUPS.filter((g) => g.key !== "other");

export function HiringMoveToControl({
  positionSourceId,
  workforceGroup,
  department,
  canAssign,
  onAssigned,
  assign = assignHiringPosition,
}: {
  positionSourceId: string;
  workforceGroup: WorkforceGroupKey | null;
  department: string | null;
  canAssign: boolean;
  onAssigned: (positionSourceId: string, next: { workforceGroup: WorkforceGroupKey | null; department: string | null }) => void;
  /** Defaults to assignHiringPosition (workbook-sourced positions). A manually-created position passes updateHiringPosition's group/department half instead — see HiringPositionDetailDrawer. */
  assign?: (positionSourceId: string, next: { workforceGroup: WorkforceGroupKey | null; department: string | null }) => Promise<AssignHiringPositionResult>;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (!canAssign) {
    const groupTitle = ASSIGNABLE_GROUPS.find((g) => g.key === workforceGroup)?.title ?? "Unassigned";
    const deptTitle = EMPLOYEE_TEAMS.find((t) => t.schedulerCode === department)?.name;
    return <span className="text-note text-sdc-muted">{deptTitle ? `${groupTitle} · ${deptTitle}` : groupTitle}</span>;
  }

  const departmentsInGroup = workforceGroup ? EMPLOYEE_TEAMS.filter((t) => workforceGroupForCardKey(t.schedulerCode) === workforceGroup) : [];

  function apply(next: { workforceGroup: WorkforceGroupKey | null; department: string | null }) {
    setError(null);
    startTransition(async () => {
      const result = await assign(positionSourceId, next);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onAssigned(positionSourceId, next);
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <select
        value={workforceGroup ?? ""}
        disabled={pending}
        onChange={(e) => apply({ workforceGroup: (e.target.value || null) as WorkforceGroupKey | null, department: null })}
        aria-label={`Move "${positionSourceId}" to workforce group`}
        className="h-7 rounded border border-sdc-border bg-white px-1.5 text-xs text-sdc-navy outline-none focus:border-sdc-blue disabled:opacity-60"
      >
        <option value="">Unassigned</option>
        {ASSIGNABLE_GROUPS.map((g) => (
          <option key={g.key} value={g.key}>
            {g.title}
          </option>
        ))}
      </select>
      {workforceGroup && (
        <select
          value={department ?? ""}
          disabled={pending}
          onChange={(e) => apply({ workforceGroup, department: e.target.value || null })}
          aria-label={`Move "${positionSourceId}" to department`}
          className="h-7 rounded border border-sdc-border bg-white px-1.5 text-xs text-sdc-navy outline-none focus:border-sdc-blue disabled:opacity-60"
        >
          <option value="">(group only)</option>
          {departmentsInGroup.map((t) => (
            <option key={t.schedulerCode} value={t.schedulerCode}>
              {t.name}
            </option>
          ))}
        </select>
      )}
      {error && (
        <span className="text-label text-sdc-red-text" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
