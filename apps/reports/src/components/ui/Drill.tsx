"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { MenuBulkActions, MenuCheckbox } from "@/components/MenuStatus";
import { DRILL_FILTER_LABEL, type DrillFilterKey, type DrillFilters } from "@/lib/drill-filters";
import { SortableColumnHeader } from "@/components/ui/SortableHeader";
import type { SortState } from "@/lib/table-sort";

// ── The drill-through panel, one design (§47) ────────────────────────────────
//
// Implements the "KPI Card Redesign" reference (KPI Card Redesign/KPI Summary Card.dc.html)
// for every drill-through in the app.
//
// ── Why this is a shared component and not three sets of classes ────────────
//
// Because there were three drill-throughs and three designs, and they had drifted far
// enough apart that the same table read differently depending on which KPI you clicked:
//
//                     HoursDetailPanel        UndefinedHoursPanel      DataQualityDrill
//   header row        navy fill, white text   TABLE_HEADER_ROW gray    navy fill, white text
//   row separation    zebra stripes           hairlines                zebra stripes
//   gridlines         TABLE_GRID (all cells)  none                     none
//   caret             ▶ + rotate-90           ▼/▶ glyph swap           n/a
//   total row         bg-gray-100 "Total"     border-t-2 navy "Shown"  n/a
//
// Five decisions, made three times, agreeing on none of them. So the design lives here
// and the panels supply data — which is also what makes the redesign hold: there is one
// place to change it next time.
//
// ── Grids read as spreadsheets; drills read as reports ──────────────────────
//
// The big grids (Monthly ETC, Projects) keep TABLE_GRID and GRID_SCROLLER — full
// gridlines, sharp corners, every cell bordered. That is deliberate (§41.23) and stays:
// people edit them like spreadsheets.
//
// A drill-through is the opposite thing. It is read, not edited; it is a rollup, not a
// matrix; and its columns are few and wide rather than many and narrow. The reference
// treats it that way — no cell borders at all, hairline separators between ROWS only,
// and hierarchy carried by type size, weight and colour. So these tokens are separate
// from the grid tokens on purpose, and neither should be used for the other.
//
// ── The reference's palette is NOT copied ───────────────────────────────────
//
// The mockup is drawn in a warm-gray scheme (#f4f4f2 / #e2e0d9 / #16233a / #2b5f8e) in
// Inter Tight and IBM Plex Mono. This app has a committed brand palette and one type
// scale, both test-guarded (§39), and a second palette living in one component is
// exactly the "duplicate theme definitions" §39.16 forbids — it is how the charts came
// to use a different font from everything else. So the reference's STRUCTURE, spacing,
// hierarchy and interaction are adopted; its hex values map onto the tokens that already
// mean those things:
//
//   #16233a ink        -> text-sdc-navy         #e2e0d9 panel border -> border-sdc-border
//   #22221c row name   -> text-sdc-gray-700     #eeece5 section rule -> border-sdc-border
//   #8b8b82 secondary  -> text-sdc-muted        #f3f2ec row hairline -> border-sdc-border-soft
//   #2b5f8e link       -> text-sdc-blue-dark    #f4f3ee chip tray    -> bg-sdc-gray-100
//   IBM Plex Mono      -> font-mono             Inter Tight          -> the app's font-sans
//
// Two of the reference's tiers are also dropped rather than mapped: #9a998f (2.87:1) and
// #a9a89f (2.39:1) fail WCAG AA, and this panel renders financial figures at 10–11px.
// Everything secondary uses the one AA-passing muted tone instead (see --sdc-muted).

// ── Tokens ──────────────────────────────────────────────────────────────────

/** The panel frame. Rounded, unlike the grids — a report card, not a spreadsheet. */
const PANEL = "flex flex-col overflow-hidden rounded-lg border border-sdc-border bg-white";

// ── The card is capped and its BODY scrolls (§49) ────────────────────────────
//
// A drill card sits beside the KPI summary card, and each is as tall as its own
// content — see the note in EtcMonthKpiCards for why they no longer stretch to match.
// "As tall as its own content" needs a ceiling, or a fifty-row rollup pushes the grid
// below it off the screen, which is the problem the side-by-side layout was introduced
// to solve.
//
// Two classes, used together, and used by the two hand-rolled drill cards on the
// Monthly ETC page as well as by DrillPanel — so "the drill scrolls internally" is one
// decision rather than four.

/** The height ceiling. Viewport-relative with a zoom floor — see .drill-cap. */
export const DRILL_CAP = "drill-cap";

/**
 * The ONE scrolling region inside a capped drill card. Everything else in the card
 * keeps its content height, so this is the child that absorbs the overflow.
 *
 * `basis-auto` is deliberate and `flex-1` would be wrong: `flex-1` sets
 * `flex-basis: 0`, which makes an auto-height flex column compute its content height
 * from a zero-height body — the card would collapse to its header instead of growing
 * to its content and then capping. `min-h-0` is what lets it shrink past its content
 * at all; without it a flex item refuses to go below its own min-content height and
 * the card overflows its ceiling instead of scrolling.
 */
export const DRILL_BODY = "styled-scrollbar min-h-0 shrink basis-auto overflow-y-auto";

/**
 * The column template, shared by the header, every group row and the total row so all
 * three are guaranteed to line up. A CSS grid rather than a <table>: the group rows and
 * the punch lines inside them have different column counts, and with a table that means
 * either a colspan'd nested table (what HoursDetailPanel did) or misaligned columns.
 *
 * The value column is 6.4rem — 96px at the 15px root, sized for the widest thing these
 * panels put in it, "$1,065,713" in the mono face, which the parts drill does.
 */
const VALUE_COL = "6.4rem";

/** Muted uppercase column header. 10px, the app's densest label step (§39.2). */
const HEAD =
  "border-b border-sdc-border px-4 py-1.5 text-label font-semibold uppercase tracking-[0.1em] text-sdc-muted";

/** A group row: hairline-separated, no cell borders. */
const GROUP_ROW =
  "grid w-full items-center gap-3 border-b border-sdc-border-soft px-4 py-2 text-left motion-interactive hover:bg-sdc-gray-50";

/** Numerics: mono + tabular so columns of figures align digit for digit. */
export const DRILL_NUM = "text-right font-mono tabular-nums text-sdc-navy";

// ── Panel shell ─────────────────────────────────────────────────────────────

export function DrillPanel({
  title,
  meta,
  note,
  onClose,
  controls,
  className,
  children,
}: {
  title: string;
  /** The one-line "what this table currently is" — the active rollup, e.g. "Grouped by department". */
  meta?: ReactNode;
  /** An optional caveat, kept out of `meta` so the meta line stays scannable. */
  note?: ReactNode;
  onClose?: () => void;
  /** The GROUP tray and the filters. Rendered in their own row — see DrillControls. */
  controls?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    // The ceiling is the panel's own business, not the caller's (§49): every drill in
    // the app scrolls internally at the same height, which is the point of there being
    // one panel component. Spacing and placement stay with the caller — see `className`.
    <section className={`${PANEL} ${DRILL_CAP} ${className ?? ""}`} aria-label={title}>
      {/* Header. Title and meta stacked on the left, Close as a quiet bordered pill on
          the right — not in the control row, because it is not a control that changes
          what the table shows.
          Outside the scrolling body, so Close and the title stay on screen however long
          the table is (§49). */}
      <div className="flex items-start justify-between gap-4 px-4 pt-3">
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold tracking-[-0.01em] text-sdc-navy">{title}</h3>
          {meta && <p className="mt-0.5 text-note text-sdc-muted">{meta}</p>}
          {note && <p className="mt-1 max-w-2xl text-note leading-tight text-sdc-yellow-text">{note}</p>}
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-md border border-sdc-border px-2 py-0.5 text-note text-sdc-muted motion-interactive hover:border-sdc-blue-100 hover:text-sdc-navy"
          >
            Close
          </button>
        )}
      </div>

      {controls}

      {/* The table region owns its own top rule, so it reads as a distinct block from
          the controls above it whether or not any controls were passed.
          It is also the one part of the card that scrolls (§49). The header above stays
          put, so Close, the group tray and the filters are reachable without scrolling
          back up through a rollup. No footer (§62 removed "Open full report" / "Export
          CSV" from every drill) — the table region is the last thing in the card, so
          there is no leftover footer band to leave empty. */}
      <div className={`${DRILL_BODY} border-t border-sdc-border`}>{children}</div>
    </section>
  );
}

/**
 * The controls row: a labelled GROUP tray, then anything else (filters) filling the rest.
 *
 * Its own row, below the header, rather than sharing one wrapping flex line with the
 * title and Close — which is what the panels did, and why on a narrow window the group
 * chips, three selects and the Close button wrapped into an unreadable pile beside the
 * heading.
 */
export function DrillControls({ children, className }: { children: ReactNode; className?: string }) {
  // The padding is overridable because the two hand-rolled drill cards on the Monthly ETC
  // strip pad themselves (p-4), and inheriting this row's px-4 on top of that indented the
  // controls 16px further than the table they control. `className` REPLACES the padding
  // rather than adding to it, which is why it is spliced in place of the default.
  return <div className={`flex flex-wrap items-center gap-3 ${className ?? "px-4 py-2.5"}`}>{children}</div>;
}

/**
 * The segmented tray from the reference: an inset well, with the selected option raised
 * to white. Replaces a row of solid-blue filled chips, which read as four primary
 * buttons competing with each other and with the toolbar above.
 *
 * Deliberately NOT made single-select like the mockup. The app's grouping is
 * multi-level and click-ordered (Department › Employee), which is a real capability the
 * mockup's five radio tabs do not have — so the tray takes the reference's LOOK and
 * keeps the app's behaviour. `aria-pressed` on each option says which it is.
 */
export function DrillGroupTray({ label = "Group", children }: { label?: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-label font-semibold uppercase tracking-[0.04em] text-sdc-muted">{label}</span>
      <div className="flex gap-0.5 rounded-md bg-sdc-gray-100 p-0.5">{children}</div>
    </div>
  );
}

export function DrillGroupOption({
  on,
  onClick,
  title,
  children,
}: {
  on: boolean;
  onClick: () => void;
  title?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      title={title}
      className={`rounded-[5px] px-2.5 py-1 text-note font-medium motion-interactive ${
        on ? "bg-white text-sdc-navy shadow-sm" : "text-sdc-muted hover:text-sdc-navy"
      }`}
    >
      {children}
    </button>
  );
}

/** The filter row beside the tray — grows to fill, wraps as one unit. */
export function DrillFilters({ children }: { children: ReactNode }) {
  return <div className="flex min-w-[14rem] flex-1 flex-wrap items-center gap-1.5">{children}</div>;
}

// ── Filters (§73) ───────────────────────────────────────────────────────────
//
// These replace the single-choice <select> pills the hours drill used to have. A select
// can only ever ask one question per dimension ("which ONE department"), and the question
// people actually bring to these tables is "these two, not the rest" — so every filter is
// now a multi-select menu over the same DrillFilters model (lib/drill-filters.ts).
//
// The pill keeps the select's look, including the tint that distinguished "All sections"
// from an active choice, because that distinction is the one thing a filter row must make
// legible at a glance. Its `min-w-0 max-w-[14rem]` is still load-bearing and still for
// §45's reason: full job names must not be able to push a horizontal scrollbar onto the
// page.
//
// Every tick applies IMMEDIATELY and the menu stays open — no draft, no debounce, no
// navigation. Unlike the Projects toolbar menus (useDraftParamsMenu), nothing here is in
// the URL and nothing has to reach the server: the rows are already in the panel, so
// filtering is a synchronous re-filter of an array and the honest latency is zero. A
// debounce would be pure added delay (§32.7).

const FILTER_PILL =
  "flex h-7 min-w-0 max-w-[14rem] cursor-pointer list-none items-center gap-1 rounded-md border px-1.5 text-note outline-none motion-interactive";

/**
 * One dimension's filter, as a checkbox menu behind a pill.
 *
 * `options` are the values present in the UNFILTERED rows — passed in rather than derived
 * from what is on screen, so ticking one department cannot make the others vanish from the
 * menu that would let you tick them back.
 */
export function DrillFilterMenu({
  filterKey,
  label,
  options,
  selected,
  onToggle,
  onSetAll,
  searchable,
}: {
  filterKey: DrillFilterKey;
  /** Overrides the shared dimension name — the undefined-hours drill says "Undefined Job". */
  label?: string;
  options: { value: string; label: string; suffix?: string }[];
  selected: string[];
  onToggle: (value: string) => void;
  onSetAll: (values: string[]) => void;
  /** A search box above the list. Set it for the long ones — employees, jobs. */
  searchable?: boolean;
}) {
  const name = label ?? DRILL_FILTER_LABEL[filterKey];
  const active = selected.length > 0;
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const [query, setQuery] = useState("");

  // Close on a click anywhere else. Same one-line treatment the toolbar menus use — a
  // <details> does not do this for itself, and a filter menu left standing open over the
  // table it just narrowed hides the result of the click.
  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      const el = detailsRef.current;
      if (el?.open && !el.contains(e.target as Node)) el.open = false;
    }
    document.addEventListener("click", onClickOutside);
    return () => document.removeEventListener("click", onClickOutside);
  }, []);

  const q = query.trim().toLowerCase();
  const shown = q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;

  return (
    <details ref={detailsRef} className="group/f relative">
      <summary
        aria-label={`Filter by ${name.toLowerCase()}`}
        className={`${FILTER_PILL} ${
          active ? "border-sdc-border bg-sdc-gray-100 text-sdc-navy" : "border-sdc-border-soft bg-white text-sdc-muted"
        }`}
      >
        <span className="min-w-0 flex-1 truncate">
          {name}
          {/* The selection, stated on the pill so the row can be read without opening
              anything: one tick names itself, several are counted. Counting SELECTIONS is
              not counting rows — §62 removed row counts from these panels and this is a
              count of the filter, which is what the badge above the row totals too. */}
          {selected.length === 1 && (
            <span className="font-medium text-sdc-navy">
              {": "}
              {options.find((o) => o.value === selected[0])?.label ?? selected[0]}
            </span>
          )}
          {selected.length > 1 && <span className="font-medium text-sdc-navy">{` (${selected.length})`}</span>}
        </span>
        <svg
          viewBox="0 0 16 16"
          width="9"
          height="9"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          aria-hidden
          className="shrink-0 opacity-70 motion-interactive group-open/f:rotate-180"
        >
          <path d="M3.5 6 L8 10.5 L12.5 6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </summary>
      {/* motion-menu-panel (§36.5): opacity and a small rise, no height animation, so the
          menu opens at the same speed whether it holds four sections or two hundred jobs.
          z-30 keeps this dropdown above the table content it opens over — the Total row
          it used to specifically clear is plain flow now, not an overlapping layer (§75). */}
      <div className="motion-menu-panel styled-scrollbar absolute left-0 top-full z-30 mt-1 max-h-[calc(var(--app-vh)_*_0.6)] w-64 overflow-y-auto rounded-lg border border-sdc-border bg-white p-2 shadow-lg">
        {searchable && options.length > 8 && (
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${name.toLowerCase()}…`}
            aria-label={`Search ${name.toLowerCase()} options`}
            className="mb-1 h-7 w-full rounded-md border border-sdc-border-soft px-2 text-note outline-none motion-interactive focus:border-sdc-blue"
          />
        )}
        {/* Select all / Clear act on the FULL option list, never the search-filtered view
            — a "Clear" that only cleared what you had typed would be a trap. */}
        <MenuBulkActions onAll={() => onSetAll(options.map((o) => o.value))} onNone={() => onSetAll([])} />
        {shown.map((o) => (
          <MenuCheckbox
            key={o.value}
            label={o.label}
            suffix={o.suffix}
            checked={selected.includes(o.value)}
            onChange={() => onToggle(o.value)}
          />
        ))}
        {shown.length === 0 && <p className="px-1.5 py-1 text-xs text-sdc-gray-400">No matches</p>}
      </div>
    </details>
  );
}

/**
 * The date filter: two bounds, inclusive, applied as typed.
 *
 * One control rather than two independent filters, which is also how it is counted — see
 * activeFilterCount. `min`/`max` come from the rows so the pickers open on the month in
 * question instead of on today.
 */
export function DrillDateRange({
  from,
  to,
  min,
  max,
  onChange,
}: {
  from: string;
  to: string;
  min?: string;
  max?: string;
  onChange: (from: string, to: string) => void;
}) {
  const active = Boolean(from || to);
  const box = `h-7 min-w-0 rounded-md border px-1 text-note outline-none motion-interactive focus:border-sdc-blue ${
    active ? "border-sdc-border bg-sdc-gray-100 text-sdc-navy" : "border-sdc-border-soft bg-white text-sdc-muted"
  }`;
  return (
    <div className="flex min-w-0 items-center gap-1">
      <span className="shrink-0 text-label font-semibold uppercase tracking-[0.04em] text-sdc-muted">Date</span>
      <input
        type="date"
        value={from}
        min={min}
        max={max}
        onChange={(e) => onChange(e.target.value, to)}
        aria-label="Filter from date"
        className={box}
      />
      <span aria-hidden className="shrink-0 text-note text-sdc-muted">
        –
      </span>
      <input
        type="date"
        value={to}
        min={min}
        max={max}
        onChange={(e) => onChange(from, e.target.value)}
        aria-label="Filter to date"
        className={box}
      />
    </div>
  );
}

/**
 * "2 filters · Clear filters" — how many filters are narrowing the table, and the way out.
 *
 * Renders NOTHING when nothing is filtering: "0 filters" is not information, and a Clear
 * button with nothing to clear is a control that does nothing. That also keeps the row
 * from reserving width for a state it spends most of its life in.
 *
 * The count is of FILTERS, never of rows — §62 removed every row/punch/record count from
 * these panels and this is deliberately not a way back in.
 */
export function DrillFilterSummary({ activeCount, onClear }: { activeCount: number; onClear: () => void }) {
  if (activeCount === 0) return null;
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <span
        className="rounded-md bg-sdc-blue-light px-1.5 py-0.5 text-label font-semibold text-sdc-blue-dark"
        // The accessible name spells out what is being counted; the visible chip stays short.
        aria-label={`${activeCount} ${activeCount === 1 ? "filter" : "filters"} active`}
      >
        {activeCount} {activeCount === 1 ? "filter" : "filters"}
      </span>
      <button
        type="button"
        onClick={onClear}
        className="h-7 shrink-0 rounded-md border border-sdc-border bg-white px-2 text-note font-medium text-sdc-muted motion-interactive hover:text-sdc-navy"
      >
        Clear filters
      </button>
    </div>
  );
}

/**
 * The filter row for a drill whose rows carry the standard dimensions — one menu per
 * dimension it is given, the date range, the count and Clear filters, in one consistent
 * order.
 *
 * Assembled here rather than at each call site so the panels cannot end up offering the
 * same filters in three different orders, which is the state their Group By trays were in
 * before §47. A panel with a filter nothing else has (the undefined drill's search box)
 * passes it as `extra`.
 */
export function DrillFilterRow({
  filters,
  menus,
  onToggle,
  onSetAll,
  onRange,
  onClear,
  activeCount,
  dateBounds,
  extra,
}: {
  filters: DrillFilters;
  menus: { key: DrillFilterKey; label?: string; options: { value: string; label: string; suffix?: string }[]; searchable?: boolean }[];
  onToggle: (key: DrillFilterKey, value: string) => void;
  onSetAll: (key: DrillFilterKey, values: string[]) => void;
  onRange: (from: string, to: string) => void;
  onClear: () => void;
  /**
   * How many filters are narrowing the table. Named `activeCount` rather than `count`
   * deliberately: §62's guard forbids a `count=` prop on these panels because DrillGroup
   * used one to state how many punches were behind a row. This one counts FILTERS, which
   * is a different thing entirely, and the distinct name keeps the guard meaningful.
   */
  activeCount: number;
  /** Omit to leave the date filter off — the parts and off-grid drills have no dates. */
  dateBounds?: { min: string; max: string };
  extra?: ReactNode;
}) {
  return (
    <DrillFilters>
      {extra}
      {menus.map((m) => (
        <DrillFilterMenu
          key={m.key}
          filterKey={m.key}
          label={m.label}
          options={m.options}
          selected={filters.values[m.key] ?? []}
          onToggle={(v) => onToggle(m.key, v)}
          onSetAll={(vs) => onSetAll(m.key, vs)}
          searchable={m.searchable}
        />
      ))}
      {dateBounds && (
        <DrillDateRange from={filters.from} to={filters.to} min={dateBounds.min} max={dateBounds.max} onChange={onRange} />
      )}
      <DrillFilterSummary activeCount={activeCount} onClear={onClear} />
    </DrillFilters>
  );
}

// ── The table ───────────────────────────────────────────────────────────────

/**
 * One row's worth of column widths. The header, the group rows and the total row all
 * take the SAME template, which is what guarantees the total lands under the figures it
 * totals — the bug a hand-counted `colSpan` produces when a column is added.
 */
function template(dimensions: number): string {
  // The last dimension takes the slack; earlier ones are content-sized with a floor, so
  // a two-level rollup does not give "Mechanical Engineering" 8 characters.
  const dims = dimensions <= 1 ? "1fr" : `${"minmax(7rem, auto) ".repeat(dimensions - 1)}minmax(7rem, 1fr)`;
  return `${dims} ${VALUE_COL}`;
}

/** One grouping dimension's header — its display label and the key sortRows/onSort key it by. */
export type DrillColumn<K extends string = string> = { label: string; key: K };

export function DrillTable<K extends string = string>({
  columns,
  unit,
  unitSortKey,
  sort,
  onSort,
  total,
  totalLabel = "Total",
  totalTitle,
  children,
}: {
  /** The grouping dimensions, left to right. */
  columns: DrillColumn<K>[];
  /** The value column's heading — "Hours", "Amount". */
  unit: string;
  /** The sort key the value column (`unit`) answers to. */
  unitSortKey: K;
  /** Omit both to render plain, non-interactive headers. */
  sort?: SortState<K>;
  onSort?: (key: K) => void;
  total: ReactNode;
  /** "Shown" rather than "Total" when a filter is narrowing the set. */
  totalLabel?: string;
  totalTitle?: string;
  children: ReactNode;
}) {
  const cols = template(columns.length);
  return (
    <div role="table" aria-rowcount={-1}>
      <div role="row" className={`${HEAD} grid gap-3`} style={{ gridTemplateColumns: cols }}>
        {columns.map((c) => (
          <SortableColumnHeader key={c.key} label={c.label} sortKey={c.key} type="text" sort={sort} onSort={onSort} />
        ))}
        <SortableColumnHeader label={unit} sortKey={unitSortKey} type="hours" align="right" sort={sort} onSort={onSort} />
      </div>

      {children}

      {/* The total, on the same template. Faint fill rather than the heavy navy rule two
          of the panels used — the reference's way of closing a report block.
          ── Why this is NOT `sticky bottom-0` any more (§75) ──────────────────────
          It used to be, on the reasoning that a fifty-group rollup would otherwise push
          the figure the drill exists to reconcile below the fold. But `sticky bottom-0`
          pins the row to the BOTTOM OF THE VIEWPORT the moment any content follows it in
          the scroll, not to the bottom of the CONTENT — so for as long as there is more
          to scroll to, it floats and paints over whatever currently occupies that same
          screen position, which is the row directly above it in an open group. A group
          with only a handful of lines rarely scrolled far enough for this to be visible;
          once DrillGroup stopped capping an open group's own height (see the note below),
          a department with many punches could scroll for a while with the Total glued
          over its bottom few rows the entire time — reported as rows "overlapping" the
          Total. Plain flow means the Total is wherever the content actually ends: always
          reachable by scrolling the card's one scrolling region, never drawn on top of a
          row that has not scrolled into view yet. */}
      <div
        role="row"
        className="grid items-center gap-3 border-t border-sdc-border-soft bg-sdc-gray-50 px-4 py-2"
        style={{ gridTemplateColumns: cols }}
      >
        <span
          role="cell"
          className="text-label font-semibold uppercase tracking-[0.08em] text-sdc-muted"
          style={{ gridColumn: `1 / ${columns.length + 1}` }}
        >
          {totalLabel}
        </span>
        <span role="cell" className={`${DRILL_NUM} text-sm font-semibold`} title={totalTitle}>
          {total}
        </span>
      </div>
    </div>
  );
}

/**
 * A group row plus its expansion.
 *
 * The whole row is the disclosure control, not a small button inside the first cell:
 * the reference makes the row clickable, and a 4px caret is a poor target. It is a
 * <button> so it is reachable by keyboard and announces `aria-expanded`.
 */
export function DrillGroup({
  values,
  total,
  totalTitle,
  open,
  onToggle,
  columns,
  children,
}: {
  /** One label per grouping dimension. */
  values: string[];
  total: ReactNode;
  totalTitle?: string;
  open: boolean;
  onToggle: () => void;
  /** How many dimensions the table has, so this row matches its template. */
  columns: number;
  /** The punch lines, rendered only while open. */
  children: ReactNode;
}) {
  return (
    <div className="border-b border-sdc-border-soft last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        // §62 dropped the line-count badge this used to name ("Hide the 262 punches behind
        // this") — a group row no longer states how many rows are behind it anywhere, so
        // the tooltip is generic to match.
        title={open ? "Hide these rows" : "Show these rows"}
        className={`${GROUP_ROW} border-b-0 ${open ? "bg-sdc-gray-50" : ""}`}
        style={{ gridTemplateColumns: template(columns) }}
      >
        {values.map((v, i) => (
          <span key={i} className="flex min-w-0 items-center gap-2 text-sm font-medium text-sdc-gray-700">
            {/* The caret sits on the FIRST dimension only, so a row has one disclosure
                cue however many levels it has. `rotate` rather than swapping ▶ for ▼:
                a glyph swap jumps, a rotation reads as the same control moving. */}
            {i === 0 && (
              <span
                aria-hidden
                className={`shrink-0 text-micro text-sdc-muted motion-interactive ${open ? "rotate-90" : ""}`}
              >
                ▶
              </span>
            )}
            <span className="truncate" title={v}>
              {v}
            </span>
          </span>
        ))}
        <span className={`${DRILL_NUM} text-note`} title={totalTitle}>
          {total}
        </span>
      </button>

      {open && (
        // Indented and tinted. NO height cap and no vertical scroll of its own any more
        // (§75) — a fixed-height, vertically-scrolling wrapper used to sit here, on the
        // reasoning that a 300-line group should not be able to push the Total row off
        // the screen. That stopped being true the moment the Total stopped being sticky
        // (see the note in DrillTable): the Total is now wherever the content ends, so
        // there is nothing left for a tall group to push "off" — it just makes the
        // panel's own scroller taller. A second, nested scroll region here was also the
        // other half of the original bug: this div's own scroll position moved
        // independently of the panel's, so scrolling THIS box never changed how far down
        // the (then-sticky) Total had floated, and it sat glued over whatever this box's
        // own scrollbar had brought into view.
        // `overflow-x-auto` stays — a group's lines can still be wider than the panel
        // (more columns than fit), and this is what lets THAT scroll sideways on its own
        // rather than the whole panel.
        <div className="overflow-x-auto border-t border-sdc-border-soft bg-sdc-gray-50/60 pl-6">
          {children}
        </div>
      )}
    </div>
  );
}

/**
 * The punch-line table inside an expanded group. A real <table> here, unlike the group
 * rows: these ARE a uniform matrix, and a table gives them a sticky header for free.
 */
export function DrillLines({
  head,
  foot,
  children,
}: {
  head: ReactNode;
  /**
   * A total row, for when this table IS the drill rather than one group inside it —
   * the ungrouped punch list. Grouped, the total belongs to DrillTable, which owns the
   * group template; ungrouped there is no group template, and a <tfoot> inside the one
   * table cannot fall out of alignment with the columns above it.
   */
  foot?: ReactNode;
  children: ReactNode;
}) {
  return (
    <table className="w-full border-collapse text-note">
      <thead className="sticky top-0 z-10 bg-sdc-gray-50">
        <tr className="[&>th]:whitespace-nowrap [&>th]:px-2 [&>th]:py-1 [&>th]:text-left [&>th]:text-label [&>th]:font-semibold [&>th]:uppercase [&>th]:tracking-[0.08em] [&>th]:text-sdc-muted">
          {head}
        </tr>
      </thead>
      <tbody className="[&>tr]:border-t [&>tr]:border-sdc-border-soft [&>tr:hover]:bg-white [&>tr>td]:px-2 [&>tr>td]:py-1">
        {children}
      </tbody>
      {/* Plain flow, not `sticky bottom-0` (§75 — see the matching note on DrillTable's
          total row): the ungrouped punch list is exactly the case a long list plus a
          sticky footer breaks — the footer would float over the last visible rows of a
          long unfiltered month for as long as there was more to scroll to. */}
      {foot && (
        <tfoot className="bg-sdc-gray-50 [&>tr>td]:border-t [&>tr>td]:border-sdc-border [&>tr>td]:px-2 [&>tr>td]:py-2">
          {foot}
        </tfoot>
      )}
    </table>
  );
}

/** The total label, so grouped and ungrouped word and weight it identically. */
export const DRILL_TOTAL_LABEL = "text-label font-semibold uppercase tracking-[0.08em] text-sdc-muted";

/** "No punches match these filters." — on the panel so every drill words it the same. */
export function DrillEmpty({ children }: { children: ReactNode }) {
  return <p className="px-4 py-6 text-note text-sdc-muted">{children}</p>;
}
