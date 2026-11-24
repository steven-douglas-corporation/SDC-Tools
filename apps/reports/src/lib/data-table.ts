// The sort / search / page / column-width logic behind components/ui/DataTable.tsx, kept pure so it is
// tested without a browser (tests/data-table.test.ts).

export type SortDir = "asc" | "desc";

export type TableColumnLogic<T> = {
  id: string;
  /** The cell's value: what it sorts by, what search matches, and the default text shown. */
  value: (row: T) => string | number | null | undefined;
  /** Default true. */
  sortable?: boolean;
  /** Default true. */
  searchable?: boolean;
};

/** Rows whose searchable columns contain every word of `query` (any column, any order, ignoring case). */
export function searchRows<T>(rows: readonly T[], columns: readonly TableColumnLogic<T>[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...rows];
  const cols = columns.filter((c) => c.searchable !== false);
  return rows.filter((row) => {
    const hay = cols.map((c) => String(c.value(row) ?? "")).join(" \u0000 ").toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

const blank = (v: unknown) => v == null || v === "" || v === "—";

/**
 * Stable sort by one column. Numbers compare as numbers, text naturally ("PO 9" before
 * "PO 10"). Empty values ("", null, "—") always go last, whichever way the sort runs, so
 * reversing a column never puts a page of blanks at the top.
 */
export function sortRows<T>(rows: readonly T[], columns: readonly TableColumnLogic<T>[], sort: { id: string; dir: SortDir } | null): T[] {
  const col = sort ? columns.find((c) => c.id === sort.id) : undefined;
  if (!sort || !col) return [...rows];
  const sign = sort.dir === "asc" ? 1 : -1;
  return rows
    .map((row, i) => ({ row, i, v: col.value(row) }))
    .sort((a, b) => {
      const ab = blank(a.v);
      const bb = blank(b.v);
      if (ab || bb) return ab === bb ? a.i - b.i : ab ? 1 : -1;
      const cmp =
        typeof a.v === "number" && typeof b.v === "number"
          ? a.v - b.v
          : String(a.v).localeCompare(String(b.v), undefined, { numeric: true, sensitivity: "base" });
      return cmp * sign || a.i - b.i;
    })
    .map((x) => x.row);
}

// ── Column widths ─────────────────────────────────────────────────────────────
//
// A column has a set width ("150px"), or none and shares what the others leave. The table
// is never laid out narrower than every column at its set width plus each sharing column
// at its minimum: below that the table scrolls sideways (its wrapper allows it) instead of
// crushing the sharing column to nothing (2026-11-17: Open POs' Supplier column was about
// 50px wide, its header spilling over the next). Dragging a header's edge sets a width
// that replaces the column's own until the page reloads.

/** Narrowest a column can be dragged to, in CSS px. */
export const MIN_COLUMN_PX = 48;
/** Narrowest a column with no set width is squeezed to before the table scrolls sideways, unless it says otherwise. */
export const SHARED_COLUMN_PX = 140;

export type TableColumnSize = { id: string; width?: string; minWidth?: number };

/** "150px" -> 150. Anything else ("20%", unset) -> null: the column shares what is left. */
export function pxWidth(width: string | undefined): number | null {
  const m = width?.trim().match(/^(\d+(?:\.\d+)?)px$/);
  return m ? Number(m[1]) : null;
}

/** The px width a column is drawn at: the dragged one, else its own; null when it shares what is left. */
export function columnPx(c: TableColumnSize, dragged: Readonly<Record<string, number>>): number | null {
  return dragged[c.id] ?? pxWidth(c.width);
}

/** A dragged width, rounded and kept at least MIN_COLUMN_PX. */
export function clampColumnPx(px: number): number {
  return Math.max(MIN_COLUMN_PX, Math.round(px));
}

/**
 * How the table is laid out. `min`: its narrowest width, in CSS px. `allFixed`: every column
 * has a px width (all dragged, say), so the table is exactly `min` wide; stretched to fill,
 * the extra would be shared out over every column and dragging one would move the others.
 */
export function tableWidth(columns: readonly TableColumnSize[], dragged: Readonly<Record<string, number>>): { min: number; allFixed: boolean } {
  let min = 0;
  let allFixed = true;
  for (const c of columns) {
    const px = columnPx(c, dragged);
    if (px == null) allFixed = false;
    min += px ?? c.minWidth ?? SHARED_COLUMN_PX;
  }
  return { min, allFixed };
}

/** One page of `rows`. `page` is clamped, so a page past the end (after a search) shows the last one. */
export function pageOf<T>(rows: readonly T[], page: number, size: number): { rows: T[]; page: number; pages: number; from: number; to: number } {
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const p = Math.min(Math.max(0, page), pages - 1);
  const start = p * size;
  const slice = rows.slice(start, start + size);
  return { rows: slice, page: p, pages, from: slice.length ? start + 1 : 0, to: start + slice.length };
}
