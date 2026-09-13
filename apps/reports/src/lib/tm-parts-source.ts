import "server-only";

import { prisma } from "@/lib/prisma";
import { resolveTmJobPks } from "@/lib/tm-hours";
import { getPartsCostForJobs, type PartsCostLine } from "@/lib/sync-totaleto";
import { withTimeoutOrNull } from "@/lib/with-timeout";
import type { TmFilters, TmPartsDrillKey, TmPartsMetrics, TmPartsDrillRow } from "@/lib/tm-report";

// T&M's three dollar cards, read from Total ETO (2026-09-02).
//
// ── Why this replaced the Power BI path ─────────────────────────────────────
//
// These cards were the last thing in the app still querying the "Job Hours Report -
// Management Level" semantic model. The company has moved off Power BI: that model
// stopped refreshing on 2026-07-31, and it is not coming back. Measured that day,
// with Total ETO carrying activity through 2026-09-04:
//
//   job    PBI rows   ETO rows   PBI Total    ETO Total     shortfall
//   1101      2,095      2,132    $786,387     $791,609       -$5,222
//   1131        557        645    $197,264     $213,881      -$16,617
//   1104      2,013      2,046    $812,496     $821,469       -$8,973
//
// Restricting Total ETO to the model's own horizon (Purchase Date <= 2026-07-31)
// closes almost all of it — job 1131 lands on 557 rows and $197,264, matching to the
// dollar — so the gap was staleness, not a different population. The T&M page was
// reporting a five-week-old world and saying nothing about it, and any range past
// July returned $0 rather than "no data yet".
//
// ── The second difference, which migrating also settles ─────────────────────
//
// Within that same horizon, Power BI's [Invoiced Amount] tracked Total ETO's BILLED
// figure, not the GL-posted one every other page in this app calls "Invoiced". On
// job 1104: PBI $805,995, ETO billed $809,135, ETO GL-posted $763,954 — a $45,181
// difference of definition, larger than the staleness gap. Two metrics wearing one
// word on two pages of the same app.
//
// This reads `actualAmount` — the GL-posted slice, the app's one definition of Parts
// Actual, the same field the Parts Cost card, the Parts List, Profitability and Cash
// Flow all reconcile against. So the Part Invoiced card will READ LOWER than it did,
// by whatever that job has on never-exported documents. That is the correction, not
// a regression.
//
// ── Same source as everything else, deliberately ────────────────────────────
//
// `getPartsCostForJobs` is the SAME SQL the per-job `getJobPartsCost` runs — one
// template parameterized by its WHERE clause, not a second query — so these cards
// read exactly what the Parts Cost card, the Parts List, Profitability and Cash Flow
// reconcile against, refund-sign rule and all.
//
// It is the multi-job form because T&M's default is ALL jobs. Fanning out per job
// took 5.8s over 239 jobs; one round trip does the same work in a fraction of it,
// and there is no per-job partial failure to account for — the query either returns
// or it does not.

/** One upstream call now, so it gets a window sized for the whole set rather than one job. */
const UPSTREAM_BUDGET_MS = 120_000;

/** A part line with the job it belongs to — `getJobPartsCost` returns lines alone. */
type TmLine = PartsCostLine & { jobId: string; jobName: string };

export type TmPartsSource = {
  lines: TmLine[];
  /** Jobs whose Total ETO read failed or timed out, so a caller can say so rather than under-report. */
  failedJobs: number;
};

/**
 * Every part line for the jobs this filter selects. Not date-filtered — each card
 * applies its OWN basis (see `inRange`), which is the whole reason the Power BI
 * version needed two different filter shapes.
 */
export async function loadTmPartsLines(filters: TmFilters): Promise<TmPartsSource> {
  // Same job universe the hours half resolves (resolveTmJobPks): an empty selection
  // means all jobs, and `validJobTypeFilter` is what "a job T&M is about" means.
  // Resolved here from the same table rather than passed in, so the dollar cards and
  // the hours cards cannot disagree about which jobs they cover.
  const jobPks = await resolveTmJobPks(filters.jobIds ?? []);
  const jobs = await prisma.job.findMany({ where: { id: { in: jobPks } }, select: { jobId: true, jobName: true } });

  const byJob = await withTimeoutOrNull(
    `TotalETO parts (T&M, ${jobs.length} jobs)`,
    UPSTREAM_BUDGET_MS,
    () => getPartsCostForJobs(jobs.map((j) => j.jobId)),
    (e: unknown) => console.error("loadTmPartsLines: getPartsCostForJobs failed:", e),
  );
  // One query means one failure mode: either every job's rows arrived or none did.
  // Reported as "all of them failed" rather than silently as an empty result, so the
  // page can say the figures are unavailable instead of showing a confident $0.
  if (!byJob) return { lines: [], failedJobs: jobs.length };

  const lines: TmLine[] = [];
  for (const j of jobs) {
    for (const l of byJob.get(j.jobId) ?? []) lines.push({ ...l, jobId: j.jobId, jobName: j.jobName ?? "" });
  }
  return { lines, failedJobs: 0 };
}

/**
 * Whether a line falls in the window, on the card's own date basis.
 *
 * A line with no date on that basis is OUT, not in: the Power BI relationship it
 * replaces could not match a blank date either, and defaulting it in would quietly
 * add rows to a windowed figure. On job 1101, 3,605 of 31,312 rows in the old model
 * had no Invoiced Date at all — that is not a rounding number.
 */
function inRange(line: PartsCostLine, basis: "invoicedDate" | "purchaseDate", start: string, end: string): boolean {
  const d = basis === "purchaseDate" ? line.purchaseDate : line.invoicedDate;
  if (!d) return false;
  const day = d.slice(0, 10);
  return day >= start && day <= end;
}

// ── The three cards, as predicates over Total ETO columns ───────────────────
//
// Each mirrors what its Power BI measure did, expressed against the fields
// PartsCostLine already carries. The text matches are case-insensitive for the same
// reason DAX's SEARCH was: these are AP vendor strings, typed by people.
const CARD_RULES: Record<
  TmPartsDrillKey,
  { amount: (l: PartsCostLine) => number; basis: "invoicedDate" | "purchaseDate"; where: (l: PartsCostLine) => boolean }
> = {
  // measure: SUM('Part Purchase'[Invoiced Amount]) — now the GL-posted slice, per
  // the header above. Invoiced money belongs to the period it was invoiced in, so
  // the Invoiced-Date basis is unchanged.
  partInvoicedAmount: {
    amount: (l) => l.actualAmount,
    basis: "invoicedDate",
    where: () => true,
  },

  // measure: Total Price where Manufacturer = "SDC" and Supplier = "Steven Douglas
  // Corp." — SDC's own manufactured parts. Kept on PURCHASE date: these are internal,
  // so SDC never invoices itself, and 1,026 of 2,257 such rows had no Invoiced Date
  // at all in the old model, which made the card structurally $0 for any recent
  // range. That divergence from Power BI's measure was already deliberate here; on
  // Total ETO it simply stops being a divergence, because there is no measure to
  // diverge from.
  sdcManufacturedPartsSalesPrice: {
    amount: (l) => l.totalPrice,
    basis: "purchaseDate",
    where: (l) =>
      (l.manufacturer ?? "").trim().toUpperCase() === "SDC" &&
      (l.supplier ?? "").trim().toUpperCase() === "STEVEN DOUGLAS CORP.",
  },

  // measure: Total Price where SEARCH("expense reports", [Supplier]) > 0 — despite
  // the name, a text-matched subset of purchase lines whose AP vendor contains
  // "expense reports", not the model's separate Travel Expenses table.
  expenseReports: {
    amount: (l) => l.totalPrice,
    basis: "invoicedDate",
    where: (l) => (l.supplier ?? "").toLowerCase().includes("expense reports"),
  },
};

/** The lines behind one card — the single definition both the KPI and its drill read. */
export function cardLines(lines: TmLine[], key: TmPartsDrillKey, filters: TmFilters): TmLine[] {
  const rule = CARD_RULES[key];
  return lines.filter((l) => rule.where(l) && inRange(l, rule.basis, filters.startDate, filters.endDate));
}

export function cardTotal(lines: TmLine[], key: TmPartsDrillKey, filters: TmFilters): number {
  const rule = CARD_RULES[key];
  return cardLines(lines, key, filters).reduce((sum, l) => sum + rule.amount(l), 0);
}

/** The three dollar cards, plus the job-context line the header shows. */
export function tmMetricsFrom(source: TmPartsSource, filters: TmFilters): TmPartsMetrics {
  const jobIds = filters.jobIds ?? [];
  const jobDisplay =
    jobIds.length === 0
      ? "All Jobs"
      : jobIds.length === 1
        ? (source.lines.find((l) => l.jobId === jobIds[0])?.jobName
            ? `${jobIds[0]} — ${source.lines.find((l) => l.jobId === jobIds[0])!.jobName}`
            : jobIds[0])
        : `${jobIds.length} jobs`;
  return {
    jobDisplay,
    partInvoicedAmount: cardTotal(source.lines, "partInvoicedAmount", filters),
    sdcManufacturedPartsSalesPrice: cardTotal(source.lines, "sdcManufacturedPartsSalesPrice", filters),
    expenseReports: cardTotal(source.lines, "expenseReports", filters),
  };
}

/**
 * One card's rows, in the drill's shape.
 *
 * `totalPrice` and `invoicedAmount` are carried per row so the drill's own
 * reconciliation (tm-drill-reconcile.ts) keeps working unchanged — it sums the
 * column the card is defined on, and that column is still here.
 */
export function tmDrillRowsFrom(source: TmPartsSource, key: TmPartsDrillKey, filters: TmFilters): TmPartsDrillRow[] {
  return cardLines(source.lines, key, filters).map((l) => ({
    jobId: l.jobId,
    jobName: l.jobName,
    partNumber: l.partNumber ?? "",
    description: l.description ?? "",
    supplier: l.supplier ?? "",
    poNumber: l.poNumber ?? "",
    purchaseDate: l.purchaseDate,
    invoicedDate: l.invoicedDate,
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    // The Part Invoiced card is defined on the GL-posted amount now, so the row's
    // "invoiced" must be that same figure or a reader adding the column up would
    // land somewhere the card never claims.
    totalPrice: l.totalPrice,
    invoicedAmount: key === "partInvoicedAmount" ? l.actualAmount : l.invoicedAmount,
  }));
}

// ── The date pickers' defaults, off Power BI too (2026-09-02) ───────────────
//
// These prefilled from [Estimated to Complete As Of Date] and [Hours Refreshed
// Thru] on the retired model, so the page opened on a window ending 2026-07-31 and
// presented that as a choice rather than as the edge of the data. With the cards on
// Total ETO there is no such edge, and the defaults should describe THIS app's own
// freshness instead.
//
// `hours_actual` is the app's own Paylocity ingest marker — the same row the Job
// Hour Details header reads for "Hours Refreshed Thru" — so the T&M window now ends
// where the app's hours actually end. The start falls back to the latest locked ETC
// month's end, which is what the old [As Of Date] measure meant.
export async function loadTmDateDefaults(): Promise<{ asOfDate: string | null; hoursRefreshedThru: string | null }> {
  const [freshness, latestEtc] = await Promise.all([
    prisma.powerBiFreshness
      .findUnique({ where: { source: "hours_actual" }, select: { refreshedThrough: true } })
      .catch(() => null),
    prisma.etcEntry
      .findFirst({ where: { needsReview: false }, orderBy: { month: "desc" }, select: { month: true } })
      .catch(() => null),
  ]);
  const refreshed = freshness?.refreshedThrough ? freshness.refreshedThrough.toISOString().slice(0, 10) : null;
  // "2026-07" -> the last day of that month, which is what an "as of" date is.
  const asOf = latestEtc?.month ? new Date(Date.UTC(Number(latestEtc.month.slice(0, 4)), Number(latestEtc.month.slice(5, 7)), 0)).toISOString().slice(0, 10) : null;
  return { asOfDate: asOf, hoursRefreshedThru: refreshed };
}
