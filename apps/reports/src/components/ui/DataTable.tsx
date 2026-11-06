"use client";

import { useMemo, useState, type ReactNode } from "react";
import { TOOLBAR_BTN_COMPACT, TOOLBAR_BTN_NEUTRAL } from "@/components/ui/classnames";
import { pageOf, searchRows, sortRows, type SortDir, type TableColumnLogic } from "@/lib/data-table";

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
//   - optional row click (Feedback opens a record) and custom cells (badges, bars).
//
// Pure logic (sort, search, page) lives in `lib/data-table.ts` so it is tested without a DOM.

export type DataTableColumn<T> = TableColumnLogic<T> & {
  header: string;
  /** What the cell shows. Defaults to `value(row)` as text. */
  render?: (row: T) => ReactNode;
  align?: "left" | "right";
  /** CSS width for the column (e.g. "150px", "20%"). Unset columns share what is left. */
  width?: string;
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
              className="min-h-9 w-full max-w-sm rounded-lg border border-sdc-border bg-white px-3 py-1.5 text-sm text-sdc-navy placeholder:text-sdc-gray-400"
            />
          )}
          <span className="text-note text-sdc-gray-600" role="status">
            {query ? `${total.toLocaleString()} of ${rows.length.toLocaleString()} match` : `${rows.length.toLocaleString()} total`}
          </span>
          {toolbar && <div className="ml-auto flex flex-wrap items-center gap-2">{toolbar}</div>}
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-sdc-border bg-white">
        <table className="w-full table-fixed text-sm" aria-label={label}>
          <colgroup>
            {columns.map((c) => (
              <col key={c.id} style={c.width ? { width: c.width } : undefined} />
            ))}
          </colgroup>
          <thead className="bg-slate-100 text-left text-note text-sdc-gray-600">
            <tr>
              {columns.map((c) => {
                const sortable = c.sortable !== false;
                const active = sort?.id === c.id;
                const arrow = active ? (sort!.dir === "asc" ? "▲" : "▼") : "";
                return (
                  <th
                    key={c.id}
                    scope="col"
                    title={c.headerTitle}
                    aria-sort={active ? (sort!.dir === "asc" ? "ascending" : "descending") : undefined}
                    className={`px-3 py-2 font-semibold ${c.align === "right" ? "text-right" : ""}`}
                  >
                    {sortable ? (
                      <button
                        type="button"
                        onClick={() => toggleSort(c.id)}
                        className={`inline-flex items-center gap-1 font-semibold hover:text-sdc-navy ${active ? "text-sdc-navy" : ""} ${
                          c.align === "right" ? "flex-row-reverse" : ""
                        }`}
                      >
                        <span>{c.header}</span>
                        <span aria-hidden className="w-2.5 text-micro">
                          {arrow}
                        </span>
                      </button>
                    ) : (
                      c.header
                    )}
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
        <div className="flex flex-wrap items-center justify-end gap-3 text-note text-sdc-gray-600">
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
