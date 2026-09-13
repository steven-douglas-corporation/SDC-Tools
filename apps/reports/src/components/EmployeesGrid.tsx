"use client";

import { useMemo, useState } from "react";
import { CARD_RENDER_ORDER } from "@/components/WorkforceSummaryCards";
import { buildDepartmentCards } from "@/lib/employee-department-cards";
import { EmployeesCards } from "@/components/EmployeesCards";
import { HiringPositionsSummary } from "@/components/HiringPositionsSummary";
import { WorkforceSummaryCards } from "@/components/WorkforceSummaryCards";
import { EmployeeDetailDrawer } from "@/components/EmployeeDetailDrawer";
import { HiringPositionsList } from "@/components/HiringPositionsList";
import { HiringPositionDetailDrawer } from "@/components/HiringPositionDetailDrawer";
import { CreateHiringPositionDrawer } from "@/components/CreateHiringPositionDrawer";
import { CapacityDrillDrawer } from "@/components/CapacityDrillDrawer";
import { DASH, type EmployeeRow } from "@/lib/employee-row";
import { resolveEmployeeGroup } from "@/lib/employee-card-theme";
import { resolvePlaceholderGroup } from "@/lib/employee-department-cards";
import {
  workforceGroupForCardKey,
  workforceGroupLongTitle,
  groupInScope,
  isExecutionGroup,
  rollupGroup,
  DEFAULT_TEAM_SCOPE,
  TEAM_SCOPE_LABEL,
  type TeamScope,
  type WorkforceGroupKey,
} from "@/lib/employee-workforce-groups";
import { countOpenings } from "@/lib/hiring-openings";
import type { SchedulerPlaceholder } from "@/lib/scheduler-db";
import type { HiringPosition } from "@/lib/hiring-positions";
import { MenuBulkActions, MenuCheckbox } from "@/components/MenuStatus";

// Toolbar + filtering + drill-down navigation for the employee roster;
// WorkforceSummaryCards/EmployeesCards/HiringPositionsList render the actual
// cards/lists.
//
// The Discipline and Dept dropdowns used to be a floating-filter row inside AG
// Grid, directly under the column headers. They live here now, next to the
// search box that was always in the toolbar anyway — one row of controls instead
// of two, and the table's header row goes back to being just headers.
const SELECT =
  "h-8 rounded-lg border border-sdc-border bg-white px-2 text-xs text-sdc-navy outline-none focus:border-sdc-blue";

// Department needs multiple-at-once (by request, 2026-08-18 — comparing two
// or three departments side by side in the unified table), unlike Discipline,
// which stays a plain single-value <select>. Plain client state, not the
// URL-param-driven pattern HoursFilterMenu/ProjectsFilterMenu use — this
// whole page is already an in-memory filter over a fully-loaded roster with
// no server round-trip to save, so a second, heavier apparatus would buy
// nothing. Reuses MenuCheckbox/MenuBulkActions (MenuStatus.tsx) since those
// are already plain presentational pieces, not tied to that URL-draft hook.
function DepartmentMenu({
  options,
  selected,
  onChange,
}: {
  options: string[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const label = selected.length === 0 ? "All departments" : selected.length === 1 ? selected[0] : `${selected.length} departments`;
  const toggle = (d: string) => onChange(selected.includes(d) ? selected.filter((x) => x !== d) : [...selected, d]);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`${SELECT} inline-flex max-w-48 items-center gap-1.5 truncate`}
      >
        <span className="truncate">{label}</span>
        <svg viewBox="0 0 16 16" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="2" className={`shrink-0 opacity-60 motion-interactive ${open ? "rotate-180" : ""}`}>
          <path d="M3.5 6 L8 10.5 L12.5 6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <>
          {/* Click-outside to close — a transparent full-screen layer under the panel. */}
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="motion-menu-panel styled-scrollbar absolute left-0 top-full z-30 mt-1 max-h-72 w-64 overflow-y-auto rounded-lg border border-sdc-border bg-white p-2 shadow-lg">
            <MenuBulkActions onAll={() => onChange(options)} onNone={() => onChange([])} />
            {options.map((d) => (
              <MenuCheckbox key={d} label={d} checked={selected.includes(d)} onChange={() => toggle(d)} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// The heading above an EXPANDED workforce group (2026-08-21) — the overview
// cards themselves stay rendered above it: the group's name, its own roll-up, and a
// single-action way back. Counts are derived from the SAME already-scoped
// rows/positions the department cards below render, so this line can never
// disagree with the sum of the cards under it.
function GroupHeader({
  title,
  activeCount,
  hiringCount,
  departmentCount,
  onCollapse,
}: {
  title: string;
  activeCount: number;
  hiringCount: number;
  departmentCount: number;
  /** Omitted for the always-expanded group sections — there is nothing to collapse back to. */
  onCollapse?: () => void;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-sdc-border bg-sdc-gray-50 px-4 py-2.5">
      <div>
        <h2 className="text-sm font-bold uppercase tracking-wide text-sdc-navy">{title}</h2>
        <div className="flex items-baseline gap-1.5 text-xs text-sdc-muted">
          {activeCount > 0 && (
            <>
              <span className="font-bold tabular-nums text-sdc-navy">{activeCount}</span>
              <span>active</span>
            </>
          )}
          {hiringCount > 0 && (
            <>
              {activeCount > 0 && <span className="text-sdc-gray-400">·</span>}
              <span className="font-bold tabular-nums text-sdc-green-text">{hiringCount}</span>
              <span>hiring</span>
              {activeCount > 0 && (
                <>
                  <span className="text-sdc-gray-400">·</span>
                  <span className="font-bold tabular-nums text-sdc-navy">{activeCount + hiringCount}</span>
                  <span>planned</span>
                </>
              )}
            </>
          )}
          {departmentCount > 1 && (
            <>
              <span className="text-sdc-gray-400">·</span>
              <span className="font-bold tabular-nums text-sdc-navy">{departmentCount}</span>
              <span>department{departmentCount === 1 ? "" : "s"}</span>
            </>
          )}
        </div>
      </div>
      {onCollapse && (
        <button type="button" onClick={onCollapse} className="text-sm font-medium text-sdc-blue hover:underline" title="Show every group again">
          Show all groups ✕
        </button>
      )}
    </div>
  );
}

// `disciplines` drives the toolbar filter only. The table itself is read-only,
// so it no longer needs the discipline or supervisor option lists that used to
// populate its in-cell dropdowns.
export function EmployeesGrid({
  rows,
  disciplines,
  placeholders,
  canAddEmployees,
  hiringPositions,
  hiringError,
  canAssignHiring,
  year,
}: {
  rows: EmployeeRow[];
  disciplines: string[];
  placeholders: SchedulerPlaceholder[];
  canAddEmployees: boolean;
  hiringPositions: HiringPosition[];
  hiringError: string | null;
  canAssignHiring: boolean;
  /** For workforce-capacity-policy.ts/workforce-capacity.ts — see page.tsx's own note on why this is computed once, server-side. */
  year: number;
}) {
  const [q, setQ] = useState("");
  // Entire Team vs Execution Team (2026-08-24). Deliberately ONE piece of state
  // feeding the two existing choke points below (`scopedToTeam` for people,
  // `openHiring` for requisitions) rather than a second dataset: every count,
  // capacity figure and KPI on this tab already derives from those two, so they
  // all recalculate for the selected view with no separate bookkeeping and no
  // chance of the two views disagreeing.
  const [teamScope, setTeamScope] = useState<TeamScope>(DEFAULT_TEAM_SCOPE);
  const [showInactive, setShowInactive] = useState(false);
  const [discipline, setDiscipline] = useState("");
  const [dept, setDept] = useState<string[]>([]);

  // ── Drill-down navigation (2026-08-19) — Employees > workforce group >
  // department, OR Employees > Hiring Positions; the two detail drawers are
  // independent overlay state, since they're overlays rather than navigation
  // levels (closing one returns to whatever level/filters were already
  // showing underneath). All of this lives in THIS component, alongside the
  // filter state above, precisely so drilling in/out and opening/closing a
  // drawer never resets a filter — there is nothing here that unmounts on
  // navigation, only state that changes.
  // NOT a scope (2026-08-21) — purely which department card to scroll to and
  // ring once a group opens. The old third level (Overview > Engineering >
  // Controls Engineering) narrowed the view to one department, which meant
  // seeing Controls Engineering's people cost two clicks and hid its siblings;
  // now every department of the open group is on screen at once and this only
  // says where to land.
  const [showHiring, setShowHiring] = useState(false);
  const [selectedEmployee, setSelectedEmployee] = useState<EmployeeRow | null>(null);
  const [selectedHiringPosition, setSelectedHiringPosition] = useState<HiringPosition | null>(null);
  const [creatingHiringPosition, setCreatingHiringPosition] = useState(false);
  // "How was this capacity-hours total built" -- a different question ("which
  // employees/positions, what proration") from the group/department drills
  // above ("who"), so it's its own piece of overlay state rather than reusing
  // group.
  const [capacityDrill, setCapacityDrill] = useState<{ title: string; subtitle?: string; employees: EmployeeRow[]; hiringPositions: HiringPosition[] } | null>(null);

  // Local, optimistically-updated copy of the server-loaded positions — a
  // successful assign/create/update (hiring-actions.ts) updates this
  // immediately rather than waiting on a full page reload, the same "apply
  // what the server action returned, don't guess" spirit as everywhere else
  // in this app that updates client state from a server action's result.
  // Includes BOTH open and closed positions now (2026-08-19, Job Status) —
  // `openHiring` below is the one place that narrows back down to what
  // should count toward hiring/planned-headcount totals.
  const [hiring, setHiring] = useState(hiringPositions);

  function applyAssignment(positionSourceId: string, next: { workforceGroup: WorkforceGroupKey | null; department: string | null }) {
    setHiring((prev) =>
      prev.map((p) => (p.sourceId === positionSourceId ? { ...p, workforceGroup: next.workforceGroup, department: next.department, isManuallyAssigned: true } : p)),
    );
    setSelectedHiringPosition((prev) =>
      prev && prev.sourceId === positionSourceId ? { ...prev, workforceGroup: next.workforceGroup, department: next.department, isManuallyAssigned: true } : prev,
    );
  }

  function applyHiringUpdate(positionSourceId: string, patch: Partial<HiringPosition>) {
    setHiring((prev) => prev.map((p) => (p.sourceId === positionSourceId ? { ...p, ...patch } : p)));
    setSelectedHiringPosition((prev) => (prev && prev.sourceId === positionSourceId ? { ...prev, ...patch } : prev));
  }

  function applyHiringCreate(position: HiringPosition) {
    setHiring((prev) => [position, ...prev]);
  }

  // Always OPEN positions only — the input WorkforceSummaryCards/EmployeesCards'
  // hiring-count formulas expect (see WorkforceSummaryCards' own "Already OPEN
  // positions only" comment). A closed/filled position (from either source)
  // never inflates a count, regardless of what HiringPositionsList's own Job
  // Status filter is currently showing.
  const openHiring = useMemo(
    // Scoped alongside the people (2026-08-24): an Execution Team view that
    // still counted a Finance requisition in Open Positions and Hiring Capacity
    // hours would contradict the cards right beside it. An UNASSIGNED position
    // (no workforce group yet) is deliberately dropped from the execution view
    // — it cannot be claimed for a group it has not been assigned to.
    () => hiring.filter((p) => p.isOpen && (teamScope === "entire" || (p.workforceGroup ? groupInScope(p.workforceGroup, teamScope) : false))),
    [hiring, teamScope],
  );

  // The scope narrowing, applied ONCE here and then used as the input to every
  // list and count below — the search/discipline/department filters, the
  // toolbar totals, and the department dropdown's own options. Doing it here
  // rather than at each site is what guarantees the views can't drift apart.
  //
  // Routed through the same resolveEmployeeGroup -> workforceGroupForCardKey
  // pair the cards themselves use, so "which employees are Execution Team" has
  // exactly one answer and it is the one the Engineering/Shop/PM cards are
  // already built from.
  const scopedToTeam = useMemo(() => {
    if (teamScope === "entire") return rows;
    return rows.filter((r) => {
      const card = resolveEmployeeGroup(r);
      // No card at all (a hidden department) is not part of the Execution Team.
      return card ? isExecutionGroup(workforceGroupForCardKey(card.key)) : false;
    });
  }, [rows, teamScope]);

  // Departments actually present in the data, so the dropdown can't offer a
  // value that would filter to nothing — which now means "present in the
  // CURRENT scope", or Execution Team would still offer Finance.
  const departments = useMemo(
    () => [...new Set(scopedToTeam.map((r) => r.department?.trim()).filter((d): d is string => !!d && d !== DASH))].sort(),
    [scopedToTeam],
  );

  const visible = useMemo(() => {
    const s = q.trim().toLowerCase();
    return scopedToTeam.filter((r) => {
      if (!showInactive && !r.active) return false;
      if (discipline && r.discipline !== discipline) return false;
      if (dept.length > 0 && !dept.includes(r.department?.trim() ?? "")) return false;
      if (!s) return true;
      // Same fields the old grid's quick filter covered.
      return [r.name, r.discipline, r.positionTitle, r.supervisor, r.department].some((v) =>
        String(v ?? "").toLowerCase().includes(s),
      );
    });
  }, [scopedToTeam, q, showInactive, discipline, dept]);

  // Scoped, so the toolbar's "N active" agrees with the cards below it rather
  // than always reporting the whole company.
  const activeCount = scopedToTeam.filter((r) => r.active).length;

  // While searching with inactive hidden, count how many INACTIVE people match
  // so we can offer to reveal them — otherwise a departed employee is
  // unfindable (search only filters the visible/active rows) and reactivation,
  // the whole point of soft-delete, is hard to discover.
  const hiddenInactiveMatches = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s || showInactive) return 0;
    return scopedToTeam.filter(
      (r) =>
        !r.active &&
        [r.name, r.discipline, r.positionTitle, r.supervisor, r.department].some((v) => String(v ?? "").toLowerCase().includes(s)),
    ).length;
  }, [scopedToTeam, q, showInactive]);


  // Clicking the open card again collapses it — the card IS the toggle, so
  // "get back to just the overview" is the same one click that opened it.

  function openHiringView() {
    setShowHiring((prev) => !prev);
  }

  // Only the Hiring Positions view is a "view" any more — the workforce-group
  // narrowing went with the summary cards that used to trigger it.
  function collapse() {
    setShowHiring(false);
  }

  function selectEmployee(row: EmployeeRow) {
    setSelectedHiringPosition(null);
    setSelectedEmployee(row);
  }

  function selectHiringPosition(position: HiringPosition) {
    setSelectedEmployee(null);
    setSelectedHiringPosition(position);
  }

  // ── Every group expanded by default (2026-08-24, by request) ──────────────
  //
  // The page used to show only the parent cards, and reaching an employee took a
  // click into one group. Now every group renders its own section — departments
  // and the people inside them — with no click required. The parent cards above
  // stay as the summary and the capacity drill-through.
  //
  // Composition rather than new UI: EmployeesCards already renders a department
  // card WITH its employees, so this calls it once per group instead of once for
  // whichever group was clicked. The grouping logic is untouched — the same
  // resolveEmployeeGroup -> workforceGroupForCardKey -> rollupGroup chain the
  // cards use, so General Engineering still rolls into Engineering and Sales into
  // Growth exactly as before.
  //
  // Ordered by CARD_RENDER_ORDER, imported from WorkforceSummaryCards rather than
  // re-listed, so the sections appear in the same order as the cards they sit
  // under. Groups with nothing in them after filtering are dropped rather than
  // rendered as an empty header.
  const groupSections = useMemo(() => {
    const groupOf = (r: EmployeeRow) => {
      const card = resolveEmployeeGroup(r);
      return card ? rollupGroup(workforceGroupForCardKey(card.key)) : null;
    };
    return CARD_RENDER_ORDER.map((key) => {
      const rows = visible.filter((r) => groupOf(r) === key);
      const hiring = openHiring.filter((p) => p.workforceGroup && rollupGroup(p.workforceGroup) === key);
      // resolvePlaceholderGroup, NOT the discipline string: a placeholder is not
      // an employee and has its own resolution path. Getting this wrong would
      // drop a Shop placeholder into Engineering as an out-of-place card, since
      // EmployeesCards creates a card for any placeholder it is handed.
      const ph = placeholders.filter((p) => {
        const card = resolvePlaceholderGroup(p);
        return card ? rollupGroup(workforceGroupForCardKey(card.key)) === key : false;
      });
      // The real card count, from the same builder EmployeesCards uses — so the
      // container asks for exactly as much width as it will fill, rather than a
      // guess from the number of distinct departments.
      const cardCount = buildDepartmentCards(rows, ph).length;
      return { key, rows, hiring, placeholders: ph, cardCount };
    }).filter((g) => g.rows.length > 0 || g.hiring.length > 0);
  }, [visible, openHiring, placeholders]);

  // A parent card click now NARROWS to that one group rather than being the only
  // way to see it — "Show all groups" in its header restores the full board.
  // Every group, always — there is no longer a control that narrows to one.
  const shownSections = groupSections;

  // ── Two top-level bands (2026-08-24, by request) ──────────────────────────
  //
  // Execution = Project Management, Engineering, Shop. Operations = the
  // back-office groups. Derived from isExecutionGroup(), the SAME predicate the
  // Entire Team / Execution Team toggle already uses, rather than a second list
  // of group keys — so the band a group appears in and the scope it belongs to
  // can never disagree.
  //
  // It also makes the toggle fall out for free: on Execution Team, `visible`
  // holds no back-office rows, so those sections are empty, get dropped, and the
  // Operations band renders nothing at all. No separate hiding rule.
  const bands = [
    { key: "execution", title: "Execution", blurb: "Project Management, Engineering and Shop" },
    { key: "operations", title: "Operations", blurb: "Growth, Finance, Executive Leadership and Operations" },
  ].map((b) => {
    const sections = shownSections.filter((sec) => (b.key === "execution" ? isExecutionGroup(sec.key) : !isExecutionGroup(sec.key)));
    // Flattened to ONE set per band, not kept per workforce group. That is what
    // lets PM, Engineering and Shop cards share a row: EmployeesCards lays its
    // cards out in a single CSS multi-column flow, so a separate call per group
    // meant a separate flow per group, and Engineering could never sit beside
    // PM no matter how much width was available.
    return {
      ...b,
      sections,
      rows: sections.flatMap((sec) => sec.rows),
      hiring: sections.flatMap((sec) => sec.hiring),
    };
  }).filter((b) => b.rows.length > 0 || b.hiring.length > 0);

  const selectedEmployeeGroup = selectedEmployee ? resolveEmployeeGroup(selectedEmployee) : null;


  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        {/* Team scope — first in the toolbar because it is a level ABOVE the
            filters beside it: those narrow who you are looking at within a
            roster, this chooses which roster. A segmented control rather than a
            <select>, so both options and the current one are readable at a
            glance; radios rather than buttons so it announces itself as one
            choice of two to a screen reader. */}
        <div role="radiogroup" aria-label="Team scope" className="flex items-center rounded-lg border border-sdc-border bg-white p-0.5">
          {(["entire", "execution"] as const).map((scope) => {
            const selected = teamScope === scope;
            return (
              <button
                key={scope}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setTeamScope(scope)}
                title={
                  scope === "execution"
                    ? "Engineering, Shop and Project Management only"
                    : "Every department, including Growth, Finance, Executive Leadership and Operations"
                }
                className={`rounded-md px-3 py-1.5 text-xs font-semibold motion-interactive ${
                  selected ? "bg-sdc-blue text-white" : "text-sdc-gray-600 hover:bg-sdc-blue-light"
                }`}
              >
                {TEAM_SCOPE_LABEL[scope]}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-2.5 rounded-lg border border-sdc-border bg-white px-3.5">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-sdc-gray-400">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search…"
            className="w-56 border-none bg-transparent py-2 text-sm text-sdc-navy outline-none placeholder:text-sdc-gray-400"
          />
        </div>
        <select value={discipline} onChange={(e) => setDiscipline(e.target.value)} aria-label="Filter by discipline" className={SELECT}>
          <option value="">All disciplines</option>
          {disciplines.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
        <DepartmentMenu options={departments} selected={dept} onChange={setDept} />
        <label className="flex items-center gap-2 text-xs font-medium text-sdc-gray-600">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} className="h-3.5 w-3.5" />
          Show inactive
        </label>
        <span className="text-xs text-sdc-gray-400">
          {activeCount} active{showInactive ? ` · ${scopedToTeam.length - activeCount} inactive` : ""}
          {/* Shown only when a filter is narrowing things, so the count doesn't
              contradict the roster total on an unfiltered view. */}
          {visible.length !== (showInactive ? scopedToTeam.length : activeCount) ? ` · ${visible.length} shown` : ""}
        </span>
        {hiddenInactiveMatches > 0 && (
          <button
            type="button"
            onClick={() => setShowInactive(true)}
            className="text-xs font-medium text-sdc-blue hover:underline"
          >
            {hiddenInactiveMatches} inactive {hiddenInactiveMatches === 1 ? "person matches" : "people match"} — show them
          </button>
        )}
      </div>

      {hiringError && (
        <p className="mb-3 rounded border border-sdc-yellow bg-sdc-yellow-bg px-2 py-1 text-note text-sdc-yellow-text">
          Couldn&apos;t read the hiring positions workbook: {hiringError}
        </p>
      )}

      <WorkforceSummaryCards
        rows={visible}
        placeholders={placeholders}
        hiringPositions={openHiring}
        year={year}
        onSelectCapacity={setCapacityDrill}
      />

      {/* The expansion (2026-08-21) — rendered UNDER the overview cards, which
          stay on screen, rather than replacing them. Clicking Engineering used
          to swap the whole area out and push you into an "Overview /
          Engineering / Controls Engineering" trail; now every department of
          the clicked group, with its people, opens right here in the same
          Employees tab and the other groups are still one click away. */}
      {(
        bands.map((band) => (
          <section key={band.key} className="mt-6">
            {/* The band heading — a rule across the full width and uppercase
                tracking, so the page reads as two places (execution work,
                business support) rather than one long run of equally-weighted
                cards. It is the only header in the band now: the per-group
                headers were removed so all of a band's cards share one flow. */}
            <div className="mb-3 flex items-baseline gap-3 border-b-2 border-sdc-navy pb-1.5">
              <h2 className="text-base font-bold uppercase tracking-wider text-sdc-navy">{band.title}</h2>
              <span className="text-xs text-sdc-muted">{band.blurb}</span>
              <span className="ml-auto text-xs text-sdc-muted">
                <span className="font-bold tabular-nums text-sdc-navy">
                  {band.rows.filter((r) => r.active).length}
                </span>{" "}
                active
              </span>
            </div>
            {/* Group containers in a flex row, so several share a line when they
                fit (2026-08-24). Each keeps its own header and its own cards, and
                a group either fits on the current line or wraps whole — cards are
                never interleaved between groups to fill space.

                The width comes from the group's own card count: flex-basis is
                ~17rem per card, so Project Management (1 card) asks for a narrow
                box and Engineering (3) a wide one, and PM + Engineering pack onto
                one line where Engineering alone would have left two thirds of it
                empty. `flex-1` lets them then stretch to fill the row exactly, and
                max-w-full stops a wide group overflowing a narrow screen.

                No breakpoints here on purpose: the packing is whatever the widths
                allow, and EmployeesCards now picks its column count from the
                container it lands in rather than from the viewport. */}
            <div className="flex flex-wrap items-start gap-x-5 gap-y-4">
              {band.sections.map((sec) => (
                <div
                  key={sec.key}
                  className="min-w-0 max-w-full flex-1"
                  style={{ flexBasis: `${Math.max(1, sec.cardCount) * 17}rem` }}
                >
                  <h3 className="mb-2 border-b border-sdc-border pb-1 text-xs font-bold uppercase tracking-wider text-sdc-muted">
                    {workforceGroupLongTitle(sec.key)}
                    <span className="ml-2 font-normal normal-case tracking-normal text-sdc-gray-400">
                      {sec.rows.filter((r) => r.active).length} active
                      {countOpenings(sec.hiring) > 0 && ` · ${countOpenings(sec.hiring)} hiring`}
                    </span>
                  </h3>
                  <EmployeesCards
                    rows={sec.rows}
                    placeholders={sec.placeholders}
                    canAddEmployees={canAddEmployees}
                    onSelectEmployee={selectEmployee}
                    focusDepartment={null}
                    hiringPositions={sec.hiring}
                    onSelectHiringPosition={selectHiringPosition}
                    year={year}
                    onSelectCapacity={setCapacityDrill}
                    canAssignHiring={canAssignHiring}
                  />
                </div>
              ))}
            </div>
          </section>
        ))
      )}

      {/* Hiring Positions last, after Execution and Operations (2026-08-24).
          Full width, and hidden entirely when nothing is open — the same rule the
          old aside followed. */}
      <HiringPositionsSummary
          hiringPositions={openHiring}
          year={year}
          onSelectHiring={openHiringView}
          onSelectCapacity={setCapacityDrill}
        expanded={showHiring}
      />

      {/* The list opens BELOW the summary that toggles it, and the workforce
          bands stay on screen (2026-08-24). It used to replace them and render
          at the top — which was fine while the summary card was up there too,
          and disorienting once the summary moved to the bottom: you clicked at
          the foot of the page and the content you were looking at vanished. */}
      {showHiring && (
        <div className="mt-4">
          <GroupHeader title="Hiring Positions" activeCount={0} hiringCount={countOpenings(openHiring)} departmentCount={0} onCollapse={collapse} />
          <HiringPositionsList
            positions={hiring}
            canAssign={canAssignHiring}
            canCreate={canAssignHiring}
            onSelect={selectHiringPosition}
            onAssigned={applyAssignment}
            onVisibilityChanged={(sourceId, isVisible) => applyHiringUpdate(sourceId, { isVisible })}
            onCreate={() => setCreatingHiringPosition(true)}
          />
        </div>
      )}

      {selectedEmployee && (
        <EmployeeDetailDrawer
          employee={selectedEmployee}
          departmentTitle={selectedEmployeeGroup?.title ?? selectedEmployee.department?.trim() ?? DASH}
          workforceGroup={workforceGroupForCardKey(selectedEmployeeGroup?.key ?? "")}
          onClose={() => setSelectedEmployee(null)}
        />
      )}

      {selectedHiringPosition && (
        <HiringPositionDetailDrawer
          position={selectedHiringPosition}
          canAssign={canAssignHiring}
          onAssigned={applyAssignment}
          onUpdated={applyHiringUpdate}
          onClose={() => setSelectedHiringPosition(null)}
        />
      )}

      {creatingHiringPosition && (
        <CreateHiringPositionDrawer onClose={() => setCreatingHiringPosition(false)} onCreated={applyHiringCreate} />
      )}

      {capacityDrill && (
        <CapacityDrillDrawer
          title={capacityDrill.title}
          subtitle={capacityDrill.subtitle}
          employees={capacityDrill.employees}
          hiringPositions={capacityDrill.hiringPositions}
          year={year}
          canAssignHiring={canAssignHiring}
          onClose={() => setCapacityDrill(null)}
        />
      )}
    </>
  );
}
