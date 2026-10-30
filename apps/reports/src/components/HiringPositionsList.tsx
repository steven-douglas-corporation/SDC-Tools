"use client";

import { useMemo, useState, type ReactNode } from "react";
import { EmptyState } from "@/components/ui/EmptyState";
import { WORKFORCE_GROUPS, rollupGroup, workforceGroupTitle, type WorkforceGroupKey } from "@/lib/employee-workforce-groups";
import { EMPLOYEE_TEAMS } from "@/lib/employee-teams";
import { employeeGroupForKey, type CardColors } from "@/lib/employee-card-theme";
import type { HiringPosition } from "@/lib/hiring-positions";
import { HiringStatusPill } from "@/components/HiringStatusPill";
import { hiringStatusStyle } from "@/lib/hiring-position-status";
import { countOpenings, openingsSummary } from "@/lib/hiring-openings";
import { findPostingForRequest, waitingLabel } from "@/lib/hiring-requests";

// The Employees page's Hiring tab list (2026-08-19; its own tab since
// 2026-10-29). Never mixed into the people on the Org chart — the task's own
// "do not mix open positions into the actual employee list as if they are
// employees".
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
// A click anywhere on a row opens its panel (2026-10-30; rows used to end in
// an "Edit" link). A posting's group and department dropdowns live in its
// panel ("Move to"), one click away.

const DEPARTMENT_TITLE = new Map(EMPLOYEE_TEAMS.map((t) => [t.schedulerCode, t.name]));
const ALL_FILTER = "__all__";

type Bucket = { key: string; title: string; colors?: CardColors; positions: HiringPosition[] };

// The whole row is one button (2026-10-30), so the title is plain text inside
// it. Titles wrap, never truncate.
function RowTitle({ p }: { p: HiringPosition }) {
  return (
    <span className="block break-words text-sm font-medium text-sdc-navy">
      {p.title}
      {/* One row per requisition, never duplicated for display — the count
          rides the title as a badge instead, hidden at quantity 1. */}
      {p.quantity > 1 && (
        <span className="ml-1.5 rounded bg-sdc-blue-light px-1.5 py-0.5 text-note font-bold tabular-nums text-sdc-blue-dark">
          ×{p.quantity}
          {p.source === "workbook" && p.filledCount > 0 && <span className="font-normal"> · {p.remainingQuantity} left</span>}
        </span>
      )}
    </span>
  );
}

// A row: one full-width button that opens the position's panel.
function RowButton({
  p,
  onSelect,
  className,
  children,
}: {
  p: HiringPosition;
  onSelect: (position: HiringPosition) => void;
  /** Padding stays here; the caller adds the row's edge, tint and hover. */
  className: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(p)}
      title={openingsSummary(p) ? `${p.title} — ${openingsSummary(p)}` : p.title}
      className={`flex w-full flex-col gap-1 px-3.5 py-2.5 text-left motion-interactive focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-sdc-blue ${className}`}
    >
      {children}
    </button>
  );
}

// ── Cards, not page-wide tables (2026-10-29) ────────────────────────────────
// Each group is a card in equal-width columns, flowing top to bottom, so cards
// pack under each other whatever their heights. Requests get a dashed blue edge and a
// blue header (red until 2026-10-30): the band's blue "Requested", and the dashed "not a real seat yet"
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
        request ? "border-dashed border-sdc-blue/50" : "border-sdc-border"
      }`}
    >
      <header
        className={`flex items-center justify-between gap-2 border-b px-3.5 ${
          request ? "border-dashed border-sdc-blue/30 bg-sdc-blue-light py-2" : colors ? "border-transparent py-2.5" : "border-sdc-border bg-sdc-gray-50 py-2"
        }`}
        style={colors ? { background: colors.bg, color: colors.text } : undefined}
      >
        <h3 className={`truncate text-sm font-bold ${request ? "text-sdc-blue-dark" : colors ? "" : "text-sdc-navy"}`}>
          {title}
          {subtitle && <span className="font-normal text-sdc-muted"> · {subtitle}</span>}
        </h3>
        {/* Positions, not rows: a ×2 requisition (or request) counts 2. */}
        <span className={`text-xs font-semibold tabular-nums ${request ? "text-sdc-blue-dark" : colors ? "opacity-75" : "text-sdc-muted"}`}>{count}</span>
      </header>
      <ul className="divide-y divide-sdc-border-soft">{children}</ul>
    </section>
  );
}

export function HiringPositionsList({
  positions,
  canCreate,
  managerNames,
  onSelect,
  onCreate,
}: {
  positions: HiringPosition[];
  canCreate: boolean;
  /** Paylocity id → name, for a request's hiring manager. */
  managerNames: ReadonlyMap<string, string>;
  onSelect: (position: HiringPosition) => void;
  onCreate: () => void;
}) {
  const [statusFilter, setStatusFilter] = useState<string>(ALL_FILTER);

  const requests = useMemo(
    () =>
      positions
        .filter((p) => p.source === "manual")
        .sort((a, b) => (a.requestedAt?.getTime() ?? 0) - (b.requestedAt?.getTime() ?? 0)),
    [positions],
  );
  const postings = useMemo(() => positions.filter((p) => p.source === "workbook"), [positions]);

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

  // The team cards under the summary band's own groups (2026-10-30): Engineering,
  // Shop, PM… in band order, General Engineering rolled into Engineering, then
  // Unassigned. A group's count is its OPEN positions, the summary tile's number.
  const sections = useMemo(() => {
    const byGroup = new Map<string, Bucket[]>();
    for (const b of buckets) {
      const wg = b.positions[0]?.workforceGroup;
      const key = wg ? rollupGroup(wg) : "unassigned";
      const list = byGroup.get(key);
      if (list) list.push(b);
      else byGroup.set(key, [b]);
    }
    const order = [...WORKFORCE_GROUPS.map((g) => g.key as string), "unassigned"];
    return [...byGroup.entries()]
      .sort(([a], [b]) => order.indexOf(a) - order.indexOf(b))
      .map(([key, list]) => ({
        key,
        title: key === "unassigned" ? "Unassigned" : workforceGroupTitle(key as WorkforceGroupKey),
        published: countOpenings(list.flatMap((b) => b.positions).filter((p) => p.isOpen)),
        buckets: list,
      }));
  }, [buckets]);

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
        // Requested on its own full-width row, the Paylocity postings below it
        // (2026-10-30). Titles wrap rather than truncate.
        <div className="flex flex-col gap-4">
          {requests.length > 0 && (
            <GroupCard title="Requested" subtitle="not in Paylocity yet" count={countOpenings(requests)} request>
              {requests.map((r) => {
                const posting = postedAs.get(r.sourceId);
                const manager = r.hiringManagerIds[0] ? managerNames.get(r.hiringManagerIds[0]) : undefined;
                return (
                  <li key={r.sourceId}>
                    <RowButton p={r} onSelect={onSelect} className="hover:bg-sdc-gray-50">
                      <RowTitle p={r} />
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-sdc-muted">
                        {/* "Requested N days ago" in the Requested header's blue (2026-10-30); the rest stays muted. */}
                        <span>
                          {[
                            { key: "team", text: r.department && DEPARTMENT_TITLE.get(r.department) },
                            { key: "asked", text: `Requested ${waitingLabel(r.requestedAt)}`.trim(), accent: true },
                            { key: "by", text: r.createdBy && `by ${r.createdBy}` },
                            { key: "manager", text: manager && `hiring manager ${manager}` },
                          ]
                            .filter((m) => m.text)
                            .map((m, i) => (
                              <span key={m.key}>
                                {i > 0 && " · "}
                                <span className={m.accent ? "font-medium text-sdc-blue-dark" : undefined}>{m.text}</span>
                              </span>
                            ))}
                        </span>
                        {posting && (
                          <span
                            className="rounded bg-sdc-green-bg px-1.5 py-0.5 text-note font-semibold text-sdc-green-text"
                            title={`Paylocity Job ${posting.sourceId}: ${posting.title}. Open it to close this request.`}
                          >
                            Looks posted
                          </span>
                        )}
                      </span>
                    </RowButton>
                  </li>
                );
              })}
            </GroupCard>
          )}

          {/* One section per group, headed like the Org chart's groups, its team
              cards side by side. Groups share a line when they fit, the same
              flow and sizing as OrgChart.tsx's Group. */}
          {sections.length > 0 && (
            <div className="flex flex-wrap items-start gap-x-5 gap-y-4">
              {sections.map((s) => (
                <section key={s.key} className="min-w-0 max-w-full flex-1" style={{ flexBasis: `${Math.max(1, s.buckets.length) * 20}rem` }}>
                  <h3 className="mb-2 border-b border-sdc-border pb-1 text-xs font-bold uppercase tracking-wider text-sdc-muted">
                    {s.title}
                    <span className="ml-2 font-normal normal-case tracking-normal text-sdc-gray-400">{s.published} published</span>
                  </h3>
                  <div className="grid items-start gap-3 [grid-template-columns:repeat(auto-fill,minmax(18rem,1fr))]">
                    {s.buckets.map((bucket) => (
                      <GroupCard key={bucket.key} title={bucket.title} colors={bucket.colors} count={countOpenings(bucket.positions)}>
                        {bucket.positions.map((p) => {
                          const style = hiringStatusStyle(p.status);
                          return (
                            <li key={p.sourceId}>
                              <RowButton p={p} onSelect={onSelect} className={`border-l-2 hover:brightness-95 ${style.accent} ${style.tint}`}>
                                <RowTitle p={p} />
                                <span className="flex flex-wrap items-center gap-2 text-xs text-sdc-muted">
                                  <HiringStatusPill status={p.status} />
                                </span>
                              </RowButton>
                            </li>
                          );
                        })}
                      </GroupCard>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
