"use client";

import { useMemo } from "react";
import { EmptyState } from "@/components/ui/EmptyState";
import { buildDepartmentCards, type DepartmentCard } from "@/lib/employee-department-cards";
import { WORKFORCE_GROUPS, workforceGroupForCardKey, rollupGroup, type WorkforceGroupKey } from "@/lib/employee-workforce-groups";
import type { EmployeeRow } from "@/lib/employee-row";
import type { SchedulerPlaceholder } from "@/lib/scheduler-db";
import type { HiringPosition } from "@/lib/hiring-positions";
import { employeeCapacityHours, hiringCapacityHours } from "@/lib/workforce-capacity";
import { hasYearPolicy } from "@/lib/workforce-capacity-policy";
import { hours as fmtHours } from "@/components/ui/format";
import { countOpenings } from "@/lib/hiring-openings";

// Card render order (2026-08-19, by request): PM, Engineering, Shop, then
// whatever's left (just "other," if it has any cards) -- Hiring Positions is
// rendered separately, always last, unaffected by this list. Deliberately
// NOT a reorder of WORKFORCE_GROUPS itself (employee-workforce-groups.ts) --
// that array also drives dropdown option order in HiringMoveToControl.tsx/
// CreateHiringPositionDrawer.tsx/HiringPositionDetailDrawer.tsx and the
// Hiring Positions card's own internal breakdown list, none of which this
// request asked to change. This is a display-order concern local to this
// component only.
// Delivery teams first, in the order the request listed them, then the
// back-office departments, then "other" (which renders nothing unless an
// unmapped department turns up — see the filter in `summaries`).
// "genEng" is deliberately ABSENT (2026-08-24): General Engineering rolls up
// into Engineering, whose card therefore already includes it
// ("Engineering Total = Engineering + General Engineering"). Giving it a card
// here as well would both fragment the Engineering view and double-count it in
// Open Positions / Planned Headcount. It stays visibly separate where the
// request asks for that — its own section in the Hiring Positions list, and its
// own option in the Create/Edit Position form.
export const CARD_RENDER_ORDER: WorkforceGroupKey[] = [
  "pm",
  "engineering",
  "shop",
  "growth",
  "finance",
  "exec",
  "operations",
  "other",
];

type WorkforceSummary = {
  key: WorkforceGroupKey;
  title: string;
  cards: DepartmentCard[];
};

export type CapacityDrillTarget = { title: string; subtitle?: string; employees: EmployeeRow[]; hiringPositions: HiringPosition[] };

export function WorkforceSummaryCards({
  rows,
  placeholders,
  hiringPositions,
  year,
  onSelectCapacity,
}: {
  rows: EmployeeRow[];
  placeholders: SchedulerPlaceholder[];
  /** Already OPEN positions only — see EmployeesGrid.tsx's `openHiring` derivation off getHiringPositions(). */
  hiringPositions: HiringPosition[];
  /** For workforce-capacity-policy.ts/workforce-capacity.ts. */
  year: number;
  /** Opens the "how was this total built" drill (Level 3, a different question from onSelectGroup/onSelectDepartment's "who"). */
  onSelectCapacity: (target: CapacityDrillTarget) => void;
}) {
  const summaries = useMemo<WorkforceSummary[]>(() => {
    const cards = buildDepartmentCards(rows, placeholders);
    const byGroup = new Map<WorkforceGroupKey, DepartmentCard[]>();
    for (const card of cards) {
      // rollupGroup: a General Engineering department card belongs under the
      // Engineering card, not a card of its own.
      const key = rollupGroup(workforceGroupForCardKey(card.key));
      const list = byGroup.get(key);
      if (list) list.push(card);
      else byGroup.set(key, [card]);
    }
    const byKey = new Map(WORKFORCE_GROUPS.map((def) => [def.key, def]));
    return CARD_RENDER_ORDER.map((key) => {
      const def = byKey.get(key)!;
      return { key: def.key, title: def.title, cards: byGroup.get(def.key) ?? [] };
    }).filter(
      // An empty workforce group (everyone filtered out, or genuinely nobody
      // on it) shows nothing rather than a "0 employees" card with nowhere
      // useful to drill — matches EmployeesCards' own "no card for an empty
      // bucket" behavior one level down.
      (g) => g.cards.length > 0,
    );
  }, [rows, placeholders]);

  // Hiring counts, by department key and by group-only (assigned to a group
  // but no specific department yet — a valid, expected intermediate state
  // per the task's own two-step "group, then optionally deeper" assignment).


  const unassignedHiring = countOpenings(hiringPositions.filter((p) => !p.workforceGroup));

  const activeHeadcount = summaries.reduce((s, g) => s + g.cards.reduce((s2, c) => s2 + c.people.filter((p) => p.active).length, 0), 0);
  // Openings, not rows — one Quantity 2 requisition is 2 open positions and
  // contributes 2 to Planned Headcount below.
  const openPositions = countOpenings(hiringPositions);
  const plannedHeadcount = activeHeadcount + openPositions;

  const total = activeHeadcount + summaries.reduce((s, g) => s + g.cards.reduce((s2, c) => s2 + c.people.filter((p) => !p.active).length, 0), 0);

  if (total === 0 && openPositions === 0) {
    return <EmptyState title="No employees match" message="Try clearing a filter or search term." />;
  }

  // Capacity hours (2026-08-19) — a SEPARATE figure from headcount above,
  // always labeled and never blended into it. Company-wide Current/Hiring
  // both include EVERY active employee/open position across every group, so
  // the drill-through for the header strip hands over the full flat lists,
  // not one card's.
  const hasCapacityPolicy = hasYearPolicy(year);
  const allActivePeople = summaries.flatMap((g) => g.cards.flatMap((c) => c.people.filter((p) => p.active)));
  const currentCapacityHours = hasCapacityPolicy ? employeeCapacityHours(activeHeadcount, year) : 0;
  const hiringCapacityHoursTotal = hasCapacityPolicy ? hiringCapacityHours(hiringPositions, year) : 0;
  const plannedCapacityHours = currentCapacityHours + hiringCapacityHoursTotal;

  return (
    <div className="flex flex-col gap-4">
      {/* Workforce-planning summary strip — company-wide, not affected by the
          Employees toolbar's own filters (those narrow WHO you're looking at;
          this answers "how big is the org, planned"). */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 rounded-xl border border-sdc-border bg-sdc-gray-50 px-4 py-2.5 text-sm">
        <span>
          <span className="font-bold tabular-nums text-sdc-navy">{activeHeadcount}</span>{" "}
          <span className="text-sdc-muted">Active Headcount</span>
        </span>
        <span>
          <span className="font-bold tabular-nums text-sdc-navy">{openPositions}</span> <span className="text-sdc-muted">Open Positions</span>
        </span>
        <span>
          <span className="font-bold tabular-nums text-sdc-navy">{plannedHeadcount}</span>{" "}
          <span className="text-sdc-muted">Planned Headcount</span>
        </span>
        {unassignedHiring > 0 && (
          <span>
            <span className="font-bold tabular-nums text-sdc-navy">{unassignedHiring}</span>{" "}
            <span className="text-sdc-muted">Unassigned Openings</span>
          </span>
        )}
        {hasCapacityPolicy && (
          <button
            type="button"
            onClick={() =>
              onSelectCapacity({
                title: "Company-Wide Capacity",
                employees: allActivePeople,
                hiringPositions,
              })
            }
            title="See how this capacity total was built, by employee and open position"
            className="flex items-baseline gap-x-2 rounded-md px-1 -mx-1 hover:bg-white"
          >
            <span className="font-bold tabular-nums text-sdc-navy">{fmtHours(currentCapacityHours)}</span>{" "}
            <span className="text-sdc-muted">current hrs/yr</span>
            {hiringCapacityHoursTotal > 0 && (
              <>
                <span className="text-sdc-gray-400">·</span>
                <span className="font-bold tabular-nums text-sdc-green-text">+{fmtHours(hiringCapacityHoursTotal)}</span>{" "}
                <span className="text-sdc-muted">hiring hrs/yr</span>
                <span className="text-sdc-gray-400">·</span>
                <span className="font-bold tabular-nums text-sdc-navy">{fmtHours(plannedCapacityHours)}</span>{" "}
                <span className="text-sdc-muted">planned hrs/yr</span>
              </>
            )}
          </button>
        )}
      </div>

      {/* Both the per-group summary cards and the Hiring Positions aside that
          used to sit here are gone (2026-08-24). The cards duplicated the
          expanded department cards below; the aside moved to its own full-width
          band after Execution and Operations (HiringPositionsSummary), because
          once the cards went it was a narrow column with an empty row beside it.

          What is left is the company-wide KPI strip above — the one thing on this
          page the expanded sections do not carry. */}
    </div>
  );
}
