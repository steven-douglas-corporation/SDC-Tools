"use client";

import { useMemo, useState } from "react";
import { BuildReadinessDrawer } from "@/components/build-readiness/BuildReadinessDrawer";
import { DRILL_NUM, DRILL_TOTAL_LABEL, DrillEmpty, DrillLines } from "@/components/ui/Drill";
import { SortableTh } from "@/components/ui/SortableHeader";
import { useColumnSort } from "@/components/useColumnSort";
import { sortRows, type SortColumns } from "@/lib/table-sort";
import { hours as fmtHours } from "@/components/ui/format";
import { hiringPositionCapacityHours } from "@/lib/workforce-capacity";
import { annualCapacityHours } from "@/lib/workforce-capacity-policy";
import type { EmployeeRow } from "@/lib/employee-row";
import type { HiringPosition } from "@/lib/hiring-positions";

// "How was this total built" for a Current/Hiring/Planned capacity-hours
// figure clicked on WorkforceSummaryCards.tsx/EmployeesCards.tsx -- the SAME
// BuildReadinessDrawer shell every other Level-3 surface in this tab uses,
// with ui/Drill.tsx's DrillLines (a flat list, not a grouped rollup -- there
// is nothing to expand here, just every contributor and its own hours,
// exactly matching TmHoursDrillPanel.tsx's own use of the same primitives).
//
// Each employee row shows the SAME full annualCapacityHours(year) figure
// summed at the card level (100% FTE, no per-employee schedule data exists
// yet). Each hiring position row shows its own prorated
// hiringPositionCapacityHours(), plus its expected start date (or "Not set --
// counted in full" when null) so the proration is never a mystery number.

type SortKey = "kind" | "name" | "detail" | "hours";

type Row = {
  kind: "Active" | "Hiring";
  name: string;
  detail: string;
  hours: number;
  hidden?: boolean;
};

const COLUMNS: SortColumns<Row, SortKey> = {
  kind: { type: "text", value: (r) => r.kind },
  name: { type: "text", value: (r) => r.name },
  detail: { type: "text", value: (r) => r.detail },
  hours: { type: "hours", value: (r) => r.hours },
};

export function CapacityDrillDrawer({
  title,
  subtitle,
  employees,
  hiringPositions,
  year,
  canAssignHiring,
  onClose,
}: {
  title: string;
  subtitle?: string;
  employees: EmployeeRow[];
  hiringPositions: HiringPosition[];
  year: number;
  /** Whether the viewer can see positions hidden via HiringVisibilityControl. Never gates whether a hidden position's HOURS count here — those always do, regardless — only whether its identity is shown as its own row vs. folded into one aggregate "Hidden positions" row. */
  canAssignHiring: boolean;
  onClose: () => void;
}) {
  const sort = useColumnSort<SortKey>({ key: "hours", direction: "desc" });
  const [query, setQuery] = useState("");

  const rows = useMemo<Row[]>(() => {
    const employeeHours = annualCapacityHours(year);
    const employeeRows: Row[] = employees.map((e) => ({
      kind: "Active",
      name: e.name,
      detail: e.department?.trim() || e.discipline,
      hours: employeeHours,
    }));

    // Every position's hours count toward the total below regardless of
    // visibility -- display visibility ≠ hiring status. For a non-editor,
    // individual hidden positions are folded into one aggregate row instead
    // of appearing separately, so the total stays exact without exposing
    // "there are exactly N separate hidden things" one row at a time.
    const shown = hiringPositions.filter((p) => p.isVisible);
    const hidden = hiringPositions.filter((p) => !p.isVisible);

    const hiringRows: Row[] = shown.map((p) => ({
      kind: "Hiring",
      name: p.title,
      detail: p.expectedStartDate ? `Starts ${p.expectedStartDate.toLocaleDateString("en-US")}` : "Not set — counted in full",
      hours: hiringPositionCapacityHours(p.expectedStartDate, year),
    }));

    if (hidden.length > 0) {
      if (canAssignHiring) {
        for (const p of hidden) {
          hiringRows.push({
            kind: "Hiring",
            name: p.title,
            detail: p.expectedStartDate ? `Starts ${p.expectedStartDate.toLocaleDateString("en-US")}` : "Not set — counted in full",
            hours: hiringPositionCapacityHours(p.expectedStartDate, year),
            hidden: true,
          });
        }
      } else {
        hiringRows.push({
          kind: "Hiring",
          name: `Hidden positions (${hidden.length})`,
          detail: "—",
          hours: hidden.reduce((sum, p) => sum + hiringPositionCapacityHours(p.expectedStartDate, year), 0),
        });
      }
    }

    return [...employeeRows, ...hiringRows];
  }, [employees, hiringPositions, year, canAssignHiring]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => r.name.toLowerCase().includes(q) || r.detail.toLowerCase().includes(q));
  }, [rows, query]);

  const sorted = useMemo(() => sortRows(filtered, sort.sort, COLUMNS), [filtered, sort.sort]);
  const total = filtered.reduce((sum, r) => sum + r.hours, 0);
  const filtering = query.trim().length > 0;

  return (
    <BuildReadinessDrawer title={title} subtitle={subtitle} breadcrumb={[title]} onBreadcrumbClick={() => {}} onClose={onClose}>
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-sdc-border-soft px-4 py-2.5">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search employee or position…"
            className="h-7 w-full max-w-xs rounded-md border border-sdc-border-soft px-2 text-note outline-none motion-interactive focus:border-sdc-blue"
          />
        </div>
        <div className="styled-scrollbar min-h-0 flex-1 overflow-y-auto">
          {sorted.length === 0 ? (
            <DrillEmpty>Nothing here yet.</DrillEmpty>
          ) : (
            <div className="overflow-x-auto">
              <DrillLines
                head={
                  <>
                    <SortableTh label="Type" sortKey="kind" type="text" sort={sort.sort} onSort={sort.onSort} className="w-20" />
                    <SortableTh label="Employee / Position" sortKey="name" type="text" sort={sort.sort} onSort={sort.onSort} />
                    <SortableTh label="Department / Start Date" sortKey="detail" type="text" sort={sort.sort} onSort={sort.onSort} className="w-52" />
                    <SortableTh label="Hours" sortKey="hours" type="hours" sort={sort.sort} onSort={sort.onSort} className="w-24" />
                  </>
                }
                foot={
                  <tr>
                    <td className={DRILL_TOTAL_LABEL} colSpan={3}>
                      {filtering ? "Shown" : "Total"}
                    </td>
                    <td className={`${DRILL_NUM} text-sm font-semibold`} title={total.toFixed(1)}>
                      {fmtHours(total)}
                    </td>
                  </tr>
                }
              >
                {sorted.map((r, i) => (
                  <tr key={`${r.kind}-${r.name}-${i}`}>
                    <td className={r.kind === "Hiring" ? "text-sdc-green-text" : "text-sdc-muted"}>{r.kind}</td>
                    <td className="text-sdc-gray-700">
                      {r.name}
                      {r.hidden && (
                        <span className="ml-2 rounded bg-sdc-yellow-bg px-1.5 py-0.5 text-micro font-bold uppercase tracking-wide text-sdc-yellow-text">
                          Hidden
                        </span>
                      )}
                    </td>
                    <td className="text-sdc-muted">{r.detail}</td>
                    <td className={DRILL_NUM} title={r.hours.toFixed(1)}>
                      {fmtHours(r.hours)}
                    </td>
                  </tr>
                ))}
              </DrillLines>
            </div>
          )}
        </div>
      </div>
    </BuildReadinessDrawer>
  );
}
