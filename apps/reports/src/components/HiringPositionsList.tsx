"use client";

import { useMemo, useState, type ReactNode } from "react";
import { EmptyState } from "@/components/ui/EmptyState";
import { HiringVisibilityControl } from "@/components/HiringVisibilityControl";
import { WORKFORCE_GROUPS, workforceGroupTitle, type WorkforceGroupKey } from "@/lib/employee-workforce-groups";
import { EMPLOYEE_TEAMS } from "@/lib/employee-teams";
import { employeeGroupForKey, type CardColors } from "@/lib/employee-card-theme";
import type { HiringPosition } from "@/lib/hiring-positions";
import { HiringStatusPill } from "@/components/HiringStatusPill";
import { hiringStatusStyle } from "@/lib/hiring-position-status";
import { countOpenings, openingsSummary } from "@/lib/hiring-openings";
import { findPostingForRequest, waitingLabel } from "@/lib/hiring-requests";

// Level 2 for the "Hiring Positions" card (2026-08-19). Never mixed into
// EmployeesCards' own employee list — the task's own "do not mix open positions
// into the actual employee list as if they are employees".
//
// Two kinds of row (2026-10-29), each group a card (see GroupCard below):
// - Hire requests, in their own card first, oldest first: what managers
//   have asked the recruiter to post. They never count toward hiring totals.
//   Each shows who asked, how long ago, and the hiring manager; one that the app
//   has matched to a Paylocity posting says "Looks posted", and its panel closes
//   it in one click. See lib/hiring-requests.ts.
// - Paylocity postings, bucketed by team with the Org chart's team titles and
//   colors (a saved assignment if any, else the hiring manager's team — see
//   hiring-positions.ts; no team yet = a gray workforce-group card), each with its Job
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

type Bucket = { key: string; title: string; colors?: CardColors; positions: HiringPosition[] };

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
      {!p.isVisible && (
        <span className="ml-2 rounded bg-sdc-yellow-bg px-1.5 py-0.5 text-micro font-bold uppercase tracking-wide text-sdc-yellow-text">Hidden</span>
      )}
    </button>
  );
}

// ── Cards, not page-wide tables (2026-10-29) ────────────────────────────────
// Each group is a card in equal-width columns, flowing top to bottom, so cards
// pack under each other whatever their heights. Requests get a dashed red edge and a
// red header: the band's red "Requested", and the dashed "not a real seat yet"
// grammar the team cards use for openings.
function GroupCard({
  title,
  subtitle,
  count,
  request = false,
  colors,
  children,
}: {
  title: string;
  subtitle?: string;
  count: number;
  request?: boolean;
  /** A team's Org chart colors; without them the header is plain gray. */
  colors?: CardColors;
  children: ReactNode;
}) {
  return (
    <section
      className={`flex min-w-0 flex-col overflow-hidden rounded-xl border bg-white shadow-sm ${
        request ? "border-dashed border-sdc-red-text/50" : "border-sdc-border"
      }`}
    >
      <header
        className={`flex items-center justify-between gap-2 border-b px-3.5 ${
          request ? "border-dashed border-sdc-red-text/30 bg-sdc-red-bg py-2" : colors ? "border-transparent py-2.5" : "border-sdc-border bg-sdc-gray-50 py-2"
        }`}
        style={colors ? { background: colors.bg, color: colors.text } : undefined}
      >
        <h3 className={`truncate text-sm font-bold ${request ? "text-sdc-red-text" : colors ? "" : "text-sdc-navy"}`}>
          {title}
          {subtitle && <span className="font-normal text-sdc-muted"> · {subtitle}</span>}
        </h3>
        {/* Positions, not rows: a ×2 requisition (or request) counts 2. */}
        <span className={`text-xs font-semibold tabular-nums ${request ? "text-sdc-red-text" : colors ? "opacity-75" : "text-sdc-muted"}`}>{count}</span>
      </header>
      <ul className="divide-y divide-sdc-border-soft">{children}</ul>
    </section>
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

  // By team (2026-10-29), titled and colored like the Org chart's team cards,
  // in the roster's team order. A posting with no team yet falls back to a gray
  // card for its workforce group, or Unassigned.
  const buckets = useMemo<Bucket[]>(() => {
    const byKey = new Map<string, HiringPosition[]>();
    const keyOf = (p: HiringPosition) => (p.department ? `team:${p.department}` : `group:${p.workforceGroup ?? "unassigned"}`);
    for (const p of filtered) {
      const list = byKey.get(keyOf(p));
      if (list) list.push(p);
      else byKey.set(keyOf(p), [p]);
    }
    // Delivery teams in roster order, then back-office teams, then the gray
    // no-team cards, Unassigned last.
    const teams = EMPLOYEE_TEAMS.map((t) => `team:${t.schedulerCode}`);
    const groups = [...WORKFORCE_GROUPS.map((g) => `group:${g.key}`), "group:unassigned"];
    const rank = (k: string) =>
      teams.includes(k) ? teams.indexOf(k) : k.startsWith("team:") ? teams.length : teams.length + 1 + groups.indexOf(k);
    return [...byKey.entries()]
      .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
      .map(([key, positions]) => {
        if (key.startsWith("team:")) {
          const group = employeeGroupForKey(key.slice(5));
          return { key, title: group?.title ?? key.slice(5), colors: group?.colors, positions };
        }
        const g = key.slice(6);
        return { key, title: g === "unassigned" ? "Unassigned" : workforceGroupTitle(g as WorkforceGroupKey), positions };
      });
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

      {requests.length === 0 && filtered.length === 0 ? (
        <EmptyState title="No positions match" message="Try a different Job Status filter." />
      ) : (
        // Equal columns (2026-10-29): every card the same width, wide enough
        // for a title like "Mechanical Design Engineer" beside Edit / Hide.
        // Column flow, not a grid: each card sits right under the one above it,
        // so a tall Requested card doesn't set the height of a whole row.
        <div className="gap-x-5 [columns:22rem] *:mb-4 *:break-inside-avoid">
          {requests.length > 0 && (
            <GroupCard title="Requested" subtitle="not in Paylocity yet" count={countOpenings(requests)} request>
              {requests.map((r) => {
                const posting = postedAs.get(r.sourceId);
                const manager = r.hiringManagerIds[0] ? managerNames.get(r.hiringManagerIds[0]) : undefined;
                return (
                  <li key={r.sourceId} className="flex flex-col gap-1 px-3.5 py-2.5">
                    <div className="flex items-center gap-3">
                      <TitleButton p={r} onSelect={onSelect} />
                      <RowActions p={r} canAssign={canAssign} onSelect={onSelect} onVisibilityChanged={onVisibilityChanged} />
                    </div>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-sdc-muted">
                      <span>
                        {[
                          r.department && DEPARTMENT_TITLE.get(r.department),
                          `Requested ${waitingLabel(r.requestedAt)}`.trim(),
                          r.createdBy && `by ${r.createdBy}`,
                          manager && `hiring manager ${manager}`,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                      {posting && (
                        <span
                          className="rounded bg-sdc-blue-light px-1.5 py-0.5 text-note font-semibold text-sdc-blue-dark"
                          title={`Paylocity Job ${posting.sourceId}: ${posting.title}. Open it to close this request.`}
                        >
                          Looks posted
                        </span>
                      )}
                    </div>
                  </li>
                );
              })}
            </GroupCard>
          )}

          {buckets.map((bucket) => (
            <GroupCard key={bucket.key} title={bucket.title} colors={bucket.colors} count={countOpenings(bucket.positions)}>
              {bucket.positions.map((p) => {
                const style = hiringStatusStyle(p.status);
                return (
                  <li key={p.sourceId} className={`flex flex-col gap-1 border-l-2 px-3.5 py-2.5 ${style.accent} ${style.tint}`}>
                    <div className="flex items-center gap-3">
                      <TitleButton p={p} onSelect={onSelect} />
                      <RowActions p={p} canAssign={canAssign} onSelect={onSelect} onVisibilityChanged={onVisibilityChanged} />
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-sdc-muted">
                      <HiringStatusPill status={p.status} />
                    </div>
                  </li>
                );
              })}
            </GroupCard>
          ))}
        </div>
      )}
    </div>
  );
}
