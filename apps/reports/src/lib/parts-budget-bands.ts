// ── Parts Cost: Projection vs Budget across every job (2026-10-22) ──────────────────────────────
//
// The Dashboard's Finances tab answers "which jobs are heading over their parts budget, and by how
// much" with ONE row per job. Every figure is the one the Job Details Parts Cost card shows for that job
// (lib/parts-cost-financials.ts assembles both), so a job reads the same here as it does there:
//
//   live job        Projected = Purchased to date + Still to purchase;  over/under = Projected − Budget
//   closed job      its final Parts Cost Actual from the Projects
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
  /** Purchased + still to purchase, or the final actual for a closed job. */
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

/**
 * A summary card the table can be opened from (2026-10-22). What each one opens:
 *   over      every over-budget job, largest overrun $ first — the jobs the "Total over budget" figure adds up
 *   excess    the jobs that bought beyond last month's Left to Purchase, largest excess first
 *   pct       the ONE job named on "Highest overrun %" — only that job, not the over-budget list
 *   dollars   the ONE job named on "Largest overrun $"
 * The two single-job cards are decided inside the status chip, exactly as the card's own figure is, so the
 * job opened is always the job the card names.
 */
export type Focus = "over" | "excess" | "pct" | "dollars";

export const FOCUS_LABEL: Record<Focus, string> = {
  over: "Over-budget jobs · largest overrun first",
  excess: "Excess bought this month",
  pct: "Highest overrun %",
  dollars: "Largest overrun $",
};

export const FOCUS_SORT: Record<Focus, SortState> = {
  over: { key: "delta", dir: "desc" },
  excess: { key: "excess", dir: "desc" },
  pct: { key: "pct", dir: "desc" },
  dollars: { key: "delta", dir: "desc" },
};

export type ViewFilter = {
  status: StatusFilter;
  /** A band, or null for every job. */
  band: BandKey | null;
  /** Free text over job id, name, customer and type. */
  q: string;
  /** A summary card's job list, or null/absent for none. Chosen instead of a band, never with one. */
  focus?: Focus | null;
  /** Customers to keep; empty or absent means every customer. A job with no customer is the "" value. */
  customers?: readonly string[];
  /** Job types to keep; empty or absent means every type. A job with no type is the "" value. */
  types?: readonly string[];
  /** One slice of a broken-out band (see breakout), or null/absent. Narrows the table like a band does. */
  segment?: Segment | null;
};

// ── Break out by (2026-10-23) ───────────────────────────────────────────────────────────────────
//
// Each band's bar can be split by Status, Type or Customer, so "who is behind this band" is visible without
// opening it. A slice is one group's jobs in one band; clicking it lists exactly those jobs.

export type BreakBy = "none" | "status" | "type" | "customer";

export const BREAK_LABEL: Record<Exclude<BreakBy, "none">, string> = {
  status: "Status",
  type: "Type",
  customer: "Customer",
};

/** A group of jobs: `values` are the raw field values it stands for (several for "Other"). */
export type Segment = { by: Exclude<BreakBy, "none">; values: readonly string[] };

export function groupValue(row: PartsBudgetRow, by: Exclude<BreakBy, "none">): string {
  if (by === "status") return row.status;
  return (by === "type" ? row.type : row.customer)?.trim() || NONE_VALUE;
}

/** Categorical colours for the groups. They deliberately avoid the green-to-red the bands use. */
export const GROUP_COLORS = ["#3B7DD8", "#E07A5F", "#3D9970", "#9B6BB5", "#C9A227", "#2A9DA5"] as const;
export const OTHER_COLOR = "#A9AFB9";
/** More groups than this are shown as the largest few plus "Other", so a bar never turns into confetti. */
export const MAX_GROUPS = GROUP_COLORS.length;

export type BreakoutGroup = { key: string; label: string; values: string[]; jobs: number; color: string };
export type BreakoutSlice = { group: BreakoutGroup; jobs: number; over: number; under: number };
export type Breakout = { by: Exclude<BreakBy, "none">; groups: BreakoutGroup[]; byBand: Record<BandKey, BreakoutSlice[]> };

/**
 * Splits each band's jobs by `by`. Only jobs that have a band (a budget) are counted, so the slices add up
 * to the band's own count. Groups are ordered largest first; past MAX_GROUPS the rest are one "Other" group
 * whose `values` list every field value it holds, so clicking it can still list exactly those jobs.
 */
export function breakout(rows: readonly PartsBudgetRow[], by: Exclude<BreakBy, "none">): Breakout {
  const banded = rows.filter((r) => r.pct != null && r.delta != null);
  const counts = new Map<string, number>();
  for (const r of banded) counts.set(groupValue(r, by), (counts.get(groupValue(r, by)) ?? 0) + 1);
  const label = (v: string) => (v === NONE_VALUE ? NONE_LABEL : v);
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || label(a[0]).localeCompare(label(b[0])));
  const keep = sorted.length > MAX_GROUPS ? sorted.slice(0, MAX_GROUPS - 1) : sorted;
  const rest = sorted.length > MAX_GROUPS ? sorted.slice(MAX_GROUPS - 1) : [];
  const groups: BreakoutGroup[] = keep.map(([v, n], i) => ({ key: v, label: label(v), values: [v], jobs: n, color: GROUP_COLORS[i] }));
  if (rest.length > 0) {
    groups.push({
      key: "__other__",
      label: `Other (${rest.length})`,
      values: rest.map(([v]) => v),
      jobs: rest.reduce((s, [, n]) => s + n, 0),
      color: OTHER_COLOR,
    });
  }
  const groupOf = new Map<string, BreakoutGroup>();
  for (const g of groups) for (const v of g.values) groupOf.set(v, g);
  const byBand = Object.fromEntries(BANDS.map((b) => [b.key, [] as BreakoutSlice[]])) as Record<BandKey, BreakoutSlice[]>;
  for (const r of banded) {
    const g = groupOf.get(groupValue(r, by))!;
    const slices = byBand[bandOf(r.pct as number)];
    let s = slices.find((x) => x.group === g);
    if (!s) {
      s = { group: g, jobs: 0, over: 0, under: 0 };
      slices.push(s);
    }
    s.jobs++;
    if ((r.delta as number) > 0) s.over += r.delta as number;
    else s.under += -(r.delta as number);
  }
  // Same order in every band, so a group sits in the same place along each bar.
  for (const k of Object.keys(byBand) as BandKey[]) byBand[k].sort((a, b) => groups.indexOf(a.group) - groups.indexOf(b.group));
  return { by, groups, byBand };
}

/** The value a job with no customer / no type is filtered under. */
export const NONE_VALUE = "";
export const NONE_LABEL = "(none)";

/**
 * Whether a row is among the jobs behind a card's figure. `scope` is the rows the card was computed from
 * (the status chip already applied), which is what decides the single job for "pct" and "dollars".
 */
export function focusMatches(row: PartsBudgetRow, focus: Focus, scope: readonly PartsBudgetRow[]): boolean {
  if (focus === "excess") return row.excess > 0.5;
  if (focus === "over") return row.pct != null && row.pct > 0 && row.delta != null && row.delta > 0;
  const s = summarize(scope);
  const target = focus === "pct" ? s.worstByPct : s.worstByDollars;
  return target != null && target.id === row.id;
}

export function statusMatches(status: RowStatus, filter: StatusFilter): boolean {
  if (filter === "both") return true;
  return filter === "active" ? status === "Active" : status === "Complete";
}

/** Customer and Type narrow like the status chip does: nothing chosen keeps every job. */
export function customerTypeMatches(row: PartsBudgetRow, f: { customers?: readonly string[]; types?: readonly string[] }): boolean {
  if (f.customers && f.customers.length > 0 && !f.customers.includes(row.customer ?? NONE_VALUE)) return false;
  if (f.types && f.types.length > 0 && !f.types.includes(row.type ?? NONE_VALUE)) return false;
  return true;
}

/**
 * The jobs every figure on the section is computed from: the status chip, Customer and Type. The summary,
 * the band chart, a card's job and the table all start here, so they cannot disagree about what is in scope.
 */
export function scopeRows(
  rows: readonly PartsBudgetRow[],
  f: { status: StatusFilter; customers?: readonly string[]; types?: readonly string[] },
): PartsBudgetRow[] {
  return rows.filter((r) => statusMatches(r.status, f.status) && customerTypeMatches(r, f));
}

export type ScopeOption = { value: string; label: string; count: number };

/** The choices for a Customer or Type menu, with how many jobs each holds in `rows`; most jobs first. */
export function scopeOptions(rows: readonly PartsBudgetRow[], field: "customer" | "type"): ScopeOption[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const v = (field === "customer" ? r.customer : r.type)?.trim() || NONE_VALUE;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, label: value === NONE_VALUE ? NONE_LABEL : value, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

export function searchMatches(row: PartsBudgetRow, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return [row.jobId, row.jobName, row.customer ?? "", row.type ?? ""].some((v) => v.toLowerCase().includes(needle));
}

/** The rows a view shows. A row with no budget has no band, so it only appears when no band is selected. */
export function filterRows(rows: readonly PartsBudgetRow[], f: ViewFilter): PartsBudgetRow[] {
  // The card's figures are computed inside the status chip, Customer and Type, so a card's job is decided
  // inside them too.
  const scope = f.focus ? scopeRows(rows, f) : [];
  return rows.filter(
    (r) =>
      statusMatches(r.status, f.status) &&
      customerTypeMatches(r, f) &&
      (f.segment == null || f.segment.values.includes(groupValue(r, f.segment.by))) &&
      searchMatches(r, f.q) &&
      (f.focus == null || focusMatches(r, f.focus, scope)) &&
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
