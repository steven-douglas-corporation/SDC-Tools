import type { ReactNode } from "react";

// ── The Dashboard's layout vocabulary (2026-08-28) ──────────────────────────
//
// The page had five sections of identical visual weight stacked in one column
// with a uniform gap. Every heading was the same size, every card the same
// border, and nothing said which blocks belonged together — which is precisely
// why it read as a long report rather than a dashboard. Nothing was wrong with
// any individual section; the page had no hierarchy above them.
//
// These three pieces are that hierarchy, and they are shared so a sixth section
// inherits it instead of inventing a sixth heading style:
//
//   Band       a labelled group of related sections ("Active work", "Execution
//              & planning", …). An eyebrow label over a hairline rule — cheap,
//              quiet, and enough to break the stack into four readable groups.
//   Panel      the standard bordered container a section's content sits in.
//   PanelHead  the header row inside a Panel — title, optional note, optional
//              right-hand controls, on one baseline.
//
// Deliberately NOT a new card style: they compose the same rounded-xl /
// border-sdc-border / shadow-sm surface the rest of the app uses (classnames.ts
// `card`). The redesign is about arrangement and emphasis, not a new skin.

/**
 * A labelled group of sections.
 *
 * `tone="muted"` is for operational metadata (the refresh card) — same
 * structure, quieter label, so it is legible as "this is not a business metric"
 * without being hidden.
 */
export function Band({
  label,
  children,
  action,
  tone = "default",
}: {
  label: string;
  children: ReactNode;
  action?: ReactNode;
  tone?: "default" | "muted";
}) {
  const labelClass =
    tone === "muted"
      ? "text-sdc-gray-400"
      : "text-sdc-navy";
  return (
    <section className="min-w-0">
      <div className="mb-3 flex items-center gap-3">
        <h2 className={`shrink-0 text-label font-bold uppercase tracking-[0.12em] ${labelClass}`}>{label}</h2>
        <span className="h-px min-w-0 flex-1 bg-sdc-border" aria-hidden />
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {children}
    </section>
  );
}

/** The standard bordered surface. `flush` drops the padding for a panel whose child owns it (a table, a grid). */
export function Panel({
  children,
  className = "",
  flush = false,
}: {
  children: ReactNode;
  className?: string;
  flush?: boolean;
}) {
  return (
    <div
      className={`min-w-0 overflow-hidden rounded-xl border border-sdc-border bg-white shadow-sm ${flush ? "" : "p-4"} ${className}`}
    >
      {children}
    </div>
  );
}

/**
 * A panel's header row. One baseline for the title, its note and any controls,
 * so two panels side by side line their headers up instead of each choosing a
 * height from its own content.
 */
export function PanelHead({
  title,
  note,
  action,
  className = "",
}: {
  title: ReactNode;
  note?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex min-h-[2.25rem] flex-wrap items-center justify-between gap-x-4 gap-y-1 ${className}`}>
      <div className="min-w-0">
        <h3 className="truncate text-sm font-semibold tracking-[-0.01em] text-sdc-navy">{title}</h3>
        {note && <p className="mt-0.5 truncate text-label text-sdc-gray-400">{note}</p>}
      </div>
      {action && <div className="flex shrink-0 items-center gap-1.5">{action}</div>}
    </div>
  );
}

/**
 * The KPI strip.
 *
 * flex-wrap with `flex-1`, not a grid. A 5-column grid leaves a visible empty
 * cell whenever the count does not divide by the column count — at the md
 * breakpoint the five KPIs rendered 3 + 2 and the sixth slot was a white hole
 * the width of a card, which is the "giant empty area" the redesign is about.
 * Wrapped flex items grow to fill their row instead, so a short last row is
 * wider cards rather than a gap, at every width and for any number of KPIs.
 */
export function KpiStrip({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-wrap gap-px overflow-hidden rounded-xl border border-sdc-border bg-sdc-border-soft shadow-sm">
      {children}
    </div>
  );
}
