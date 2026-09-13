import { resolveEmployeeGroup, compareGroupOrder, type EmployeeGroup } from "@/lib/employee-card-theme";
import { DISCIPLINE_LABEL } from "@/lib/disciplines";
import type { SchedulerPlaceholder } from "@/lib/scheduler-db";
import type { EmployeeRow } from "@/lib/employee-row";

// The one place that turns a filtered employee-row list (+ Scheduler
// placeholders) into the Employees tab's department cards — pulled out of
// EmployeesCards.tsx (2026-08-19) so the new workforce-group summary level
// can compute the SAME cards (for its department line items and counts)
// without a second, drifting copy of this grouping/sorting logic. Pure and
// React-free, so it's directly unit-testable and safe to call from a
// server component if that's ever useful.

export type DepartmentCard = EmployeeGroup & { people: EmployeeRow[]; placeholders: SchedulerPlaceholder[] };

// Which card a placeholder belongs to — department/discipline (labels), not
// just team (code): matchesGrowth and the Finance/Sales/Exec matchers in
// resolveEmployeeGroup() key off the LABEL, not the code — team alone only
// resolves the seven delivery teams, which is all it needs to for real
// employee rows, but a placeholder in Growth/Finance/Sales/Exec would fall
// through to a raw-code bucket without this. Exported so EmployeesGrid.tsx's
// drill-down scoping can classify a placeholder the same way this file does,
// rather than re-deriving it.
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
      // Matches Scheduler's own card order: lead first, then sort_order,
      // then name. Someone with no Scheduler match at all (sortOrder null)
      // sorts after everyone who has one — not yet reconciled, not yet
      // ordered.
      people: [...c.people].sort(
        (a, b) =>
          Number(b.isLead) - Number(a.isLead) ||
          (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity) ||
          a.name.localeCompare(b.name),
      ),
    }));
}
