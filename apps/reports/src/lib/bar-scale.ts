// ── Bar heights for the "Estimate to Complete vs Actual" chart ──────────────
//
// Extracted from JobHoursDashboard (2026-08-24) so the one property this chart
// must never lose can be tested rather than trusted. It HAS been lost once: a
// square-root curve was added to keep small sections readable against the Total
// rows, then reverted on 2026-08-20 because it made every pair of bars in the
// chart lie about its ratio. These tests exist so that cannot happen quietly.
//
// ── Two domains, and why that is not the same mistake ───────────────────────
//
// A "Total" row is the SUM of the sections beside it, so on one shared scale it
// is always the tallest bar by roughly an order of magnitude — measured on the
// live 59-job selection, the tallest section reached 29% of the plot area while
// the Total sat at 100%. Raising the pixel height cannot fix that (it was raised
// 300 -> 420 -> 546 twice by request): the tallest bar already resolves to
// exactly 100% with no headroom above it, so there is no whitespace to reclaim,
// and more pixels scales the gap up along with everything else.
//
// So sections are measured against the tallest SECTION and Totals against the
// tallest TOTAL. Proportionality is then exact everywhere it is meaningful to
// compare — within the sections, and within the Total band — and the only
// comparison lost by height is section-against-Total, which was never useful
// because one contains the other. The Total band is visually separate anyway
// (its own grey series, its own label, its own hide pill) and every bar carries
// its real value as a label.
//
// Dependency-free so `tsx --test` can load it directly.

export type BarDomains = {
  /** Tallest value among the non-Total rows. At least 1, so a domain is never 0. */
  detailMax: number;
  /** Tallest value among the Total rows. At least 1. */
  totalMax: number;
};

export type ScalableRow = { planned: number; actual: number; isTotal: boolean };

/**
 * The two independent domains for a set of rows.
 *
 * Floored at 1 rather than guarded at the call site: a domain of 0 would make
 * every height a division by zero, and a chart of all-zero rows should render
 * flat, not NaN.
 */
export function barDomains(rows: readonly ScalableRow[]): BarDomains {
  const detail: number[] = [];
  const totals: number[] = [];
  for (const r of rows) (r.isTotal ? totals : detail).push(r.planned, r.actual);
  return {
    detailMax: Math.max(1, ...detail),
    totalMax: Math.max(1, ...totals),
  };
}

/**
 * A bar's height as a percentage of the plot area, linear within its own domain.
 *
 * Zero maps to zero, and there is deliberately NO minimum-height floor: a
 * section with no hours should read as absent, not be nudged up to look
 * present. Negatives clamp to 0 — they should not occur, and a bar hanging below
 * the baseline would be worse than showing nothing.
 */
export function barHeightPct(value: number, isTotal: boolean, domains: BarDomains): number {
  const max = isTotal ? domains.totalMax : domains.detailMax;
  if (max <= 0) return 0;
  return (Math.max(0, value) / max) * 100;
}
