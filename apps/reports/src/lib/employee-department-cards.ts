import { resolveEmployeeGroup, compareGroupOrder, type EmployeeGroup } from "@/lib/employee-card-theme";
import { DISCIPLINE_LABEL } from "@/lib/disciplines";
import type { SchedulerPlaceholder } from "@/lib/scheduler-db";
import { comparePositionCode, type EmployeeRow } from "@/lib/employee-row";

// Turns the employee rows (+ Scheduler placeholders) into department cards:
// who is in each department, in card order. Since the Cards view went
// (2026-10-29) its one caller is WorkforceSummaryCards, which rolls the cards
// up into its workforce-group tiles. Pure and React-free, so it's directly unit-testable.

export type DepartmentCard = EmployeeGroup & { people: EmployeeRow[]; placeholders: SchedulerPlaceholder[] };

// Which card a placeholder belongs to — department/discipline (labels), not
// just team (code): matchesGrowth and the Finance/Sales/Exec matchers in
// resolveEmployeeGroup() key off the LABEL, not the code — team alone only
// resolves the seven delivery teams, which is all it needs to for real
// employee rows, but a placeholder in Growth/Finance/Sales/Exec would fall
// through to a raw-code bucket without this.
export function resolvePlaceholderGroup(p: SchedulerPlaceholder): EmployeeGroup | null {
  const label = DISCIPLINE_LABEL[p.discipline] ?? null;
  return resolveEmployeeGroup({ team: p.discipline, department: label, discipline: label });
}

export function buildDepartmentCards(rows: EmployeeRow[], placeholders: SchedulerPlaceholder[]): DepartmentCard[] {
  const byKey = new Map<string, DepartmentCard>();
  for (const r of rows) {
    const group = resolveEmployeeGroup(r);
    if (!group) continue; // hidden department (Operations/Unassigned) — still counted upstream, no card
    let card = byKey.get(group.key);
    if (!card) {
      card = { ...group, people: [], placeholders: [] };
      byKey.set(group.key, card);
    }
    card.people.push(r);
  }
  // Placeholders slot into an EXISTING card by discipline code — a
  // placeholder for a discipline with nobody real in it yet still deserves
  // to be seen (that's the point of a placeholder), so this runs after the
  // people loop and can create a card with zero real members.
  for (const p of placeholders) {
    let card = byKey.get(p.discipline);
    if (!card) {
      const group = resolvePlaceholderGroup(p);
      if (!group) continue;
      card = { ...group, people: [], placeholders: [] };
      byKey.set(group.key, card);
    }
    card.placeholders.push(p);
  }
  return [...byKey.values()]
    .sort((a, b) => compareGroupOrder(a.key, b.key))
    .map((c) => ({
      ...c,
      // Leadership first (2026-10-02), then the ★ lead, then by position code
      // so people with the same code sit together (2026-10-05, replacing
      // Scheduler's sort_order), then name.
      people: [...c.people].sort(
        (a, b) =>
          Number(b.isLeadership ?? false) - Number(a.isLeadership ?? false) ||
          Number(b.isLead) - Number(a.isLead) ||
          comparePositionCode(a, b),
      ),
    }));
}
