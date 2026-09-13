import { PageTitle } from "@/components/ui/Typography";
import { SourceStaleBanner } from "@/components/SourceStaleBanner";
import { PAGE_SHELL } from "@/components/ui/classnames";
import { loadJobCostRows } from "@/lib/job-cost-source";
import { loadCostRates, loadHourAllocations } from "@/lib/job-cost-actions";
import { JobCostExplorer } from "@/components/JobCostExplorer";
import { SuppressToasts } from "@/components/ui/Toast";
import { requirePagePermission } from "@/lib/require-permission";

// "Job Cost Explorer" — integrated from the standalone app at
// D:\AI Projects\new app. Per-job profit/margin, reusing this app's own job,
// hours, and parts-cost data instead of the standalone app's independent
// Power BI queries — see docs/INTEGRATIONS.md and the DEVLOG entry for the
// full audit of what was reused vs. what still has no equivalent here.
//
// `?asOf=YYYY-MM-DD` (2026-08-11): a month-end snapshot selector. Absent, or
// literally "current", means today's live view (unchanged from before this
// param existed) — anything else re-resolves the whole table (hours, ETC,
// inventory) as of that month-end. See lib/job-cost-source.ts's
// loadJobCostRows for the resolution rules.
export async function ProfitabilityView({ params }: { params: { asOf?: string } }) {
  await requirePagePermission("profitability:view");
  const { asOf: asOfParam } = params;
  const asOf = asOfParam && asOfParam !== "current" ? asOfParam : null;

  const [
    { rows, inventoryAsOf, etcRefreshedThru, partsCostAvailable, asOf: appliedAsOf, inventoryMissing, etcMissing, asOfOptions },
    { defaults, overrides },
    allocations,
  ] = await Promise.all([loadJobCostRows(asOf), loadCostRates(), loadHourAllocations()]);

  return (
    // `w-full p-8` — the same outer-wrapper padding etc/page.tsx and the other
    // Reports tabs already carry (2026-08-12: this page never had it, which is
    // why its table sat flush against the sidebar). AppShell's <main> is a
    // flex-1 sibling of the sidebar with no padding of its own by design (see
    // AppShell.tsx) — every page is expected to supply its own breathing room,
    // and this one simply hadn't. Sticky/frozen columns are unaffected: their
    // `left-*` offsets resolve against the table's own scroll container
    // (GRID_SCROLLER, inside JobCostExplorer.tsx), not the viewport or this
    // div, so padding out here only moves that whole box rightward as a unit.
    <div className={PAGE_SHELL}>
      <SourceStaleBanner sources={["parts_cost_actual", "totaleto_jobs"]} what="These job costs" />
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3">
        <PageTitle>Profitability</PageTitle>
        <p className="text-note text-sdc-gray-400">
          Per-job profit and margin — hours and parts cost from this app&apos;s own data
          {/* The active As-of date, stated plainly wherever the page's own
              subtitle already is — "show the active As of date clearly". */}
          {" · "}
          {appliedAsOf ? <>As of <span className="font-semibold text-sdc-navy">{appliedAsOf}</span></> : "Current"}
        </p>
      </div>
      {/* SuppressToasts belongs HERE, wrapping the call site — not inside
          JobCostExplorer.tsx wrapping its own return value. A component cannot
          supply its own useToast() call with a Provider it renders as part of
          its own output: useContext resolves against ANCESTORS at the point the
          hook runs, and a self-wrap is a descendant of that point, not an
          ancestor. This is a server component, so it can render the client
          SuppressToasts wrapper directly, same as any other client child. */}
      <SuppressToasts>
        <JobCostExplorer
          rows={rows}
          defaultRates={defaults}
          yearRateOverrides={overrides}
          hourAllocations={Object.fromEntries(allocations)}
          inventoryAsOf={inventoryAsOf}
          etcRefreshedThru={etcRefreshedThru}
          partsCostAvailable={partsCostAvailable}
          asOf={appliedAsOf}
          inventoryMissing={inventoryMissing}
          etcMissing={etcMissing}
          asOfOptions={asOfOptions}
        />
      </SuppressToasts>
    </div>
  );
}


// -- Route entry point --
//
// The page's body lives in `ProfitabilityView` above so that BOTH this route and the split
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
export default async function JobCostExplorerPage({ searchParams }: { searchParams: Promise<{ asOf?: string }> }) {
  return <ProfitabilityView params={await searchParams} />;
}
