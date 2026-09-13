// ── One sort mechanism for every drill-through table ────────────────────────
//
// No React, no I/O — same reason drill-filters.ts and undefined-hours-rules.ts stay
// pure: it makes this importable by every drill (both tiers — the ones that share
// ui/Drill.tsx and the ones that predate it) and by tests, without either needing a
// database or a DOM.
//
// Filtering and grouping already have their own independent concerns (drill-filters.ts,
// groupHoursRows) — this is a THIRD, equally independent one, applied last: sort never
// changes which rows are shown or how they're rolled up, only their order.

export type SortDirection = "asc" | "desc";

export type SortState<K extends string = string> = { key: K; direction: SortDirection } | null;

export type ColumnType = "text" | "status" | "id" | "date" | "number" | "currency" | "hours";

export function defaultAlign(type: ColumnType): "left" | "right" {
  return type === "number" || type === "currency" || type === "hours" ? "right" : "left";
}

/**
 * none -> ascending -> descending -> none. A different column always restarts at
 * ascending, whatever direction the previous column was on.
 *
 * The "none" state is not a compromise — every drill-through table already has a
 * deliberate default order before any of this exists (a grid-canonical rollup order, a
 * spent-descending drill, a `workDate desc` punch list), and a third click getting back
 * to that costs nothing to support: it is simply "call sortRows with `null`".
 */
export function cycleSortState<K extends string>(current: SortState<K>, key: K): SortState<K> {
  if (!current || current.key !== key) return { key, direction: "asc" };
  if (current.direction === "asc") return { key, direction: "desc" };
  return null;
}

// Job numbers, payroll ids and the like are strings that are almost always numeric, and
// a plain string sort puts "10000" before "979". Numeric when both sides parse; string
// fallback otherwise, so a non-numeric id (a part number, "ABC-123") still sorts
// sensibly rather than comparing as NaN. Same rule as compareJobIds in lib/job-filters.ts,
// applied generically rather than re-implemented per column.
function compareIds(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return a.localeCompare(b);
}

/**
 * The one comparator every sortable column goes through.
 *
 * Nulls (and undefined) always sort LAST, in both directions — the same convention
 * already established once in this codebase (JobCostExplorer.tsx's hand-rolled sort).
 * Consistent placement matters more than which end: a blank cell wandering to the top on
 * a descending click and the bottom on an ascending one would read as broken, not merely
 * unsorted.
 *
 * Dates are compared as strings deliberately, not parsed — every date this app hands to
 * a sortable column is already "YYYY-MM-DD" or "YYYY-MM", and lexicographic order on
 * that format IS chronological order. Parsing would be doing work to arrive at the
 * answer the string comparison already gives.
 */
export function compareByType(
  type: ColumnType,
  a: string | number | null | undefined,
  b: string | number | null | undefined,
  direction: SortDirection,
): number {
  const av = a ?? null;
  const bv = b ?? null;
  if (av == null && bv == null) return 0;
  if (av == null) return 1;
  if (bv == null) return -1;

  const dir = direction === "desc" ? -1 : 1;

  if (type === "number" || type === "currency" || type === "hours") {
    return (Number(av) - Number(bv)) * dir;
  }
  if (type === "id") {
    return compareIds(String(av), String(bv)) * dir;
  }
  return String(av).localeCompare(String(bv)) * dir;
}

export type SortAccessor<T> = (row: T) => string | number | null | undefined;

export type SortColumns<T, K extends string> = Record<K, { type: ColumnType; value: SortAccessor<T> }>;

/**
 * Sorts a row array by the current sort state and a column-key -> accessor/type map.
 *
 * Returns a NEW array (never mutates `rows`) — callers hold the input in a memo or a
 * prop they don't own. Returns `rows` itself, unchanged, when `sort` is null or names a
 * column that isn't in `columns` (a stale key surviving a grouping change, say) — a
 * defensive no-op rather than a thrown error over a rollup that just changed shape.
 */
export function sortRows<T, K extends string>(rows: T[], sort: SortState<K>, columns: SortColumns<T, K>): T[] {
  if (!sort) return rows;
  const col = columns[sort.key];
  if (!col) return rows;
  return [...rows].sort((a, b) => compareByType(col.type, col.value(a), col.value(b), sort.direction));
}
