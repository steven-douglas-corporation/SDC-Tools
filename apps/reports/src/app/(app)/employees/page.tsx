import { prisma } from "@/lib/prisma";
import { PAGE_SHELL } from "@/components/ui/classnames";
import { PageTitle } from "@/components/ui/Typography";
import { EmployeesGrid } from "@/components/EmployeesGrid";
import { DISCIPLINE_LABELS } from "@/lib/disciplines";
import type { EmployeeRow } from "@/components/EmployeesCards";
import { fetchEmployeeTeams } from "@/lib/employee-team-field";
import { fetchSchedulerPlaceholders } from "@/lib/scheduler-db";
import { fetchSchedulerOverlay } from "@/lib/employee-scheduler-overlay";
import { normalizeName } from "@/lib/sync-scheduler-team";
import { requirePagePermission } from "@/lib/require-permission";
import { hasPermission } from "@/lib/permissions";
import { getHiringPositions, redactHiddenPositions } from "@/lib/hiring-positions";

// Team groupings, matching the SDC Scheduler app's team_members.discipline
// categories. Now a sortable AG Grid column (Community can't do row grouping).
const DISCIPLINES = DISCIPLINE_LABELS;
const DASH = "—";

// Replaces the "Employees" tab of Project Planner Data Control.xlsx.
// Soft-delete only: deactivating keeps every historical hour intact.
//
// Read-only view — see EmployeesCards. The roster's fields all have upstream
// owners (Scheduler for discipline, Paylocity for name/department/supervisor),
// so it is maintained through the toolbar's sync and import buttons rather than
// by typing into cells.
export async function EmployeesView() {
  const session = await requirePagePermission("employees:view");
  const employees = await prisma.employee.findMany({
    orderBy: [{ discipline: "asc" }, { name: "asc" }],
  });
  // team is Scheduler-authoritative; isLead/specialty are read live off the
  // SAME source (see employee-scheduler-overlay.ts) — both fail soft to
  // "nothing extra shown" if the Scheduler DB isn't reachable, so a roster
  // load never depends on Scheduler being up.
  const [teamById, overlayByName, placeholders, hiring] = await Promise.all([
    fetchEmployeeTeams(),
    fetchSchedulerOverlay(),
    fetchSchedulerPlaceholders(),
    getHiringPositions(),
  ]);

  // id → name across the WHOLE roster, so a supervisor who has since been
  // deactivated still resolves to a name instead of showing as a dash.
  const nameById = new Map(employees.map((e) => [e.id, e.name]));

  const rows: EmployeeRow[] = employees.map((e) => {
    const overlay = overlayByName.get(normalizeName(e.name));
    return {
      id: e.id,
      name: e.name,
      discipline: DISCIPLINES.includes(e.discipline ?? "") ? (e.discipline as string) : DASH,
      positionTitle: e.positionTitle?.trim() || DASH,
      supervisor: e.supervisorId != null ? (nameById.get(e.supervisorId) ?? DASH) : DASH,
      department: e.department ?? "",
      team: teamById.get(e.id) ?? null,
      active: e.active,
      billingGroup: e.billingGroup ?? "",
      paylocityId: e.paylocityId ?? "",
      isLead: overlay?.isLead ?? false,
      specialty: overlay?.specialty ?? null,
      sortOrder: overlay?.sortOrder ?? null,
    };
  });

  const canAddEmployees = hasPermission(session.user.role, "employees:edit");
  const canAssignHiring = hasPermission(session.user.role, "employees:hiring:assign");
  // Plain server-computed year, threaded down as a prop -- keeps
  // workforce-capacity-policy.ts/workforce-capacity.ts pure and testable
  // independent of the system clock, and leaves a clean seam for a future
  // year-selector.
  const year = new Date().getFullYear();
  // The one enforcement point for "users without hiring-edit permission
  // should only see positions currently marked visible" (2026-08-19) — done
  // here, server-side, before the array ever reaches EmployeesGrid (a client
  // component), so a hidden position's real title is never even sent to a
  // non-editor's browser. See redactHiddenPositions' own comment.
  const hiringPositions = redactHiddenPositions(hiring.positions, canAssignHiring);

  return (
    <div className={PAGE_SHELL}>
      <div className="mb-1">
        <div>
          <PageTitle className="mb-1">Employees</PageTitle>
          <p className="max-w-4xl text-sm text-sdc-gray-600">
            Replaces the Project Planner workbook&apos;s Employees tab. Start at the Engineering / Shop / PM workforce
            overview, then open one card to see all of that group&apos;s departments and their people right here — a
            person&apos;s own detail opens in a side panel. Deactivated employees
            keep all historical hours. Team grouping is shared live with SDC Scheduler&apos;s board — the roster here
            is read-only, maintained through Scheduler&apos;s own board and, for bulk roster maintenance,
            Admin &rsaquo; Data Management.
          </p>
        </div>
      </div>

      <div className="mt-5">
        <EmployeesGrid
          rows={rows}
          disciplines={DISCIPLINES}
          placeholders={placeholders}
          canAddEmployees={canAddEmployees}
          hiringPositions={hiringPositions}
          hiringError={hiring.error}
          canAssignHiring={canAssignHiring}
          year={year}
        />
      </div>
    </div>
  );
}


// -- Route entry point --
//
// The page's body lives in `EmployeesView` above so that BOTH this route and the split
// view can render it. Split view renders two views in ONE document (see
// lib/split-view.ts for why one document rather than two frames), which means a
// pane cannot be a route and therefore cannot read `searchParams` - there is only
// one URL and two panes would collide in it. So the body takes its context as a
// plain argument, and the two callers differ only in where they read that context
// from: this wrapper reads the URL, a pane reads its own `l.`/`r.` namespace.
export default async function EmployeesPage() {
  return <EmployeesView />;
}
