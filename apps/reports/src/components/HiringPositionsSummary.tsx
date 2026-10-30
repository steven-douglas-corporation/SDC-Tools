"use client";

import { useMemo } from "react";
import { WORKFORCE_GROUPS, rollupGroup, type WorkforceGroupKey } from "@/lib/employee-workforce-groups";
import { openingsFor, countOpenings } from "@/lib/hiring-openings";
import type { HiringPosition } from "@/lib/hiring-positions";
import { hiringCapacityHours } from "@/lib/workforce-capacity";
import { hasYearPolicy } from "@/lib/workforce-capacity-policy";
import { hours as fmtHours } from "@/components/ui/format";
import type { CapacityDrillTarget } from "@/components/WorkforceSummaryCards";

// ── Hiring Positions, as a full-width band (2026-08-24, by request) ─────────
//
// Moved out of WorkforceSummaryCards, where it was a narrow aside sitting to the
// right of the per-group summary cards. Those cards were removed, which left it
// floating in a column of its own with the rest of the row empty; it now sits
// below Execution and Operations as a band of the same shape as theirs.
//
// One heading, not two. It used to carry a "PLANNED" region label above a card
// titled "Hiring Positions" — two names for one thing, which only made sense
// while it was the right-hand half of a Current Workforce / Planned pair.
//
// Every figure is the same computation as before, moved verbatim: total openings
// and per-group counts from openingsFor (so a Quantity 2 requisition counts
// twice), capacity from hiringCapacityHours, and the same rollup that credits
// General Engineering's openings to Engineering. Nothing about hiring counts,
// capacity, quantities, group mappings or open/closed logic changed here.
//
// Since 2026-10-29 it heads the Employees page's Hiring tab (which replaced the
// Cards view), with the full list always open beneath it.
export function HiringPositionsSummary({
  hiringPositions,
  year,
  onSelectCapacity,
  requestCount,
}: {
  /** Already filtered to OPEN positions by the caller — see EmployeesGrid's `openHiring`. */
  hiringPositions: HiringPosition[];
  year: number;
  onSelectCapacity: (target: CapacityDrillTarget) => void;
  /** Positions asked for in hire requests waiting to be posted (2026-10-29): a request for 3 counts 3, like the openings. Shown beside the openings, never added to them. */
  requestCount: number;
}) {
  const byGroup = useMemo(() => {
    const m = new Map<WorkforceGroupKey, number>();
    for (const p of hiringPositions) {
      if (!p.workforceGroup) continue;
      // Same rollup the workforce cards use: General Engineering's openings are
      // credited to Engineering rather than shown as their own line.
      const key = rollupGroup(p.workforceGroup);
      m.set(key, (m.get(key) ?? 0) + openingsFor(p));
    }
    return m;
  }, [hiringPositions]);

  const openPositions = countOpenings(hiringPositions);
  const unassigned = countOpenings(hiringPositions.filter((p) => !p.workforceGroup));
  const hasCapacityPolicy = hasYearPolicy(year);
  const hiringHours = hasCapacityPolicy ? hiringCapacityHours(hiringPositions, year) : 0;

  // Rolled-up groups are skipped: their openings are credited to the group they
  // roll into, so a General Engineering tile would always read 0 and imply there
  // were none.
  const groupTiles = WORKFORCE_GROUPS.filter((g) => g.key !== "other" && !g.rollsUpTo)
    .map((g) => ({ key: g.key, title: g.title, count: byGroup.get(g.key) ?? 0 }))
    .filter((g) => g.count > 0);

  return (
    <section>
      {/* Same band heading as Execution and Operations, so this reads as a third
          band rather than a stray card. */}
      <div className="mb-3 flex items-baseline gap-3 border-b-2 border-sdc-navy pb-1.5">
        <h2 className="text-base font-bold uppercase tracking-wider text-sdc-navy">Hiring Positions</h2>
        <span className="text-xs text-sdc-muted">Not yet people — open requisitions</span>
        <span className="ml-auto text-xs text-sdc-muted">
          <span className="font-bold tabular-nums text-sdc-navy">{openPositions}</span> published
        </span>
      </div>

      {/* Dashed border throughout, the same "open seat" grammar the department
          cards use for their own hiring rows — an open requisition is never
          styled like a person. */}
      <div className="rounded-xl border border-dashed border-sdc-green bg-white">
        <div className="flex flex-wrap items-stretch divide-y divide-dashed divide-sdc-border sm:divide-y-0">
          {/* Plain figures, not toggles (2026-10-29): on the Hiring tab the list
              is always open right below. */}
          <div className="flex min-w-[12rem] flex-col justify-center border-r border-dashed border-sdc-green bg-sdc-green-bg/50 px-4 py-3">
            <span className="flex items-baseline gap-1.5 text-sdc-green-text">
              <span className="text-lg font-bold tabular-nums">{openPositions}</span>
              <span className="text-xs font-semibold uppercase tracking-wide">published positions</span>
            </span>
          </div>

          {/* Requests sit right beside the published positions (2026-10-29), in
              blue (red until 2026-10-30): asked for, not in Paylocity yet. They never count toward the
              published total or the hours and team tiles that follow. */}
          {requestCount > 0 && (
            <div
              title="Positions asked for in hire requests, not posted in Paylocity yet"
              className="flex min-w-[9rem] flex-col justify-center gap-0.5 border-r border-dashed border-sdc-border bg-sdc-blue-light/50 px-4 py-3 text-sdc-blue-dark"
            >
              <span className="text-lg font-bold tabular-nums">{requestCount}</span>
              <span className="text-label font-semibold uppercase tracking-wide">Requested</span>
            </div>
          )}

          {hasCapacityPolicy && (
            <button
              type="button"
              onClick={() => onSelectCapacity({ title: "Hiring Positions — Capacity", employees: [], hiringPositions })}
              title="See how this capacity total was built, by open position"
              className="flex min-w-[11rem] flex-col gap-0.5 border-r border-dashed border-sdc-border px-4 py-3 text-left hover:bg-sdc-blue-light/30"
            >
              <span className="flex items-baseline gap-1.5">
                <span className="text-lg font-bold tabular-nums text-sdc-green-text">+{fmtHours(hiringHours)}</span>
                <span className="text-xs text-sdc-muted">hiring hrs/yr</span>
              </span>
              <span className="text-label text-sdc-muted">How this was built</span>
            </button>
          )}

          {/* Horizontal, not a stacked list — the request's "display
              workforce-group hiring totals horizontally instead of stacking them
              in a narrow card". They wrap when the row runs out. */}
          {groupTiles.map((g) => (
            <div key={g.key} className="flex min-w-[9rem] flex-col justify-center gap-0.5 border-r border-dashed border-sdc-border px-4 py-3">
              <span className="text-lg font-bold tabular-nums text-sdc-navy">{g.count}</span>
              <span className="text-label uppercase tracking-wide text-sdc-muted">{g.title}</span>
            </div>
          ))}

          {unassigned > 0 && (
            <div className="flex min-w-[9rem] flex-col justify-center gap-0.5 px-4 py-3">
              <span className="text-lg font-bold tabular-nums text-sdc-navy">{unassigned}</span>
              <span className="text-label uppercase tracking-wide text-sdc-muted">Unassigned</span>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
