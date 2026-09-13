// The Employees tab's top-level grouping (2026-08-19, by request): three
// workforce categories sitting ABOVE the existing seven delivery-team
// department cards — Engineering / Shop / PM — plus a catch-all "Other" for
// everything a department card already covers today that isn't one of those
// three (Growth, Finance, Sales, Executive Leadership, and any raw department
// string with no team at all). Nothing here reads an employee directly: it
// only classifies a department CARD's own key (employee-card-theme.ts's
// `EmployeeGroup.key` — a team's `schedulerCode`, or a raw department/"Other"
// key for anything else) into one of the four buckets, so there is exactly
// one department→card resolution in the app (resolveEmployeeGroup) and this
// is purely a second, coarser tier over its output — never a second
// classification of the same employee.

export type WorkforceGroupKey =
  | "engineering"
  | "genEng"
  | "shop"
  | "pm"
  | "growth"
  | "finance"
  | "exec"
  | "operations"
  | "other";

export type WorkforceGroupDef = {
  key: WorkforceGroupKey;
  title: string;
  /** Spelled-out name, for the in-place group header only ("PM" the card, "Project Management" the heading above its departments). Defaults to `title`. */
  longTitle?: string;
  // employee-teams.ts's `schedulerCode` values that belong to this group.
  // "other" has none listed — it is whatever no other group claims.
  teamCodes: string[];
  /**
   * Card keys that are NOT delivery-team scheduler codes (2026-08-24).
   *
   * The four groups added below are back-office departments, which by
   * definition have no `schedulerCode` — Scheduler doesn't schedule work
   * through them, so employee-teams.ts has no entry for them and
   * resolveEmployeeGroup() gives their cards a raw key instead
   * ("growth", "sales", "finance", "exec", "operations"). Kept as a separate
   * field from `teamCodes` so the existing "no team code is claimed by two
   * groups" invariant still means what it says, and so it stays obvious which
   * keys are Scheduler's vocabulary and which are this app's own.
   */
  cardKeys?: string[];
  /**
   * Aggregates into this group for group-level totals (2026-08-24).
   *
   * General Engineering is a separate, selectable workforce group for HIRING —
   * it gets its own option in the Create/Edit Position form and its own section
   * in the Hiring Positions list — while every Engineering-level total counts it
   * as Engineering: "Engineering Total = Engineering + General Engineering".
   *
   * A rollup rather than simply making it an Engineering department, because the
   * request needs both halves: separately selectable AND summed. And a rollup
   * rather than special-casing "genEng" at each total, because the summing sites
   * then never name it — they call rollupGroup() and stay correct if another
   * group is ever rolled up the same way.
   */
  rollsUpTo?: WorkforceGroupKey;
};

// ── The company's departments, as seven cards (2026-08-24, by request) ──────
//
// Was Engineering / Shop / PM + an "Other" catch-all that swept Growth,
// Sales, Finance and Executive Leadership together, and hid Operations
// entirely (employee-card-theme.ts's HIDDEN_DEPARTMENT_CARDS returned null for
// it, so that person appeared on no card at all). Every real department now has
// its own card, and the mapping below is the requested one exactly.
//
// Two rules from the request worth stating here, because both are the opposite
// of what the department names suggest:
//   * Service Engineering does NOT get its own card — it counts under
//     Engineering (team code "service").
//   * Manufacturing Operations does NOT get its own card, and is NOT the same
//     thing as Operations — it counts under Shop (team code "mfgops"), while
//     "Operations" is a separate one-person back-office department with its
//     own card.
//
// Sales is likewise not a card at this level: it is a DEPARTMENT card one level
// down, inside Growth / Business Development, which is where the request puts
// it. So Growth's card claims two card keys, "growth" (which
// employee-card-theme.ts already folds "Growth / Business Development" and
// "Business Development" into) and "sales".
//
// Counts these produce against the roster of 2026-08-24 — asserted in
// tests/employee-workforce-groups.test.ts so a mapping change that moves
// somebody fails there rather than silently on screen:
//   Engineering 27 · Shop 29 · PM 4 · Growth 9 · Finance 4 · Exec 5 · Operations 1
export const WORKFORCE_GROUPS: WorkforceGroupDef[] = [
  { key: "engineering", title: "Engineering", teamCodes: ["mech", "controls", "service"] },
  // Rolls up into Engineering for totals; stays its own group for hiring
  // selection and display. Its single department is "geneng"
  // (employee-teams.ts), which no employee can currently resolve to — this
  // group exists for openings, not for moving anybody.
  { key: "genEng", title: "General Engineering", teamCodes: ["geneng"], rollsUpTo: "engineering" },
  { key: "shop", title: "Shop", teamCodes: ["build", "wire", "mfgops"] },
  { key: "pm", title: "PM", longTitle: "Project Management", teamCodes: ["pm"] },
  { key: "growth", title: "Growth / Business Development", teamCodes: [], cardKeys: ["growth", "sales"] },
  { key: "finance", title: "Finance", teamCodes: [], cardKeys: ["finance"] },
  { key: "exec", title: "Executive Leadership", teamCodes: [], cardKeys: ["exec"] },
  { key: "operations", title: "Operations", teamCodes: [], cardKeys: ["operations"] },
  // Still last, and still a real destination: a department string nobody has
  // mapped yet (a new Paylocity department, say) must land SOMEWHERE, or the
  // people in it would vanish from the tab. It renders no card when empty —
  // see WorkforceSummaryCards' own filter — so on today's data it is invisible.
  { key: "other", title: "Other", teamCodes: [] },
];

const GROUP_BY_CARD_KEY = new Map<string, WorkforceGroupKey>();
for (const g of WORKFORCE_GROUPS) {
  for (const code of g.teamCodes) GROUP_BY_CARD_KEY.set(code, g.key);
  for (const code of g.cardKeys ?? []) GROUP_BY_CARD_KEY.set(code.toLowerCase(), g.key);
}

/**
 * Which workforce group a department CARD belongs to, by the card's own key
 * (resolveEmployeeGroup()'s output — a team's schedulerCode for one of the
 * seven delivery teams, or a raw department/"growth"/"finance"/... key for
 * everything else). Anything not one of the nine listed team codes falls to
 * "other" — this is the one place that catch-all is decided, so a department
 * newly added to employee-teams.ts automatically lands in the right
 * workforce group the moment its schedulerCode is added to WORKFORCE_GROUPS
 * above, with no second lookup table to keep in sync.
 */
export function workforceGroupForCardKey(cardKey: string): WorkforceGroupKey {
  // Team codes are already lowercase by construction; the non-team card keys
  // are matched case-insensitively for the same reason employee-teams.ts
  // matches its department strings that way — they originate in Paylocity
  // data, not in code.
  return GROUP_BY_CARD_KEY.get(cardKey) ?? GROUP_BY_CARD_KEY.get(cardKey.toLowerCase()) ?? "other";
}

export function workforceGroupTitle(key: WorkforceGroupKey): string {
  return WORKFORCE_GROUPS.find((g) => g.key === key)?.title ?? "Other";
}

/**
 * The group heading shown above its departments once a workforce card is
 * opened in place. Same string as workforceGroupTitle() for every group but
 * PM, whose card abbreviation reads oddly as a section heading.
 */
export function workforceGroupLongTitle(key: WorkforceGroupKey): string {
  const def = WORKFORCE_GROUPS.find((g) => g.key === key);
  return def?.longTitle ?? def?.title ?? "Other";
}

// ── Team scope: Entire Team vs Execution Team (2026-08-24, by request) ──────
//
// A view switch on the Employees tab, not a second dataset: "Execution Team"
// narrows to the three groups that actually execute project work — Engineering,
// Shop and PM — and "Entire Team" is everything, including the back-office
// groups added earlier the same day.
//
// The execution set is DERIVED, not a fourth hand-written list of group keys.
// A group belongs to it exactly when it owns delivery-team codes: `teamCodes`
// holds employee-teams.ts's seven schedulerCodes and only the three execution
// groups have any, while the back-office groups carry `cardKeys` instead
// (they are real departments, just not teams Scheduler schedules work through)
// and "other" carries neither.
//
// That derivation is the point. Engineering/Shop/PM already have exactly one
// definition of which departments they contain, and this reuses it rather than
// restating it — so adding Service Engineering to Engineering, or a new
// delivery team to Shop, lands in Execution Team automatically with nothing
// here to keep in sync. A literal ["engineering", "shop", "pm"] would be a
// second source of truth that could silently disagree with the first.
export type TeamScope = "entire" | "execution";

export const DEFAULT_TEAM_SCOPE: TeamScope = "entire";

/** Human label for the toggle. */
export const TEAM_SCOPE_LABEL: Record<TeamScope, string> = {
  entire: "Entire Team",
  execution: "Execution Team",
};

export const EXECUTION_GROUP_KEYS: readonly WorkforceGroupKey[] = WORKFORCE_GROUPS.filter((g) => g.teamCodes.length > 0).map((g) => g.key);

const EXECUTION_SET = new Set<WorkforceGroupKey>(EXECUTION_GROUP_KEYS);

/** Whether a workforce group is part of the Execution Team. */
export function isExecutionGroup(key: WorkforceGroupKey): boolean {
  return EXECUTION_SET.has(key);
}

/**
 * Whether a workforce group should be shown/counted under the given scope.
 * "entire" admits everything, which is what makes this safe to call
 * unconditionally at every filter site instead of branching on the scope there.
 */
export function groupInScope(key: WorkforceGroupKey, scope: TeamScope): boolean {
  return scope === "entire" || isExecutionGroup(key);
}

// ── Canonical department order (2026-08-31) ─────────────────────────────────
//
// Every department card key in ONE business order, derived from the two
// declarations that already encode it: WORKFORCE_GROUPS top to bottom, and
// within each group its own `teamCodes` / `cardKeys` in the order they are
// written. Both of those orders are deliberate already — WORKFORCE_GROUPS runs
// Engineering → Shop → PM → back office, and employee-teams.ts's codes run in
// the order work moves through the teams — so this restates nothing.
//
// Used for any list that needs EVERY department in a sensible business order —
// today the Employee Utilization panel's department selector.
//
// NOT the source for the Dashboard's Engineering & Shop Utilization card. That
// card follows the ETC tab's own column order, derived in
// lib/etc-capacity-departments.ts, because the ETC structure is a statement
// about which departments book ETC hours rather than about how the company is
// organised. The two agree on the relative order of every department they share
// — asserted in tests/etc-capacity-departments.test.ts — but they are different
// questions and must not be collapsed into one list.
//
// A key not listed here ranks last rather than being dropped, so a brand-new
// Paylocity department string still renders — at the bottom, where it is visible
// as something nobody has classified yet.
export const DEPARTMENT_CARD_ORDER: readonly string[] = WORKFORCE_GROUPS.flatMap((g) => [
  ...g.teamCodes,
  ...(g.cardKeys ?? []),
]);

const DEPARTMENT_CARD_RANK = new Map(DEPARTMENT_CARD_ORDER.map((key, i) => [key, i]));

/** Position of a department card key in the canonical business order. Unlisted keys rank last. */
export function departmentCardOrderRank(cardKey: string): number {
  return (
    DEPARTMENT_CARD_RANK.get(cardKey) ??
    DEPARTMENT_CARD_RANK.get(cardKey.toLowerCase()) ??
    Number.MAX_SAFE_INTEGER
  );
}

// ── Rollup: which group a total should credit (2026-08-24) ──────────────────
//
// Identity for every group except General Engineering, which credits
// Engineering. Call this at any site that AGGREGATES — hiring counts, capacity
// hours, planning KPIs — and NOT at sites that display a position's own group
// (the Create/Edit form's options, the Hiring Positions list's sections), which
// must keep General Engineering visibly separate.
//
// That split is the whole design: `rollupGroup` for arithmetic, the raw
// `workforceGroup` for identity.
export function rollupGroup(key: WorkforceGroupKey): WorkforceGroupKey {
  return WORKFORCE_GROUPS.find((g) => g.key === key)?.rollsUpTo ?? key;
}

/**
 * Every group that rolls INTO the given one, including itself — so
 * "Engineering" answers [engineering, genEng] and everything else answers just
 * itself. Lets a caller filter a list by "is this mine, counting rollups"
 * without knowing which groups roll up where.
 */
export function groupsRollingInto(key: WorkforceGroupKey): WorkforceGroupKey[] {
  return WORKFORCE_GROUPS.filter((g) => g.key === key || g.rollsUpTo === key).map((g) => g.key);
}
