// ── Parts Cost: Projection vs Budget across every job (2026-10-22) ──────────────────────────────
//
// The Dashboard's Finances tab answers "which jobs are heading over their parts budget, and by how
// much" with ONE row per job. Every figure is the one the Job Details Parts Cost card shows for that job
// (lib/parts-cost-financials.ts assembles both), so a job reads the same here as it does there:
//
//   live job        Projected = Purchased to date + Still to purchase;  over/under = Projected − Budget
//   completed job   with no live parts data in Total ETO: its final Parts Cost Actual from the Projects
//                   tab stands in for the projection (the card's "Actual Cost")
//
// This file is the pure half — bands, filters, sorting and the summary — so the chart, the table and the
// Excel export cannot disagree about what a band, a filter or a total is. No server imports.

export type BandKey = "under" | "b0_10" | "b10_25" | "b25_50" | "b50";

export type Band = { key: BandKey; label: string; short: string; color: string };

/** Least to most over. The colours step from green through yellow to a deep red. */
export const BANDS: readonly Band[] = [
  { key: "under", label: "Under budget", short: "Under", color: "#4F9D69" },
  { key: "b0_10", label: "0–10% over", short: "0–10%", color: "#E9C46A" },
  { key: "b10_25", label: "10–25% over", short: "10–25%", color: "#F4A261" },
  { key: "b25_50", label: "25–50% over", short: "25–50%", color: "#D9534F" },
  { key: "b50", label: "50%+ over", short: "50%+", color: "#8E1B1B" },
];

export type RowStatus = "Active" | "Complete" | string;

/** Where a row's projected figure comes from. */
export type Basis = "live" | "estimate" | "final";

export const BASIS_LABEL: Record<Basis, string> = {
  live: "Live",
  estimate: "Live · forecast estimate",
  final: "Final actual",
};

export type PartsBudgetRow = {
  /** Internal id. */
  id: number;
  jobId: string;
  jobName: string;
  customer: string | null;
  type: string | null;
  status: RowStatus;
  budget: number | null;
  /** Purchased + still to purchase, or the final actual for a completed job with no live data. */
  projected: number;
  /** projected − budget. Positive = over. Null without a budget. */
  delta: number | null;
  /** delta / budget, in percent, rounded to one decimal — the figure the table prints and the band uses. */
  pct: number | null;
  /** Null for a completed job shown at its final actual (there is no purchasing to report). */
  purchased: number | null;
  stillToPurchase: number;
  /** Bought this month beyond last month's Left to Purchase. Already inside `purchased`. */
  excess: number;
  basis: Basis;
};

/**
 * The band a rounded percentage falls in. Exactly on budget counts as under; the edges belong to the
 * higher band (10.0% is "10–25%"), and the figure used is the one-decimal value the table prints, so a
 * job never sits in a band its own percentage contradicts.
 */
export function bandOf(pct: number): BandKey {
  if (pct <= 0) return "under";
  if (pct < 10) return "b0_10";
  if (pct < 25) return "b10_25";
  if (pct < 50) return "b25_50";
  return "b50";
}

/** One-decimal percent, the same rounding for the band, the table and the export. */
export function roundPct(n: number): number {
  return Math.round(n * 10) / 10;
}

export type StatusFilter = "both" | "active" | "complete";

export type ViewFilter = {
  status: StatusFilter;
  /** A band, or null for every job. */
  band: BandKey | null;
  /** Free text over job id, name, customer and type. */
  q: string;
};

export function statusMatches(status: RowStatus, filter: StatusFilter): boolean {
  if (filter === "both") return true;
  return filter === "active" ? status === "Active" : status === "Complete";
}

export function searchMatches(row: PartsBudgetRow, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return [row.jobId, row.jobName, row.customer ?? "", row.type ?? ""].some((v) => v.toLowerCase().includes(needle));
}

/** The rows a view shows. A row with no budget has no band, so it only appears when no band is selected. */
export function filterRows(rows: readonly PartsBudgetRow[], f: ViewFilter): PartsBudgetRow[] {
  return rows.filter(
    (r) =>
      statusMatches(r.status, f.status) &&
      searchMatches(r, f.q) &&
      (f.band == null || (r.pct != null && bandOf(r.pct) === f.band)),
  );
}

export type BandTotals = { band: Band; jobs: number; over: number; under: number };

/** Count and dollars per band, over the rows passed (apply the status filter first, not the band). */
export function bandTotals(rows: readonly PartsBudgetRow[]): BandTotals[] {
  const out = BANDS.map((band) => ({ band, jobs: 0, over: 0, under: 0 }));
  for (const r of rows) {
    if (r.pct == null || r.delta == null) continue;
    const t = out.find((o) => o.band.key === bandOf(r.pct as number))!;
    t.jobs++;
    if (r.delta > 0) t.over += r.delta;
    else t.under += -r.delta;
  }
  return out;
}

export type Summary = {
  jobs: number;
  withBudget: number;
  noBudget: number;
  jobsOver: number;
  /** Sum of the over-budget jobs' overruns. */
  totalOver: number;
  worstByPct: PartsBudgetRow | null;
  worstByDollars: PartsBudgetRow | null;
  /** Jobs that bought more this month than last month's Left to Purchase allowed. */
  withExcess: number;
};

export function summarize(rows: readonly PartsBudgetRow[]): Summary {
  const budgeted = rows.filter((r) => r.pct != null && r.delta != null);
  const over = budgeted.filter((r) => (r.pct as number) > 0);
  const best = <T,>(list: T[], key: (t: T) => number): T | null =>
    list.reduce<T | null>((a, b) => (a == null || key(b) > key(a) ? b : a), null);
  return {
    jobs: rows.length,
    withBudget: budgeted.length,
    noBudget: rows.length - budgeted.length,
    jobsOver: over.length,
    totalOver: over.reduce((s, r) => s + (r.delta as number), 0),
    worstByPct: best(over, (r) => r.pct as number),
    worstByDollars: best(over, (r) => r.delta as number),
    withExcess: rows.filter((r) => r.excess > 0.5).length,
  };
}

export type SortKey =
  | "jobId" | "jobName" | "customer" | "type" | "status" | "budget" | "projected" | "delta" | "pct" | "stillToPurchase" | "excess";

export type SortState = { key: SortKey; dir: "asc" | "desc" };

/** Worst percentage first — what the table opens on. */
export const DEFAULT_SORT: SortState = { key: "pct", dir: "desc" };

const NUMERIC: ReadonlySet<SortKey> = new Set(["budget", "projected", "delta", "pct", "stillToPurchase", "excess"]);

/** Numeric job ids sort as numbers ("979" before "1101"); a blank always sorts last, in either direction. */
export function sortRows(rows: readonly PartsBudgetRow[], s: SortState): PartsBudgetRow[] {
  const sign = s.dir === "asc" ? 1 : -1;
  const get = (r: PartsBudgetRow): number | string | null => {
    const v = r[s.key];
    if (v == null) return null;
    if (s.key === "jobId") return Number.isFinite(Number(v)) ? Number(v) : String(v);
    return NUMERIC.has(s.key) ? (v as number) : String(v).toLowerCase();
  };
  return [...rows].sort((a, b) => {
    const x = get(a);
    const y = get(b);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    if (typeof x === "number" && typeof y === "number") return (x - y) * sign;
    if (typeof x === "number") return -1 * sign;
    if (typeof y === "number") return 1 * sign;
    return x.localeCompare(y) * sign;
  });
}

/** Signed dollars and percent for display: "+$12,761" / "−$3,100". */
export function signedUsd(n: number, usd: (n: number) => string): string {
  const r = Math.round(n);
  return `${r > 0 ? "+" : r < 0 ? "−" : ""}${usd(Math.abs(r))}`;
}

export function signedPct(p: number): string {
  return `${p > 0 ? "+" : p < 0 ? "−" : ""}${Math.abs(p).toFixed(1)}%`;
}
