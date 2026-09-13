"use client";

import { Fragment, useMemo, useState } from "react";
import { INPUT, TABLE_ROW_HOVER } from "@/components/ui/classnames";
import { Panel, PanelHead } from "@/components/dashboard/DashboardLayout";
import { EmployeePunchDrillPanel, useEmployeePunchDrill } from "@/components/dashboard/EmployeePunchDrill";
import { SortableTh } from "@/components/ui/SortableHeader";
import { cycleSortState, sortRows, type SortColumns, type SortState } from "@/lib/table-sort";
import { departmentCardOrderRank } from "@/lib/employee-workforce-groups";
import type {
  DepartmentUtilizationResult,
  DepartmentUtilizationRow,
  UtilizationMeasures,
} from "@/lib/department-utilization";

// ── Department / Employee Utilization, the Dashboard's section ──────────────
//
// Presentational only. Every figure arrives already computed from
// lib/department-utilization.ts through getDashboardOverview's single pass —
// there is no business rule in this file, and nothing here fetches anything.
// A client component purely because the two views are interactive (sort, expand,
// department filter, employee search); the data is handed in as a prop.
//
// The layout is deliberately NOT the Power BI matrix it replaces. That visual put
// fifteen numeric columns and a nested three-level row hierarchy in one grid, which
// is why it needs a full screen and still crowds. Here:
//
//   - the department table keeps all fifteen measures but scrolls HORIZONTALLY in
//     its own container, so a narrow screen never pushes the whole Dashboard
//     sideways (the six columns that answer "how are we doing" are the ones inside
//     the initial viewport; the billable breakdown follows to the right);
//   - the row hierarchy collapses from three levels to two — department, expand for
//     its people — because the middle level (billing group) is one repeated word
//     per row and is better as a column;
//   - the employee view is its own ranked bar list rather than a second matrix.

const pctFmt = (n: number | null): string => (n === null ? "—" : `${Math.round(n * 100)}%`);
const hoursFmt = (n: number | null): string =>
  n === null ? "—" : n === 0 ? "0" : n.toLocaleString("en-US", { maximumFractionDigits: 0 });

/**
 * Utilization bar colour. Deliberately a THREE-stop scale with a neutral middle,
 * not a red/green pass-fail: utilization is a business ratio somebody has to
 * interpret, and painting 89% red implies a threshold nobody has agreed to. Red is
 * reserved for the genuinely wrong-looking end of the range.
 */
function utilTone(pct: number | null): { bar: string; text: string } {
  if (pct === null) return { bar: "bg-sdc-gray-400", text: "text-sdc-muted" };
  if (pct >= 0.9) return { bar: "bg-sdc-green", text: "text-sdc-green-text" };
  if (pct >= 0.7) return { bar: "bg-sdc-blue", text: "text-sdc-blue-dark" };
  return { bar: "bg-sdc-red", text: "text-sdc-red-text" };
}

type DeptSortKey =
  | "title" | "billingGroup" | "employees" | "theoreticalHours" | "actualHours" | "availablePct"
  | "utilizationPct" | "billableTotal" | "billableActive" | "warranty" | "billableService"
  | "billableSpareParts" | "bellco" | "nonBillable" | "travelHours" | "travelPct" | "overtimeHours";

const DEPT_COLUMNS: SortColumns<DepartmentUtilizationRow, DeptSortKey> = {
  title: { type: "text", value: (r) => r.title },
  billingGroup: { type: "text", value: (r) => r.billingGroup },
  employees: { type: "number", value: (r) => r.employees },
  theoreticalHours: { type: "hours", value: (r) => r.theoreticalHours },
  actualHours: { type: "hours", value: (r) => r.actualHours },
  availablePct: { type: "number", value: (r) => r.availablePct },
  utilizationPct: { type: "number", value: (r) => r.utilizationPct },
  billableTotal: { type: "hours", value: (r) => r.billableTotal },
  billableActive: { type: "hours", value: (r) => r.billableActive },
  warranty: { type: "hours", value: (r) => r.warranty },
  billableService: { type: "hours", value: (r) => r.billableService },
  billableSpareParts: { type: "hours", value: (r) => r.billableSpareParts },
  bellco: { type: "hours", value: (r) => r.bellco },
  nonBillable: { type: "hours", value: (r) => r.nonBillable },
  travelHours: { type: "hours", value: (r) => r.travelHours },
  travelPct: { type: "number", value: (r) => r.travelPct },
  overtimeHours: { type: "hours", value: (r) => r.overtimeHours },
};

// The five CORE measures — headcount, the two hour totals and the two ratios —
// answer "how are we doing" and sit inside the initial viewport. The billable
// breakdown after them is real detail nobody scans first, so it is rendered a
// shade lighter and follows to the right. Same table, same data, one visual
// tier of difference: the requirement is to make the important columns easier
// to scan, not to hide the rest behind a toggle.
const DEPT_HEADERS: { key: DeptSortKey; label: string; core?: boolean }[] = [
  { key: "employees", label: "Employees", core: true },
  { key: "theoreticalHours", label: "Theoretical", core: true },
  { key: "actualHours", label: "Actual", core: true },
  { key: "availablePct", label: "Available %", core: true },
  { key: "utilizationPct", label: "Utilization %", core: true },
  { key: "billableTotal", label: "Billable" },
  { key: "billableActive", label: "Active" },
  { key: "warranty", label: "Warranty" },
  { key: "billableService", label: "Service" },
  { key: "billableSpareParts", label: "Spare Parts" },
  { key: "bellco", label: "Bellco" },
  { key: "nonBillable", label: "Non-Billable" },
  { key: "travelHours", label: "Travel" },
  { key: "travelPct", label: "Travel %" },
  { key: "overtimeHours", label: "Overtime" },
];

// The frozen first column. One token, because the header, the department rows,
// the employee sub-rows and the total row must agree on width to the pixel or the
// sticky column visibly steps as you scroll sideways.
//
// It deliberately carries NO background: every use site supplies its own, and that
// background MUST BE OPAQUE. A sticky cell is painted over the scrolling content
// beneath it, so `bg-inherit` (which resolves to transparent on a row with no
// background of its own) or any `/30`-style translucent tint lets the numeric
// columns slide visibly through the department names. That is exactly what
// happened here before the row backgrounds below were made solid.
const DEPT_CELL = "sticky left-0 z-10 w-[17rem] min-w-[17rem] max-w-[17rem] whitespace-nowrap";

/** The Utilization % cell — the number the section exists for, so it carries the bar. */
function UtilCell({ pct, muted }: { pct: number | null; muted?: boolean }) {
  const tone = utilTone(pct);
  if (pct === null) {
    return (
      <span className="text-sdc-muted" title="Utilization % is only defined for the billable delivery departments">
        —
      </span>
    );
  }
  return (
    <span className="inline-flex items-center justify-end gap-2">
      <span className="h-1.5 w-14 shrink-0 overflow-hidden rounded-full bg-sdc-gray-100" aria-hidden>
        <span className={`block h-full rounded-full ${tone.bar}`} style={{ width: `${Math.min(100, pct * 100)}%` }} />
      </span>
      <span className={`tabular-nums font-semibold ${muted ? "text-sdc-muted" : tone.text}`}>{pctFmt(pct)}</span>
    </span>
  );
}

function DepartmentTable({
  result,
  drill,
}: {
  result: DepartmentUtilizationResult;
  drill: ReturnType<typeof useEmployeePunchDrill>;
}) {
  // ── null, not { utilizationPct, desc } (2026-08-31) ──────────────────────
  //
  // null means "the order the server already put them in", which sortRows()
  // passes through untouched — the canonical business order from
  // employee-workforce-groups.ts (Mechanical → Controls → Service → General
  // Engineering → Project Management). This defaulted to Utilization %
  // descending, which silently reshuffled that order on every render and, since
  // Service and PM carry a null Utilization %, parked them wherever the null
  // comparator happened to put them.
  //
  // Clicking a header still sorts, and a third click returns here — see
  // cycleSortState's own note on why the "none" state exists.
  const [sort, setSort] = useState<SortState<DeptSortKey>>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const rows = useMemo(() => sortRows(result.departments, sort, DEPT_COLUMNS), [result.departments, sort]);
  const onSort = (k: DeptSortKey) => setSort((s) => cycleSortState(s, k));

  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const numeric = (row: UtilizationMeasures, key: DeptSortKey) => {
    switch (key) {
      case "employees": return String(row.employees);
      case "availablePct": return pctFmt(row.availablePct);
      case "travelPct": return pctFmt(row.travelPct);
      case "travelHours": return hoursFmt(row.travelHours);
      case "theoreticalHours": return hoursFmt(row.theoreticalHours);
      case "actualHours": return hoursFmt(row.actualHours);
      case "billableTotal": return hoursFmt(row.billableTotal);
      case "billableActive": return hoursFmt(row.billableActive);
      case "warranty": return hoursFmt(row.warranty);
      case "billableService": return hoursFmt(row.billableService);
      case "billableSpareParts": return hoursFmt(row.billableSpareParts);
      case "bellco": return hoursFmt(row.bellco);
      case "nonBillable": return hoursFmt(row.nonBillable);
      case "overtimeHours": return hoursFmt(row.overtimeHours);
      default: return "";
    }
  };

  return (
    // The scroller, not the page, takes the overflow — a fifteen-column table must
    // never make the whole Dashboard scroll sideways on a laptop, and a
    // twelve-department list must not push the rest of the page off the bottom.
    // Both axes are capped here, and the header row sticks so a scrolled table
    // still says which column is which.
    <div className="styled-scrollbar max-h-[27rem] overflow-auto">
      <table className="w-full min-w-[62rem] border-collapse text-sm">
        <thead>
          <tr className="border-b border-sdc-border bg-white text-xs uppercase tracking-wide text-sdc-muted">
            <SortableTh
              label="Department"
              sortKey="title"
              type="text"
              sort={sort}
              onSort={onSort}
              // z-30: this one corner cell is sticky on BOTH axes, so it has to
              // sit above the sticky row (z-20) and the sticky column (z-10).
              className={`${DEPT_CELL} sticky top-0 z-30 bg-white py-2 pl-3 pr-3 font-semibold`}
            />
            {DEPT_HEADERS.map((h) => (
              <SortableTh
                key={h.key}
                label={h.label}
                sortKey={h.key}
                type={h.key.endsWith("Pct") || h.key === "employees" ? "number" : "hours"}
                sort={sort}
                onSort={onSort}
                className={`sticky top-0 z-20 bg-white py-2 px-2 font-semibold whitespace-nowrap ${
                  h.core ? "" : "text-sdc-gray-400"
                }`}
              />
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const open = expanded.has(row.key);
            return (
              // Fragment (not the <tr>) carries the key: one department renders a
              // row PLUS its expanded employee rows, so the list item is the pair.
              <Fragment key={row.key}>
                <tr className={`border-b border-sdc-border-soft ${TABLE_ROW_HOVER} ${open ? "bg-sdc-blue-light" : "bg-white"}`}>
                  <th scope="row" className={`${DEPT_CELL} ${open ? "bg-sdc-blue-light" : "bg-white"} py-1.5 pl-3 pr-3 text-left font-normal`}>
                    <button
                      type="button"
                      onClick={() => toggle(row.key)}
                      aria-expanded={open}
                      title={
                        row.inUtilizationScope
                          ? undefined
                          : "Outside the billable delivery departments — hours are shown, Utilization % is not"
                      }
                      className="flex w-full items-center gap-1.5 text-left hover:underline"
                    >
                      <span
                        className={`inline-block shrink-0 text-[0.6rem] text-sdc-muted motion-interactive ${open ? "rotate-90" : ""}`}
                        aria-hidden
                      >
                        ▶
                      </span>
                      {/* Non-scope departments are muted rather than badged. The "—" this
                          row already shows under Utilization % says the same thing, and a
                          pill here was wrapping the longer names onto three lines and
                          making every row a different height. */}
                      <span className={`shrink-0 font-medium ${row.inUtilizationScope ? "text-sdc-navy" : "text-sdc-gray-600"}`}>
                        {row.title}
                      </span>
                      {row.billingGroup !== row.title && (
                        <span className="ml-auto min-w-0 truncate pl-2 text-xs text-sdc-muted">{row.billingGroup}</span>
                      )}
                    </button>
                  </th>
                  {DEPT_HEADERS.map((h) => (
                    <td
                      key={h.key}
                      className={`py-1.5 px-2 text-right tabular-nums whitespace-nowrap ${
                        h.core ? "text-sdc-navy" : "text-sdc-gray-600"
                      }`}
                    >
                      {h.key === "utilizationPct" ? <UtilCell pct={row.utilizationPct} /> : numeric(row, h.key)}
                    </td>
                  ))}
                </tr>
                {open &&
                  row.employeeRows.map((e) => (
                    <tr
                      key={`${row.key}::${e.employeeId}`}
                      className={`border-b border-sdc-border-soft text-xs ${
                        drill.isOpen(e.employeeId) ? "bg-sdc-blue-light" : "bg-sdc-gray-50"
                      }`}
                    >
                      <th
                        scope="row"
                        className={`${DEPT_CELL} ${drill.isOpen(e.employeeId) ? "bg-sdc-blue-light" : "bg-sdc-gray-50"} py-1 pl-9 pr-3 text-left font-normal text-sdc-gray-700`}
                      >
                        {/* Only people with hours are drillable — an empty panel
                            for someone who booked nothing is a dead end, so the
                            row stays plain text rather than offering a click
                            that leads nowhere. */}
                        {e.actualHours > 0 ? (
                          <button
                            type="button"
                            onClick={() => drill.toggle({ employeeId: e.employeeId, name: e.name })}
                            aria-pressed={drill.isOpen(e.employeeId)}
                            title={`Show ${e.name}'s punches for this month`}
                            className="text-left underline decoration-dotted decoration-sdc-gray-400 underline-offset-2 hover:text-sdc-blue hover:decoration-sdc-blue"
                          >
                            {e.name}
                          </button>
                        ) : (
                          e.name
                        )}
                        {!e.active && (
                          <span
                            className="ml-1.5 rounded bg-sdc-yellow-bg px-1 py-0.5 text-[0.6rem] font-semibold uppercase text-sdc-yellow-text"
                            title="No longer active, but booked hours in this month — see department-utilization.ts"
                          >
                            Left
                          </span>
                        )}
                      </th>
                      {DEPT_HEADERS.map((h) => (
                        <td key={h.key} className="py-1 px-2 text-right tabular-nums whitespace-nowrap text-sdc-gray-700">
                          {h.key === "employees" ? "" : h.key === "utilizationPct" ? <UtilCell pct={e.utilizationPct} muted /> : numeric(e, h.key)}
                        </td>
                      ))}
                    </tr>
                  ))}
              </Fragment>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-sdc-border bg-white font-semibold text-sdc-navy">
            <th scope="row" className={`${DEPT_CELL} bg-white py-2 pl-3 pr-3 text-left`}>
              Total
              {/* NOT "billable departments" any more: this foots the ETC
                  Engineering + Shop departments the card shows, which differ from
                  the report's five by Manufacturing Operations. See
                  department-utilization.ts's header — the figure legitimately
                  differs from the Power BI report's grand total, and the label has
                  to say which one it is. */}
              <span className="ml-1.5 text-xs font-normal text-sdc-muted">Engineering &amp; Shop</span>
            </th>
            {DEPT_HEADERS.map((h) => (
              <td
                key={h.key}
                className="py-2 px-2 text-right tabular-nums whitespace-nowrap"
                // The foot's Utilization % is billable / actual across EVERY row
                // above, Service Engineering and Project Management included —
                // even though those two rows show "—" for their own Utilization %
                // (they sit outside the report's billable departments). Their
                // hours are in both halves of the ratio, so the foot stays a
                // true total of what is on screen; saying so here is cheaper
                // than letting somebody derive it and conclude it is a bug.
                title={
                  h.key === "utilizationPct"
                    ? "Billable hours / hours worked across every ETC Engineering and Shop department shown"
                    : undefined
                }
              >
                {h.key === "utilizationPct" ? <UtilCell pct={result.total.utilizationPct} /> : numeric(result.total, h.key)}
              </td>
            ))}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

type EmpSort = "utilAsc" | "utilDesc" | "hours" | "name";

function EmployeeUtilization({
  result,
  drill,
}: {
  result: DepartmentUtilizationResult;
  drill: ReturnType<typeof useEmployeePunchDrill>;
}) {
  const [dept, setDept] = useState<string>("__scope__");
  const [query, setQuery] = useState("");
  const [order, setOrder] = useState<EmpSort>("utilAsc");

  // Derived from `employees`, NOT from `result.departments` — that array is now
  // the execution-only set the department card renders, and reading it here would
  // have quietly dropped Shop, Finance and the rest from THIS panel's selector
  // while its "All departments" option still filtered over all of them. This
  // panel is a peer card with its own scope and was not part of the execution
  // filter; deriving its options from the rows it actually filters keeps the two
  // consistent by construction.
  const departments = useMemo(() => {
    const seen = new Map<string, string>();
    for (const e of result.employees) if (!seen.has(e.departmentKey)) seen.set(e.departmentKey, e.departmentTitle);
    return [...seen.entries()]
      .map(([key, title]) => ({ key, title }))
      .sort((a, b) => departmentCardOrderRank(a.key) - departmentCardOrderRank(b.key) || a.title.localeCompare(b.title));
  }, [result.employees]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = result.employees.filter((e) => {
      if (dept === "__scope__") {
        // The default view answers the same question the report's "Bottom 10" does:
        // who among the billable departments is running low. Somebody with no hours
        // at all has no utilization to rank, so they are not in it.
        if (!e.inUtilizationScope || e.actualHours <= 0) return false;
      } else if (dept !== "__all__" && e.departmentKey !== dept) return false;
      if (q && !e.name.toLowerCase().includes(q)) return false;
      return true;
    });
    list = [...list];
    switch (order) {
      case "utilAsc":
        // Nulls last in both directions — an undefined ratio is not "the lowest".
        list.sort((a, b) => (a.utilizationPct ?? Infinity) - (b.utilizationPct ?? Infinity) || a.name.localeCompare(b.name));
        break;
      case "utilDesc":
        list.sort((a, b) => (b.utilizationPct ?? -Infinity) - (a.utilizationPct ?? -Infinity) || a.name.localeCompare(b.name));
        break;
      case "hours":
        list.sort((a, b) => b.actualHours - a.actualHours || a.name.localeCompare(b.name));
        break;
      case "name":
        list.sort((a, b) => a.name.localeCompare(b.name));
        break;
    }
    return list;
  }, [result.employees, dept, query, order]);

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-sdc-border-soft px-3 py-2">
        <label className="sr-only" htmlFor="util-emp-search">
          Search employee
        </label>
        <input
          id="util-emp-search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search employee…"
          className={`${INPUT} min-w-[10rem] flex-1 !py-1.5 text-sm`}
        />
        <label className="sr-only" htmlFor="util-emp-dept">
          Department
        </label>
        <select
          id="util-emp-dept"
          value={dept}
          onChange={(e) => setDept(e.target.value)}
          className={`${INPUT} w-auto shrink-0 !py-1.5 pr-8 text-sm`}
        >
          <option value="__scope__">Billable departments</option>
          <option value="__all__">All departments</option>
          {departments.map((d) => (
            <option key={d.key} value={d.key}>
              {d.title}
            </option>
          ))}
        </select>
        <label className="sr-only" htmlFor="util-emp-sort">
          Sort
        </label>
        <select
          id="util-emp-sort"
          value={order}
          onChange={(e) => setOrder(e.target.value as EmpSort)}
          className={`${INPUT} w-auto shrink-0 !py-1.5 pr-8 text-sm`}
        >
          <option value="utilAsc">Lowest utilization</option>
          <option value="utilDesc">Highest utilization</option>
          <option value="hours">Most hours</option>
          <option value="name">Name</option>
        </select>
      </div>

      {rows.length === 0 ? (
        <p className="px-3 py-6 text-sm text-sdc-muted">No employees match that filter.</p>
      ) : (
        // Capped height with its own scroll so a 50-person list cannot stretch the
        // Dashboard; the department table above stays the page's anchor.
        <ul className="styled-scrollbar max-h-[24rem] min-h-0 flex-1 overflow-y-auto">
          {rows.map((e) => {
            const tone = utilTone(e.utilizationPct);
            const width = e.utilizationPct === null ? 0 : Math.min(100, e.utilizationPct * 100);
            return (
              <li key={e.employeeId}>
                {/* The whole row opens this person's punches — this list is the
                    most natural place to ask "why is that number what it is",
                    so it is drillable as well as the department table's rows.
                    People with no hours stay inert: an empty panel is a dead
                    end. */}
                <button
                  type="button"
                  onClick={() => e.actualHours > 0 && drill.toggle({ employeeId: e.employeeId, name: e.name })}
                  disabled={e.actualHours <= 0}
                  aria-pressed={drill.isOpen(e.employeeId)}
                  title={e.actualHours > 0 ? `Show ${e.name}'s punches for this month` : `${e.name} booked no hours this month`}
                  className={`flex w-full items-center gap-3 px-3 py-1.5 text-left text-sm ${
                    drill.isOpen(e.employeeId) ? "bg-sdc-blue-light" : TABLE_ROW_HOVER
                  } ${e.actualHours > 0 ? "" : "cursor-default"}`}
                >
                  {/* Hours moved onto the second line, beside the department,
                      and the bar is narrower. This list now lives in a 21rem
                      column beside the department table, and as a row of four
                      fixed-width columns it left the NAME 26px of a 314px panel
                      -- every person read as two characters. The fixed furniture
                      is ~156px now, so the name keeps the rest. */}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sdc-navy">{e.name}</span>
                    <span className="flex items-baseline gap-2 text-xs text-sdc-muted">
                      <span className="min-w-0 truncate">{e.departmentTitle}</span>
                      <span className="ml-auto shrink-0 tabular-nums">{hoursFmt(e.actualHours)}h</span>
                    </span>
                  </span>
                  <span className="h-2 w-16 shrink-0 overflow-hidden rounded-full bg-sdc-gray-100" aria-hidden>
                    <span className={`block h-full rounded-full ${tone.bar}`} style={{ width: `${width}%` }} />
                  </span>
                  <span className={`w-11 shrink-0 text-right text-sm font-semibold tabular-nums ${tone.text}`}>
                    {pctFmt(e.utilizationPct)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function UtilizationPanel({ result, monthLabel }: { result: DepartmentUtilizationResult; monthLabel: string }) {
  const hasHours = result.total.actualHours > 0;
  // ONE punch drill for the whole section, scoped to the same month the table
  // is showing — so clicking a second person replaces the panel rather than
  // stacking two, and the panel can never be showing a different month from the
  // row that opened it.
  const drill = useEmployeePunchDrill(result.month);
  const drilled = drill.target ? result.employees.find((e) => e.employeeId === drill.target!.employeeId) : null;

  if (!hasHours) {
    return (
      <Panel>
        <PanelHead
          title="Engineering & Shop Utilization"
          note={`${monthLabel} · ${result.workingDays} working days`}
        />
        <p className="py-8 text-sm text-sdc-muted">No hours booked in {monthLabel} yet.</p>
      </Panel>
    );
  }

  return (
    // ── One full-width column (2026-08-31, by request) ──────────────────────
    //
    // Everything in this band is now the same width and stacks top to bottom.
    //
    // It was a two-column grid: the department table at 1fr and, beside it, a
    // 21rem column holding either the ranked employee list or — once you clicked
    // a person — their punch drill, which widened that column to 26–31rem. That
    // widening is what this change removes. The department table is sixteen
    // columns and measures ~1362px; handing a third of the row to the drill
    // pushed several hundred pixels of it behind a horizontal scrollbar exactly
    // when a reader was trying to compare the punch detail against the row it
    // came from. A table you have to scroll sideways to read is worse than a
    // taller page, which the original two-column note said about a 65/35 split
    // and is just as true of a drill-sized right column.
    //
    // So the drill opens BELOW the department card at full width, and the ranked
    // employee list follows it. No `xl:` column template, no drill-dependent
    // width, nothing that changes shape when the drill opens — the department
    // table is the same width whether or not somebody is drilled into.
    //
    // Every panel here is still height-capped and scrolls internally (the drill
    // through Drill.tsx's own `drill-cap`), so stacking three of them does not
    // turn the band into a long scroll: the page grows by one capped card when a
    // drill is open, and by nothing at all when it is not.
    <div className="flex min-w-0 flex-col gap-5">
      <Panel flush className="flex min-w-0 flex-col">
        <PanelHead
          className="border-b border-sdc-border px-4 py-2.5"
          title="Engineering & Shop Utilization"
          note={`${monthLabel} · ${result.workingDays} working days · theoretical = headcount × ${result.workingDays} × 8h${
            result.travelKnown ? "" : " · travel not recorded for this month"
          }`}
        />
        <DepartmentTable result={result} drill={drill} />
      </Panel>

      {/* Directly under the table the click came from, so the punches and the
          row they belong to read as one thing. Rendered only while somebody is
          selected — closing it leaves no placeholder and the band returns to its
          compact height. Clicking a second person REPLACES this panel rather than
          adding another: there is one drill for the whole section, keyed by the
          selected employee (see useEmployeePunchDrill), so two people's punches
          can never be on screen at once claiming to be the same month. */}
      {drill.target && (
        <EmployeePunchDrillPanel
          target={drill.target}
          result={drill.result}
          loading={drill.loading}
          error={drill.error}
          monthLabel={monthLabel}
          onClose={drill.close}
          expectedHours={drilled?.actualHours ?? 0}
        />
      )}

      {/* The ranked list stays — it is a peer question ("who is running low"),
          not a thing the drill replaces. It used to be swapped out because it
          shared the right-hand column with the drill; now that they are stacked,
          both can be on screen, which is what makes clicking through several
          people from the list actually work. */}
      <Panel flush className="flex min-w-0 flex-col">
        <PanelHead
          className="border-b border-sdc-border px-4 py-2.5"
          title="Employee Utilization"
          note="Billable hours / hours worked"
        />
        <EmployeeUtilization result={result} drill={drill} />
      </Panel>
    </div>
  );
}
