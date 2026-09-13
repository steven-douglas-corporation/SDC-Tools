import { PageTitle } from "@/components/ui/Typography";
import { PAGE_SHELL, card } from "@/components/ui/classnames";
import { JobHoursDashboard } from "@/components/JobHoursDashboard";
import { IndicatorCard } from "@/components/charts/IndicatorCard";
import { JobSelect } from "@/components/JobSelect";
import { listDashboardJobs, getJobHoursDashboard, defaultDashboardJobId } from "@/lib/job-hours-dashboard";
import { getPartsCostFinancials, type PartsCostFinancials } from "@/lib/parts-cost-financials";
import { SchedulerJobLink } from "@/components/SchedulerJobLink";
import { getSchedulerLinkContext } from "@/lib/scheduler-link";
import { getJobBom, type JobBom } from "@/lib/job-bom";
import { getJobHoursDetail, type JobHoursDetail } from "@/lib/job-hours-detail";
import { withTimeoutOrNull, UPSTREAM_BUDGET_MS } from "@/lib/with-timeout";
import { JobProcurement } from "@/components/JobProcurement";
import { EmptyState } from "@/components/ui/EmptyState";
import { ScrollIntoView } from "@/components/ScrollIntoView";
import { requirePagePermission } from "@/lib/require-permission";
import { restrictedSectionPermission, RESTRICTED_SECTION_CODES } from "@/lib/sections";
import { hasPermission } from "@/lib/permissions";
import { cookies } from "next/headers";
import { JOB_HOURS_SELECTION_COOKIE, parseSelectionCookie } from "@/lib/job-hours-selection";

// No-job-selected placeholder, so the dashboard's prop stays non-nullable and
// the panel has one shape to render.
const EMPTY_HOURS_DETAIL: JobHoursDetail = { rows: [], total: 0, sections: [], truncated: false };

// "Job Hour Details" — web recreation of the Power BI "Job Hours Report —
// Management Level" drillthrough. Supports one OR many jobs (aggregated), like
// the report's job slicer. Selected jobs travel in ?jobs=<jobId,jobId,…>.
export async function JobHoursView({ params }: { params: { jobs?: string; job?: string; section?: string } }) {
  const pageSession = await requirePagePermission("job-hour-details:view");
  const { jobs: jobsParam, job: legacyJobParam, section } = params;
  const jobs = await listDashboardJobs();
  const idByJobId = new Map(jobs.map((j) => [j.jobId, j.id]));

  // Selected Job Ids (e.g. "1135,1136"). Falls back to the legacy single ?job=
  // (internal id) param, then to the data-rich default.
  let selectedJobIds = (jobsParam ?? "").split(",").map((s) => s.trim()).filter((s) => idByJobId.has(s));
  if (selectedJobIds.length === 0 && legacyJobParam) {
    const j = jobs.find((x) => x.id === Number(legacyJobParam));
    if (j) selectedJobIds = [j.jobId];
  }
  // Present-but-empty `?jobs=` means the user cleared the picker deliberately.
  // Absent means they've simply arrived. Only the second gets a default job —
  // treating them alike is what made "remove the last job" impossible before,
  // since the server re-picked one the instant the param went away.
  const explicitlyEmpty = jobsParam !== undefined && jobsParam.trim() === "";

  // ── The remembered selection, resolved HERE rather than after hydration ────
  //
  // This is the fix for the wrong-job flash (2026-09-02). The last selection
  // used to live in localStorage, which only the browser can read, so a bare
  // /job-hours landing rendered the default job below — 1130, whichever job
  // happens to have the most hours this month — with its hours, charts, parts
  // and procurement, and JobSelect then replaced the URL after mount to swap in
  // the job the user actually wanted. Two server renders, two sets of live
  // Total ETO calls, and one visible frame of the WRONG JOB'S figures.
  //
  // As a cookie it arrives with the document request, so the first job-specific
  // frame this page ever renders is already the right job. Order matters and is
  // deliberate: an explicit ?jobs= / ?job= (a deep link from Projects, Job Cost
  // Explorer, the Scheduler, a bookmark) always beats the memory, and the memory
  // beats the default. See lib/job-hours-selection.ts.
  if (selectedJobIds.length === 0 && !explicitlyEmpty) {
    const remembered = parseSelectionCookie((await cookies()).get(JOB_HOURS_SELECTION_COOKIE)?.value).filter((id) =>
      idByJobId.has(id),
    );
    if (remembered.length > 0) selectedJobIds = remembered;
  }

  // Nothing asked for and nothing remembered — the landing a first-time visitor
  // gets. Still the data-richest job, so the page opens on something worth
  // reading rather than an empty shell.
  if (selectedJobIds.length === 0 && !explicitlyEmpty) {
    const def = await defaultDashboardJobId();
    const j = jobs.find((x) => x.id === def);
    if (j) selectedJobIds = [j.jobId];
  }
  const selectedInternalIds = selectedJobIds.map((s) => idByJobId.get(s)!).filter((n) => n != null);
  const data = selectedInternalIds.length ? await getJobHoursDashboard(selectedInternalIds) : null;

  // Punch-level hours for the drill-through panel. Straight from the app's own
  // MySQL (populated by the hours sync), so it costs one indexed query and can't
  // disagree with the section totals above it. Empty when nothing's ingested yet
  // — the panel says so rather than looking broken.
  const hoursDetail = data ? await getJobHoursDetail(data.jobRefs.map((r) => r.id)) : EMPTY_HOURS_DETAIL;

  // "Open in Scheduler" icon target + which jobs have a Scheduler project
  // (fail-soft empty set when its DB isn't configured).
  const { baseUrl: schedulerBaseUrl, jobNumbers: schedulerJobNumbers, ssoEmail: schedulerSsoEmail } = await getSchedulerLinkContext();

  // Parts lines — live from TotalETO — aggregated across every selected job.
  // Feeds the Parts Cost card, and (single job only) the Procurement Parts List.
  //
  // The Parts Cost MONEY totals aggregate correctly across jobs, so they follow
  // the selection. The Procurement drawer below does not — a BOM tree is per job
  // — and stays single-job.
  //
  // Two things this has to be careful about with many jobs selected:
  //  • It's one live TotalETO call PER JOB, so a large selection is a lot of
  //    upstream round trips. Capped, with the card saying so rather than
  //    quietly showing a partial figure.
  //  • A single job's call failing used to be swallowed, and its lines simply
  //    dropped out of the total — a $0 bar that looks like "nothing bought yet"
  //    but actually means "we couldn't ask". Failures are counted now and shown.
  const isMulti = selectedJobIds.length > 1;
  const singleJobId = selectedJobIds.length === 1 ? selectedJobIds[0] : null;
  // Was 12, which is what made a whole-Active-group selection show $0 across
  // every Parts Cost figure (reported 2026-08-24). The cap existed for a real
  // reason — one live Total ETO call per job, and an unbounded Promise.all
  // turning 59 jobs into 59 simultaneous upstream requests — so it is lifted
  // only now that getPartsCostFinancials bounds that fan-out to 6 at a time.
  //
  // 100 rather than removed outright: the whole Active group (59) has to work,
  // but a select-everything on a 300-job list is still 300 upstream calls and
  // deserves a backstop rather than a stampede.
  const PARTS_MAX_JOBS = 100;
  const partsCapped = !!data && data.jobRefs.length > PARTS_MAX_JOBS;

  // ── The two TotalETO reads are CONCURRENT and TIME-BOXED (§69) ─────────────
  //
  // They used to run one after the other — the whole parts block awaited, then the BOM
  // — with no budget on either. Measured 2026-08-06 while TotalETO was degraded:
  // getJobPartsCost 110.5s, getJobBom 101.7s, and this page returning 200 in
  // 2.0–3.9 MINUTES behind its loading skeleton while every app-database read on it
  // took ~30ms. Sequential was doubling a wait that should not have existed.
  //
  // Both fixes are needed and neither is sufficient alone: running them concurrently
  // halves a bad day, and the budget is what stops a bad day being unbounded. On a
  // healthy day (~1–3s each) nothing about this is observable.
  //
  // The fallbacks were already built — a null `parts` renders "Parts Cost is
  // unavailable", a null `bom` renders the procurement EmptyState — so timing out
  // lands in paths the page already had, rather than needing new UI. See
  // lib/with-timeout.ts for why the abandoned query is not (and cannot be) cancelled.
  // One centralized reconciliation (src/lib/parts-cost-financials.ts, audit
  // "Audit Parts Cost Projection Formula Across All Projects", 2026-08-15) —
  // this used to be an inline IIFE re-deriving the same Invoiced/Left-to-
  // invoice/ETC/Projection math this page's own copy could drift from every
  // other consumer's. `financials.lines` carries the same per-line rows
  // Procurement needs below, so this is still exactly one TotalETO fetch per
  // job, not two. Passing no `asOfDate` resolves to the same "latest EtcEntry
  // month for these jobs" query job-hours-dashboard.ts's own `latestEtcMonth`
  // already runs (identical where/orderBy/select), so this reproduces
  // `data.kpis.latestEtcMonth` exactly.
  const partsPromise: Promise<PartsCostFinancials> =
    data && !partsCapped
      ? getPartsCostFinancials(data.jobRefs.map((r) => r.id))
      : Promise.resolve({
          budget: null, invoiced: 0, leftToInvoice: 0, etc: null, totalSpent: 0,
          projection: 0, billedNotPosted: 0,
          // Nothing selected, so there is nothing to project. `etcUnknown: true`
          // rather than false: there is no prior ETC to report here, and claiming one
          // of 0 would be a forecast nobody made.
          purchased: 0, priorEtc: null, priorEtcSource: "none", partsSpentThisMonth: 0,
          adjustedEtcRaw: null, adjustedEtc: 0, openBalance: 0, externalOpen: 0,
          inHouseExcluded: 0, inHouseRows: 0, additionalExposure: 0, coverageLine: null,
          etcUnknown: true, etcMonth: null,
          variance: null, variancePct: null, failedJobs: 0, lineCount: 0, lines: [],
        });

  // Job Cost — the BOM cost hierarchy (formerly its own page) now lives below
  // Parts Cost here. It's a per-single-job view, so only load it when exactly
  // one job is selected. Best-effort: a TotalETO hiccup mustn't break the page.
  const bomPromise: Promise<JobBom | null> =
    data && singleJobId
      ? withTimeoutOrNull(`TotalETO BOM (job ${singleJobId})`, UPSTREAM_BUDGET_MS, () => getJobBom(singleJobId), (e) =>
          console.error(`getJobBom failed for job ${singleJobId}:`, e),
        )
      : Promise.resolve(null);

  const [financials, bom] = await Promise.all([partsPromise, bomPromise]);
  // Every job failed: show nothing rather than a confident set of $0 bars —
  // same rule the old inline computation used (`failedJobs === jobRefs.length`).
  const partsUnavailable = !!data && financials.failedJobs === data.jobRefs.length && data.jobRefs.length > 0;
  const parts = partsUnavailable ? null : financials;
  // Distinguishes "we asked and could not get it" from "there is nothing to ask for",
  // which is what decides between the warning EmptyState and the plain one below.
  const bomFailed = !!(data && singleJobId) && bom == null;

  // ── Which Standard Fees sections this role may see (2026-09-02) ───────────
  //
  // PM, Manufacturing and the two Warranty sections are permission-gated: the
  // Quoted page hides them from a role without the matching grant and shows them
  // to a role that has it (see restrictedSectionPermission / lib/permissions.ts).
  //
  // This chart used to hide all four from EVERYONE, unconditionally. That was not
  // a stricter reading of the rule — it was the rule applied without its
  // condition, and the cost was real hours nobody could see at any permission
  // level: 556h of Manufacturing on job 1131, 1,178h on 1104, 1,027h on 1118 —
  // present in the payload and drawn nowhere. A punch that exists in Paylocity
  // and in this app's own tables has to be visible to somebody.
  //
  // Resolved here, from the role requirePagePermission already looked up, and
  // passed to the client component — the same approach the Quoted page takes, so
  // there is no extra query and no second notion of who may see what.
  const role = pageSession.user.role;
  const allowedPoolCodes = [...RESTRICTED_SECTION_CODES].filter((code) => {
    const permission = restrictedSectionPermission(code);
    return permission === null || hasPermission(role, permission);
  });

  return (
    <div className={PAGE_SHELL}>
      <div className="mb-1 flex flex-wrap items-end justify-between gap-4">
        <PageTitle>Job Details</PageTitle>
        <div className="flex items-center gap-2">
          <span className="text-xs text-sdc-muted">Jobs</span>
          {/* Multi-job picker. Several jobs aggregate into one set of hours
              charts, the way the Power BI job slicer does. */}
          <JobSelect jobs={jobs} selected={selectedJobIds} />
        </div>
      </div>
      <p className="mb-5 text-sm text-sdc-gray-600">
        Quoted vs actual vs estimate-to-complete hours by section and billing group, per job.
      </p>

      {data ? (
        <>
          {/* Header row (§57): the project-title card and the two summary
              cards on ONE line, all the same height. The title card is wider
              (2fr vs 1fr each) because it holds the most text, but the row
              stays balanced. `items-stretch` (grid default) equalises heights;
              the title card centres its two lines vertically so it fills that
              height without the empty space the old p-4 block wasted. The
              "Eng Design-to-Debug Ratio" and "Active Jobs" cards were both
              removed here (the latter counted active jobs app-wide, not
              anything scoped to the selected job(s), so it never belonged on
              this card next to figures that ARE about the selection). On
              narrow screens the title spans the full width and the summary
              cards wrap beneath. Below `sm` everything stacks. */}
          <div className="mb-5 grid grid-cols-2 gap-4 lg:grid-cols-[2fr_1fr_1fr]">
            <div className={`${card("p-3.5")} col-span-2 flex flex-col justify-center lg:col-span-1`}>
              {selectedJobIds.length > 1 ? (
                // Aggregate mode: the charts/KPIs below sum every selected job,
                // so the header must say so rather than name a single job.
                <>
                  <p className="font-heading text-lg font-bold leading-tight tracking-tight text-sdc-navy">
                    {selectedJobIds.length} jobs (aggregated)
                  </p>
                  <p className="mt-0.5 truncate text-xs text-sdc-muted" title={selectedJobIds.join(", ")}>
                    {selectedJobIds.join(", ")}
                  </p>
                </>
              ) : (
                <>
                  <p className="flex items-center gap-2 font-heading text-lg font-bold leading-tight tracking-tight text-sdc-navy">
                    <span className="truncate">{data.job.jobId} — {data.job.jobName}</span>
                    <SchedulerJobLink
                      jobId={data.job.jobId}
                      jobName={data.job.jobName}
                      baseUrl={schedulerBaseUrl}
                      available={schedulerJobNumbers.has(data.job.jobId)}
                      ssoEmail={schedulerSsoEmail}
                      className="shrink-0 text-sdc-gray-400 hover:text-sdc-blue"
                    />
                  </p>
                  <p className="mt-0.5 truncate text-xs text-sdc-muted">
                    {data.job.customer ?? "—"} · {data.job.status}
                  </p>
                </>
              )}
            </div>
            <IndicatorCard label="Hours Refreshed Thru" value={data.kpis.hoursRefreshedThru ?? "—"} />
            <IndicatorCard label="Latest ETC Month" value={data.kpis.latestEtcMonth ?? "—"} />
          </div>
          {/* Parts Cost joins the two hours charts in one row (§52) — it follows
              the selection like they do: these dollars sum across jobs
              correctly, unlike the BOM below. Below the row, Procurement reads
              hours → parts $ → part-level detail. */}
          <JobHoursDashboard
            data={data}
            hoursDetail={hoursDetail}
            // The Standard Fees sections THIS role may see. Empty for a role with
            // none of the three grants, which is what every role got before — see
            // the note where this is computed.
            allowedPoolCodes={allowedPoolCodes}
            // `partsCapped` forces null rather than passing the all-zero stub
            // below. That stub used to reach the card, which then rendered
            // Invoiced $0 / Left to invoice $0 / Spent $0 with the explanation
            // relegated to a note underneath — indistinguishable from "this
            // selection genuinely bought nothing", and read (reasonably) as
            // broken aggregation. A number nobody computed must not be shown at
            // all.
            parts={parts && !partsCapped ? { financials: parts, jobCount: data.jobRefs.length } : null}
          />

          {partsCapped && (
            <p className="mt-6 rounded-lg border border-sdc-border bg-sdc-gray-50 px-4 py-3 text-sm text-sdc-gray-600">
              Parts Cost is hidden for selections above 100 jobs — the figures come from one live Total ETO call per job, and a
              selection this size would hammer it for a total nobody reads per job anyway. Narrow the selection to see parts dollars.
            </p>
          )}
          {!partsCapped && !parts && (
            <p className="mt-6 rounded-lg border border-sdc-yellow bg-sdc-yellow-bg px-4 py-3 text-sm text-sdc-yellow-text">
              Parts Cost is unavailable — Total ETO couldn&apos;t be reached for {data.jobRefs.length === 1 ? "this job" : "any of the selected jobs"}.
              This is usually a brief upstream hiccup; the hours above are unaffected.
            </p>
          )}

          {/* Procurement — the two-tab (Assemblies / Parts List) drawer ported
              from the Build Readiness app. It's a per-single-job view (BOM tree +
              live PO purchase lines), so it only renders for one selected job. */}
          {isMulti ? (
            // Hours only. One quiet line rather than a full Procurement heading
            // followed by an empty box — with several jobs selected, parts and
            // procurement aren't unavailable, they're not a sensible question,
            // and a big empty panel implies something failed to load.
            <p className="mt-8 rounded-lg border border-sdc-border bg-sdc-gray-50 px-4 py-3 text-sm text-sdc-gray-600">
              Hours and Parts Cost above are <strong>summed across all {selectedJobIds.length} selected jobs</strong>. Procurement is per-job —
              each job has its own BOM and buy-list — so select a single job to see assemblies and the parts list.
            </p>
          ) : (
          <div className="mt-8" id="procurement">
            {/* Deep-link landing (SDC_Scheduler's Procurement drawer launcher,
                `?section=procurement`) — the section already renders inline
                below regardless, this just brings it on screen instead of
                leaving the visitor to scroll down and find it themselves. */}
            {section === "procurement" && <ScrollIntoView id="procurement" />}
            <p className="mb-3 font-heading text-lg font-bold tracking-tight text-sdc-navy">Procurement</p>
            <p className="mb-4 text-sm text-sdc-gray-600">
              Assembly readiness and the full parts buy-list — assemblies, parts, PO status, suppliers and material cost, pulled live from Total ETO.
            </p>
            {!singleJobId ? (
              <EmptyState title="Select a single job" message="Procurement is per job — pick one job above to see its assemblies and parts list." />
            ) : bomFailed ? (
              <EmptyState
                tone="warning"
                title="Procurement is temporarily unavailable"
                message="The BOM couldn't be loaded from Total ETO / Power BI right now. This is usually a brief upstream hiccup — try again in a moment, or run Sync from the Dashboard."
              />
            ) : bom && bom.roots.length ? (
              <JobProcurement bom={bom} partsLines={parts?.lines ?? []} />
            ) : (
              <EmptyState title="No BOM found for this job" message="This job has no assembly/part records in Total ETO." />
            )}
          </div>
          )}
        </>
      ) : (
        <div className={card("p-8")}>
          {/* Cleared the picker, rather than "something went wrong" — the page
              can legitimately have nothing selected now. */}
          <EmptyState
            title="No jobs selected"
            message="Pick one or more jobs above. Several jobs aggregate into one set of hours charts; a single job also shows its parts cost and procurement."
          />
        </div>
      )}
    </div>
  );
}


// -- Route entry point --
//
// The page's body lives in `JobHoursView` above so that BOTH this route and the split
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
export default async function JobHoursPage({ searchParams }: { searchParams: Promise<{ jobs?: string; job?: string; section?: string }> }) {
  return <JobHoursView params={await searchParams} />;
}
