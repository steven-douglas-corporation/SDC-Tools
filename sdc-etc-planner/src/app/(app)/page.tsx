import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { getDataQuality, getPunchExplorer } from "@/lib/data-quality";
import { DashboardTabs } from "@/components/DashboardTabs";
import { DataQualityPanel } from "@/components/DataQualityPanel";
import { recentRefreshRuns, currentRefresh } from "@/lib/refresh-service";
import { buildSourceHealth } from "@/lib/source-health";
import { PageTitle } from "@/components/ui/Typography";
import { BUTTON_PRIMARY, PAGE_SHELL } from "@/components/ui/classnames";
import { requirePagePermission } from "@/lib/require-permission";
import { getDashboardOverview, dashboardMonth } from "@/lib/dashboard-overview";
import { DashboardOverviewPanel, monthLabel } from "@/components/dashboard/DashboardOverview";
import { DashboardMonthSelect } from "@/components/dashboard/DashboardMonthSelect";
import { RefreshScheduleCard } from "@/components/dashboard/RefreshScheduleCard";
import { Band } from "@/components/dashboard/DashboardLayout";
import { UtilizationPanel } from "@/components/dashboard/UtilizationPanel";

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
// Preserved from the old page, unchanged in behaviour: the Data Quality tab and
// its issue badge, the Manage Jobs button, and the refresh-status card (moved to
// the bottom — it is a caveat on the figures, not one of them).

export async function DashboardView({ params }: { params: {
    tab?: string;
    m?: string;
    dqFrom?: string;
    dqTo?: string;
    dqEmp?: string;
    dqFn?: string;
    dqMtd?: string;
  } }) {
  await requirePagePermission("dashboard:view");
  const sp = params;
  const month = dashboardMonth(sp.m);
  // The Data Quality explorer classifies every punch in the window, so it runs
  // only when that tab is actually open. The dashboard's landing view must not
  // pay for it — which is also why the tab lives in the URL rather than in
  // client state alone.
  const onQualityTab = sp.tab === "quality";

  const [overview, dataQuality, explorer, freshnessRows, refreshRuns, liveRefresh] = await Promise.all([
    getDashboardOverview(month),
    // The Power BI report's Data Quality page, rebuilt locally — see
    // lib/data-quality.ts for where each rule comes from.
    getDataQuality(),
    onQualityTab
      ? getPunchExplorer({ from: sp.dqFrom, to: sp.dqTo, employeeId: sp.dqEmp, functionId: sp.dqFn, monthToDate: sp.dqMtd === "1" })
      : null,
    prisma.powerBiFreshness.findMany(),
    // The last few passes (§25.11). ONE would answer "who refreshed and when",
    // which is all the old card asked; the health panel also draws each source's
    // own recent outcomes from these, which is what makes "failing since 6am"
    // distinguishable from "failed once just now" — see lib/source-health.ts.
    // 20, not 6, since 2026-09-09. Six rows is six hours of a quiet day and about
    // four minutes of a busy one: five manual clicks in a row (which is what people
    // do when a source keeps failing) pushed every successful hourly pass out of the
    // window, so "Last success" read "not in recent history" for a source that had
    // in fact succeeded forty minutes earlier — the one fact that distinguishes
    // "Total ETO is broken" from "Total ETO is an hour stale".
    recentRefreshRuns(20),
    // So a source being worked on right now reads as refreshing rather than as
    // whatever it was on the last completed pass.
    currentRefresh(),
    // Which jobs actually have a Scheduler project, so a FAT row is never a dead
    // link. Fail-soft: an unreachable Scheduler yields an empty set (no links).
  ]);

  return (
    <div className={PAGE_SHELL}>
      {/* ── Header bar ────────────────────────────────────────────────────────
          A real bar now, closed by a rule, rather than a title floating above
          the content: the month/year control and Manage Jobs belong to the whole
          page, and the rule is what says so.

          No "Refresh Data" button here on purpose — RefreshDataButton is already
          in the sidebar on every page (the Refresh card at the bottom points
          readers there), and a second copy of a global control is a second thing
          to keep in step, not a convenience. */}
      <div className="mb-7 flex flex-wrap items-end justify-between gap-x-6 gap-y-3 border-b border-sdc-border pb-5">
        <div className="min-w-0">
          <PageTitle>Dashboard</PageTitle>
          <p className="text-sm text-sdc-gray-600">
            Active work, execution and capacity — month-scoped figures are for{" "}
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

      <DashboardTabs
        issueCount={dataQuality.future.count + dataQuality.afterCompletion.count + dataQuality.undefinedEmployees.count}
        dataQuality={<DataQualityPanel dq={dataQuality} explorer={explorer} />}
        overview={
          // Four labelled bands, not five equal blocks in a stack. The KPI
          // strip and the first two bands live inside DashboardOverviewPanel;
          // capacity and the system metadata are bands here because they are
          // separate components. See DashboardLayout.tsx.
          <div className="flex flex-col gap-8">
            <DashboardOverviewPanel data={overview} />

            {/* The page's most detailed figures — the "and here is the detail"
                answer to the hours KPIs above. Same `overview` object, same
                month: no second month state and no second fetch. */}
            <Band label="Capacity &amp; utilization">
              <UtilizationPanel result={overview.utilization} monthLabel={monthLabel(month)} />
            </Band>

            {/* Operational metadata, deliberately last and deliberately quiet —
                a muted band label and a lighter container, so it stays findable
                without competing with a business figure. */}
            <Band label="System" tone="muted">
              <RefreshScheduleCard health={buildSourceHealth({ freshness: freshnessRows, runs: refreshRuns, running: liveRefresh })} />
            </Band>
          </div>
        }
      />
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
export default async function Home({ searchParams }: { searchParams: Promise<{
    tab?: string;
    m?: string;
    dqFrom?: string;
    dqTo?: string;
    dqEmp?: string;
    dqFn?: string;
    dqMtd?: string;
  }> }) {
  return <DashboardView params={await searchParams} />;
}
