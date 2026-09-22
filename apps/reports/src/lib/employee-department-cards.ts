import { resolveEmployeeGroup, compareGroupOrder, type EmployeeGroup } from "@/lib/employee-card-theme";
import { DISCIPLINE_LABEL } from "@/lib/disciplines";
import { EMPLOYEE_TEAMS } from "@/lib/employee-teams";
import { rollupGroup, workforceGroupForCardKey, type WorkforceGroupKey } from "@/lib/employee-workforce-groups";
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

/** schedulerCodes of teams whose card must render even with nobody on it yet — see EmployeeTeam.alwaysShowCard. */
export const ALWAYS_SHOW_CARD_KEYS: readonly string[] = EMPLOYEE_TEAMS.filter((t) => t.alwaysShowCard).map((t) => t.schedulerCode);

/**
 * The subset of ALWAYS_SHOW_CARD_KEYS that belongs to one workforce-group
 * SECTION of the Employees tab (2026-09-22) — e.g. "engineering" for "ai".
 *
 * EmployeesGrid.tsx renders one EmployeesCards per section, each scoped to
 * that section's own rows/placeholders. Passing the FULL, unfiltered
 * ALWAYS_SHOW_CARD_KEYS to every section would inject the same empty card
 * (AI) into every one of them — PM, Shop, Growth, Finance… — not just
 * Engineering. This uses the exact same rollupGroup(workforceGroupForCardKey())
 * mapping EmployeesGrid's own `groupOf` uses for real rows, so "which section
 * does this always-show key belong to" can never disagree with "which section
 * does an actual employee of that team land in".
 */
export function alwaysShowKeysForGroup(groupKey: WorkforceGroupKey): string[] {
  return ALWAYS_SHOW_CARD_KEYS.filter((code) => rollupGroup(workforceGroupForCardKey(code)) === groupKey);
}

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

/**
 * `alwaysShow` (2026-09-22) — schedulerCodes to render a card for even when
 * empty, e.g. ALWAYS_SHOW_CARD_KEYS above. Defaults to none, so every
 * existing caller (and every test in employee-department-cards.test.ts, which
 * asserts exact card counts for plain rows/placeholders input) is unaffected
 * unless it opts in. The real Employees tab passes ALWAYS_SHOW_CARD_KEYS;
 * nothing else needs to.
 */
export function buildDepartmentCards(rows: EmployeeRow[], placeholders: SchedulerPlaceholder[], alwaysShow: readonly string[] = []): DepartmentCard[] {
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
  // Force-included empty cards, opted in via `alwaysShow` — after the two
  // loops above, so a team that DOES have a real person or placeholder keeps
  // that populated card rather than being overwritten by an empty stand-in.
  for (const key of alwaysShow) {
    if (byKey.has(key)) continue;
    const group = resolveEmployeeGroup({ team: key });
    if (!group) continue;
    byKey.set(key, { ...group, people: [], placeholders: [] });
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
