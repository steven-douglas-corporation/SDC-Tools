import { PageTitle } from "@/components/ui/Typography";
import { PAGE_SHELL } from "@/components/ui/classnames";
import { prisma } from "@/lib/prisma";
import { requirePagePermission } from "@/lib/require-permission";
import { hasPermission } from "@/lib/permissions";
import { ReconcileRosterButton } from "@/components/ReconcileRosterButton";
import { getDataQuality, getPunchExplorer } from "@/lib/data-quality";
import { getUndefinedHoursTotals } from "@/lib/unattributed-hours";
import { getRosterQuality } from "@/lib/paylocity-roster-sync";
import { getPositionFamilyQuality } from "@/lib/position-families-sync";
import { recentRefreshRuns, currentRefresh } from "@/lib/refresh-service";
import { buildSourceHealth } from "@/lib/source-health";
import { dashboardMonth } from "@/lib/dashboard-overview";
import { dataManagementTab } from "@/lib/data-management-tabs";
import { DataQualityPanel } from "@/components/DataQualityPanel";
import { DataManagementTabs } from "@/components/DataManagementTabs";
import { RefreshScheduleCard } from "@/components/dashboard/RefreshScheduleCard";
import { DashboardMonthSelect } from "@/components/dashboard/DashboardMonthSelect";

// ── Data Management (reshaped 2026-10-20, tabs and split view 2026-10-21) ────
//
// Three tabs: is what the app holds clean (Data quality, first and the default), can I
// trust what it is showing (Data sources), and what do I have to do by hand (Employee
// roster).
//
// The first two came from the Dashboard, where they were the "System" band and the
// Data Quality tab. They are about the data, not about the work the Dashboard is for,
// and the tab's issue badge only ever pulled people to a screen most of them never
// opened otherwise. The components and their queries moved unchanged.
//
// ── Tabs, and why only the open one is built (2026-10-21) ────────────────────
//
// They were three bands stacked on one page, and every visit read all of it — the punch
// explorer reads every punch, the roster file and position families are read from disk.
// Now the open tab is the `?tab=` param (see lib/data-management-tabs.ts), and the server
// builds only that one. The first tab, Data quality, is the default and writes no param.
//
// ── Split view (2026-10-21) ─────────────────────────────────────────────────
//
// This page lost its split-view entry when Data Quality moved here from the Dashboard
// (19798b7): the Dashboard was splittable, `/admin/data-management` was not a pane at
// all. It is registered again (SPLIT_ROUTES in lib/split-view.ts, PANE_VIEWS in
// components/PaneView.tsx), and its body lives in `DataManagementView` below so a pane
// renders the page itself rather than a copy. The `tab` and the month are per pane,
// like every other param. See the route entry point at the bottom.
//
// The Undefined Hours check is the one month-scoped figure in the checks (it is the
// Monthly ETC page's own per-month card), so the Data quality tab carries a month
// picker — the same control and the same `?m=` as the Dashboard's — defaulting to the
// current month.
//
// ── Roster maintenance, moved off the Employees page (2026-08-24) ────────────
//
// Both tools below used to sit in the Employees page header, beside the title,
// where every visitor saw them on every visit. An audit of what they actually do
// found that neither is redundant — Refresh Data and the hourly auto-sync run
// neither of them — but neither is day-to-day roster work either:
//
//   Reconcile with Scheduler  Read-only. Writes nothing. Compares the two
//     rosters BY NAME, and is explicitly not the authoritative comparison:
//     scripts/reconcile-employee-groups.ts matches on a stable employee_id and
//     is the one to trust (see sync-scheduler-team.ts's header). A diagnostic.
//
//   Import supervisors        RETIRED 2026-09-30, for the time being. The hourly
//     Paylocity roster sync (lib/paylocity-roster-sync.ts) now owns supervisor
//     and job title, so the section below only says where they come from.
//     ImportSupervisorsButton is unmounted; its server action refuses.
//
// So they moved rather than being removed, and the backend is untouched — the
// same two components and the same two server actions, mounted here instead.
// The Employees page now points at this screen.
//
// ── Who sees what (2026-10-20) ──────────────────────────────────────────────
//
// The page is gated on data-management:view. It was dashboard:view until 2026-10-21, because
// the sources and the checks are what the Dashboard's tab showed to those roles; the new
// permission was seeded to match it, and is the one to widen. Reconcile with Scheduler needs employees:edit
// (it reads the Scheduler's roster) and is only rendered for roles that hold it; its
// server action checks the same permission, because hiding a button is not a gate. The
// Paylocity note is plain information and shows to everyone.

export type DataManagementParams = {
  tab?: string;
  m?: string;
  dqFrom?: string;
  dqTo?: string;
  dqEmp?: string;
  dqFn?: string;
  dqMtd?: string;
};

export async function DataManagementView({ params }: { params: DataManagementParams }) {
  const session = await requirePagePermission("data-management:view");
  const canReconcile = hasPermission(session.user.role, "employees:edit");
  const tab = dataManagementTab(params.tab);

  return (
    <div className={PAGE_SHELL}>
      <div className="mb-7 border-b border-sdc-border pb-5">
        <PageTitle className="mb-1">Data Management</PageTitle>
        <p className="max-w-3xl text-sm text-sdc-gray-600">
          Whether the data behind the app is current and clean: how each source last refreshed, the data-quality checks, and the
          manual roster tools.
        </p>
      </div>

      <DataManagementTabs>
        {tab === "sources" && <SourcesTab />}
        {tab === "quality" && <QualityTab params={params} />}
        {tab === "roster" && <RosterTab canReconcile={canReconcile} />}
      </DataManagementTabs>
    </div>
  );
}

async function SourcesTab() {
  const [freshnessRows, refreshRuns, liveRefresh] = await Promise.all([
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
  ]);

  return <RefreshScheduleCard health={buildSourceHealth({ freshness: freshnessRows, runs: refreshRuns, running: liveRefresh })} />;
}

async function QualityTab({ params }: { params: DataManagementParams }) {
  const month = dashboardMonth(params.m);

  const [dataQuality, explorer, roster, families, undefinedHours] = await Promise.all([
    // The Power BI report's Data Quality page, rebuilt locally — see
    // lib/data-quality.ts for where each rule comes from.
    getDataQuality(),
    getPunchExplorer({ from: params.dqFrom, to: params.dqTo, employeeId: params.dqEmp, functionId: params.dqFn, monthToDate: params.dqMtd === "1" }),
    getRosterQuality(),
    getPositionFamilyQuality(),
    // The Monthly ETC card's own figure for this month (same function), so the tile's
    // headline and the detail it opens cannot disagree with that page.
    getUndefinedHoursTotals(month),
  ]);

  return (
    <>
      <div className="mb-4 flex items-center justify-end gap-2.5">
        <span className="text-label text-sdc-muted">Undefined Hours month</span>
        <DashboardMonthSelect month={month} label="Undefined Hours" />
      </div>
      <DataQualityPanel
        dq={dataQuality}
        explorer={explorer}
        roster={roster}
        families={families}
        month={month}
        undefinedHours={undefinedHours}
      />
    </>
  );
}

function RosterTab({ canReconcile }: { canReconcile: boolean }) {
  return (
    <>
      <p className="mb-4 max-w-3xl text-sm text-sdc-gray-600">
        Manual roster maintenance. Nothing here runs on a schedule, and Refresh Data does not perform any of it — these
        are the actions that need a person to start them.
      </p>

      <div className="max-w-3xl space-y-4">
        {canReconcile && (
          <section className="rounded-xl border border-sdc-border bg-white p-5">
            <h2 className="text-sm font-bold uppercase tracking-wider text-sdc-navy">Reconcile with Scheduler</h2>
            <p className="mt-1.5 text-sm text-sdc-gray-600">
              Compares this app&apos;s full roster against SDC Scheduler&apos;s team board and reports where the two
              disagree on active status or team. <strong>Read-only — it changes nothing.</strong> Useful after adding
              someone, or when a name looks wrong in one app but not the other.
            </p>
            <p className="mt-1.5 text-sm text-sdc-gray-600">
              It matches people <em>by name</em>, so nicknames and spelling differences can show up as unmatched. For
              the authoritative comparison, which matches on employee id,
              run <code className="rounded bg-sdc-gray-50 px-1 py-0.5 text-label">scripts/reconcile-employee-groups.ts</code>.
            </p>
            <div className="mt-3">
              <ReconcileRosterButton />
            </div>
          </section>
        )}

        <section className="rounded-xl border border-sdc-border bg-white p-5">
          <h2 className="text-sm font-bold uppercase tracking-wider text-sdc-navy">Supervisors and job titles come from Paylocity</h2>
          <p className="mt-1.5 text-sm text-sdc-gray-600">
            The employee roster syncs from Paylocity&apos;s roster file every hour, with Refresh Data. It adds
            anyone new, hidden until someone shows them on the Employees page, and keeps each person&apos;s{" "}
            <strong>supervisor</strong> and <strong>job title</strong> exactly as Paylocity has them.{" "}
            <strong>These can&apos;t be edited here. To change one, change it in Paylocity</strong>, and it comes
            through on the next refresh.
          </p>
          <p className="mt-1.5 text-sm text-sdc-gray-600">
            The sync never removes anyone or changes a name or department. It hides people Paylocity marks
            inactive, and sets each person&apos;s team from their position family and reporting line — see the Org
            Chart view on the Employees page.
          </p>
        </section>
      </div>
    </>
  );
}

// -- Route entry point --
//
// The page's body lives in `DataManagementView` above so that BOTH this route and the
// split / workspace panes render the exact same thing (see components/PaneView.tsx). A
// pane cannot be a route and therefore cannot read `searchParams` — there is only one
// URL per document — so the body takes its params as a plain object and each caller
// supplies them. `searchParams` is still awaited HERE, which keeps this route dynamic.
export default async function AdminDataManagementPage({ searchParams }: { searchParams: Promise<DataManagementParams> }) {
  return <DataManagementView params={await searchParams} />;
}
