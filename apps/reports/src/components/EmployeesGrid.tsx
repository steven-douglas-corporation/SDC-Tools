"use client";

import { useMemo, useState } from "react";
import { HiringPositionsSummary } from "@/components/HiringPositionsSummary";
import { WorkforceSummaryCards } from "@/components/WorkforceSummaryCards";
import { EmployeeDetailDrawer } from "@/components/EmployeeDetailDrawer";
import { HiringPositionsList } from "@/components/HiringPositionsList";
import { HiringPositionDetailDrawer } from "@/components/HiringPositionDetailDrawer";
import { CreateHiringPositionDrawer } from "@/components/CreateHiringPositionDrawer";
import { CapacityDrillDrawer } from "@/components/CapacityDrillDrawer";
import { DASH, rowMatchesSearch, type EmployeeRow } from "@/lib/employee-row";
import { resolveEmployeeGroup } from "@/lib/employee-card-theme";
import { workforceGroupForCardKey, type WorkforceGroupKey } from "@/lib/employee-workforce-groups";
import { countOpenings } from "@/lib/hiring-openings";
import { HIRING_POSITIONS_ENABLED } from "@/lib/hiring-feature";
import { findPostingForRequest, teamLeadOptions } from "@/lib/hiring-requests";
import { OrgChart, PendingTeamChanges } from "@/components/OrgChart";
import type { OrgChart as OrgChartData } from "@/lib/org-chart";
import type { SchedulerPlaceholder } from "@/lib/scheduler-db";
import type { HiringPosition } from "@/lib/hiring-positions";

// The Employees page: the Org chart (people) and Hiring (positions) as two tabs,
// with the drawers both open. WorkforceSummaryCards/OrgChart/HiringPositionsList
// render the actual cards and lists.
//
// Hiring replaced the Cards view (2026-10-29). Cards drew the same people by
// department, which the Org chart had taken over almost entirely; its filters
// (team scope, discipline, department) and its Add employee button went with
// it. The Org chart offers "Request a hire" on a team's card instead.

// The Org chart's search box.
function SearchBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-sdc-border bg-white px-3.5">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-sdc-gray-400">
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search…"
        aria-label="Search people"
        className="w-56 border-none bg-transparent py-2 text-sm text-sdc-navy outline-none placeholder:text-sdc-gray-400"
      />
    </div>
  );
}

export function EmployeesGrid({
  rows,
  placeholders,
  canAddEmployees,
  canViewHours,
  hiringPositions,
  hiringError,
  canAssignHiring,
  year,
  orgChart,
  orgChartWithInactive,
}: {
  rows: EmployeeRow[];
  placeholders: SchedulerPlaceholder[];
  canAddEmployees: boolean;
  /** dashboard:view — offers the employee panel's Hours tab. */
  canViewHours: boolean;
  hiringPositions: HiringPosition[];
  hiringError: string | null;
  canAssignHiring: boolean;
  /** For workforce-capacity-policy.ts/workforce-capacity.ts — see page.tsx's own note on why this is computed once, server-side. */
  year: number;
  /** The Org chart view (2026-10-02): the same people, nested by reporting line — see lib/org-chart.ts. */
  orgChart: OrgChartData;
  /** The same chart with inactive people drawn too — what "Show inactive" switches to. */
  orgChartWithInactive: OrgChartData;
}) {
  // Org chart (reporting lines, the default since 2026-10-02) or Hiring
  // (positions and hire requests, 2026-10-29).
  const [view, setView] = useState<"chart" | "hiring">("chart");
  const rowsById = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const [q, setQ] = useState("");
  const [showInactive, setShowInactive] = useState(false);

  // The drawers are overlay state, not navigation: closing one returns to
  // whatever was showing underneath, with the search and tab untouched.
  const [selectedEmployee, setSelectedEmployee] = useState<EmployeeRow | null>(null);
  const [selectedHiringPosition, setSelectedHiringPosition] = useState<HiringPosition | null>(null);
  // A new hire request, and the team it was started from (a card's "Request a
  // hire"), or null from the Hiring tab's own button.
  const [requestingHire, setRequestingHire] = useState<{ team: string | null } | null>(null);
  // "How was this capacity-hours total built" -- a different question ("which
  // employees/positions, what proration") from "who", so it's its own piece of
  // overlay state.
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

  function applyHiringRequestClosed(positionSourceId: string) {
    setHiring((prev) => prev.filter((p) => p.sourceId !== positionSourceId));
    setSelectedHiringPosition(null);
  }

  // Hire requests (2026-10-29): the team leads a request can name as hiring
  // manager, and every roster name by Paylocity id so a request shows its
  // manager by name even if they are no longer a lead.
  const teamLeads = useMemo(() => teamLeadOptions(rows), [rows]);
  const nameByPaylocityId = useMemo(() => new Map(rows.filter((r) => r.paylocityId).map((r) => [r.paylocityId, r.name])), [rows]);
  const selectedRequestPosting = useMemo(
    () => (selectedHiringPosition ? findPostingForRequest(selectedHiringPosition, hiring) : null),
    [selectedHiringPosition, hiring],
  );

  // Always OPEN positions only — the input WorkforceSummaryCards' and the Org
  // chart's hiring-count formulas expect (see WorkforceSummaryCards' own
  // "Already OPEN positions only" comment). A closed/filled position (from
  // either source) never inflates a count, regardless of what
  // HiringPositionsList's own Job Status filter is currently showing.
  const openHiring = useMemo(() => hiring.filter((p) => p.isOpen), [hiring]);

  // While searching with inactive hidden, count how many INACTIVE people match
  // so we can offer to reveal them — otherwise a departed employee is
  // unfindable and reactivation, the whole point of soft-delete, is hard to
  // discover.
  const hiddenInactiveMatches = useMemo(() => {
    if (!q.trim() || showInactive) return 0;
    return rows.filter((r) => !r.active && rowMatchesSearch(r, q)).length;
  }, [rows, q, showInactive]);

  function selectEmployee(row: EmployeeRow) {
    setSelectedHiringPosition(null);
    setSelectedEmployee(row);
  }

  function selectHiringPosition(position: HiringPosition) {
    setSelectedEmployee(null);
    setSelectedHiringPosition(position);
  }

  const selectedEmployeeGroup = selectedEmployee ? resolveEmployeeGroup(selectedEmployee) : null;
  const views = HIRING_POSITIONS_ENABLED
    ? ([["chart", "Org chart"], ["hiring", "Hiring"]] as const)
    : ([["chart", "Org chart"]] as const);

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        {views.length > 1 && (
          <div role="radiogroup" aria-label="View" className="flex items-center rounded-lg border border-sdc-border bg-white p-0.5">
            {views.map(([v, label]) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={view === v}
                onClick={() => setView(v)}
                title={v === "chart" ? "Everyone nested by who they report to" : "Published positions and hire requests"}
                className={`rounded-md px-3 py-1.5 text-xs font-semibold motion-interactive ${
                  view === v ? "bg-sdc-navy text-white" : "text-sdc-gray-600 hover:bg-sdc-blue-light"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        {view === "chart" && (
          <>
            <SearchBox value={q} onChange={setQ} />
            <label className="flex items-center gap-2 text-xs font-medium text-sdc-gray-600">
              <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} className="h-3.5 w-3.5" />
              Show inactive
            </label>
            {hiddenInactiveMatches > 0 && (
              <button type="button" onClick={() => setShowInactive(true)} className="text-xs font-medium text-sdc-blue hover:underline">
                {hiddenInactiveMatches} inactive {hiddenInactiveMatches === 1 ? "person matches" : "people match"} — show them
              </button>
            )}
          </>
        )}
      </div>

      {hiringError && (
        <p className="mb-3 rounded border border-sdc-yellow bg-sdc-yellow-bg px-2 py-1 text-note text-sdc-yellow-text">
          Couldn&apos;t read the hiring positions: {hiringError}
        </p>
      )}

      {view === "chart" || !HIRING_POSITIONS_ENABLED ? (
        <div className="grid gap-6">
          {/* The headcount strip and group tiles, for the whole organisation. */}
          <WorkforceSummaryCards
            rows={rows}
            placeholders={placeholders}
            hiringPositions={openHiring}
            year={year}
            onSelectCapacity={setCapacityDrill}
          />
          {orgChart.pending.length > 0 && <PendingTeamChanges pending={orgChart.pending} />}
          <OrgChart
            chart={showInactive ? orgChartWithInactive : orgChart}
            query={q}
            people={rowsById}
            onSelectPerson={selectEmployee}
            year={year}
            onSelectCapacity={setCapacityDrill}
            hiringPositions={HIRING_POSITIONS_ENABLED ? openHiring : undefined}
            onSelectHiringPosition={selectHiringPosition}
            canAssignHiring={canAssignHiring}
            onRequestHire={HIRING_POSITIONS_ENABLED && canAssignHiring ? (team) => setRequestingHire({ team }) : undefined}
            canManualAdd={canAddEmployees}
          />
        </div>
      ) : (
        // The Hiring tab: the band's figures, then every position and request.
        <div className="grid gap-4">
          <HiringPositionsSummary
            hiringPositions={openHiring}
            year={year}
            onSelectCapacity={setCapacityDrill}
            requestCount={countOpenings(hiring.filter((p) => p.source === "manual" && p.isVisible))}
          />
          <HiringPositionsList
            positions={hiring}
            canAssign={canAssignHiring}
            canCreate={canAssignHiring}
            managerNames={nameByPaylocityId}
            onSelect={selectHiringPosition}
            onVisibilityChanged={(sourceId, isVisible) => applyHiringUpdate(sourceId, { isVisible })}
            onCreate={() => setRequestingHire({ team: null })}
          />
        </div>
      )}

      {selectedEmployee && (
        <EmployeeDetailDrawer
          employee={selectedEmployee}
          departmentTitle={selectedEmployeeGroup?.title ?? selectedEmployee.department?.trim() ?? DASH}
          workforceGroup={workforceGroupForCardKey(selectedEmployeeGroup?.key ?? "")}
          canEdit={canAddEmployees}
          canViewHours={canViewHours}
          people={rows}
          onSelectEmployee={selectEmployee}
          supervisorOptions={rows
            .filter((r) => r.active)
            .map((r) => ({ id: r.id, name: r.name }))
            .sort((a, b) => a.name.localeCompare(b.name))}
          onClose={() => setSelectedEmployee(null)}
        />
      )}

      {HIRING_POSITIONS_ENABLED && selectedHiringPosition && (
        <HiringPositionDetailDrawer
          position={selectedHiringPosition}
          canAssign={canAssignHiring}
          onAssigned={applyAssignment}
          onUpdated={applyHiringUpdate}
          onClosed={applyHiringRequestClosed}
          onClose={() => setSelectedHiringPosition(null)}
          leads={teamLeads}
          managerName={nameByPaylocityId.get(selectedHiringPosition.hiringManagerIds[0] ?? "") ?? null}
          posting={selectedRequestPosting}
        />
      )}

      {HIRING_POSITIONS_ENABLED && requestingHire && (
        <CreateHiringPositionDrawer
          leads={teamLeads}
          initialTeam={requestingHire.team}
          onClose={() => setRequestingHire(null)}
          onCreated={applyHiringCreate}
        />
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
