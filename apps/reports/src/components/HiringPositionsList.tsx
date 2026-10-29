"use client";

import { useMemo, useState } from "react";
import { EmptyState } from "@/components/ui/EmptyState";
import { HiringVisibilityControl } from "@/components/HiringVisibilityControl";
import { WORKFORCE_GROUPS, workforceGroupTitle, type WorkforceGroupKey } from "@/lib/employee-workforce-groups";
import { EMPLOYEE_TEAMS } from "@/lib/employee-teams";
import type { HiringPosition } from "@/lib/hiring-positions";
import { HiringStatusPill } from "@/components/HiringStatusPill";
import { hiringStatusStyle } from "@/lib/hiring-position-status";
import { countOpenings, openingsSummary } from "@/lib/hiring-openings";
import { findPostingForRequest, waitingLabel } from "@/lib/hiring-requests";

// Level 2 for the "Hiring Positions" card (2026-08-19). Never mixed into
// EmployeesCards' own employee list — the task's own "do not mix open positions
// into the actual employee list as if they are employees".
//
// Two kinds of row (2026-10-29):
// - Hire requests, in their own section at the top, oldest first: what managers
//   have asked the recruiter to post. They never count toward hiring totals.
//   Each shows who asked, how long ago, and the hiring manager; one that the app
//   has matched to a Paylocity posting says "Looks posted", and its panel closes
//   it in one click. See lib/hiring-requests.ts.
// - Paylocity postings, bucketed by workforce group (a saved assignment if any,
//   else the hiring manager's team — see hiring-positions.ts), each with its Job
//   Status as a pill, left accent and tint from lib/hiring-position-status.ts.
//
// The status filter applies to postings, and offers the statuses actually
// present. Like the rest of this list it is DISPLAY only: hiring totals come
// from the full set filtered by `isOpen` (see EmployeesGrid.tsx's openHiring).
//
// Every row ends in the same "Edit" link (2026-10-27). A posting's group and
// department dropdowns live in its panel ("Move to"), one click away.

const DEPARTMENT_TITLE = new Map(EMPLOYEE_TEAMS.map((t) => [t.schedulerCode, t.name]));
const ALL_FILTER = "__all__";

type Bucket = { key: WorkforceGroupKey | "unassigned"; title: string; positions: HiringPosition[] };

function TitleButton({ p, onSelect }: { p: HiringPosition; onSelect: (position: HiringPosition) => void }) {
  return (
    <button
      type="button"
      onClick={() => onSelect(p)}
      className="min-w-0 flex-1 truncate text-left text-sm font-medium text-sdc-navy hover:text-sdc-blue hover:underline"
      title={openingsSummary(p) ? `${p.title} — ${openingsSummary(p)}` : p.title}
    >
      {p.title}
      {/* One row per requisition, never duplicated for display — the count
          rides the title as a badge instead, hidden at quantity 1. */}
      {p.quantity > 1 && (
        <span className="ml-1.5 rounded bg-sdc-blue-light px-1.5 py-0.5 text-note font-bold tabular-nums text-sdc-blue-dark">
          ×{p.quantity}
          {p.source === "workbook" && p.filledCount > 0 && <span className="font-normal"> · {p.remainingQuantity} left</span>}
        </span>
      )}
      {p.department && <span className="ml-2 truncate text-xs font-normal text-sdc-muted">{DEPARTMENT_TITLE.get(p.department)}</span>}
      {!p.isVisible && (
        <span className="ml-2 rounded bg-sdc-yellow-bg px-1.5 py-0.5 text-micro font-bold uppercase tracking-wide text-sdc-yellow-text">Hidden</span>
      )}
    </button>
  );
}

function RowActions({
  p,
  canAssign,
  onSelect,
  onVisibilityChanged,
}: {
  p: HiringPosition;
  canAssign: boolean;
  onSelect: (position: HiringPosition) => void;
  onVisibilityChanged: (positionSourceId: string, isVisible: boolean) => void;
}) {
  return (
    <span className="flex w-24 shrink-0 items-center justify-end gap-2.5">
      <button type="button" onClick={() => onSelect(p)} className="text-note font-medium text-sdc-blue hover:underline" title="Edit this position">
        Edit
      </button>
      <HiringVisibilityControl position={p} canAssign={canAssign} onToggled={onVisibilityChanged} />
    </span>
  );
}

export function HiringPositionsList({
  positions,
  canAssign,
  canCreate,
  managerNames,
  onSelect,
  onVisibilityChanged,
  onCreate,
}: {
  positions: HiringPosition[];
  canAssign: boolean;
  canCreate: boolean;
  /** Paylocity id → name, for a request's hiring manager. */
  managerNames: ReadonlyMap<string, string>;
  onSelect: (position: HiringPosition) => void;
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

  const requests = useMemo(
    () =>
      visibilityFiltered
        .filter((p) => p.source === "manual")
        .sort((a, b) => (a.requestedAt?.getTime() ?? 0) - (b.requestedAt?.getTime() ?? 0)),
    [visibilityFiltered],
  );
  const postings = useMemo(() => visibilityFiltered.filter((p) => p.source === "workbook"), [visibilityFiltered]);

  // Matched against every posting, hidden ones included: hiding a posting
  // doesn't make the request any less posted.
  const postedAs = useMemo(() => new Map(requests.map((r) => [r.sourceId, findPostingForRequest(r, positions)])), [requests, positions]);

  const statuses = useMemo(() => [...new Set(postings.map((p) => p.status))].filter(Boolean).sort(), [postings]);

  const filtered = useMemo(() => {
    if (statusFilter === ALL_FILTER) return postings;
    return postings.filter((p) => p.status === statusFilter);
  }, [postings, statusFilter]);

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
          aria-label="Filter Paylocity postings by Job Status"
          className="h-8 rounded-lg border border-sdc-border bg-white px-2 text-xs text-sdc-navy outline-none focus:border-sdc-blue"
        >
          <option value={ALL_FILTER}>All Positions</option>
          {statuses.map((s) => (
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
            + Request a hire
          </button>
        )}
      </div>

      {requests.length > 0 && (
        <section className="overflow-hidden rounded-xl border border-sdc-border bg-white shadow-sm">
          <header className="flex items-center justify-between gap-2 border-b border-sdc-border bg-sdc-gray-50 px-3.5 py-2">
            <h3 className="text-sm font-bold text-sdc-navy">
              Requested <span className="font-normal text-sdc-muted">· not in Paylocity yet</span>
            </h3>
            <span className="text-xs font-semibold tabular-nums text-sdc-muted">{requests.length}</span>
          </header>
          <ul className="divide-y divide-sdc-border-soft">
            {requests.map((r) => {
              const posting = postedAs.get(r.sourceId);
              const manager = r.hiringManagerIds[0] ? managerNames.get(r.hiringManagerIds[0]) : undefined;
              return (
                <li key={r.sourceId} className="flex flex-wrap items-center gap-3 px-3.5 py-2.5">
                  <TitleButton p={r} onSelect={onSelect} />
                  <span className="min-w-0 shrink text-xs text-sdc-muted">
                    {[
                      `Requested ${waitingLabel(r.requestedAt)}`.trim(),
                      r.createdBy && `by ${r.createdBy}`,
                      manager && `hiring manager ${manager}`,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                  {posting && (
                    <span
                      className="shrink-0 rounded bg-sdc-blue-light px-1.5 py-0.5 text-note font-semibold text-sdc-blue-dark"
                      title={`Paylocity Job ${posting.sourceId}: ${posting.title}. Open it to close this request.`}
                    >
                      Looks posted
                    </span>
                  )}
                  <RowActions p={r} canAssign={canAssign} onSelect={onSelect} onVisibilityChanged={onVisibilityChanged} />
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {filtered.length === 0 ? (
        requests.length === 0 && <EmptyState title="No positions match" message="Try a different Job Status filter." />
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
            {/* Column headers for the rows below. Hidden on narrow widths, where the rows wrap. */}
            <div className="hidden items-center gap-3 border-b border-sdc-border-soft bg-white px-3.5 py-1.5 text-label font-bold uppercase tracking-wider text-sdc-muted sm:flex">
              <span className="min-w-0 flex-1">Position</span>
              <span className="w-28 shrink-0">Status</span>
              <span className="w-24 shrink-0" aria-hidden />
            </div>
            <ul className="divide-y divide-sdc-border-soft">
              {bucket.positions.map((p) => {
                const style = hiringStatusStyle(p.status);
                return (
                  <li key={p.sourceId} className={`flex flex-wrap items-center gap-3 border-l-2 px-3.5 py-2.5 ${style.accent} ${style.tint}`}>
                    <TitleButton p={p} onSelect={onSelect} />
                    <span className="w-28 shrink-0">
                      <HiringStatusPill status={p.status} />
                    </span>
                    <RowActions p={p} canAssign={canAssign} onSelect={onSelect} onVisibilityChanged={onVisibilityChanged} />
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
