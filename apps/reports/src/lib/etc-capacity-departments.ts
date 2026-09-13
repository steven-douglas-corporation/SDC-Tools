import { ETC_SECTIONS } from "@/lib/sections";
import { departmentFor } from "@/lib/hours-operational-grouping";
import { EMPLOYEE_TEAMS } from "@/lib/employee-teams";

// ── The ETC tab's own department structure, as roster departments ───────────
//
// One question, answered once: which departments does the ETC/execution
// workflow actually cover, and in what order does the ETC tab show them?
//
// The answer is DERIVED from the ETC grid's own column definitions
// (sections.ts's ETC_SECTIONS), not restated. Phase "Complete Design & Build"
// (section 10) is the phase whose columns are per-department — the later phases
// (40 Machine Testing, 50 Teardown & Install) split only into Engineering / Shop
// and carry no department breakdown, so they contribute no departments here.
//
// Today that yields, in this exact order:
//
//   Engineering   1. Mechanical Engineering   (10-211)
//                 2. Controls Engineering     (10-312, 10-313)
//                 3. General Engineering      (10-515 … 10-518)
//   Shop          4. Mechanical Build         (10-411)
//                 5. Electrical Build         (10-412)
//
// ── What is NOT here, and why that is the ETC tab's decision, not ours ──────
//
//   * PM. The ETC grid has no 10-111 column at all — sections.ts's
//     ETC_EXCLUDED_CODES drops it, "confirmed by decoding the real 'Managers
//     Fill Out' sheet". PM signs off an ETC month (etc-departments.ts) but books
//     no ETC hours, so it is not part of this capacity structure.
//   * Manufacturing Operations. Same reason — 10-413 is excluded from the ETC
//     grid by that same set.
//   * Service Engineering. No section-10 column, and etc-departments.ts states
//     it outright: "MFG and Service do not sign off an ETC month".
//
// So if the ETC sheet ever gains a PM or Manufacturing column, this list grows
// with it on the next build and the Dashboard follows. There is nothing here to
// remember to update, which is the whole point.
//
// ── Wire ────────────────────────────────────────────────────────────────────
//
// There is no separate Wire department to include. 10-412 is "Electrical
// Build", and this app's roster folds Machine Wiring INTO that team — see
// employee-teams.ts (the `wire` team owns both "Electrical Build" and "Machine
// Wiring" department strings) and etc-departments.ts, whose sign-off box for it
// is literally labelled "Electrical Build and Machine Wiring". Wiring people are
// therefore counted, under Electrical Build; a sixth row would be double
// counting them.
//
// ── Why not a team/group filter ─────────────────────────────────────────────
//
// This deliberately does NOT go through employee-workforce-groups.ts's
// Engineering/Shop/PM grouping or its EXECUTION_GROUP_KEYS. Those answer "how is
// the company organised", and the answers differ from the ETC structure in both
// directions: the execution scope includes PM, Service and Manufacturing
// Operations (none of which the ETC grid has a column for), and Shop's
// membership in an Operations organisation is irrelevant to whether Mechanical
// Build books ETC hours. Filtering by organisation is what produced the wrong
// card twice — once keeping the back office, once dropping the whole Shop.

/** The ETC grid phase whose columns are per-department. The later phases split only into Engineering / Shop. */
const DEPARTMENT_PHASE = "Complete Design & Build";

type EtcCapacityDepartment = {
  /** The department card key (employee-teams.ts's schedulerCode) — what a utilization row is keyed by. */
  cardKey: string;
  /** The department's name, identical in the ETC grid and on the roster. */
  name: string;
  /** "Engineering" or "Shop", straight from the ETC grid's own billing group. */
  billingGroup: "Engineering" | "Shop";
  /** The ETC section codes that feed this department, for traceability. */
  sectionCodes: string[];
};

function build(): EtcCapacityDepartment[] {
  const out: EtcCapacityDepartment[] = [];
  const byName = new Map<string, EtcCapacityDepartment>();

  for (const section of ETC_SECTIONS) {
    if (section.phase !== DEPARTMENT_PHASE) continue;
    const name = departmentFor(section.code);

    const existing = byName.get(name);
    if (existing) {
      // Controls Engineering arrives twice (10-312, 10-313) and General
      // Engineering four times. One row each, in the order first seen — which is
      // the ETC grid's left-to-right column order.
      existing.sectionCodes.push(section.code);
      continue;
    }

    // The bridge from the ETC grid's department name to the roster's department
    // card. An exact name match on employee-teams.ts, NOT a hand-written table:
    // the two vocabularies genuinely agree on all five of these names, and
    // matching on it means a rename in one place cannot leave a stale mapping in
    // another — it throws instead.
    const team = EMPLOYEE_TEAMS.find((t) => t.name === name);
    if (!team) {
      // Loud at import time, on purpose. A silently dropped department is a
      // missing row and a wrong total, and this is exactly the failure that is
      // invisible on screen — the card just looks like it has one fewer team.
      throw new Error(
        `etc-capacity-departments.ts: ETC section ${section.code} maps to department "${name}", ` +
          `which matches no EMPLOYEE_TEAMS entry. Add the team, or align the names.`,
      );
    }

    const entry: EtcCapacityDepartment = {
      cardKey: team.schedulerCode,
      name,
      billingGroup: section.billingGroup,
      sectionCodes: [section.code],
    };
    byName.set(name, entry);
    out.push(entry);
  }

  if (out.length === 0) {
    throw new Error("etc-capacity-departments.ts: no ETC department columns found — did the phase label change?");
  }
  return out;
}

/**
 * The ETC tab's departments, in the ETC tab's own column order. Engineering
 * block first, then Shop, because that is how ETC_SECTIONS is declared.
 */
export const ETC_CAPACITY_DEPARTMENTS: readonly EtcCapacityDepartment[] = build();

/** Just the card keys, in ETC order — the order the Dashboard's utilization rows use. */
export const ETC_CAPACITY_CARD_KEYS: readonly string[] = ETC_CAPACITY_DEPARTMENTS.map((d) => d.cardKey);

const RANK = new Map(ETC_CAPACITY_CARD_KEYS.map((key, i) => [key, i]));

/**
 * Whether a department card key is part of the ETC capacity structure.
 *
 * Takes the card key that resolveEmployeeGroup() already produces for every
 * employee and department row, so no caller has to re-derive a department from a
 * raw Paylocity string. Anything unmapped — a back-office department, a brand-new
 * department string, the no-department bucket — is false.
 */
export function isEtcCapacityCardKey(cardKey: string): boolean {
  return RANK.has(cardKey);
}

/** Position in the ETC tab's column order. Unlisted keys rank last rather than being reordered into the middle. */
export function etcCapacityOrderRank(cardKey: string): number {
  return RANK.get(cardKey) ?? Number.MAX_SAFE_INTEGER;
}

/** "Engineering" / "Shop" for one of these departments, from the ETC grid's own billing group. Null if not one of them. */
export function etcCapacityBillingGroup(cardKey: string): "Engineering" | "Shop" | null {
  return ETC_CAPACITY_DEPARTMENTS.find((d) => d.cardKey === cardKey)?.billingGroup ?? null;
}
