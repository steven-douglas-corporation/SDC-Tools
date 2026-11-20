import { PageTitle } from "@/components/ui/Typography";
import { SourceStaleBanner } from "@/components/SourceStaleBanner";
import { PAGE_SHELL } from "@/components/ui/classnames";
import { requireEltOnly } from "@/lib/cash-flow-access";
import { getProjectEstimates, getCashFlowLines, resolveAsOf, listSnapshots, getLatestSnapshotSummary } from "@/lib/cash-flow";
import { CashFlowClient } from "@/components/CashFlowClient";
import { CashFlowLeftToInvoiceSplit } from "@/components/CashFlowLeftToInvoiceSplit";
import { currentMonth, isValidMonth, round2 } from "@/lib/etc";
import { monthEndLabel, resolveLeftToInvoice } from "@/lib/left-to-invoice";
import { showsPartsBreakout } from "@/lib/parts-breakout-scope";
import { getEtcSplitJobs, resolveSplitMonth } from "@/lib/etc-split-jobs";
import { readPartsEtcBreakout } from "@/lib/parts-etc-breakout";
import { buildOverview, type JobBuckets } from "@/lib/left-to-invoice-by-month";

// Cash Flow Forecast — ELT-only (see cash-flow-access.ts's own header for
// why this is a hard role check, not a togglable Permission). "Current" is
// always live against Total ETO; any other `as`/`compare` param reads an
// immutable stored snapshot — see lib/cash-flow.ts.
export async function CashFlowView({ params }: { params: { as?: string; compare?: string; lti?: string } }) {
  await requireEltOnly();
  const { as, compare } = params;
  // Left to Invoice Split cutoff: a valid `YYYY-MM` = that month's last day, anything else = today.
  const ltiMonth = params.lti && isValidMonth(params.lti) ? params.lti : null;
  const liveChosen = params.lti === "today";

  // Started HERE, before the asOf/compareAsOf resolution below, because neither
  // of these depends on either of them — and both used to sit inside the
  // Promise.all at the bottom, which meant they could not begin until
  // resolveAsOf() and getLatestSnapshotSummary() had both finished in sequence.
  // That was two round-trips of dead time on a page measured at ~1.26s.
  // They are awaited in the same Promise.all as before, so a rejection still
  // surfaces there and still fails the render; the `.catch` is only to stop Node
  // reporting an unhandled rejection in the window before that await, if the
  // resolution below throws first.
  const estimatesPromise = getProjectEstimates();
  const snapshotsPromise = listSnapshots();
  // "Monthly ETC - Left to Invoice Split" (moved here from Monthly ETC). Never throws — a Total ETO
  // outage costs this table, not the forecast below it.
  //
  // The JOBS are the Monthly ETC grid's own (lib/etc-split-jobs.ts), in the grid's order, so this
  // table's Total ties to the Monthly ETC Parts Cost Left to Invoice column. They used to be every
  // project in Total ETO, which added jobs the grid does not list (60 vs 42 on 2026-11-20).
  //
  // THE DAY the figures are measured on follows Monthly ETC too: it counts a month as of that
  // month's last day. So the cutoff is the picked `lti` month, else — when the ETC month being shown
  // is already over — that month's end (December 3rd, before December's ETC exists, still reads
  // November as of November 30th, exactly like Monthly ETC). Only while the ETC month is the current
  // one is it "today (live)", which is the same figure for that month.
  const splitPromise = resolveSplitMonth(ltiMonth)
    .then(async (month) => {
      const etcJobs = await getEtcSplitJobs(month);
      // `lti=today` is the explicit "Today (live)" choice; without it an over ETC month defaults to its end.
      const cutoff = ltiMonth ?? (liveChosen ? null : month < currentMonth() ? month : null);
      const r = etcJobs.length > 0 ? await readPartsEtcBreakout(etcJobs.map((j) => ({ pk: j.pk, jobNumber: j.jobId })), cutoff) : null;
      // The totals tie only when measured the way Monthly ETC measures: that month's last day, or
      // live while the month is still the current one (same figure then).
      const ties = cutoff === month || (cutoff === null && month === currentMonth());
      const base = { month, cutoff, hasColumn: showsPartsBreakout(month), ties };
      // Nothing to split, said as such: no ETC jobs for the month (not started, or before ETC history),
      // or Total ETO could not be read. Neither may read as "Nothing left to invoice".
      if (r === null) return { ...base, status: "no-jobs" as const, payOverview: buildOverview([], "given"), overrides: 0 };
      if (r.linesFailed) return { ...base, status: "failed" as const, payOverview: buildOverview([], "given"), overrides: 0 };
      const jobs: JobBuckets[] = [];
      let overrides = 0;
      for (const j of etcJobs) {
        const b = r.byJobPk.get(j.pk);
        const buckets = b?.byPaymentMonth;
        if (!b || !buckets) continue;
        jobs.push({ jobId: j.jobId, jobName: j.jobName, buckets });
        // A manager-typed figure replaces Total ETO's on the Monthly ETC cell; it cannot be split by
        // date, so this table keeps Total ETO's and says how many rows differ. Judged by the same
        // rule the Monthly ETC cell uses (resolveLeftToInvoice), not a copy of it.
        const resolved = resolveLeftToInvoice({
          computed: b.rawLeftToInvoice == null ? null : round2(b.rawLeftToInvoice),
          stored: j.override,
        });
        if (resolved.overridden) overrides++;
      }
      return { ...base, status: "ok" as const, payOverview: buildOverview(jobs, "given"), overrides };
    })
    .catch((e) => {
      console.error("[cash-flow] left to invoice split failed:", e);
      return null;
    });
  estimatesPromise.catch(() => {});
  snapshotsPromise.catch(() => {});

  const asOf = await resolveAsOf(as);

  // `compare=none` is an explicit "don't compare"; leaving it off entirely
  // defaults to the most recent snapshot, so "Forecast Change vs Previous
  // Snapshot" (the task's own standing KPI) has a real answer on first load
  // rather than requiring the user to pick something before it means
  // anything.
  let compareAsOf = null as Awaited<ReturnType<typeof resolveAsOf>> | null;
  if (compare === "none") {
    compareAsOf = null;
  } else if (compare) {
    compareAsOf = await resolveAsOf(compare);
  } else if (asOf.kind === "current") {
    const latest = await getLatestSnapshotSummary();
    if (latest) compareAsOf = { kind: "snapshot", snapshot: latest };
  }

  const [estimates, lines, compareLines, snapshots, split] = await Promise.all([
    estimatesPromise,
    getCashFlowLines(asOf),
    compareAsOf ? getCashFlowLines(compareAsOf) : Promise.resolve(null),
    snapshotsPromise,
    splitPromise,
  ]);

  return (
    <div className={PAGE_SHELL}>
      {/* Every figure on this page comes from the Total ETO snapshot, so when that
          source fails to refresh the page still renders — correctly, from the last
          good snapshot — and until now said nothing about it. Silent when healthy. */}
      <SourceStaleBanner sources={["cash_flow_snapshot"]} what="This forecast" />
      {split && (
        <CashFlowLeftToInvoiceSplit
          payOverview={split.payOverview}
          status={split.status}
          month={split.month}
          hasColumn={split.hasColumn}
          ties={split.ties}
          asOfLabel={split.cutoff ? monthEndLabel(split.cutoff) : `today, ${new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}`}
          cutoffMonth={split.cutoff}
          overrides={split.overrides}
        />
      )}
      <div className="mb-1">
        <PageTitle className="mb-1">Cash Flow Forecast</PageTitle>
        <p className="max-w-3xl text-sm text-sdc-gray-600">
          Built from Total ETO&apos;s own AR sales terms, AP due dates, and open PO commitments — the same figures
          Total ETO&apos;s Project Cash Flow Forecast report is built from. Unlike that report, every refresh here
          preserves a timestamped, immutable version, so you can see what the forecast looked like at any past point
          in time. ELT only.
        </p>
      </div>

      <div className="mt-5">
        <CashFlowClient estimates={estimates} lines={lines} compareLines={compareLines} snapshots={snapshots} asOf={asOf} compareAsOf={compareAsOf} />
      </div>
    </div>
  );
}


// -- Route entry point --
//
// The page's body lives in `CashFlowView` above so that BOTH this route and the split
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
export default async function CashFlowPage({ searchParams }: { searchParams: Promise<{ as?: string; compare?: string; lti?: string }> }) {
  return <CashFlowView params={await searchParams} />;
}
