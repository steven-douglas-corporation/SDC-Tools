"use client";

import type { ColumnType, SortState } from "@/lib/table-sort";
import { defaultAlign } from "@/lib/table-sort";

// ── The one sortable header cell, for both drill-through tiers ─────────────
//
// Tier 1 (HoursDetailPanel, UndefinedHoursPanel, the two EtcMonthKpiCards drills) shares
// ui/Drill.tsx; Tier 2 (the Data Quality tables) predates it and stays independent by its
// own code comments (see drill-design.test.ts, which only requires the first two panels
// to route through Drill.tsx). Sorting is the one concern both tiers need equally, so it
// lives in its own tier-neutral file rather than being added to either side.
//
// Styled with `currentColor` and opacity only, never a hardcoded text/hover color: two
// of the nine tables this feeds (DataQualityPanel's non-job-hours table,
// DataQualityExplorer's punch table) still render the pre-redesign navy header band
// (white text on bg-sdc-navy), where a dark hover color would be invisible.
//
// One rotating chevron rather than swapping glyphs for ascending/descending — the app's
// own tested doctrine for the drill-group expand caret (drill-design.test.ts: "the caret
// rotates rather than swapping glyph"), and the same device /quoted's existing
// SortButton.tsx already uses for its own sort indicator.

type SortCellProps<K extends string> = {
  label: React.ReactNode;
  sortKey: K;
  type: ColumnType;
  sort: SortState<K> | null | undefined;
  /** Omit for a column that deliberately has no sort (e.g. a variable-length list cell
   *  with no single scalar to compare) — renders as plain, non-interactive text. */
  onSort?: (key: K) => void;
  /** Defaults from `type` (numeric types right-align) — override only to disagree with that. */
  align?: "left" | "right";
  /** Native hover tooltip on the header cell itself — same spot a plain `<th title=…>`
   *  would carry it, for a column whose label alone doesn't explain what it means. */
  title?: string;
};

function ariaSortValue<K extends string>(sort: SortState<K> | null | undefined, key: K): "ascending" | "descending" | "none" {
  if (!sort || sort.key !== key) return "none";
  return sort.direction === "desc" ? "descending" : "ascending";
}

function SortGlyph({ active, direction }: { active: boolean; direction?: "asc" | "desc" }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="9"
      height="9"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden
      className={`shrink-0 motion-interactive ${active ? "opacity-100" : "opacity-30"} ${direction === "desc" ? "rotate-180" : ""}`}
    >
      <path d="M4 9 L8 5 L12 9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SortControl<K extends string>({ label, sortKey, sort, onSort, align }: SortCellProps<K>) {
  const active = Boolean(sort && sort.key === sortKey);
  if (!onSort) return <>{label}</>;
  return (
    <button
      type="button"
      onClick={() => onSort(sortKey)}
      aria-label={
        typeof label === "string"
          ? `Sort by ${label}${active ? `, currently ${sort!.direction === "desc" ? "descending" : "ascending"}` : ""}`
          : undefined
      }
      className={`inline-flex w-full items-center gap-1 motion-interactive hover:opacity-70 ${align === "right" ? "justify-end" : ""}`}
    >
      <span>{label}</span>
      <SortGlyph active={active} direction={active ? sort!.direction : undefined} />
    </button>
  );
}

/** For a real `<table>`'s `<thead><tr>{head}</tr></thead>` — DrillLines' `head`, and every
 *  Tier-2 table's own hand-rolled `<thead>`. */
export function SortableTh<K extends string>({
  className,
  align: alignProp,
  title,
  ...props
}: SortCellProps<K> & { className?: string }) {
  const align = alignProp ?? defaultAlign(props.type);
  return (
    <th title={title} aria-sort={ariaSortValue(props.sort, props.sortKey)} className={`${align === "right" ? "text-right" : "text-left"} ${className ?? ""}`}>
      <SortControl {...props} align={align} />
    </th>
  );
}

/** For DrillTable's CSS-grid header row — a `role="columnheader"` span, not a `<th>`. */
export function SortableColumnHeader<K extends string>({
  className,
  align: alignProp,
  ...props
}: SortCellProps<K> & { className?: string }) {
  const align = alignProp ?? defaultAlign(props.type);
  return (
    <span role="columnheader" aria-sort={ariaSortValue(props.sort, props.sortKey)} className={`${align === "right" ? "text-right" : ""} ${className ?? ""}`}>
      <SortControl {...props} align={align} />
    </span>
  );
}
