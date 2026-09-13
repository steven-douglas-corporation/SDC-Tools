"use client";

import { useMemo, useState } from "react";
import { EmptyState } from "@/components/ui/EmptyState";
import { HiringMoveToControl } from "@/components/HiringMoveToControl";
import { HiringVisibilityControl } from "@/components/HiringVisibilityControl";
import { WORKFORCE_GROUPS, workforceGroupTitle, type WorkforceGroupKey } from "@/lib/employee-workforce-groups";
import { EMPLOYEE_TEAMS } from "@/lib/employee-teams";
import type { HiringPosition } from "@/lib/hiring-positions";
import { HiringStatusPill } from "@/components/HiringStatusPill";
import { MANUAL_JOB_STATUSES, hiringStatusStyle, manualJobStatusOf } from "@/lib/hiring-position-status";
import { countOpenings, openingsSummary } from "@/lib/hiring-openings";

// Level 2 for the "Hiring Positions" card (2026-08-19) — every position
// (workbook + manually created), bucketed by its current workforce group
// (manual assignment if any, else the classifier's best-effort guess — see
// hiring-positions.ts), each row carrying the same Move-to control the
// detail drawer offers, so a manager scanning the whole list can reassign
// without opening each one. Never mixed into EmployeesCards' own employee
// list — the task's own "do not mix open positions into the actual employee
// list as if they are employees".
//
// (2026-08-21, status at a glance): every row now carries its Job Status as a
// pill, a thin colored left accent and a very light tint of the same status
// color, plus a real Status column between the position info and the
// group/department assignment controls -- the point being that nobody has to
// click Edit to find out whether a position is Open, Published, On Hold or
// Filled. All four treatments come from lib/hiring-position-status.ts, never
// from per-component color choices.
//
// The filter offers "All Positions" (the default now, so all four statuses
// are visible immediately) plus one option per status. Any off-vocabulary
// status actually present in the data (an older workbook wording) is still
// appended as its own option so such a row stays findable.
//
// This filter, and this whole list, are DISPLAY only: they never affect the
// hiring/planned-headcount or capacity-hours totals shown elsewhere, which
// always come from the full set filtered by `isOpen` -- isOpenHiringStatus is
// still the only rule deciding that, and it did not change (see
// WorkforceSummaryCards' caller in EmployeesGrid.tsx).

const DEPARTMENT_TITLE = new Map(EMPLOYEE_TEAMS.map((t) => [t.schedulerCode, t.name]));
const ALL_FILTER = "__all__";

type Bucket = { key: WorkforceGroupKey | "unassigned"; title: string; positions: HiringPosition[] };

export function HiringPositionsList({
  positions,
  canAssign,
  canCreate,
  onSelect,
  onAssigned,
  onVisibilityChanged,
  onCreate,
}: {
  positions: HiringPosition[];
  canAssign: boolean;
  canCreate: boolean;
  onSelect: (position: HiringPosition) => void;
  onAssigned: (positionSourceId: string, next: { workforceGroup: WorkforceGroupKey | null; department: string | null }) => void;
  onVisibilityChanged: (positionSourceId: string, isVisible: boolean) => void;
  onCreate: () => void;
}) {
  const [statusFilter, setStatusFilter] = useState<string>(ALL_FILTER);
  // Unchecked by default, same as EmployeesGrid's "Show inactive" — only
  // meaningful for an editor (a non-editor's `positions` prop was already
  // redacted server-side, see hiring-positions.ts's redactHiddenPositions, so
  // they'd never have anything to reveal by checking it).
  const [showHidden, setShowHidden] = useState(false);

  // Non-editors never see a hidden position here regardless of this
  // checkbox — display visibility ≠ hiring status, so this filter must never
  // touch `positions` itself, only what THIS list renders.
  const visibilityFiltered = useMemo(() => {
    if (canAssign && showHidden) return positions;
    return positions.filter((p) => p.isVisible);
  }, [positions, canAssign, showHidden]);

  // Only statuses OUTSIDE the four -- the four are always offered whether or
  // not anything currently carries them, so the dropdown is a stable list
  // rather than one that changes shape as positions are edited.
  const otherStatuses = useMemo(
    () => [...new Set(visibilityFiltered.filter((p) => !manualJobStatusOf(p.status)).map((p) => p.status))].filter(Boolean).sort(),
    [visibilityFiltered],
  );

  // Matched on the NORMALIZED status, so picking "On Hold" also catches a
  // workbook row spelled "on hold".
  const filtered = useMemo(() => {
    if (statusFilter === ALL_FILTER) return visibilityFiltered;
    return visibilityFiltered.filter((p) => (manualJobStatusOf(p.status) ?? p.status) === statusFilter);
  }, [visibilityFiltered, statusFilter]);

  const buckets = useMemo<Bucket[]>(() => {
    const byGroup = new Map<WorkforceGroupKey | "unassigned", HiringPosition[]>();
    for (const p of filtered) {
      const key = p.workforceGroup ?? "unassigned";
      const list = byGroup.get(key);
      if (list) list.push(p);
      else byGroup.set(key, [p]);
    }
    const ordered: Bucket[] = WORKFORCE_GROUPS.filter((g) => g.key !== "other").map((g) => ({
      key: g.key,
      title: g.title,
      positions: byGroup.get(g.key) ?? [],
    }));
    const other = byGroup.get("other");
    if (other) ordered.push({ key: "other", title: workforceGroupTitle("other"), positions: other });
    ordered.push({ key: "unassigned", title: "Unassigned", positions: byGroup.get("unassigned") ?? [] });
    return ordered.filter((b) => b.positions.length > 0);
  }, [filtered]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          aria-label="Filter by Job Status"
          className="h-8 rounded-lg border border-sdc-border bg-white px-2 text-xs text-sdc-navy outline-none focus:border-sdc-blue"
        >
          <option value={ALL_FILTER}>All Positions</option>
          {MANUAL_JOB_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
          {otherStatuses.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        {canAssign && (
          <label className="flex items-center gap-2 text-xs font-medium text-sdc-gray-600">
            <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} className="h-3.5 w-3.5" />
            Show hidden
          </label>
        )}
        {canCreate && (
          <button
            type="button"
            onClick={onCreate}
            className="h-8 rounded-lg bg-sdc-blue px-3 text-xs font-semibold text-white motion-interactive hover:brightness-95"
          >
            + Create Position
          </button>
        )}
      </div>

      {filtered.length === 0 ? (
        <EmptyState title="No positions match" message="Try a different Job Status filter." />
      ) : (
        buckets.map((bucket) => (
          <section key={bucket.key} className="overflow-hidden rounded-xl border border-sdc-border bg-white shadow-sm">
            <header className="flex items-center justify-between gap-2 border-b border-sdc-border bg-sdc-gray-50 px-3.5 py-2">
              <h3 className="text-sm font-bold text-sdc-navy">{bucket.title}</h3>
              {/* Openings, not rows — a section holding one ×2 requisition is
                  two openings. The per-row ×N badges below explain any gap
                  between this figure and the number of rows. */}
              <span className="text-xs font-semibold tabular-nums text-sdc-muted">{countOpenings(bucket.positions)}</span>
            </header>
            {/* Column headers for the rows below -- the requested
                "Position | Status | assignment" reading order, with Status
                sitting between the position info and the group/department
                controls. Hidden on narrow widths, where the rows wrap. */}
            <div className="hidden items-center gap-3 border-b border-sdc-border-soft bg-white px-3.5 py-1.5 text-label font-bold uppercase tracking-wider text-sdc-muted sm:flex">
              <span className="min-w-0 flex-1">Position</span>
              <span className="w-28 shrink-0">Status</span>
              <span className="w-56 shrink-0 text-right">Assignment</span>
            </div>
            <ul className="divide-y divide-sdc-border-soft">
              {bucket.positions.map((p) => {
                const style = hiringStatusStyle(p.status);
                return (
                  <li
                    key={p.sourceId}
                    className={`flex flex-wrap items-center gap-3 border-l-2 px-3.5 py-2.5 ${style.accent} ${style.tint}`}
                  >
                    <button
                      type="button"
                      onClick={() => onSelect(p)}
                      className="min-w-0 flex-1 truncate text-left text-sm font-medium text-sdc-navy hover:text-sdc-blue hover:underline"
                      title={openingsSummary(p) ? `${p.title} — ${openingsSummary(p)}` : p.title}
                    >
                      {p.title}
                      {/* One row per requisition, never duplicated for display
                          (the request is explicit about that) — the count rides
                          the title as a badge instead. Hidden at quantity 1, so
                          it marks out the multi-opening rows rather than
                          decorating every row. */}
                      {p.quantity > 1 && (
                        <span className="ml-1.5 rounded bg-sdc-blue-light px-1.5 py-0.5 text-note font-bold tabular-nums text-sdc-blue-dark">
                          ×{p.quantity}
                          {p.filledCount > 0 && <span className="font-normal"> · {p.remainingQuantity} left</span>}
                        </span>
                      )}
                      {p.department && (
                        <span className="ml-2 truncate text-xs font-normal text-sdc-muted">{DEPARTMENT_TITLE.get(p.department)}</span>
                      )}
                      {!p.isVisible && (
                        <span className="ml-2 rounded bg-sdc-yellow-bg px-1.5 py-0.5 text-micro font-bold uppercase tracking-wide text-sdc-yellow-text">
                          Hidden
                        </span>
                      )}
                    </button>
                    <span className="w-28 shrink-0">
                      <HiringStatusPill status={p.status} />
                    </span>
                    <span className="flex w-56 shrink-0 items-center justify-end gap-2.5">
                      {p.source === "workbook" ? (
                        <HiringMoveToControl
                          positionSourceId={p.sourceId}
                          workforceGroup={p.workforceGroup}
                          department={p.department}
                          canAssign={canAssign}
                          onAssigned={onAssigned}
                        />
                      ) : (
                        <button
                          type="button"
                          onClick={() => onSelect(p)}
                          className="text-note font-medium text-sdc-blue hover:underline"
                          title="Edit this position"
                        >
                          Edit
                        </button>
                      )}
                      <HiringVisibilityControl position={p} canAssign={canAssign} onToggled={onVisibilityChanged} />
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
