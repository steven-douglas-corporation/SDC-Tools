import { prisma } from "@/lib/prisma";
import { PAGE_SHELL } from "@/components/ui/classnames";
import { PageTitle } from "@/components/ui/Typography";
import { EmployeesGrid } from "@/components/EmployeesGrid";
import { DISCIPLINE_LABELS } from "@/lib/disciplines";
import { fetchEmployeeTeams } from "@/lib/employee-team-field";
import { fetchSchedulerPlaceholders } from "@/lib/scheduler-db";
import { fetchSchedulerOverlay } from "@/lib/employee-scheduler-overlay";
import { normalizeName } from "@/lib/sync-scheduler-team";
import { requirePagePermission } from "@/lib/require-permission";
import { hasPermission } from "@/lib/permissions";
import { getHiringPositions } from "@/lib/hiring-positions";
import { HIRING_POSITIONS_ENABLED } from "@/lib/hiring-feature";
import { resolveTeams, departmentLeads } from "@/lib/team-resolution";
import { resolveEmployeeGroup, NO_DEPARTMENT } from "@/lib/employee-card-theme";
import { isPaylocityId, type EmployeeRow } from "@/lib/employee-row";
import { buildOrgChart } from "@/lib/org-chart";
import type { PositionFamilyRow } from "@/lib/position-families-parse";

// Team groupings, matching the SDC Scheduler app's team_members.discipline
// categories. Now a sortable AG Grid column (Community can't do row grouping).
const DISCIPLINES = DISCIPLINE_LABELS;
const DASH = "—";

// Replaces the "Employees" tab of Project Planner Data Control.xlsx.
// Soft-delete only: deactivating keeps every historical hour intact.
//
// Read-only view. The roster's fields all have upstream
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
  const [teamById, overlayByName, placeholders, familyRows] = await Promise.all([
    fetchEmployeeTeams(),
    fetchSchedulerOverlay(),
    fetchSchedulerPlaceholders(),
    // Position families (2026-10-02): who is Leadership, and the Org chart view.
    prisma.positionFamily.findMany({
      select: { positionCode: true, familyCode: true, familyName: true, title: true, headcount: true, source: true },
    }),
  ]);
  const families = familyRows.map((r) => ({ ...r, source: r.source as PositionFamilyRow["source"] }));
  const peopleForRule = employees.map((e) => ({ ...e, team: teamById.get(e.id) ?? null }));
  const teamRule = resolveTeams(peopleForRule, families);
  const leads = departmentLeads(peopleForRule, teamRule);
  const orgChart = buildOrgChart(peopleForRule, families);
  // The same chart with hidden people drawn too, for "Show inactive". Built here
  // because the builder is server-only; the grid just picks one.
  const orgChartWithInactive = buildOrgChart(peopleForRule, families, { includeInactive: true });

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
      supervisorId: e.supervisorId,
      positionCode: e.positionCode,
      department: e.department ?? "",
      team: teamById.get(e.id) ?? null,
      teamOverride: e.teamOverride,
      placedByHand: teamRule.get(e.id)?.overridden ?? false,
      active: e.active,
      billingGroup: e.billingGroup ?? "",
      paylocityId: e.paylocityId ?? "",
      // The ★ is the top of each team by reporting line (lib/team-resolution.ts
      // departmentLeads), no longer Scheduler's is_lead checkbox.
      isLead: leads.has(e.id),
      isLeadership: teamRule.get(e.id)?.leader ?? false,
      specialty: overlay?.specialty ?? null,
      sortOrder: overlay?.sortOrder ?? null,
    };
  });

  // Hiring positions (DataWarehouse), read after the roster because an
  // unassigned position defaults to the card its hiring manager sits on: the
  // export names managers by Paylocity id, and this maps each id to its card.
  // Left off (and no read made) while the feature flag is off.
  const cardKeyByPaylocityId = new Map<string, string>();
  for (const r of rows) {
    if (!isPaylocityId(r.paylocityId)) continue;
    const key = resolveEmployeeGroup(r)?.key;
    if (key && key !== NO_DEPARTMENT) cardKeyByPaylocityId.set(r.paylocityId.trim(), key);
  }
  // employees:hiring:view (2026-10-30): without it nothing about hiring is read,
  // so none of it reaches the browser.
  const canViewHiring = hasPermission(session.user.role, "employees:hiring:view");
  const hiring = HIRING_POSITIONS_ENABLED && canViewHiring ? await getHiringPositions({ cardKeyByPaylocityId }) : { positions: [], error: null };

  const canAddEmployees = hasPermission(session.user.role, "employees:edit");
  const canAssignHiring = hasPermission(session.user.role, "employees:hiring:assign");
  // Plain server-computed year, threaded down as a prop -- keeps
  // workforce-capacity-policy.ts/workforce-capacity.ts pure and testable
  // independent of the system clock, and leaves a clean seam for a future
  // year-selector.
  const year = new Date().getFullYear();
  // Every position goes to every viewer as-is: hiding positions was removed
  // (2026-10-30), and the stored isVisible flag is no longer read.
  const hiringPositions = hiring.positions;

  return (
    <div className={PAGE_SHELL}>
      {/* The Dashboard's header (2026-10-29): title, one line on what the page
          is, and the rule the tabs below sit under. */}
      <div className="mb-7 border-b border-sdc-border pb-5">
        <PageTitle>Employees</PageTitle>
        <p className="text-sm text-sdc-gray-600">Everyone on the Paylocity roster by who they report to, plus contractors and the positions being hired for</p>
      </div>

      <div>
        <EmployeesGrid
          rows={rows}
          placeholders={placeholders}
          canAddEmployees={canAddEmployees}
          canViewHours={hasPermission(session.user.role, "dashboard:view")}
          hiringPositions={hiringPositions}
          hiringError={hiring.error}
          canAssignHiring={canAssignHiring}
          canViewHiring={canViewHiring}
          canRequestHire={hasPermission(session.user.role, "employees:hiring:request")}
          year={year}
          orgChart={orgChart}
          orgChartWithInactive={orgChartWithInactive}
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
