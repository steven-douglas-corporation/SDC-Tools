import { PageTitle } from "@/components/ui/Typography";
import { PAGE_SHELL } from "@/components/ui/classnames";
import { requirePagePermission } from "@/lib/require-permission";
import { ImportSupervisorsButton } from "@/components/ImportSupervisorsButton";
import { ReconcileRosterButton } from "@/components/ReconcileRosterButton";

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
//   Import supervisors        Writes Employee.supervisorId from an uploaded
//     Paylocity export. Needs a human to supply the file, so no scheduled step
//     can replace it, and no SharePoint auto-pull exists yet. Occasional bulk
//     maintenance; single people are edited from the Employees page itself.
//
// So they moved rather than being removed, and the backend is untouched — the
// same two components and the same two server actions, mounted here instead.
// The Employees page now points at this screen.
//
// Gated on employees:edit, the stronger of the two: the reconcile is read-only,
// but the import writes to the roster, and a page that mixes both should ask
// for the permission the writing half needs.
export default async function AdminDataManagementPage() {
  await requirePagePermission("employees:edit");

  return (
    <div className={PAGE_SHELL}>
      <PageTitle className="mb-1">Data Management</PageTitle>
      <p className="mb-6 max-w-3xl text-sm text-sdc-gray-600">
        Manual roster maintenance. Nothing here runs on a schedule, and Refresh Data does not perform any of it —
        these are the actions that need a person to start them.
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
          <h2 className="text-sm font-bold uppercase tracking-wider text-sdc-navy">Import supervisors (Paylocity)</h2>
          <p className="mt-1.5 text-sm text-sdc-gray-600">
            Sets each person&apos;s reporting line from a Paylocity employee export, matching the
            export&apos;s <em>Emp Id</em> against the Paylocity id stored here.
            <strong> This writes to the roster.</strong> Use it for a bulk refresh of reporting lines; to change one
            person, edit them on the Employees page instead.
          </p>
          <div className="mt-3">
            <ImportSupervisorsButton />
          </div>
        </section>
      </div>
    </div>
  );
}
