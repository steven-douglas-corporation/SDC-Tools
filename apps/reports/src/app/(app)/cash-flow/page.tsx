import { PageTitle } from "@/components/ui/Typography";
import { SourceStaleBanner } from "@/components/SourceStaleBanner";
import { PAGE_SHELL } from "@/components/ui/classnames";
import { requireEltOnly } from "@/lib/cash-flow-access";
import { getProjectEstimates, getCashFlowLines, resolveAsOf, listSnapshots, getLatestSnapshotSummary } from "@/lib/cash-flow";
import { CashFlowClient } from "@/components/CashFlowClient";

// Cash Flow Forecast — ELT-only (see cash-flow-access.ts's own header for
// why this is a hard role check, not a togglable Permission). "Current" is
// always live against Total ETO; any other `as`/`compare` param reads an
// immutable stored snapshot — see lib/cash-flow.ts.
export async function CashFlowView({ params }: { params: { as?: string; compare?: string } }) {
  await requireEltOnly();
  const { as, compare } = params;

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

  const [estimates, lines, compareLines, snapshots] = await Promise.all([
    estimatesPromise,
    getCashFlowLines(asOf),
    compareAsOf ? getCashFlowLines(compareAsOf) : Promise.resolve(null),
    snapshotsPromise,
  ]);

  return (
    <div className={PAGE_SHELL}>
      {/* Every figure on this page comes from the Total ETO snapshot, so when that
          source fails to refresh the page still renders — correctly, from the last
          good snapshot — and until now said nothing about it. Silent when healthy. */}
      <SourceStaleBanner sources={["cash_flow_snapshot"]} what="This forecast" />
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
export default async function CashFlowPage({ searchParams }: { searchParams: Promise<{ as?: string; compare?: string }> }) {
  return <CashFlowView params={await searchParams} />;
}
