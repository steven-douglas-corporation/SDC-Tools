"use client";

import { Fragment, useState, type CSSProperties, type ReactNode } from "react";
import { sortRows, type SortDir } from "@/lib/data-table";

// A card that heads a short list: who it is, one status badge, one progress bar, then a
// scrollable mini-table of its items. First built for Job Details' Parts card view (one card
// per vendor, its POs underneath) and shared so other pages that group POs or parts get the
// same card instead of drawing their own.
//
// Deliberately small. The header holds a title, a subtitle, an optional avatar and badge; the
// body is one bar; the list takes columns like DataTable does. Anything more belongs on the
// page the card links to, not on the card.

export type ListCardColumn<T> = {
  id: string;
  header: ReactNode;
  /** Hover text for the column header. */
  headerTitle?: string;
  align?: "right";
  /** CSS grid track. Default: the first column takes the room ("1fr"), the rest fit ("auto"). */
  width?: string;
  render: (row: T) => ReactNode;
  /**
   * What the column sorts by. With it, and the card's `onSort`, the header becomes a sort
   * button. Same rules as DataTable (lib/data-table.ts sortRows): numbers as numbers, text
   * naturally, blanks last either way.
   */
  sortValue?: (row: T) => string | number | null | undefined;
};

export type ListCardSort = { id: string; dir: SortDir };

export type ListCardProps<T> = {
  title: ReactNode;
  /** Hover text for the title, usually the full name when it is cut off. */
  titleTip?: string;
  subtitle?: ReactNode;
  avatar?: ReactNode;
  badge?: { text: string; className: string; title?: string };
  /** One bar under the header. `pct` is clamped to 0–100 for drawing; `label` sits to its right. */
  progress?: { pct: number; barClassName: string; label: ReactNode; labelClassName?: string; title?: string };
  columns: ListCardColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  /** Makes each row a button. Rows then get a chevron, like a link to more detail. */
  onRowClick?: (row: T) => void;
  rowTitle?: (row: T) => string | undefined;
  emptyText?: ReactNode;
  footer?: ReactNode;
  /**
   * Sorting by a column header, controlled by the page so several cards can share one order.
   * `sort` null keeps `rows` in the order given.
   */
  sort?: ListCardSort | null;
  onSort?: (columnId: string) => void;
  /**
   * Splits the list under collapsible group headers (e.g. one per supplier). Groups appear in
   * the order their first row does, after sorting; every group starts open.
   */
  groupBy?: { key: (row: T) => string; label: (key: string, rows: T[]) => ReactNode; title?: (key: string, rows: T[]) => string };
};

const Chevron = () => (
  <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" className="text-sdc-gray-400" aria-hidden>
    <path d="M6 3.5 L10.5 8 L6 12.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export function ListCard<T>({
  title,
  titleTip,
  subtitle,
  avatar,
  badge,
  progress,
  columns,
  rows,
  rowKey,
  onRowClick,
  rowTitle,
  emptyText,
  footer,
  sort,
  onSort,
  groupBy,
}: ListCardProps<T>) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const tracks = [...columns.map((c, i) => c.width ?? (i === 0 ? "1fr" : "auto")), ...(onRowClick ? ["auto"] : [])].join(" ");
  // ONE grid for the header and every row (each a subgrid of it), so an "auto" column is
  // sized once, to its widest cell. Each row used to be its own grid, sizing its auto
  // columns to its own content: a date with ↻, a wider amount or the row-only chevron
  // moved that row's columns off the header's. The header sits inside the scroll box
  // (sticky) for the same reason: outside it, a scrollbar narrowed the rows but not it.
  const grid: CSSProperties = { gridTemplateColumns: tracks };
  const rowCls = "col-span-full grid grid-cols-subgrid items-center border-b border-sdc-border-soft/60 px-3 py-1.5 text-left last:border-b-0";
  const cells = (row: T) =>
    columns.map((c) => (
      <span key={c.id} className={`min-w-0 ${c.align === "right" ? "text-right" : ""}`}>
        {c.render(row)}
      </span>
    ));

  const sortable = columns.filter((c) => c.sortValue).map((c) => ({ id: c.id, value: c.sortValue! }));
  const ordered = sort ? sortRows(rows, sortable, sort) : rows;
  const groups: { key: string; rows: T[] }[] = [];
  if (groupBy) {
    const at = new Map<string, number>();
    for (const row of ordered) {
      const k = groupBy.key(row);
      if (!at.has(k)) at.set(k, groups.push({ key: k, rows: [] }) - 1);
      groups[at.get(k)!].rows.push(row);
    }
  }
  const toggle = (k: string) =>
    setCollapsed((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  const renderRow = (row: T) =>
    onRowClick ? (
      <button key={rowKey(row)} type="button" onClick={() => onRowClick(row)} title={rowTitle?.(row)} className={`${rowCls} hover:bg-sdc-blue-light/30`}>
        {cells(row)}
        <Chevron />
      </button>
    ) : (
      <div key={rowKey(row)} title={rowTitle?.(row)} className={rowCls}>
        {cells(row)}
      </div>
    );

  return (
    <article className="flex flex-col overflow-hidden rounded-lg border border-sdc-border bg-white shadow-sm">
      <div className="flex flex-col gap-2 border-b border-sdc-border-soft p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            {avatar}
            <div className="min-w-0">
              <div className="truncate text-sm font-bold text-sdc-navy" title={titleTip}>
                {title}
              </div>
              {subtitle != null && <div className="truncate text-label text-sdc-gray-400">{subtitle}</div>}
            </div>
          </div>
          {badge && (
            <span title={badge.title} className={`shrink-0 rounded px-1.5 py-0.5 text-micro font-bold tracking-wide ${badge.className}`}>
              {badge.text}
            </span>
          )}
        </div>
        {progress && (
          <div className="flex items-center gap-2" title={progress.title}>
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-sdc-gray-100">
              <div className={`h-full rounded-full ${progress.barClassName}`} style={{ width: `${Math.max(0, Math.min(100, progress.pct))}%` }} />
            </div>
            <span className={`shrink-0 text-right text-note font-semibold tabular-nums ${progress.labelClassName ?? ""}`}>{progress.label}</span>
          </div>
        )}
      </div>

      <div className="grid max-h-56 content-start gap-x-2 overflow-y-auto styled-scrollbar" style={grid}>
        <div className="sticky top-0 z-[1] col-span-full grid grid-cols-subgrid items-center bg-sdc-gray-100 px-3 py-1.5 text-micro font-bold uppercase tracking-wider text-sdc-gray-400">
          {columns.map((c) => {
            const right = c.align === "right";
            if (!onSort || !c.sortValue)
              return (
                <span key={c.id} title={c.headerTitle} className={right ? "text-right" : ""}>
                  {c.header}
                </span>
              );
            const active = sort?.id === c.id;
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => onSort(c.id)}
                title={`${c.headerTitle ? `${c.headerTitle}. ` : ""}Click to sort; click again to reverse`}
                aria-label={`Sort by ${typeof c.header === "string" ? c.header : c.id}${active ? `, now ${sort!.dir === "asc" ? "ascending" : "descending"}` : ""}`}
                className={`flex items-center gap-0.5 font-bold uppercase tracking-wider hover:text-sdc-navy ${right ? "justify-end" : ""} ${active ? "text-sdc-navy" : ""}`}
              >
                {c.header}
                {active && <span aria-hidden>{sort!.dir === "asc" ? "▲" : "▼"}</span>}
              </button>
            );
          })}
          {onRowClick && <span />}
        </div>
        {rows.length === 0 && emptyText != null && <p className="col-span-full px-3 py-3 text-center text-label text-sdc-gray-400">{emptyText}</p>}
        {groupBy
          ? groups.map((g) => {
              const open = !collapsed.has(g.key);
              return (
                <Fragment key={`group:${g.key}`}>
                  <button
                    type="button"
                    onClick={() => toggle(g.key)}
                    aria-expanded={open}
                    title={groupBy.title?.(g.key, g.rows) ?? `${open ? "Hide" : "Show"} these`}
                    className="col-span-full flex items-center gap-1.5 border-b border-sdc-border-soft/60 bg-slate-50 px-3 py-1 text-left text-label font-semibold text-sdc-gray-600 hover:bg-slate-100"
                  >
                    <span className="w-2.5 text-sdc-gray-400" aria-hidden>
                      {open ? "▾" : "▸"}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{groupBy.label(g.key, g.rows)}</span>
                  </button>
                  {open && g.rows.map(renderRow)}
                </Fragment>
              );
            })
          : ordered.map(renderRow)}
      </div>
      {footer && <div className="mt-auto flex flex-wrap gap-2 border-t border-sdc-border-soft p-2.5">{footer}</div>}
    </article>
  );
}

/** The grid ListCards sit in: as many columns as fit, each at least `min` wide. */
export function ListCardGrid({ children, min = 300, className = "" }: { children: ReactNode; min?: number; className?: string }) {
  return (
    <div className={`grid gap-3 ${className}`} style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${min}px, 1fr))` }}>
      {children}
    </div>
  );
}
