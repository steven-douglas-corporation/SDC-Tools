"use client";

import { useMemo, useState } from "react";
import { hours as fmtHours, hoursCell, hoursExact } from "@/components/ui/format";
// The one drill-through design (§47). See components/ui/Drill.tsx for why the panels
// supply data and the design lives there.
import {
  DRILL_NUM,
  DRILL_TOTAL_LABEL,
  DrillControls,
  DrillEmpty,
  DrillFilterRow,
  DrillGroup,
  DrillGroupOption,
  DrillGroupTray,
  DrillLines,
  DrillPanel,
  DrillTable,
} from "@/components/ui/Drill";
// One filter model for every drill on this page (§73) — the same vocabulary the rollup
// uses, so "Section" cannot mean one thing to Group By and another to a filter.
import { dateBounds, filterOptions, matchesDrillFilters, type DrillFilterKey } from "@/lib/drill-filters";
import { useDrillFilters } from "@/components/useDrillFilters";
import { useColumnSort } from "@/components/useColumnSort";
import { SortableTh } from "@/components/ui/SortableHeader";
import { sortRows, type SortColumns } from "@/lib/table-sort";
import type { JobHoursDetail } from "@/lib/job-hours-detail";
// The two canonical orders the grid itself reads in — see the note on groupHoursRows.
import { departmentFilterRank } from "@/lib/hours-filters";
import { SECTIONS } from "@/lib/sections";

// The dimensions the punch list can be rolled up by. Exported because the Undefined
// Hours panel offers the same rollup over the same row shape, and a second copy of this
// vocabulary is one that eventually disagrees about what "Section" groups on.
export type GroupKey = "department" | "employee" | "section" | "job";

export const GROUP_LABEL: Record<GroupKey, string> = {
  department: "Department",
  employee: "Employee",
  section: "Section",
  job: "Job",
};

// The value a row contributes to a given grouping dimension.
//
// Section deliberately groups on "code — name" rather than the bare code: the two are
// 1:1, so grouping on the pair is identical to grouping on the code, and it saves
// carrying a representative row around purely to print the name.
//
// Department and Job fall back to an em dash. A punch with no department still has
// hours, and dropping it out of a rollup would make the group totals stop summing to
// the Total at the bottom.
export function groupValue(row: JobHoursDetail["rows"][number], key: GroupKey): string {
  switch (key) {
    case "department":
      return row.department || "—";
    case "employee":
      return row.employee || "—";
    case "section":
      return row.sectionName ? `${row.section} — ${row.sectionName}` : row.section;
    case "job":
      return row.job || "—";
  }
}

export type HoursGroup = {
  key: string;
  values: string[];
  lines: number;
  hours: number;
  // The punches behind the rollup, kept so expanding a group needs no second pass
  // over the data and cannot disagree with the count beside it.
  rows: JobHoursDetail["rows"];
};

// Roll punch lines up into one row per distinct combination of the chosen dimensions.
// Returns null when nothing is grouped, which is how the panel decides to render the
// punch list instead.
//
// Exported and pure so the arithmetic is testable: the invariant that matters is that
// the group hours SUM to the ungrouped total, because both are shown at once — the
// groups in the table and the total in its footer.
//
// ── Order (changed 2026-08-05, by request) ─────────────────────────────────
//
// Grouped by DEPARTMENT or by SECTION, the rows now come out in the order the Monthly
// ETC grid reads left to right, so the drill and the table underneath it can be
// compared line for line. Hours-descending re-sorted the departments on every filter
// change, which meant the drill and the grid agreed on the totals and disagreed on the
// order — the reading you actually do between the two is "is Controls the same in
// both", and that is a lot harder when the rows move.
//
// Neither order is derived here. Departments follow EMPLOYEE_TEAMS (lib/employee-teams),
// which is already the canonical order and already knows the alias names — "Mechanical
// Build / Manufacturing" and "Mechanical Build" are one team. Sections follow SECTIONS,
// which IS the grid's column order. A second hand-written list of either is one that
// eventually disagrees with the grid it is supposed to match.
//
// Every other dimension — employee, job, and any combination — keeps hours descending:
// there is no grid order for those, and "where did the time go" is the right first row.
// Ties break on the key so the order is stable across renders rather than dependent on
// Map insertion.
export function groupHoursRows(
  rows: JobHoursDetail["rows"],
  groupBy: GroupKey[],
): HoursGroup[] | null {
  if (groupBy.length === 0) return null;
  const map = new Map<string, HoursGroup>();
  for (const r of rows) {
    const values = groupBy.map((k) => groupValue(r, k));
    // JSON rather than a joined string: collision-free by construction. Joining means
    // choosing a separator that can't appear in a department name, an employee name or
    // a job title — and on a space, ["a b", "c"] and ["a", "b c"] would collapse into
    // the same group.
    const key = JSON.stringify(values);
    const cur = map.get(key) ?? { key, values, lines: 0, hours: 0, rows: [] };
    cur.lines += 1;
    cur.hours += r.hours;
    cur.rows.push(r);
    map.set(key, cur);
  }
  const groups = [...map.values()];

  // A single dimension that the grid has an order for uses that order. Combinations are
  // left on hours-descending: "Department › Employee" has no grid equivalent, and
  // ordering the outer level while the inner one stayed by size would read as neither.
  if (groupBy.length === 1 && (groupBy[0] === "department" || groupBy[0] === "section")) {
    const rank = groupBy[0] === "department" ? departmentFilterRank : sectionRank;
    return groups.sort((a, b) => {
      const ra = rank(a.values[0]);
      const rb = rank(b.values[0]);
      // Anything the grid has no place for sorts after everything it does — by hours, so
      // an unrecognised department is still ordered usefully among its own kind rather
      // than alphabetically.
      if (ra !== rb) return ra - rb;
      return b.hours - a.hours || a.key.localeCompare(b.key);
    });
  }

  return groups.sort((a, b) => b.hours - a.hours || a.key.localeCompare(b.key));
}

// UNRANKED (not -1) for anything unmapped, so it sorts last rather than first.
// Department ranking itself now comes from hours-filters.ts's
// departmentFilterRank -- this file used to have its own copy, which
// collapsed "no department" and "a real but unmapped department" (e.g.
// Finance, Sales, a typo) to the same rank instead of ordering the blank
// strictly after the others the way departmentFilterRank does.
const UNRANKED = Number.MAX_SAFE_INTEGER;

// Sections are grouped as "code — name" (see groupValue), so the code is read off the
// front rather than the whole label being matched.
export function sectionRank(label: string): number {
  const code = label.split(" — ")[0]?.trim() ?? label.trim();
  const i = SECTIONS.findIndex((s) => s.code === code);
  return i === -1 ? UNRANKED : i;
}

// ── Punch-line sorting ──────────────────────────────────────────────────────
//
// One shared sort state serves both the ungrouped punch list and every expanded group's
// lines — they show the same row shape, just with some columns hidden (see detailCols).
// A module-level constant, not a useMemo: every accessor closes over nothing but the row
// itself, so there is nothing to recompute per render.
// One rendering of the rule-book verdict, shared by this panel's two tables so the
// grouped and flat views cannot describe the same punch differently. Undefined is
// called out in the warning colour and carries the REASON in its tooltip, because the
// two real fixes differ: a mis-punched Section/Function gets corrected in Paylocity,
// while a legitimate combination the rule book has not approved yet needs the rule
// book extended. It is never a reason to hide the row — the hours still count.
function MappingStatusCell({ row }: { row: { mappingStatus: string; rawSection: string; rawFunction: string; undefinedReason?: string } }) {
  if (row.mappingStatus !== "Undefined") return <span className="text-sdc-muted">Mapped</span>;
  return (
    <span
      className="text-sdc-yellow-text"
      title={`Undefined${row.undefinedReason ? `: ${row.undefinedReason}` : ""} — Section ${row.rawSection || "(blank)"} + Function ${row.rawFunction || "(blank)"} is not in the approved rule book. The hours are still counted.`}
    >
      Undefined
    </span>
  );
}

type LineSortKey = "date" | "job" | "employee" | "department" | "rawSection" | "rawSectionName" | "rawFunction" | "standardTaskDescription" | "mappingStatus" | "hours";

const LINE_COLUMNS: SortColumns<JobHoursDetail["rows"][number], LineSortKey> = {
  date: { type: "date", value: (r) => r.date },
  // The pre-joined "1105 — Cell A" display string; split so it sorts on the job number
  // like the rest of the app (see compareByType's `id` handling), not the whole string.
  job: { type: "id", value: (r) => (r.job ? r.job.split(" — ")[0] : null) },
  employee: { type: "text", value: (r) => (r.employee && r.employee !== "—" ? r.employee : null) },
  department: { type: "text", value: (r) => (r.department && r.department !== "—" ? r.department : null) },
  // Each half sortable on its own — the point of splitting them.
  rawSection: { type: "text", value: (r) => r.rawSection || null },
  rawSectionName: { type: "text", value: (r) => r.rawSectionName || null },
  rawFunction: { type: "text", value: (r) => r.rawFunction || null },
  standardTaskDescription: { type: "text", value: (r) => r.standardTaskDescription || null },
  mappingStatus: { type: "text", value: (r) => r.mappingStatus || null },
  hours: { type: "hours", value: (r) => r.hours },
};

/**
 * The rollup's own column map for the currently-chosen `groupBy` — one text accessor per
 * grouped dimension (reading the group's `values[i]` at that dimension's position), plus
 * Hours. Shared by HoursDetailPanel and UndefinedHoursPanel — both roll up through
 * groupHoursRows onto the identical `HoursGroup` shape, so a second copy of this loop
 * would be exactly the kind of page-by-page duplicate the shared sort mechanism exists
 * to avoid.
 */
export function rollupSortColumns(groupBy: GroupKey[]): SortColumns<HoursGroup, GroupKey | "hours"> {
  const cols: Partial<SortColumns<HoursGroup, GroupKey | "hours">> = { hours: { type: "hours", value: (g) => g.hours } };
  groupBy.forEach((k, i) => {
    cols[k] = { type: "text", value: (g) => g.values[i] };
  });
  return cols as SortColumns<HoursGroup, GroupKey | "hours">;
}

// In-app equivalent of the Power BI report's "Hours Detail" drillthrough page:
// every punch on the job — date, who, their department, section, hours — with a
// total at the bottom.
//
// Whole job with a Section column, per Dan, plus a section filter so the
// section you drilled from is one click away. `initialSection` preselects it,
// because arriving here from a section bar and seeing every section would lose
// the context you clicked with.
//
// Sourced from the app's own Paylocity ingest, NOT Power BI's 'Hours Actual':
// the two disagree on section attribution (see JobHoursDetail in schema.prisma),
// so a model-sourced table could show a total that contradicted the bar above it.
export function HoursDetailPanel({
  detail,
  initialSection,
  title,
  note,
  onClose,
  className,
  defaultGroupBy,
  hideFilters,
}: {
  detail: JobHoursDetail;
  initialSection?: string | null;
  // Layout the CALLER owns: spacing when this sits below something, `h-full` when it
  // sits beside something and the two are meant to be the same height. The panel used
  // to hardcode `mt-4`, which was right for its only caller at the time and wrong the
  // moment it acquired a second one.
  className?: string;
  // Overrides the heading — the Monthly ETC drill names the month it's showing.
  title?: string;
  // Shown under the subtitle. Used to explain a gap between this table's total
  // and the figure on the card that opened it, rather than leaving the reader to
  // spot the difference and assume something is broken.
  note?: string;
  // Opens grouped by something other than Department (still one of the same
  // GROUP_KEYS toggles below — every caller keeps the full tray, just a
  // different starting point for this one). Defaults to `["department"]" so
  // every existing caller is unaffected.
  defaultGroupBy?: GroupKey[];
  // Drops these dimensions from the filter dropdowns entirely, for a caller whose
  // own initialSection + surrounding context already narrows the drill enough
  // that offering a second Department/Employee narrowing is redundant. Grouping
  // by that dimension is untouched — this only hides the FILTER, not the tray.
  hideFilters?: DrillFilterKey[];
  onClose: () => void;
}) {
  // ── Filters (§73) ───────────────────────────────────────────────────────────
  //
  // Four dimensions and a date range, all multi-select, over the shared model — where
  // this panel previously had three single-choice selects and no way to ask about two
  // departments at once. Department is new here: it was the DEFAULT rollup and yet the
  // one dimension you could not narrow to, so "show me only Mechanical's punches, by
  // employee" was not expressible.
  //
  // `initialSection` still preselects the section you drilled from — as a one-value
  // selection now rather than a select's value. See useDrillFilters for why Clear filters
  // returns to it rather than to nothing.
  const seededSection =
    initialSection && detail.sections.some((s) => s.code === initialSection) ? initialSection : null;
  // Keyed on `initialSection` (§73's resetKey, same mechanism EtcMonthKpiCards keys on
  // `month`) — without it, clicking a second bar updated SectionDrill above (plain props)
  // but left this panel's Section filter seeded from whichever bar was clicked FIRST:
  // this state is `useState`-lazy-initialized once and this component never unmounts
  // between clicks, so nothing told it to re-seed.
  const filterState = useDrillFilters(initialSection ?? undefined, () => ({
    values: seededSection ? { section: [seededSection] } : {},
    from: "",
    to: "",
  }));
  const { filters } = filterState;

  // The Job column only appears when the detail actually spans jobs (the Monthly
  // ETC month view). On the per-job drill it would repeat the page heading on
  // every row, so it's inferred from the data rather than passed as a flag.
  const showJob = detail.rows.some((r) => r.job);

  // ── Group by ────────────────────────────────────────────────────────────────
  //
  // Toggle chips rather than a single-choice dropdown, because the useful question
  // is usually two-dimensional: "which departments, and who inside them" (2026-08-03,
  // by request). Order is CLICK order, so Department then Employee reads
  // department-major and the reverse reads employee-major — the same data pivoted,
  // and which one is right depends on what you are chasing.
  //
  // With nothing selected the table is the punch list it has always been. Selecting
  // anything switches it to one row per distinct combination, with a line count so a
  // group of 1 is distinguishable from a group of 40 at the same total.
  //
  // Grouping applies to the FILTERED rows, so it composes with the three selects
  // rather than competing with them, and the Total stays the same figure either way.
  // Opens grouped by DEPARTMENT (2026-08-03, by request). A raw punch list is the wrong
  // first view: 25 lines of "NOT DEFINED / Jake Wiegand" answers "which punches" when the
  // question being asked is "where did the time go". Department is the coarsest useful
  // answer, and the chips take you finer or back to the lines in one click.
  const [groupBy, setGroupBy] = useState<GroupKey[]>(defaultGroupBy ?? ["department"]);
  // Which groups are opened to show the punches inside them. Cleared whenever the
  // grouping changes, because the keys it holds describe the OLD shape — a stale key
  // wouldn't crash (it simply wouldn't match) but it would leave rows silently open or
  // shut for reasons the reader can't see.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Sort is a THIRD, independent concern from filtering and grouping (§73's own "Group
  // By stays entirely separate" principle, extended) — see table-sort.ts.
  const rollupSort = useColumnSort<GroupKey | "hours">();
  const lineSort = useColumnSort<LineSortKey>();

  const toggleGroup = (k: GroupKey) => {
    setExpanded(new Set());
    // The rollup's columns change identity whenever groupBy does, so any prior rollup
    // sort is stale by construction.
    rollupSort.setSort(null);
    setGroupBy((prev) => {
      const next = prev.includes(k) ? prev.filter((g) => g !== k) : [...prev, k];
      // A line sort survives a groupBy change UNLESS the column it's sorting on just
      // became one of the grouped (hidden) dimensions — date/hours are never hidden.
      const sortedKey = lineSort.sort?.key;
      if (sortedKey && sortedKey !== "date" && sortedKey !== "hours" && !sortedKey.startsWith("raw") && !sortedKey.startsWith("standard") && sortedKey !== "mappingStatus" && next.includes(sortedKey as GroupKey)) {
        lineSort.setSort(null);
      }
      return next;
    });
  };
  const toggleExpanded = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  // Rebuilt only when groupBy changes, since the accessors close over its shape.
  const rollupColumns = useMemo(() => rollupSortColumns(groupBy), [groupBy]);

  // One predicate for every dimension, so adding a filter cannot leave the row set and
  // the "Shown" wording disagreeing about whether anything is narrowed — which is what
  // happened when the job select was added to the three-condition version of this.
  const rows = useMemo(() => detail.rows.filter((r) => matchesDrillFilters(r, filters)), [detail.rows, filters]);
  const total = rows.reduce((s, r) => s + r.hours, 0);

  // ── The menus' options come from the UNFILTERED rows ─────────────────────────
  //
  // Deliberately not from `rows`: an option list that shrinks as you tick removes the
  // box you would use to widen the selection again, which is a filter you can enter and
  // not leave. Memoised on detail.rows alone for the same reason — these do not move
  // when a filter changes.
  const menus = useMemo(() => {
    const list: { key: DrillFilterKey; options: { value: string; label: string; suffix?: string }[]; searchable?: boolean }[] = [
      {
        key: "department",
        options: filterOptions(detail.rows, "department").map((d) => ({ value: d, label: d })),
      },
      {
        key: "employee",
        options: filterOptions(detail.rows, "employee").map((e) => ({ value: e, label: e })),
        searchable: true,
      },
      {
        // Section options come from `detail.sections`, not from a scan of the rows: that
        // list is already scoped to the card that opened the drill (see scopedDetail in
        // EtcMonthKpiCards) and it carries the names and the per-section hours the old
        // select showed.
        key: "section",
        options: detail.sections.map((s) => ({
          value: s.code,
          label: `${s.code} — ${s.name}`,
          suffix: fmtHours(s.hours),
        })),
        searchable: true,
      },
    ];
    if (showJob) {
      list.push({
        key: "job",
        options: filterOptions(detail.rows, "job").map((j) => ({ value: j, label: j })),
        searchable: true,
      });
    }
    return hideFilters ? list.filter((m) => !hideFilters.includes(m.key)) : list;
  }, [detail.rows, detail.sections, showJob, hideFilters]);

  const bounds = useMemo(() => dateBounds(detail.rows), [detail.rows]);

  // null when nothing is grouped — the punch list renders instead. See groupHoursRows.
  const grouped = useMemo(() => groupHoursRows(rows, groupBy), [rows, groupBy]);

  // Job is only offered when the data actually spans jobs — same rule as the column.
  const GROUP_KEYS: GroupKey[] = showJob
    ? ["department", "employee", "section", "job"]
    : ["department", "employee", "section"];

  // Which columns an expanded group's punch lines show. A grouped dimension is
  // CONSTANT inside the group, so printing it on every line would just repeat the row
  // that was clicked to get there. Date and Hours always show — they are the only two
  // that vary no matter how the rollup is built.
  const detailCols = {
    job: showJob && !groupBy.includes("job"),
    employee: !groupBy.includes("employee"),
    department: !groupBy.includes("department"),
    section: !groupBy.includes("section"),
  };

  // Which columns the flat (ungrouped) punch list shows. Named so the header and the
  // body read the same list rather than two hand-kept copies.
  // Drives the footer's colSpan, so it must list every column the flat table renders.
  // Section/Function were split into five columns on 2026-08-21; a stale count here
  // would leave the total cell under the wrong column.
  const flatCols = [
    "Date",
    ...(showJob ? ["Job"] : []),
    "Employee",
    "Department",
    "Section",
    "Section Name",
    "Function",
    "Function Name",
    "Mapping",
    "Hours",
  ];
  // What the table currently IS — the active rollup, with no punch count attached
  // anywhere in it (§62: "3 groups by department · 680 of 680 punches" is now just
  // "Grouped by department"). Counts are gone from every level — this line, each
  // group row, and the expand/collapse tooltip in DrillGroup — while the Hours column
  // and the total stay untouched; §62 only asks to stop counting rows, not hours.
  const meta = grouped
    ? `Grouped by ${groupBy.map((k) => GROUP_LABEL[k].toLowerCase()).join(" › ")}`
    : showJob
      ? "Every punch booked this month"
      : "Every punch booked on this job";

  // Whether a filter is narrowing the table, read from the filter state rather than by
  // comparing row counts. Same figure the badge shows, so the total's label and the badge
  // can never contradict each other — and it is what keeps a FILTERED subtotal from being
  // read as the KPI: filtered, the total row says "Shown", not "Total".
  const filtering = filterState.count > 0;

  return (
    // Spacing is the caller's business (`className`) — the panel used to hardcode `mt-4`,
    // which was right for its only caller at the time and wrong the moment it sat BESIDE
    // the card that opens it rather than below it.
    <DrillPanel
      title={title ?? "Hours Detail"}
      meta={`${meta}${filtering ? " · filtered" : ""}${detail.truncated ? " · oldest punches omitted past the cap" : ""}`}
      note={note}
      onClose={onClose}
      className={className}
      controls={
        <DrillControls>
          {/* The rollup comes first: it changes what the table IS, where the selects
              below only narrow it. Multi-select and click-ordered — see the note where
              groupBy is declared — which is why these are `aria-pressed` toggles in a
              tray rather than the reference's five radio tabs. */}
          <DrillGroupTray>
            {GROUP_KEYS.map((k) => {
              const on = groupBy.includes(k);
              const rank = groupBy.indexOf(k) + 1;
              return (
                <DrillGroupOption
                  key={k}
                  on={on}
                  onClick={() => toggleGroup(k)}
                  title={
                    on
                      ? `Grouped by ${GROUP_LABEL[k].toLowerCase()} (level ${rank}) — click to remove`
                      : `Roll the punches up by ${GROUP_LABEL[k].toLowerCase()}`
                  }
                >
                  {/* The ordinal only appears once there are two or more levels, where
                      the order actually changes the reading. */}
                  {groupBy.length > 1 && on ? `${rank}. ` : ""}
                  {GROUP_LABEL[k]}
                </DrillGroupOption>
              );
            })}
            {/* The reference's "None". Named "Punches" because that is what it shows, and
                it is IN the tray rather than a separate Ungroup button beside it — one
                control answering "how is this rolled up", with every answer including
                "not at all" in the same place. */}
            <DrillGroupOption
              on={!grouped}
              onClick={() => {
                setGroupBy([]);
                setExpanded(new Set());
                rollupSort.setSort(null);
              }}
              title="Show the individual punches"
            >
              Punches
            </DrillGroupOption>
          </DrillGroupTray>

          {/* The filters, BESIDE the tray and independent of it (§73): the tray decides
              what a row is, these decide which rows there are. Nothing here touches
              `groupBy` and nothing there touches `filters`, so either can be changed
              without disturbing the other — and grouping applies to the filtered rows, so
              the two compose rather than compete. */}
          <DrillFilterRow
            filters={filters}
            menus={menus}
            activeCount={filterState.count}
            onToggle={filterState.toggle}
            onSetAll={filterState.setAll}
            onRange={filterState.setRange}
            onClear={filterState.clear}
            dateBounds={bounds}
          />
        </DrillControls>
      }
    >
      {rows.length === 0 ? (
        // Distinguishes "nothing ingested" from "your filters exclude everything" — the
        // fixes are completely different.
        <DrillEmpty>
          {detail.rows.length === 0
            ? "No punch-level hours stored for this job yet. They land with the next hours sync."
            : "No punches match these filters."}
        </DrillEmpty>
      ) : grouped ? (
        <DrillTable
          columns={groupBy.map((k) => ({ label: GROUP_LABEL[k], key: k }))}
          unit="Hours"
          unitSortKey="hours"
          sort={rollupSort.sort}
          onSort={rollupSort.onSort}
          totalLabel={filtering ? "Shown" : "Total"}
          total={fmtHours(total)}
          totalTitle={hoursExact(total)}
        >
          {sortRows(grouped, rollupSort.sort, rollupColumns).map((g) => (
            <DrillGroup
              key={g.key}
              values={g.values}
              total={hoursCell(g.hours)}
              totalTitle={hoursExact(g.hours)}
              open={expanded.has(g.key)}
              onToggle={() => toggleExpanded(g.key)}
              columns={groupBy.length}
            >
              {/* A grouped dimension is CONSTANT inside the group, so printing it on
                  every line would just repeat the row that was clicked to get here —
                  see detailCols. */}
              <DrillLines
                head={
                  <>
                    <SortableTh label="Date" sortKey="date" type="date" sort={lineSort.sort} onSort={lineSort.onSort} className="w-24" />
                    {detailCols.job && <SortableTh label="Job" sortKey="job" type="id" sort={lineSort.sort} onSort={lineSort.onSort} className="w-56" />}
                    {detailCols.employee && <SortableTh label="Employee" sortKey="employee" type="text" sort={lineSort.sort} onSort={lineSort.onSort} />}
                    {detailCols.department && (
                      <SortableTh label="Department" sortKey="department" type="text" sort={lineSort.sort} onSort={lineSort.onSort} className="w-44" />
                    )}
                    {detailCols.section && (
                      <>
                        {/* Section and Function as separate columns (2026-08-21) — a
                            combined "10-211 — General" cell cannot say whether the
                            Section, the Function, or only the pairing is wrong. */}
                        <SortableTh label="Section" sortKey="rawSection" type="text" sort={lineSort.sort} onSort={lineSort.onSort} className="w-16" />
                        <SortableTh label="Section Name" sortKey="rawSectionName" type="text" sort={lineSort.sort} onSort={lineSort.onSort} className="w-40" />
                        <SortableTh label="Function" sortKey="rawFunction" type="text" sort={lineSort.sort} onSort={lineSort.onSort} className="w-16" />
                        <SortableTh label="Function Name" sortKey="standardTaskDescription" type="text" sort={lineSort.sort} onSort={lineSort.onSort} className="w-40" />
                        <SortableTh label="Mapping" sortKey="mappingStatus" type="text" sort={lineSort.sort} onSort={lineSort.onSort} className="w-24" />
                      </>
                    )}
                    <SortableTh label="Hours" sortKey="hours" type="hours" sort={lineSort.sort} onSort={lineSort.onSort} className="w-20" />
                  </>
                }
              >
                {sortRows(g.rows, lineSort.sort, LINE_COLUMNS).map((r, ri) => (
                  <tr key={`${r.date}-${r.employee}-${r.section}-${ri}`}>
                    <td className="font-mono tabular-nums text-sdc-muted">{r.date}</td>
                    {detailCols.job && (
                      <td className="text-sdc-gray-700" title={r.job}>
                        <span className="line-clamp-1">{r.job}</span>
                      </td>
                    )}
                    {detailCols.employee && <td className="text-sdc-gray-700">{r.employee}</td>}
                    {detailCols.department && <td className="text-sdc-muted">{r.department}</td>}
                    {detailCols.section && (
                      <>
                        <td className="font-mono text-sdc-muted">{r.rawSection}</td>
                        <td className="text-sdc-muted">{r.rawSectionName}</td>
                        <td className="font-mono text-sdc-muted">{r.rawFunction}</td>
                        <td className="text-sdc-muted">{r.standardTaskDescription}</td>
                        <td className="text-sdc-muted">
                          <MappingStatusCell row={r} />
                        </td>
                      </>
                    )}
                    <td className={DRILL_NUM} title={hoursExact(r.hours)}>
                      {hoursCell(r.hours)}
                    </td>
                  </tr>
                ))}
              </DrillLines>
            </DrillGroup>
          ))}
        </DrillTable>
      ) : (
        // Ungrouped: the punch list itself, shown directly rather than behind one
        // collapsed "All punches" group the way the reference's "None" does — this panel
        // has always shown the punches on arrival and making that a click is a step
        // backwards. The total rides in the table's own tfoot, where it cannot drift out
        // of the column it totals.
        //
        // No scroll container of its own any more (§49). This used to be capped at 24rem
        // inside a panel that was otherwise unbounded; the panel is now capped and its
        // body is the scroller, so a second one here would mean two scrollbars, the
        // shorter of the two winning, and the Lines view showing less than the rollup
        // beside it on the same screen. The sticky HEADER works against the panel's
        // scroller exactly as it did against this one; the footer is plain flow, not
        // sticky (§75), so it needs nothing special from this wrapper at all.
        <>
          <DrillLines
            head={
              <>
                <SortableTh label="Date" sortKey="date" type="date" sort={lineSort.sort} onSort={lineSort.onSort} className="w-24" />
                {showJob && <SortableTh label="Job" sortKey="job" type="id" sort={lineSort.sort} onSort={lineSort.onSort} className="w-56" />}
                <SortableTh label="Employee" sortKey="employee" type="text" sort={lineSort.sort} onSort={lineSort.onSort} />
                <SortableTh label="Department" sortKey="department" type="text" sort={lineSort.sort} onSort={lineSort.onSort} className="w-44" />
                <SortableTh label="Section" sortKey="rawSection" type="text" sort={lineSort.sort} onSort={lineSort.onSort} className="w-16" />
                <SortableTh label="Section Name" sortKey="rawSectionName" type="text" sort={lineSort.sort} onSort={lineSort.onSort} className="w-40" />
                <SortableTh label="Function" sortKey="rawFunction" type="text" sort={lineSort.sort} onSort={lineSort.onSort} className="w-16" />
                <SortableTh label="Function Name" sortKey="standardTaskDescription" type="text" sort={lineSort.sort} onSort={lineSort.onSort} className="w-40" />
                <SortableTh label="Mapping" sortKey="mappingStatus" type="text" sort={lineSort.sort} onSort={lineSort.onSort} className="w-24" />
                <SortableTh label="Hours" sortKey="hours" type="hours" sort={lineSort.sort} onSort={lineSort.onSort} className="w-20" />
              </>
            }
            foot={
              <tr>
                <td className={DRILL_TOTAL_LABEL} colSpan={flatCols.length - 1}>
                  {filtering ? "Shown" : "Total"}
                </td>
                <td className={`${DRILL_NUM} text-sm font-semibold`} title={hoursExact(total)}>
                  {fmtHours(total)}
                </td>
              </tr>
            }
          >
            {sortRows(rows, lineSort.sort, LINE_COLUMNS).map((r, i) => (
              <tr key={`${r.date}-${r.employee}-${r.section}-${i}`}>
                <td className="font-mono tabular-nums text-sdc-muted">{r.date}</td>
                {showJob && (
                  <td className="text-sdc-gray-700" title={r.job}>
                    <span className="line-clamp-1">{r.job}</span>
                  </td>
                )}
                <td className="text-sdc-gray-700">{r.employee}</td>
                <td className="text-sdc-muted">{r.department}</td>
                <td className="font-mono text-sdc-muted">{r.rawSection}</td>
                <td className="text-sdc-muted">{r.rawSectionName}</td>
                <td className="font-mono text-sdc-muted">{r.rawFunction}</td>
                <td className="text-sdc-muted">{r.standardTaskDescription}</td>
                <td className="text-sdc-muted">
                  <MappingStatusCell row={r} />
                </td>
                {/* Rounded, like every other hours figure in the app; the title keeps the
                    exact punch reachable. */}
                <td className={DRILL_NUM} title={hoursExact(r.hours)}>
                  {hoursCell(r.hours)}
                </td>
              </tr>
            ))}
          </DrillLines>
        </>
      )}
    </DrillPanel>
  );
}
