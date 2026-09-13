import { PageTitle } from "@/components/ui/Typography";
import { PAGE_SHELL } from "@/components/ui/classnames";
import { requirePagePermission } from "@/lib/require-permission";
import { listDashboardJobs } from "@/lib/job-hours-dashboard";
import type { TmMetrics, TmPartsMetrics } from "@/lib/tm-report";
import { loadTmPartsLines, tmMetricsFrom, loadTmDateDefaults } from "@/lib/tm-parts-source";
import { getTmHoursTotals, resolveTmJobPks, type TmHoursTotals } from "@/lib/tm-hours";
import { resolveTmDateRange } from "@/lib/tm-drill-validate";
import { TmReportClient } from "@/components/TmReportClient";

// "T&M" — native recreation of the Power BI "Job Hours Report - Management
// Level" report's own "T&M" page, for its three dollar cards (see
// src/lib/tm-parts-source.ts). Both halves now read the company's own systems
// directly — parts from Total ETO, hours from the Paylocity ingest — with no
// Power BI left on this page (2026-09-02: the model was retired and had been
// stale since 2026-07-31).
export async function TmView({ params }: { params: { jobs?: string; start?: string; end?: string } }) {
  await requirePagePermission("tm:view");
  const { jobs: jobsParam, start, end } = params;

  const [jobs, dateDefaults] = await Promise.all([listDashboardJobs(), loadTmDateDefaults()]);
  const idByJobId = new Set(jobs.map((j) => j.jobId));

  const selectedJobIds = (jobsParam ?? "").split(",").map((s) => s.trim()).filter((s) => idByJobId.has(s));

  // ── ONE function resolves the job population (2026-09-01) ─────────────────
  //
  // This used to derive jobPks inline from the `jobs` list above, while the
  // DRILL-through resolved the same selection through resolveTmJobPks()
  // (tm-drill-actions.ts). Two code paths answering "which jobs is this
  // number about" is exactly how a KPI and its own detail drift apart, even
  // when — as here — the two happened to agree today (both land on
  // validJobTypeFilter, verified: 239 jobs either way).
  //
  // They agreed by coincidence, not by construction. Now the page calls the
  // same function the drill does, so an edit to the job universe cannot move
  // one without the other. Empty selection = All Jobs, the same convention
  // buildTmFilters() uses for the Power BI path.
  const jobPks = await resolveTmJobPks(selectedJobIds);

  // With nothing in the URL yet, the window matches the Power BI page's own
  // reporting window: [Estimated to Complete As Of Date] -> [Hours Refreshed
  // Thru]. (Described here as "a 90-day window" until 2026-08-24 — it never was;
  // it is whatever those two measures happen to be, currently a two-month span.)
  // That ETC-derived START is the only ETC thing about this filter: the range is
  // applied to transaction and work dates, never to ETC months — which is why the
  // input labels no longer say "ETC".
  const fallbackEnd = dateDefaults.hoursRefreshedThru ?? new Date().toISOString().slice(0, 10);
  const fallbackStart = dateDefaults.asOfDate ?? fallbackEnd;

  // Real calendar validation, one endpoint independent of the other, and an
  // inverted range read in the order that can match records — see
  // resolveTmDateRange's own header for the two bugs this replaced.
  const { startDate, endDate } = resolveTmDateRange(start, end, fallbackStart, fallbackEnd);

  // Two independent sources, two independent failure modes: a Total ETO outage
  // shouldn't blank out hours that a local database read already has, and vice
  // versa. Only an HOURS failure blocks the whole page — hours failing means
  // something's wrong with the app's own database, which is a lot more serious
  // than the upstream parts read having a bad moment.
  let hoursTotals: TmHoursTotals | null = null;
  let hoursError: string | null = null;
  try {
    hoursTotals = await getTmHoursTotals(jobPks, startDate, endDate);
  } catch (err) {
    hoursError = err instanceof Error ? err.message : "Could not read hours data.";
  }

  let partsMetrics: TmPartsMetrics | null = null;
  let partsError: string | null = null;
  try {
    const partsFilters = { jobIds: selectedJobIds, startDate, endDate };
    partsMetrics = tmMetricsFrom(await loadTmPartsLines(partsFilters), partsFilters);
  } catch (err) {
    partsError = err instanceof Error ? err.message : "Could not reach Power BI.";
  }

  const metrics: TmMetrics | null = hoursTotals
    ? {
        jobDisplay: partsMetrics?.jobDisplay ?? "",
        partInvoicedAmount: partsMetrics?.partInvoicedAmount ?? 0,
        sdcManufacturedPartsSalesPrice: partsMetrics?.sdcManufacturedPartsSalesPrice ?? 0,
        expenseReports: partsMetrics?.expenseReports ?? 0,
        ...hoursTotals,
      }
    : null;

  return (
    <div className={PAGE_SHELL}>
      <PageTitle className="mb-1">T&M</PageTitle>
      <p className="mb-6 max-w-2xl text-sm text-sdc-gray-600">
        Time &amp; materials summary for a job (or every job), over a date range. The five Hours figures come from the
        app&apos;s own Paylocity punch data — the same source Monthly ETC uses, never Power BI — and together they
        account for every hour punched in the range: Engineering and Shop by billing group, PM and Manufacturing carved
        out of them, and Other for anything else (Service, Spare Parts, or an unmapped code worth chasing). Part
        Invoiced Amount, SDC Manufactured Parts Sales Price and Expense Reports read live from the same Power BI
        measures as the &quot;T&amp;M&quot; page in Job Hours Report - Management Level, where the date range applies to
        each line&apos;s <span className="whitespace-nowrap">Invoiced Date</span>.
      </p>
      <TmReportClient
        jobs={jobs}
        selectedJobIds={selectedJobIds}
        startDate={startDate}
        endDate={endDate}
        metrics={metrics}
        hoursError={hoursError}
        partsError={partsError}
      />
    </div>
  );
}


// -- Route entry point --
//
// The page's body lives in `TmView` above so that BOTH this route and the split
// view can render it. Split view renders two views in ONE document (see
// lib/split-view.ts for why one document rather than two frames), which means a
// pane cannot be a route and therefore cannot read `searchParams` - there is only
// one URL, and two panes reading it would collide. So the body takes its context as
// a plain argument, and the two callers differ only in where they read that context
// from: this wrapper reads the URL, a pane reads its own `l.`/`r.` namespace.
//
// Nothing about this route's behaviour changes: same URL, same params, same server
// render. `searchParams` is still awaited HERE, which is what keeps this route
// dynamic exactly as before.
export default async function TmPage({ searchParams }: { searchParams: Promise<{ jobs?: string; start?: string; end?: string }> }) {
  return <TmView params={await searchParams} />;
}
