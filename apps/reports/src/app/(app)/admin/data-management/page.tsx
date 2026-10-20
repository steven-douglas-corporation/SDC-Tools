import { PageTitle } from "@/components/ui/Typography";
import { PAGE_SHELL } from "@/components/ui/classnames";
import { prisma } from "@/lib/prisma";
import { requirePagePermission } from "@/lib/require-permission";
import { ReconcileRosterButton } from "@/components/ReconcileRosterButton";
import { getDataQuality, getPunchExplorer } from "@/lib/data-quality";
import { getUndefinedHoursTotals } from "@/lib/unattributed-hours";
import { getRosterQuality } from "@/lib/paylocity-roster-sync";
import { getPositionFamilyQuality } from "@/lib/position-families-sync";
import { recentRefreshRuns, currentRefresh } from "@/lib/refresh-service";
import { buildSourceHealth } from "@/lib/source-health";
import { dashboardMonth } from "@/lib/dashboard-overview";
import { DataQualityPanel } from "@/components/DataQualityPanel";
import { RefreshScheduleCard } from "@/components/dashboard/RefreshScheduleCard";
import { DashboardMonthSelect } from "@/components/dashboard/DashboardMonthSelect";
import { Band } from "@/components/dashboard/DashboardLayout";

// ── Data Management (reshaped 2026-10-20) ───────────────────────────────────
//
// Three bands, in the order a person asks the questions: can I trust what the
// app is showing (the sources), is what it holds clean (the checks), and what do
// I have to do by hand (roster maintenance).
//
// The first two came from the Dashboard, where they were the "System" band and the
// Data Quality tab. They are about the data, not about the work the Dashboard is for,
// and the tab's issue badge only ever pulled people to a screen most of them never
// opened otherwise. The components and their queries moved unchanged; what changed is
// that this page is always the Data Quality page, so the punch explorer, the roster
// file and the position families are read on every visit rather than only when a tab
// was open.
//
// The Undefined Hours check is the one month-scoped figure in the checks (it is the
// Monthly ETC page's own per-month card), so the Data quality band carries a month
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
// Gated on employees:edit, the stronger of the two: the reconcile is read-only,
// but the import writes to the roster, and a page that mixes both should ask
// for the permission the writing half needs.
export default async function AdminDataManagementPage({
  searchParams,
}: {
  searchParams: Promise<{
    m?: string;
    dqFrom?: string;
    dqTo?: string;
    dqEmp?: string;
    dqFn?: string;
    dqMtd?: string;
  }>;
}) {
  await requirePagePermission("employees:edit");
  const sp = await searchParams;
  const month = dashboardMonth(sp.m);

  const [dataQuality, explorer, roster, families, undefinedHours, freshnessRows, refreshRuns, liveRefresh] = await Promise.all([
    // The Power BI report's Data Quality page, rebuilt locally — see
    // lib/data-quality.ts for where each rule comes from.
    getDataQuality(),
    getPunchExplorer({ from: sp.dqFrom, to: sp.dqTo, employeeId: sp.dqEmp, functionId: sp.dqFn, monthToDate: sp.dqMtd === "1" }),
    getRosterQuality(),
    getPositionFamilyQuality(),
    // The Monthly ETC card's own figure for this month (same function), so the tile's
    // headline and the detail it opens cannot disagree with that page.
    getUndefinedHoursTotals(month),
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

  return (
    <div className={PAGE_SHELL}>
      <div className="mb-7 border-b border-sdc-border pb-5">
        <PageTitle className="mb-1">Data Management</PageTitle>
        <p className="max-w-3xl text-sm text-sdc-gray-600">
          Whether the data behind the app is current and clean: how each source last refreshed, the data-quality checks, and the
          manual roster tools.
        </p>
      </div>

      <div className="flex flex-col gap-8">
        <Band label="Data sources">
          <RefreshScheduleCard health={buildSourceHealth({ freshness: freshnessRows, runs: refreshRuns, running: liveRefresh })} />
        </Band>

        <Band
          label="Data quality"
          action={
            <div className="flex items-center gap-2.5">
              <span className="text-label text-sdc-muted">Undefined Hours month</span>
              <DashboardMonthSelect month={month} label="Undefined Hours" />
            </div>
          }
        >
          <DataQualityPanel
            dq={dataQuality}
            explorer={explorer}
            roster={roster}
            families={families}
            month={month}
            undefinedHours={undefinedHours}
          />
        </Band>

        <Band label="Employee roster">
          <p className="mb-4 max-w-3xl text-sm text-sdc-gray-600">
            Manual roster maintenance. Nothing here runs on a schedule, and Refresh Data does not perform any of it — these
            are the actions that need a person to start them.
          </p>

          <div className="max-w-3xl space-y-4">
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
        </Band>
      </div>
    </div>
  );
}
