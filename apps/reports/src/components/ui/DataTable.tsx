"use client";

import { useMemo, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from "react";
import { TOOLBAR_BTN_COMPACT, TOOLBAR_BTN_NEUTRAL } from "@/components/ui/classnames";
import { clampColumnPx, columnPx, pageOf, searchRows, sortRows, tableWidth, type SortDir, type TableColumnLogic } from "@/lib/data-table";

// ── DataTable: the app's one list-of-records table ──────────────────────────
//
// Replaced AG Grid on the Audit Log and Feedback (2026-11-06). The grid was hard to use
// for what those pages are: its text rendered at about half the size of every other
// table (the shared theme said 8px, and the app's 80% zoom applies to it like to
// everything else), and every column carried a filter box under its header.
//
// What this gives instead, and nothing more:
//   - the app's own table type and colours, so a list looks like the tables around it;
//   - click a header to sort (again to reverse), with the direction shown;
//   - ONE search box over the columns a page marks searchable;
//   - paging chosen per page: "pages" (Previous / Next), "more" (Show more), or "none";
//   - optional row click (Feedback opens a record) and custom cells (badges, bars);
//   - drag a header's right edge to resize its column (double-click the edge to undo);
//     widths last until the page reloads;
//   - never narrower than its columns need: a narrow window scrolls it sideways.
//
// Pure logic (sort, search, page, widths) lives in `lib/data-table.ts` so it is tested without a DOM.

export type DataTableColumn<T> = TableColumnLogic<T> & {
  header: string;
  /** What the cell shows. Defaults to `value(row)` as text. */
  render?: (row: T) => ReactNode;
  align?: "left" | "right";
  /** CSS width for the column (e.g. "150px", "20%"). Unset columns share what is left. */
  width?: string;
  /** For a column with no px `width`: the narrowest (CSS px) it is squeezed to before the table scrolls sideways. Default 140. */
  minWidth?: number;
  /** Let long text wrap onto more lines. Off: one line, cut off with "…", full text on hover. */
  wrap?: boolean;
  /** Hover text for a cell. */
  title?: (row: T) => string | undefined;
  /** Header hover text. */
  headerTitle?: string;
  className?: string;
};

export type DataTablePaging = "pages" | "more" | "none";

export function DataTable<T>({
  rows,
  columns,
  rowKey,
  label,
  defaultSort,
  paging = "pages",
  pageSize = 50,
  search = true,
  searchPlaceholder = "Search…",
  onRowClick,
  emptyText = "Nothing to show.",
  toolbar,
}: {
  rows: readonly T[];
  columns: DataTableColumn<T>[];
  /** A stable id per row. Omit for read-only lists with no id; rows are then keyed by position. */
  rowKey?: (row: T) => string | number;
  /** Accessible name for the table. */
  label: string;
  defaultSort?: { id: string; dir: SortDir };
  /** How to split long lists: Previous / Next pages, a "Show more" button, or every row at once. */
  paging?: DataTablePaging;
  pageSize?: number;
  /** Show the search box (it searches the columns not marked `searchable: false`). */
  search?: boolean;
  searchPlaceholder?: string;
  onRowClick?: (row: T) => void;
  emptyText?: string;
  /** Extra controls on the search row, right-aligned. */
  toolbar?: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ id: string; dir: SortDir } | null>(defaultSort ?? null);
  const [page, setPage] = useState(0);
  const [shownCount, setShownCount] = useState(pageSize);

  const matched = useMemo(() => searchRows(rows, columns, query), [rows, columns, query]);
  const sorted = useMemo(() => sortRows(matched, columns, sort), [matched, columns, sort]);

  const total = sorted.length;
  const view =
    paging === "pages"
      ? pageOf(sorted, page, pageSize)
      : paging === "more"
        ? { rows: sorted.slice(0, shownCount), page: 0, pages: 1, from: total ? 1 : 0, to: Math.min(shownCount, total) }
        : { rows: sorted, page: 0, pages: 1, from: total ? 1 : 0, to: total };

  // Any change to what matches or its order starts again from the top.
  const resetPosition = () => {
    setPage(0);
    setShownCount(pageSize);
  };

  const toggleSort = (id: string) => {
    setSort((s) => (s?.id === id ? { id, dir: s.dir === "asc" ? "desc" : "asc" } : { id, dir: "asc" }));
    resetPosition();
  };

  // Widths set by dragging a header's edge (CSS px, by column id), until the page reloads.
  const [dragged, setDragged] = useState<Record<string, number>>({});
  const drag = useRef<{ id: string; x: number; px: number; scale: number } | null>(null);
  const layout = tableWidth(columns, dragged);

  const startResize = (id: string, e: PointerEvent<HTMLElement>) => {
    const th = e.currentTarget.parentElement;
    if (!th) return;
    e.preventDefault(); // no text selected while dragging
    e.currentTarget.setPointerCapture(e.pointerId);
    // The pointer moves in screen px; the column is sized in its own CSS px, which the app's
    // zoom makes smaller. Measured at the start, as useFillHeight does.
    const scale = th.offsetWidth ? th.getBoundingClientRect().width / th.offsetWidth : 1;
    drag.current = { id, x: e.clientX, px: th.offsetWidth, scale };
  };
  const moveResize = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (d) setDragged((w) => ({ ...w, [d.id]: clampColumnPx(d.px + (e.clientX - d.x) / d.scale) }));
  };
  const endResize = () => {
    drag.current = null;
  };
  const resetWidth = (id: string) => setDragged(({ [id]: _dropped, ...rest }) => rest);

  return (
    <div className="flex flex-col gap-3">
      {(search || toolbar) && (
        <div className="flex flex-wrap items-center gap-3">
          {search && (
            <input
              type="search"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                resetPosition();
              }}
              placeholder={searchPlaceholder}
              aria-label={`Search ${label}`}
              title="Type one or more words; a row shows when it contains every word"
              className="min-h-10 w-full max-w-sm rounded-lg border border-sdc-border bg-white px-3 py-1.5 text-base text-sdc-navy placeholder:text-sdc-gray-400"
            />
          )}
          <span className="text-sm text-sdc-gray-600" role="status">
            {query ? `${total.toLocaleString()} of ${rows.length.toLocaleString()} match` : `${rows.length.toLocaleString()} total`}
          </span>
          {toolbar && <div className="ml-auto flex flex-wrap items-center gap-2">{toolbar}</div>}
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-sdc-border bg-white">
        {/* globals.css sizes every <table> from --table-font-size (about 10px, !important),
            so a size class here would do nothing. A record list is read row by row rather
            than scanned as a dense grid, so it asks for 13px through that variable. */}
        {/* Never narrower than its columns need (tableWidth): below that the wrapper scrolls
            sideways. Once every column has a px width it is exactly that wide, so dragging one
            column does not stretch the others. */}
        <table
          className="w-full table-fixed"
          aria-label={label}
          style={{ "--table-font-size": "0.8667rem", minWidth: `${layout.min}px`, width: layout.allFixed ? `${layout.min}px` : undefined } as CSSProperties}
        >
          <colgroup>
            {columns.map((c) => {
              const px = columnPx(c, dragged);
              const width = px != null ? `${px}px` : c.width;
              return <col key={c.id} style={width ? { width } : undefined} />;
            })}
          </colgroup>
          <thead className="bg-slate-100 text-left text-sdc-gray-600">
            <tr>
              {columns.map((c, ci) => {
                const sortable = c.sortable !== false;
                const active = sort?.id === c.id;
                // Every sortable header shows a faint ↕ so it reads as clickable before any hover;
                // the sorted one shows its direction (2026-11-16, the same as ListCard's headers).
                // The arrow always follows the label. Right-aligned headers used to put it first,
                // and a label wrapped onto two lines then sat at the far right with the arrow
                // stranded at the far left, reading as a column of its own (2026-11-17).
                const arrow = active ? (sort!.dir === "asc" ? "▲" : "▼") : "↕";
                // A label wraps at its spaces; a word that still does not fit ends in "…" rather
                // than running over the next header.
                const labelCls = "min-w-0 overflow-hidden text-ellipsis";
                return (
                  <th
                    key={c.id}
                    scope="col"
                    title={sortable ? `${c.headerTitle ? `${c.headerTitle}. ` : ""}Click to sort; click again to reverse` : c.headerTitle}
                    aria-sort={active ? (sort!.dir === "asc" ? "ascending" : "descending") : undefined}
                    className={`relative overflow-hidden px-3 py-2 font-semibold ${c.align === "right" ? "text-right" : ""}`}
                  >
                    {sortable ? (
                      <button
                        type="button"
                        onClick={() => toggleSort(c.id)}
                        className={`group -mx-1 inline-flex max-w-full cursor-pointer items-center gap-1 rounded px-1 font-semibold hover:bg-white hover:text-sdc-navy ${active ? "text-sdc-navy" : ""}`}
                      >
                        <span className={labelCls}>{c.header}</span>
                        <span aria-hidden className={`w-3 shrink-0 text-center ${active ? "" : "opacity-40 group-hover:opacity-100"}`}>
                          {arrow}
                        </span>
                      </button>
                    ) : (
                      <span className={`block ${labelCls}`}>{c.header}</span>
                    )}
                    {/* The resize grip: the header's right edge, marked by a short grey line that
                        turns blue on hover (none on the last column, against the table's border).
                        The grab area is wider than the line. Pointer only. */}
                    <span
                      aria-hidden
                      title="Drag to resize this column; double-click to undo"
                      onPointerDown={(e) => startResize(c.id, e)}
                      onPointerMove={moveResize}
                      onPointerUp={endResize}
                      onPointerCancel={endResize}
                      onDoubleClick={() => resetWidth(c.id)}
                      className={`absolute inset-y-0 right-0 w-2 cursor-col-resize touch-none after:absolute after:inset-y-2 after:right-0 after:w-px hover:after:w-0.5 hover:after:bg-sdc-blue ${
                        ci < columns.length - 1 ? "after:bg-slate-300" : ""
                      }`}
                    />
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {view.rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-3 py-8 text-center text-sdc-gray-400">
                  {query ? "Nothing matches that search." : emptyText}
                </td>
              </tr>
            ) : (
              view.rows.map((row, i) => (
                <tr
                  key={rowKey ? rowKey(row) : `${view.from}-${i}`}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  onKeyDown={
                    onRowClick
                      ? (e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            onRowClick(row);
                          }
                        }
                      : undefined
                  }
                  tabIndex={onRowClick ? 0 : undefined}
                  className={`border-t border-sdc-border align-top ${onRowClick ? "cursor-pointer hover:bg-sdc-blue-light/40 focus-visible:bg-sdc-blue-light/40" : "hover:bg-slate-50"}`}
                >
                  {columns.map((c) => {
                    const v = c.value(row);
                    const text = v == null ? "" : String(v);
                    return (
                      <td
                        key={c.id}
                        title={c.title ? c.title(row) : c.wrap ? undefined : text}
                        className={`px-3 py-2 text-sdc-navy ${c.align === "right" ? "text-right tabular-nums" : ""} ${
                          c.wrap ? "whitespace-pre-line break-words" : "truncate"
                        } ${c.className ?? ""}`}
                      >
                        {c.render ? c.render(row) : text}
                      </td>
                    );
                  })}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {paging !== "none" && total > 0 && (
        <div className="flex flex-wrap items-center justify-end gap-3 text-sm text-sdc-gray-600">
          <span>
            Showing {view.from.toLocaleString()}–{view.to.toLocaleString()} of {total.toLocaleString()}
          </span>
          {paging === "pages" && view.pages > 1 && (
            <>
              <button type="button" disabled={view.page === 0} onClick={() => setPage(view.page - 1)} className={`${TOOLBAR_BTN_COMPACT} ${TOOLBAR_BTN_NEUTRAL} disabled:opacity-40`}>
                ‹ Previous
              </button>
              <span>
                Page {view.page + 1} of {view.pages}
              </span>
              <button
                type="button"
                disabled={view.page >= view.pages - 1}
                onClick={() => setPage(view.page + 1)}
                className={`${TOOLBAR_BTN_COMPACT} ${TOOLBAR_BTN_NEUTRAL} disabled:opacity-40`}
              >
                Next ›
              </button>
            </>
          )}
          {paging === "more" && view.to < total && (
            <button type="button" onClick={() => setShownCount((n) => n + pageSize)} className={`${TOOLBAR_BTN_COMPACT} ${TOOLBAR_BTN_NEUTRAL}`}>
              Show {Math.min(pageSize, total - view.to)} more
            </button>
          )}
        </div>
      )}
    </div>
  );
}
