import Link from "next/link";
import { PageTitle } from "@/components/ui/Typography";
import { BUTTON_PRIMARY, PAGE_SHELL } from "@/components/ui/classnames";
import { requirePagePermission } from "@/lib/require-permission";
import { getDashboardOverview, dashboardMonth } from "@/lib/dashboard-overview";
import { DashboardOverviewPanel, monthLabel } from "@/components/dashboard/DashboardOverview";
import { DashboardMonthSelect } from "@/components/dashboard/DashboardMonthSelect";
import { Band } from "@/components/dashboard/DashboardLayout";
import { UtilizationPanel } from "@/components/dashboard/UtilizationPanel";
import { DashboardTabs } from "@/components/DashboardTabs";
import { FinancesPanel } from "@/components/dashboard/FinancesPanel";
import { DashboardFeedbackBand } from "@/components/dashboard/DashboardFeedbackBand";
import { financeCardsFor } from "@/lib/finance-cards";

// ── The Dashboard (redesigned 2026-08-27) ───────────────────────────────────
//
// Was four count KPIs, a "Manage Jobs" button and a refresh-status card, on a
// page wide enough for far more — a landing page that told a manager the number
// of jobs and nothing about the work. It now answers the questions the ETC
// process actually opens with: what is active and for whom, what is being tested
// this month and by which discipline, and what capacity the two execution
// departments have in that month.
//
// Two structural rules hold this together:
//
//   1. ONE data pass. Every figure comes from getDashboardOverview(month) — a
//      single parallel batch of five reads (jobs, employees, punch hours,
//      Scheduler FATs, Scheduler discipline owners). No card fetches anything of
//      its own, so adding a card costs nothing and the numbers on two cards
//      cannot disagree.
//   2. ONE month. The month selector sets `?m=YYYY-MM` and the server rebuilds
//      the page from it, so the FAT count, the ME/CE split, Engineering hours and
//      Shop hours move together by construction rather than by four controls
//      being kept in step.
//
// Active Jobs is deliberately NOT month-scoped. There is no historical
// active-job model in this app — `Job.status` is the current state and nothing
// records what it was in March — so a month-scoped active count would be a
// number about today wearing a label about the past. It says "current status" on
// the section instead.
//
// The Data Quality tab (with its issue badge) and the "Data source health" card
// moved to Admin > Data Management on 2026-10-20. They are about whether to
// trust the data rather than about the work, and the Dashboard is now only the
// work. The Manage Jobs button stays.
//
// ── Two tabs: Executive and Finances (2026-10-20) ──────────────────────────
//
// Executive is everything above. Finances is a set of cards, each a window onto a
// page that already shows the figure and each ending in a "More details" link to it —
// see lib/finance-cards.ts. A role sees the Finances tab only if it can open at least
// one of those pages; otherwise the Dashboard is exactly what it was, with no tab
// strip.
//
// Finances is decided and built HERE, on the server, from the role: a role without
// access never has finance figures in its page, which a hidden-but-mounted panel
// would not guarantee. And it is only built when the URL says `?tab=finances`, so
// the landing view does not pay for it.

export async function DashboardView({ params }: { params: { tab?: string; m?: string } }) {
  const session = await requirePagePermission("dashboard:view");
  const month = dashboardMonth(params.m);
  const financeCards = financeCardsFor(session.user.role);
  const hasFinances = financeCards.length > 0;
  const financesOpen = hasFinances && params.tab === "finances";

  const overview = await getDashboardOverview(month);

  const executive = (
    // Bands, not equal blocks in a stack. The KPI strip and the first two bands
    // live inside DashboardOverviewPanel; capacity is a band here because it is a
    // separate component. See DashboardLayout.tsx.
    <div className="flex flex-col gap-8">
      <DashboardOverviewPanel data={overview} />

      {/* The page's most detailed figures — the "and here is the detail"
          answer to the hours KPIs above. Same `overview` object, same
          month: no second month state and no second fetch. */}
      <Band label="Capacity &amp; utilization">
        <UtilizationPanel result={overview.utilization} monthLabel={monthLabel(month)} />
      </Band>

      <DashboardFeedbackBand view="executive" month={month} />
    </div>
  );

  return (
    <div className={PAGE_SHELL}>
      {/* ── Header bar ────────────────────────────────────────────────────────
          A real bar now, closed by a rule, rather than a title floating above
          the content: the month/year control and Manage Jobs belong to the whole
          page, and the rule is what says so.

          No "Refresh Data" button here on purpose — RefreshDataButton is already
          in the sidebar on every page, and a second copy of a global control is
          a second thing to keep in step, not a convenience. */}
      <div className="mb-7 flex flex-wrap items-end justify-between gap-x-6 gap-y-3 border-b border-sdc-border pb-5">
        <div className="min-w-0">
          <PageTitle>Dashboard</PageTitle>
          <p className="text-sm text-sdc-gray-600">
            {hasFinances ? "Work, capacity and finances" : "Active work, execution and capacity"} — month-scoped figures are for{" "}
            <span className="font-semibold text-sdc-navy">{monthLabel(month)}</span>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2.5">
          <DashboardMonthSelect month={month} />
          <Link href="/jobs" className={BUTTON_PRIMARY}>
            Manage Jobs
          </Link>
        </div>
      </div>

      {hasFinances ? (
        <DashboardTabs
          executive={executive}
          finances={financesOpen ? <FinancesPanel month={month} cards={financeCards} /> : null}
        />
      ) : (
        executive
      )}
    </div>
  );
}


// -- Route entry point --
//
// The page's body lives in `DashboardView` above so that BOTH this route and the split
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
export default async function Home({ searchParams }: { searchParams: Promise<{ tab?: string; m?: string }> }) {
  return <DashboardView params={await searchParams} />;
}
