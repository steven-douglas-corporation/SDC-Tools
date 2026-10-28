import type { PartsCostLine } from "@/lib/sync-totaleto";
import { dayOf, isWithinAsOf, leftToInvoiceForLines, lineLeftToInvoice, rawLeftToInvoice, type LeftToInvoiceScope } from "@/lib/left-to-invoice";

// ── Left to Invoice, split by when the supplier is expected to bill it (2026-10-28) ──
//
// Asked: "is there any way to know WHEN the Left to Invoice amount is due — what month do we
// need to pay it?" Nothing in Total ETO dates it: an amount nobody has invoiced yet has no
// invoice due date (`APDocDueDate` only exists once an invoice does). The closest real date on
// the PO line is its required date — when the part is due to arrive — which is also the stand-in
// the Cash Flow forecast already uses for the same question (cash-flow-totaleto.ts). So this
// buckets the SAME per-line balances the headline sums by that date.
//
// It is a SPLIT of the headline, never a second formula: every line contributes exactly
// `lineLeftToInvoice(line, scope)` to exactly one bucket, so
//
//     overdue + Σ months + noDate + floorAdjustment  ===  leftToInvoiceForLines(lines, scope)
//
// to the cent, for any lines. `floorAdjustment` is the only term that is not a line: the
// headline floors a job's aggregate at 0, and when a job is over-posted that floor adds back
// what its negative lines took away.
//
// "Overdue" is a statement about the PART, not about money owed: its required date has passed
// and nobody has billed the balance. Either it has not been billed or the bill has not been
// entered — the two things worth chasing. It is NOT "late payment".

export const OVERDUE_BUCKET = "overdue" as const;
export const NO_DATE_BUCKET = "no-date" as const;

export type LeftToInvoiceBuckets = {
  /** Required date before `today`. */
  overdue: number;
  /** `YYYY-MM` → amount, for required dates from `today` onward. Ascending when read via `sortedMonths`. */
  months: Record<string, number>;
  /** Extra Costs and PO lines Total ETO has no required date for. */
  noDate: number;
  /** See header. Zero unless the job is over-posted. */
  floorAdjustment: number;
  /** === leftToInvoiceForLines(lines, scope). */
  total: number;
};

export function emptyBuckets(): LeftToInvoiceBuckets {
  return { overdue: 0, months: {}, noDate: 0, floorAdjustment: 0, total: 0 };
}

/** The bucket one line falls in. `today` is an inclusive `YYYY-MM-DD`; string compare, no Date. */
export function bucketOf(line: PartsCostLine, today: string): string {
  const due = dayOf(line.requiredDate);
  if (due === null) return NO_DATE_BUCKET;
  return due < today ? OVERDUE_BUCKET : due.slice(0, 7);
}

/** One job's lines, split. Pass the same `scope` the headline used so the totals are the headline. */
export function leftToInvoiceByMonth(lines: readonly PartsCostLine[], scope: LeftToInvoiceScope, today: string): LeftToInvoiceBuckets {
  const out = emptyBuckets();
  for (const line of lines) {
    if (!isWithinAsOf(line, scope.asOf)) continue;
    const v = lineLeftToInvoice(line, scope);
    if (v === 0) continue;
    const key = bucketOf(line, today);
    if (key === OVERDUE_BUCKET) out.overdue += v;
    else if (key === NO_DATE_BUCKET) out.noDate += v;
    else out.months[key] = (out.months[key] ?? 0) + v;
  }
  const raw = rawLeftToInvoice(lines, scope);
  out.total = leftToInvoiceForLines(lines, scope);
  out.floorAdjustment = out.total - raw;
  return out;
}

/** Add `b` into `a` (several jobs → one total). Mutates and returns `a`. */
export function addBuckets(a: LeftToInvoiceBuckets, b: LeftToInvoiceBuckets): LeftToInvoiceBuckets {
  a.overdue += b.overdue;
  a.noDate += b.noDate;
  a.floorAdjustment += b.floorAdjustment;
  a.total += b.total;
  for (const [m, v] of Object.entries(b.months)) a.months[m] = (a.months[m] ?? 0) + v;
  return a;
}

/** Months in ascending order, for display. */
export function sortedMonths(b: LeftToInvoiceBuckets): { month: string; amount: number }[] {
  return Object.entries(b.months)
    .sort(([x], [y]) => x.localeCompare(y))
    .map(([month, amount]) => ({ month, amount }));
}

/** Today as `YYYY-MM-DD` in local time, built from parts — never a Date round-trip through UTC. */
export function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * The split as one line for a tooltip: `Overdue $1,200 · Nov 2026 $300 · No date $40`.
 * Empty buckets are left out; an empty string when there is nothing to say.
 */
export function describeBuckets(b: LeftToInvoiceBuckets, fmt: (n: number) => string): string {
  const parts: string[] = [];
  if (Math.abs(b.overdue) >= 0.005) parts.push(`Overdue ${fmt(b.overdue)}`);
  for (const m of sortedMonths(b)) if (Math.abs(m.amount) >= 0.005) parts.push(`${monthName(m.month)} ${fmt(m.amount)}`);
  if (Math.abs(b.noDate) >= 0.005) parts.push(`No date ${fmt(b.noDate)}`);
  return parts.join(" · ");
}

/** `2026-11` → `Nov 2026`. Falls back to the input for anything that is not a `YYYY-MM`. */
export function monthName(month: string): string {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!m) return month;
  return new Date(Number(m[1]), Number(m[2]) - 1, 1).toLocaleString("en-US", { month: "short", year: "numeric" });
}

// ── All jobs together (2026-10-28) ───────────────────────────────────────────
//
// The Monthly ETC overview: one row per job, one column per expected billing month. Each job's
// buckets are the ones its own Left to Invoice cell already carries (parts-etc-breakout.ts), so
// every row sums to its cell and the Total row sums to the column of cells above it.

export type JobBuckets = { jobId: string; jobName: string; buckets: LeftToInvoiceBuckets };

export type LeftToInvoiceOverview = {
  /** Ascending `YYYY-MM`, every month any job has money in. */
  months: string[];
  /** Jobs with a non-zero balance, largest first. */
  rows: (JobBuckets & { sum: number })[];
  totals: { overdue: number; months: Record<string, number>; noDate: number; sum: number };
};

/** Overdue + months + no date. The per-job figure its grid cell shows (before any manual override). */
export function bucketSum(b: LeftToInvoiceBuckets): number {
  return b.overdue + b.noDate + Object.values(b.months).reduce((a, v) => a + v, 0);
}

export function buildOverview(jobs: readonly JobBuckets[]): LeftToInvoiceOverview {
  const rows = jobs
    .map((j) => ({ ...j, sum: bucketSum(j.buckets) }))
    .filter((r) => Math.abs(r.sum) >= 0.005 || Math.abs(r.buckets.overdue) >= 0.005 || Math.abs(r.buckets.noDate) >= 0.005)
    .sort((a, b) => b.sum - a.sum || a.jobId.localeCompare(b.jobId));
  const totals = { overdue: 0, months: {} as Record<string, number>, noDate: 0, sum: 0 };
  const months = new Set<string>();
  for (const r of rows) {
    totals.overdue += r.buckets.overdue;
    totals.noDate += r.buckets.noDate;
    totals.sum += r.sum;
    for (const [m, v] of Object.entries(r.buckets.months)) {
      months.add(m);
      totals.months[m] = (totals.months[m] ?? 0) + v;
    }
  }
  return { months: [...months].sort(), rows, totals };
}
