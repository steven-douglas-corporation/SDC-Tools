// The one `EmployeeRow` shape shared across the Employees tab's page,
// filtering, card-building and (2026-08-19) workforce-group/detail-drawer
// layers. Lived inline in EmployeesCards.tsx originally; pulled out here once
// a second lib-level consumer (employee-department-cards.ts) needed it too —
// a component file importing FROM a lib module is normal in this app, a lib
// module importing a type back out of a component file is not, so this is
// the one place it's declared now.

export const DASH = "—";

/**
 * Whether this person comes from Paylocity's roster. Paylocity's employee ids are
 * numeric; TEMP1, P6 and a blank are people entered in this app, whose supervisor
 * no sync owns — so for them alone it is set on the Employees page (2026-10-02).
 */
/**
 * People with the same Paylocity position code side by side (2026-10-05, by
 * request): by code, then name; anyone with no code after everyone who has one.
 * Shared by the Cards and Org chart views so a card orders its people the same
 * way in both.
 */
export function comparePositionCode(a: { positionCode?: string | null; name: string }, b: { positionCode?: string | null; name: string }): number {
  const ca = a.positionCode?.trim() || null;
  const cb = b.positionCode?.trim() || null;
  if (ca !== cb) {
    if (ca === null) return 1;
    if (cb === null) return -1;
    const byCode = ca.localeCompare(cb, undefined, { numeric: true, sensitivity: "base" });
    if (byCode !== 0) return byCode;
  }
  return a.name.localeCompare(b.name);
}

export function isPaylocityId(paylocityId: string | null | undefined): boolean {
  return !!paylocityId && /^\d+$/.test(paylocityId.trim());
}

export type EmployeeRow = {
  id: number;
  name: string;
  discipline: string; // label or DASH
  // Job title (Employee_Department_Map.xlsx's own field) or DASH. Falls back
  // to discipline in roleOf() below when there's no title on file.
  positionTitle: string;
  supervisor: string; // supervisor name or DASH
  // The supervisor's Employee.id, for the drawer's picker (people not in Paylocity only).
  supervisorId?: number | null;
  // Paylocity Position Code (2026-10-05) — people within a card are grouped by it.
  positionCode?: string | null;
  department: string;
  // The shared team code (pm/mech/controls/build/wire/mfgops/service) —
  // resolveEmployeeGroup()'s first, most authoritative signal.
  team: string | null;
  active: boolean;
  billingGroup: string;
  paylocityId: string;
  // The ★ department lead: the top of the person's team by reporting line
  // (team-resolution.ts departmentLeads, 2026-10-05). specialty/sortOrder below
  // are still live from Scheduler's team_members (employee-scheduler-overlay.ts) —
  // false/null when there's no Scheduler match at all (not yet reconciled).
  isLead: boolean;
  // Leadership: their position code is in family 100 (2026-10-02). Badged, and
  // listed first on whichever card they sit on — see lib/team-resolution.ts.
  isLeadership?: boolean;
  specialty: string | null;
  sortOrder: number | null;
};
