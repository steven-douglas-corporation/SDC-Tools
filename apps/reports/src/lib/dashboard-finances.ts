import "server-only";
import { prisma } from "@/lib/prisma";
import { getEtcMonthJobWhere } from "@/lib/etc-month-jobs";
import { getEtcMonthKpis } from "@/lib/etc-month-kpis";
import { PARTS_COST_SECTION } from "@/lib/sections";
import { monthBounds } from "@/lib/hours-etc-scope-rules";
import { loadTmPartsLines, tmMetricsFrom } from "@/lib/tm-parts-source";
import type { TmFilters } from "@/lib/tm-report";

// ── Readers for the Finances tab's cards (2026-10-20) ───────────────────────
//
// Nothing here defines a figure. Each reader calls the function the destination page
// calls, with the same scope, and returns what it returned — see lib/finance-cards.ts
// for the rule. A reader never throws: a card that cannot load says so and the rest of
// the tab renders, which is why every result has an "unavailable" state rather than a
// zero. A $0 on a card reads as "nothing was spent", and a failed read is not that.

export type PartsSpentResult =
  | { state: "ok"; spent: number; jobs: number }
  /** The month has no Parts Cost rows yet (ETC not started), so there is nothing to total. */
  | { state: "notStarted" }
  | { state: "unavailable" };

/**
 * The Monthly ETC page's "Parts spent" KPI for the month, over the same jobs.
 *
 * The job set is getEtcMonthJobWhere (the grid's, the Standard Sheet's) with the same
 * `etcEntries` include, and the figure is getEtcMonthKpis(...).parts.spent — the call
 * the page makes for its card. The page passes the rows after its Billable display
 * filter; this is the unfiltered month, which is what the page shows by default.
 */
export async function loadPartsSpent(month: string): Promise<PartsSpentResult> {
  try {
    const { where } = await getEtcMonthJobWhere(month);
    const jobs = await prisma.job.findMany({ where, include: { etcEntries: { where: { month } } } });
    const withParts = jobs.filter((j) => j.etcEntries.some((e) => e.section === PARTS_COST_SECTION)).length;
    if (withParts === 0) return { state: "notStarted" };
    const kpis = await getEtcMonthKpis(month, jobs);
    return { state: "ok", spent: kpis.parts.spent, jobs: withParts };
  } catch (e) {
    console.error("[dashboard-finances] parts spent failed:", e);
    return { state: "unavailable" };
  }
}

export type TmDollarsResult =
  | { state: "ok"; partInvoiced: number; sdcManufactured: number; expenseReports: number }
  | { state: "unavailable" };

/**
 * The T&M page's three dollar cards for every job over the month, as the page computes
 * them (loadTmPartsLines, then tmMetricsFrom).
 *
 * The page does not check `failedJobs`: when Total ETO cannot be reached
 * loadTmPartsLines returns no lines rather than throwing, and the page would show
 * $0.00 as if it were a result. The check is made here so this card never does.
 */
export async function loadTmDollars(month: string): Promise<TmDollarsResult> {
  const { from, to } = monthBounds(month);
  const filters: TmFilters = { jobIds: [], startDate: from, endDate: to };
  try {
    const source = await loadTmPartsLines(filters);
    if (source.failedJobs > 0) return { state: "unavailable" };
    const m = tmMetricsFrom(source, filters);
    return {
      state: "ok",
      partInvoiced: m.partInvoicedAmount,
      sdcManufactured: m.sdcManufacturedPartsSalesPrice,
      expenseReports: m.expenseReports,
    };
  } catch (e) {
    console.error("[dashboard-finances] T&M dollars failed:", e);
    return { state: "unavailable" };
  }
}
