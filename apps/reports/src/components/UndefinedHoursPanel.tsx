"use client";

import { useMemo, useState } from "react";
import { hours as fmtHours, hoursExact } from "@/components/ui/format";
// The one drill-through design (§47) — shared with HoursDetailPanel, which is what
// stops these two tables from drifting apart again.
import {
  DRILL_BODY,
  DRILL_CAP,
  DRILL_NUM,
  DRILL_TOTAL_LABEL,
  DrillControls,
  DrillFilterRow,
  DrillGroup,
  DrillGroupOption,
  DrillGroupTray,
  DrillLines,
  DrillTable,
} from "@/components/ui/Drill";
import { reconcileUndefined, reconciliationMessage } from "@/lib/undefined-hours-rules";
import type { UnattributedDetail } from "@/lib/unattributed-hours";
// One rollup implementation for every drill on this page — including the grid's
// department and section ordering. See the note on groupHoursRows.
import { groupHoursRows, rollupSortColumns, GROUP_LABEL, type GroupKey } from "@/components/HoursDetailPanel";
// The same filter model as every other drill on this page (§73). The reason cards above
// are a filter too, and they write into the same state rather than keeping a second one —
// see the note where the panel's filters are declared.
import { dateBounds, filterOptions, matchesDrillFilters, type DrillFilterKey } from "@/lib/drill-filters";
import { useDrillFilters } from "@/components/useDrillFilters";
import { useColumnSort } from "@/components/useColumnSort";
import { SortableTh } from "@/components/ui/SortableHeader";
import { sortRows, type SortColumns } from "@/lib/table-sort";

// ── Line sorting ─────────────────────────────────────────────────────────────
//
// One shared sort state for both the grouped lines and the ungrouped list — they show
// the same row shape, just with Department and Row hidden in the grouped view (see the
// two <DrillLines> heads below; unlike HoursDetailPanel this panel never shows
// Department at the line level even when grouped by something else, so there is no
// detailCols-style conditional to track here).
type LineSortKey = "date" | "employee" | "department" | "job" | "section" | "reason" | "hours" | "row";

const LINE_COLUMNS: SortColumns<UnattributedDetail["rows"][number], LineSortKey> = {
  date: { type: "date", value: (r) => r.date },
  employee: { type: "text", value: (r) => r.employee || null },
  department: { type: "text", value: (r) => (r.department && r.department !== "—" ? r.department : null) },
  // The raw, unusable cell value ("NOT DEFINED", "2026 SERVICE") — never a real job
  // number, so `text`, not `id`.
  job: { type: "text", value: (r) => r.job || null },
  // Sorts on exactly what the cell displays — the combined "code — name" whenever the
  // two differ, the bare code otherwise.
  section: { type: "text", value: (r) => (r.sectionName && r.sectionName !== r.section ? `${r.section} — ${r.sectionName}` : r.section) },
  reason: { type: "status", value: (r) => r.reasonLabel },
  hours: { type: "hours", value: (r) => r.hours },
  row: { type: "number", value: (r) => r.sourceRow || null },
};

// ── The Undefined Hours drill-through (§42.11, §42.27, §42.28) ──────────────
//
// This used to borrow HoursDetailPanel, which is built for "who worked on this job" —
// a flat punch list grouped by department/employee/section. That is the wrong shape
// here. These rows are not work to be understood, they are FAULTS to be corrected, and
// the question a manager has is "what do I go and fix, and where".
//
// So the panel leads with the reason breakdown, tells you what to do about each one,
// and states its reconciliation against the KPI outright rather than leaving two
// numbers on different parts of the screen for a reader to compare.
//
// ── Why the reconciliation line is prominent rather than a footnote ─────────
//
// §42.28 requires the drill to show reconciliation status and treat a mismatch as an
// application issue. That is not defensive decoration: the card and this panel read
// two different tables until 2026-08-05, and the previous version of this drill
// carried a note explaining that they might disagree. They cannot disagree any more —
// both come from one pass over one import — so the line is now an assertion the app
// makes about itself, and a red one means something is genuinely broken.

const REASON_TONE: Record<string, string> = {
  // Faults somebody can fix in Paylocity — amber, because this is work to do rather
  // than something broken.
  fault: "border-sdc-yellow bg-sdc-yellow-bg/50",
};

export function UndefinedHoursPanel({
  detail,
  month,
  onClose,
}: {
  detail: UnattributedDetail;
  month: string;
  onClose: () => void;
}) {
  // ── Filters (§73) ─────────────────────────────────────────────────────────
  //
  // No filters at all = every counted row, which is the state in which the visible total
  // equals the KPI — the §42.11 identity. Any filter narrows the list and the panel says
  // so, so a filtered subtotal is never mistaken for the headline.
  //
  // The reason cards above are part of THIS state, not a second one beside it. They were a
  // single-select `reason` variable, which meant the panel had two independent notions of
  // "narrowed" — the cards' and the search box's — and adding four more dimensions to that
  // arrangement would have given it six. Clicking a card now toggles that reason in the
  // shared model, so it is counted by the badge, undone by Clear filters, and combinable:
  // two reasons at once is a real question ("everything a supervisor has to re-code"), and
  // the single-select version could not ask it.
  const filterState = useDrillFilters(month);
  const { filters } = filterState;
  const reasons = filters.values.reason ?? [];
  const [query, setQuery] = useState("");
  // One way out for everything narrowing the table — the search box included. A "Clear
  // filters" that left text in the box would leave the table narrowed after the control
  // that says it un-narrows it.
  const clearAll = () => {
    filterState.clear();
    setQuery("");
  };

  // ── Grouped by department by default (2026-08-05, by request) ─────────────
  //
  // Same rollup, same chips and the same grid ordering as the other drills — via
  // groupHoursRows, not a second implementation. The undefined rows are structurally
  // HoursDetailRow (plus reason/sourceRow), so they group without adaptation, and the
  // department order comes from EMPLOYEE_TEAMS exactly as it does on the Engineering
  // and Shop drills.
  //
  // Department rather than Reason as the default, even though reason is what this panel
  // is about: the reason breakdown is already stated above as its own block, so opening
  // on it would say the same thing twice. Department answers the question the block
  // does not — WHOSE time this is, and therefore who to go and ask.
  const [groupBy, setGroupBy] = useState<GroupKey[]>(["department"]);
  const [openGroup, setOpenGroup] = useState<string | null>(null);

  // Sort is independent of filtering and grouping (§73's own principle, extended) — see
  // table-sort.ts.
  const rollupSort = useColumnSort<GroupKey | "hours">();
  const lineSort = useColumnSort<LineSortKey>();
  const rollupColumns = useMemo(() => rollupSortColumns(groupBy), [groupBy]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return detail.rows.filter((r) => {
      if (!matchesDrillFilters(r, filters)) return false;
      if (!q) return true;
      return (
        r.employee.toLowerCase().includes(q) ||
        r.job.toLowerCase().includes(q) ||
        r.section.toLowerCase().includes(q) ||
        r.date.includes(q)
      );
    });
  }, [detail.rows, filters, query]);

  // The menus' options come from the UNFILTERED rows — see the same note in
  // HoursDetailPanel: a shrinking option list is a filter you can enter and not leave.
  //
  // "Undefined Job" rather than "Job cell" (§76, by request — the previous name read as
  // a spreadsheet coordinate, and "Job" alone would claim it WAS one): the value is the
  // raw, unusable cell contents that made the row undefined in the first place — "NOT
  // DEFINED", "2026 SERVICE", or a numeric-looking code like "2026" that just has no
  // matching Job in the app (see lib/paylocity-workbook.ts's JOB_NOT_FOUND widening),
  // never a real job number. The table's own column was renamed alongside it, so the
  // filter and the header still use the same word for the same thing.
  const menus = useMemo(() => {
    const list: { key: DrillFilterKey; label?: string; options: { value: string; label: string; suffix?: string }[]; searchable?: boolean }[] = [
      { key: "department", options: filterOptions(detail.rows, "department").map((d) => ({ value: d, label: d })) },
      {
        key: "employee",
        options: filterOptions(detail.rows, "employee").map((e) => ({ value: e, label: e })),
        searchable: true,
      },
      {
        key: "section",
        options: detail.sections.map((s) => ({
          value: s.code,
          label: s.name === s.code ? s.code : `${s.code} — ${s.name}`,
          suffix: fmtHours(s.hours),
        })),
        searchable: true,
      },
      {
        key: "job",
        label: "Undefined Job",
        options: filterOptions(detail.rows, "job").map((j) => ({ value: j, label: j })),
        searchable: true,
      },
      {
        // The reason menu and the reason cards are two ways into one selection — the cards
        // for the guided path (they carry the corrective action), the menu for combining a
        // reason with a department in one pass over the row.
        key: "reason",
        options: detail.groups.map((g) => ({ value: g.reason, label: g.label })),
      },
    ];
    return list;
  }, [detail.rows, detail.sections, detail.groups]);

  const bounds = useMemo(() => dateBounds(detail.rows), [detail.rows]);

  const shownTotal = rows.reduce((s, r) => s + r.hours, 0);
  const filtered = filterState.count > 0 || query.trim() !== "";
  const recon = reconcileUndefined(detail.total, detail.storedTotal);
  const groups = useMemo(() => groupHoursRows(rows, groupBy), [rows, groupBy]);

  return (
    <section
      // Capped, with one scrolling body (§49) — the same treatment DrillPanel gives the
      // other drills, applied here because this panel owns its own shell (see the header
      // note for why it is not DrillPanel).
      //
      // The header and the reconciliation line stay OUTSIDE the scroller: Close has to be
      // reachable, and the reconciliation line is an assertion the app makes about itself
      // (§42.28) — scrolling it out of sight would be the one thing on this panel that
      // must not happen.
      // No `overflow-hidden` alongside the ceiling: at extreme zoom this panel's fixed
      // region (heading + reconciliation line) can exceed the ceiling's own floor on its
      // own. Clipping there would make the table unreachable; overflowing is merely
      // untidy, and the page scrolls. Nothing needs the clip — the last child is the
      // padded body, so no background reaches the rounded corners.
      className={`motion-panel flex ${DRILL_CAP} flex-col rounded-xl border border-sdc-border bg-white shadow-sm`}
      aria-label={`Data Quality — Undefined Hours detail for ${month}`}
    >
      {/* ── Header: title, month, KPI total, close (§42.27) ─────────────── */}
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-sdc-border-soft px-4 py-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-sdc-navy">
            Data Quality — Undefined Hours <span className="font-normal text-sdc-muted">— {month}</span>
          </h3>
          <p className="mt-0.5 text-note leading-relaxed text-sdc-gray-600">
            Time booked to something that isn&apos;t a usable job number. It reaches{" "}
            <strong>no figure on this page</strong> — not the grid, not the totals, not the Engineering or Shop KPIs.
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded-md border border-sdc-border bg-white px-2.5 py-1 text-label font-medium text-sdc-gray-600 motion-interactive hover:bg-sdc-blue-light"
        >
          Close
        </button>
      </header>

      {/* ── Reconciliation status (§42.28) ───────────────────────────────── */}
      <p
        role={recon.ok ? undefined : "alert"}
        className={`flex items-center gap-2 px-4 py-2 text-label font-medium ${
          recon.ok ? "bg-sdc-blue-light/50 text-sdc-gray-600" : "bg-sdc-red-bg text-sdc-red-text"
        }`}
      >
        {/* Not colour alone (§42.23): the glyph and the wording both carry it. */}
        <span aria-hidden>{recon.ok ? "✓" : "✕"}</span>
        {reconciliationMessage(detail.total, detail.storedTotal)}
        {!recon.ok && <span className="font-normal">— this is an application fault, not a display issue. Please report it.</span>}
      </p>

      {/* ── Fixed: reason cards, Group by, filters, and the meta line (§75) ────────
          None of this scrolls with the table any more. It used to live inside the same
          scrolling body as the records — "the cards are the tallest block, so pinning
          the controls would leave the table a sliver" — but that traded away the actual
          requirement: a filter or the Group tray must stay reachable, and the meta line
          must stay legible ("what am I looking at"), however far down the records you've
          scrolled. Every other drill already keeps its controls outside the scroller (see
          DrillPanel) — this is the one place that didn't, because this panel hand-rolls
          its own shell (see the header note for why it isn't DrillPanel). */}
      <div className="px-4 py-3">
        {/* ── Reasons, with what to do about each (§42.12, §42.27) ───────── */}
        {detail.groups.length > 0 && (
          <>
            <h4 className="mb-1.5 text-label font-semibold uppercase tracking-wide text-sdc-muted">Why these are undefined</h4>
            <ul className="mb-3 grid gap-1.5 md:grid-cols-2">
              {detail.groups.map((g) => {
                const active = reasons.includes(g.reason);
                return (
                  <li key={g.reason}>
                    <button
                      type="button"
                      // Toggles this reason in the shared filter state, so two cards can be
                      // active at once and the badge and Clear filters both know about it.
                      onClick={() => filterState.toggle("reason", g.reason)}
                      aria-pressed={active}
                      className={`w-full rounded-lg border px-3 py-2 text-left motion-interactive ${REASON_TONE.fault} ${
                        active ? "ring-2 ring-sdc-blue ring-offset-1" : "hover:border-sdc-yellow-text"
                      }`}
                    >
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="text-xs font-semibold text-sdc-navy">{g.label}</span>
                        <span className="shrink-0 text-xs font-bold tabular-nums text-sdc-navy" title={hoursExact(g.hours)}>
                          {fmtHours(g.hours)}
                        </span>
                      </span>
                      {/* The corrective action — §42.27's "corrective data needed". */}
                      <span className="mt-0.5 block text-note leading-relaxed text-sdc-gray-600">{g.fix}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}

        {/* ── Group by and filters, in the shared drill controls (§47) ─────────
            One row, the same tray and the same filter treatment as every other drill —
            these were a line of solid-blue chips plus a separate Ungroup button, which
            read as five primary actions and matched nothing else in the app. The
            behaviour is unchanged: the dimensions still toggle (so "Department ›
            Employee" is reachable) and "Punches" is the old Ungroup. */}
        <DrillControls>
          <DrillGroupTray>
            {(Object.keys(GROUP_LABEL) as GroupKey[]).map((k) => {
              const on = groupBy.includes(k);
              const rank = groupBy.indexOf(k) + 1;
              return (
                <DrillGroupOption
                  key={k}
                  on={on}
                  onClick={() => {
                    // Toggling a dimension, not replacing the set — "Department › Employee"
                    // is a real question ("which of Mechanical's people did this?") and the
                    // other drills already work this way.
                    setGroupBy((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]));
                    setOpenGroup(null);
                    // The rollup's columns change identity whenever groupBy does.
                    rollupSort.setSort(null);
                    // The grouped lines never show Department/Row regardless of which
                    // dimension(s) are chosen — only the ungrouped<->grouped TRANSITION
                    // changes the line columns. groupBy.length === 0 here means "currently
                    // ungrouped", so this click is exactly that transition.
                    if (groupBy.length === 0 && (lineSort.sort?.key === "department" || lineSort.sort?.key === "row")) {
                      lineSort.setSort(null);
                    }
                  }}
                  title={
                    on
                      ? `Grouped by ${GROUP_LABEL[k].toLowerCase()} (level ${rank}) — click to remove`
                      : `Roll the records up by ${GROUP_LABEL[k].toLowerCase()}`
                  }
                >
                  {groupBy.length > 1 && on ? `${rank}. ` : ""}
                  {GROUP_LABEL[k]}
                </DrillGroupOption>
              );
            })}
            <DrillGroupOption
              on={groupBy.length === 0}
              onClick={() => {
                setGroupBy([]);
                setOpenGroup(null);
                rollupSort.setSort(null);
              }}
              title="Show the individual punches"
            >
              {/* "Punches", matching the hours drill (2026-08-05, by request). Both trays
                  end in the same un-grouped option and it must read the same in both. */}
              Punches
            </DrillGroupOption>
          </DrillGroupTray>

          {/* The five dimension menus, the date range, the badge and Clear filters — the
              same row, in the same order, as every other drill (§73). The search box rides
              along as `extra` because it is this panel's alone: it spans four fields at
              once, which is the right control for hunting a specific bad punch and the
              wrong one for narrowing to a department.
              `count` includes the search box, so the badge counts everything narrowing the
              table rather than everything narrowing it that happens to be a menu. */}
          <DrillFilterRow
            filters={filters}
            menus={menus}
            activeCount={filterState.count + (query.trim() ? 1 : 0)}
            onToggle={filterState.toggle}
            onSetAll={filterState.setAll}
            onRange={filterState.setRange}
            onClear={clearAll}
            dateBounds={bounds}
            extra={
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search employee, job, section or date"
                aria-label="Search undefined hours"
                className="h-7 min-w-[12rem] flex-1 rounded-md border border-sdc-border-soft px-2 text-note outline-none motion-interactive focus:border-sdc-blue"
              />
            }
          />
        </DrillControls>

        {/* What the table currently IS — the shared design's meta line, in the position
            this panel has room for it (its heading is the KPI strip above). No record
            count anywhere in it (§62): the active rollup is named, not counted — the
            KPI reconciliation banner above already states the total, in hours. */}
        <p className="px-4 pb-2 text-note text-sdc-muted">
          {groups ? `Grouped by ${groupBy.map((k) => GROUP_LABEL[k].toLowerCase()).join(" › ")}` : "All records"}
          {/* A filtered view no longer equals the KPI, and says so rather than letting a
              subtotal be read as the headline. */}
          {filtered && (
            <>
              {" · showing "}
              <strong className="font-semibold text-sdc-navy" title={hoursExact(shownTotal)}>
                {fmtHours(shownTotal)}
              </strong>
              {` of the ${fmtHours(detail.storedTotal)} total — clear the filters to reconcile against the KPI`}
            </>
          )}
        </p>
      </div>

      {/* ── The ONE scrolling region — only the records (§75) ──────────────────────
          Everything that decides what the table shows now lives above, outside this
          div; everything below is what got decided. The table's own header stays
          visible while its rows scroll — that is what `sticky` on DrillLines' thead is
          for — and the Total row at the bottom is plain flow, not pinned (see the note
          on DrillTable in ui/Drill.tsx for why a sticky one used to paint over rows that
          had not scrolled into view yet). */}
      <div className={`${DRILL_BODY} border-t border-sdc-border px-4 py-3`}>
        {detail.rows.length === 0 ? (
          <p className="rounded-lg border border-dashed border-sdc-border bg-sdc-gray-50 px-3 py-6 text-center text-note text-sdc-muted">
            Every punch this month has a valid job number. Nothing to correct.
          </p>
        ) : rows.length === 0 ? (
          <p className="rounded-lg border border-dashed border-sdc-border bg-sdc-gray-50 px-3 py-6 text-center text-note text-sdc-muted">
            No records match these filters.
          </p>
        ) : groups ? (
          /* ── The rollup, in the shared drill table (§47) ─────────────────────
             One row per group, a caret that opens the lines underneath, the total at the
             bottom. It used to hand-roll all of that with a navy-ruled footer, a ▼/▶
             glyph swap and a colspan'd nested table — none of which matched the hours
             drill doing the identical job. */
          <DrillTable
            columns={groupBy.map((k) => ({ label: GROUP_LABEL[k], key: k }))}
            unit="Hours"
            unitSortKey="hours"
            sort={rollupSort.sort}
            onSort={rollupSort.onSort}
            totalLabel={filtered ? "Shown" : "Total"}
            total={fmtHours(shownTotal)}
            totalTitle={hoursExact(shownTotal)}
          >
            {sortRows(groups, rollupSort.sort, rollupColumns).map((g) => (
              <DrillGroup
                key={g.key}
                values={g.values}
                total={fmtHours(g.hours)}
                totalTitle={hoursExact(g.hours)}
                open={openGroup === g.key}
                onToggle={() => setOpenGroup(openGroup === g.key ? null : g.key)}
                columns={groupBy.length}
              >
                <DrillLines
                  head={
                    <>
                      <SortableTh label="Date" sortKey="date" type="date" sort={lineSort.sort} onSort={lineSort.onSort} className="w-24" />
                      <SortableTh label="Employee" sortKey="employee" type="text" sort={lineSort.sort} onSort={lineSort.onSort} />
                      <SortableTh label="Undefined Job" sortKey="job" type="text" sort={lineSort.sort} onSort={lineSort.onSort} className="w-32" />
                      <SortableTh label="Section" sortKey="section" type="text" sort={lineSort.sort} onSort={lineSort.onSort} className="w-48" />
                      <SortableTh label="Reason" sortKey="reason" type="status" sort={lineSort.sort} onSort={lineSort.onSort} className="w-36" />
                      <SortableTh label="Hours" sortKey="hours" type="hours" sort={lineSort.sort} onSort={lineSort.onSort} className="w-20" />
                    </>
                  }
                >
                  {sortRows(g.rows as UnattributedDetail["rows"], lineSort.sort, LINE_COLUMNS).map((r, i) => (
                    <tr key={`${r.date}-${r.sourceRow}-${i}`}>
                      <td className="whitespace-nowrap font-mono tabular-nums text-sdc-muted">{r.date}</td>
                      <td className="text-sdc-gray-700">{r.employee}</td>
                      {/* The raw cell value is the thing to go and correct, so it stays
                          monospaced and emphasised rather than muted with the rest. */}
                      <td className="font-mono font-semibold text-sdc-red-text">{r.job}</td>
                      <td className="whitespace-nowrap text-sdc-muted">
                        {r.sectionName === r.section ? r.section : `${r.section} — ${r.sectionName}`}
                      </td>
                      <td className="whitespace-nowrap text-sdc-muted">{r.reasonLabel}</td>
                      <td className={DRILL_NUM} title={hoursExact(r.hours)}>
                        {fmtHours(r.hours)}
                      </td>
                      <td className="text-right font-mono tabular-nums text-sdc-muted">{r.sourceRow || "—"}</td>
                    </tr>
                  ))}
                </DrillLines>
              </DrillGroup>
            ))}
          </DrillTable>
        ) : (
          // No scroll container of its own (§49): the panel body above IS the scroller,
          // and a second one nested inside it would cap the Lines view shorter than the
          // rollup it toggles with. The sticky HEADER still works against the body's
          // scroller the same way it did against this one; the total row is plain flow
          // now, not sticky (§75), so it needs nothing special from this wrapper at all.
          <div className="border-t border-sdc-border">
            <DrillLines
              head={
                <>
                  <SortableTh label="Date" sortKey="date" type="date" sort={lineSort.sort} onSort={lineSort.onSort} className="w-24" />
                  <SortableTh label="Employee" sortKey="employee" type="text" sort={lineSort.sort} onSort={lineSort.onSort} />
                  <SortableTh label="Department" sortKey="department" type="text" sort={lineSort.sort} onSort={lineSort.onSort} className="w-40" />
                  <SortableTh label="Undefined Job" sortKey="job" type="text" sort={lineSort.sort} onSort={lineSort.onSort} className="w-32" />
                  <SortableTh label="Section" sortKey="section" type="text" sort={lineSort.sort} onSort={lineSort.onSort} className="w-48" />
                  <SortableTh label="Reason" sortKey="reason" type="status" sort={lineSort.sort} onSort={lineSort.onSort} className="w-36" />
                  <SortableTh label="Hours" sortKey="hours" type="hours" sort={lineSort.sort} onSort={lineSort.onSort} className="w-20" />
                  {/* The source row, so somebody can open the workbook and find it. */}
                  <SortableTh label="Row" sortKey="row" type="number" sort={lineSort.sort} onSort={lineSort.onSort} className="w-16" />
                </>
              }
              foot={
                <tr>
                  <td className={DRILL_TOTAL_LABEL} colSpan={6}>
                    {filtered ? "Shown" : "Total"}
                  </td>
                  <td className={`${DRILL_NUM} text-sm font-semibold`} title={hoursExact(shownTotal)}>
                    {fmtHours(shownTotal)}
                  </td>
                  <td />
                </tr>
              }
            >
              {sortRows(rows, lineSort.sort, LINE_COLUMNS).map((r, i) => (
                <tr key={`${r.date}-${r.employee}-${r.section}-${r.sourceRow}-${i}`}>
                  <td className="whitespace-nowrap font-mono tabular-nums text-sdc-muted">{r.date}</td>
                  <td className="text-sdc-gray-700">{r.employee}</td>
                  <td className="text-sdc-muted">{r.department}</td>
                  {/* The raw cell value is the thing to go and correct, so it is
                      monospaced and emphasised rather than buried. */}
                  <td className="font-mono font-semibold text-sdc-red-text">{r.job}</td>
                  <td className="whitespace-nowrap text-sdc-muted">
                    {r.sectionName === r.section ? r.section : `${r.section} — ${r.sectionName}`}
                  </td>
                  <td className="whitespace-nowrap text-sdc-muted">{r.reasonLabel}</td>
                  <td className={DRILL_NUM} title={hoursExact(r.hours)}>
                    {fmtHours(r.hours)}
                  </td>
                  <td className="text-right font-mono tabular-nums text-sdc-muted">{r.sourceRow || "—"}</td>
                </tr>
              ))}
            </DrillLines>
          </div>
        )}
      </div>
    </section>
  );
}
