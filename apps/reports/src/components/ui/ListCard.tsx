"use client";

import type { CSSProperties, ReactNode } from "react";

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
};

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
}: ListCardProps<T>) {
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
          {columns.map((c) => (
            <span key={c.id} title={c.headerTitle} className={c.align === "right" ? "text-right" : ""}>
              {c.header}
            </span>
          ))}
          {onRowClick && <span />}
        </div>
        {rows.length === 0 && emptyText != null && <p className="col-span-full px-3 py-3 text-center text-label text-sdc-gray-400">{emptyText}</p>}
        {rows.map((row) =>
          onRowClick ? (
            <button key={rowKey(row)} type="button" onClick={() => onRowClick(row)} title={rowTitle?.(row)} className={`${rowCls} hover:bg-sdc-blue-light/30`}>
              {cells(row)}
              <Chevron />
            </button>
          ) : (
            <div key={rowKey(row)} title={rowTitle?.(row)} className={rowCls}>
              {cells(row)}
            </div>
          ),
        )}
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
