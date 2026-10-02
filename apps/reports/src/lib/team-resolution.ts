import { DISCIPLINE_LABEL } from "@/lib/disciplines";
import { codeKey, mergePositionFamilies, LEADERSHIP_FAMILY, type PositionFamilyRow } from "@/lib/position-families-parse";

// ── Which team each person belongs on (2026-10-02) ──────────────────────────
//
// Pure: people and the PositionFamily rows in, a proposed team per person out.
// Unit-tested in tests/team-resolution.test.ts. Settled with the user against
// the 2 Oct 2026 roster, drawn as the "SDC Team Branches" chart:
//
//   1. Leadership — anyone whose position code is in family 100 — keeps the
//      team they have. 100 is a level, not a department: the CFO belongs on
//      Finance and the VP of Operations on Operations.
//   2. Everyone else takes the team of their BRANCH HEAD: follow "reports to"
//      upward until the next person is Leadership (or there is no one above).
//      The person reached heads the branch, and their family sets the team for
//      everyone under them. People sit with the branch they report into, so a
//      Service Technician under the Service Engineering Manager is on Service
//      whatever their own code says.
//   3. A position code in several families: 500 (Service) wins, otherwise the
//      lowest family code — so IC (107 and 404) is 107.
//   4. Branch head with no family: the person's own family decides. Neither
//      has one: no proposal, and the team is left as it is.
//
// Nothing here writes. The Org Chart page shows these proposals and what would
// change; the roster sync applies them once that is switched on.

/** Family → team code (Employee.team's vocabulary; see lib/disciplines.ts). */
export const FAMILY_TEAM: Readonly<Record<string, string>> = {
  "102": "growth", //   Marketing
  "103": "hr", //       Human Resources
  "104": "finance", //  Finance
  "105": "sales", //    Sales
  "106": "pm", //       Project Management
  "107": "ops", //      Procurement
  "108": "ai", //       AI + Internal Processes
  "201": "mech", //     Mechanical Engineering
  "301": "controls", // Electrical Controls Engineering
  "401": "build", //    Mechanical Assembly
  "402": "wire", //     Electrical Assembly
  "404": "mfgops", //   Manufacturing Operations
  "500": "service", //  Service
};

/** Display names for team codes: the shared labels, plus HR, which Scheduler has no bucket for. */
export const TEAM_NAME: Readonly<Record<string, string>> = { ...DISCIPLINE_LABEL, hr: "Human Resources" };

const SERVICE_FAMILY = "500";

/** The one family that decides for a code listed under several. */
export function pickFamily(familyCodes: string[]): string | null {
  if (!familyCodes.length) return null;
  if (familyCodes.includes(SERVICE_FAMILY)) return SERVICE_FAMILY;
  return [...familyCodes].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))[0];
}

export type TeamPerson = {
  id: number;
  name: string;
  positionCode: string | null;
  supervisorId: number | null;
  /** The team stored today (Employee.team). */
  team: string | null;
};

export type TeamResolution = {
  leader: boolean;
  /** The person's own deciding family, or null when their code has none. */
  family: string | null;
  /** FAMILY_TEAM of that family. */
  ownTeam: string | null;
  /** The top of their branch (themselves when they report straight to Leadership); null for Leadership. */
  branchHeadId: number | null;
  /** The team the rule gives them; null = leave the stored team alone. */
  proposedTeam: string | null;
  /** Where the proposal came from. */
  how: "leader" | "branch" | "own" | "none";
};

export function resolveTeams(people: TeamPerson[], rows: PositionFamilyRow[]): Map<number, TeamResolution> {
  const families = mergePositionFamilies(rows);
  const byId = new Map(people.map((p) => [p.id, p]));
  const familyOf = (p: TeamPerson): string[] => (p.positionCode ? (families.get(codeKey(p.positionCode))?.families.map((f) => f.code) ?? []) : []);
  const isLeader = (p: TeamPerson) => familyOf(p).includes(LEADERSHIP_FAMILY);
  const decidingFamily = (p: TeamPerson) => pickFamily(familyOf(p).filter((f) => f !== LEADERSHIP_FAMILY));

  const out = new Map<number, TeamResolution>();
  for (const p of people) {
    const family = decidingFamily(p);
    const ownTeam = family ? (FAMILY_TEAM[family] ?? null) : null;
    if (isLeader(p)) {
      out.set(p.id, { leader: true, family, ownTeam, branchHeadId: null, proposedTeam: p.team, how: "leader" });
      continue;
    }
    // Up the reporting line until the next person is Leadership or missing.
    // `seen` stops a supervisor loop in the data from spinning forever.
    let head = p;
    const seen = new Set([p.id]);
    for (;;) {
      const sup = head.supervisorId != null ? byId.get(head.supervisorId) : undefined;
      if (!sup || isLeader(sup) || seen.has(sup.id)) break;
      seen.add(sup.id);
      head = sup;
    }
    const headFamily = decidingFamily(head);
    const headTeam = headFamily ? (FAMILY_TEAM[headFamily] ?? null) : null;
    const proposedTeam = headTeam ?? ownTeam;
    out.set(p.id, {
      leader: false,
      family,
      ownTeam,
      branchHeadId: head.id,
      proposedTeam,
      how: headTeam ? "branch" : ownTeam ? "own" : "none",
    });
  }
  return out;
}

export type TeamChange = { id: number; name: string; from: string | null; to: string; reason: string };

/** What applying the proposals would change, for people shown in the app. */
export function pendingTeamChanges(
  people: (TeamPerson & { active: boolean })[],
  resolutions: Map<number, TeamResolution>,
): TeamChange[] {
  const byId = new Map(people.map((p) => [p.id, p]));
  const changes: TeamChange[] = [];
  for (const p of people) {
    const r = resolutions.get(p.id);
    if (!p.active || !r || r.leader || !r.proposedTeam || r.proposedTeam === p.team) continue;
    const head = r.branchHeadId != null ? byId.get(r.branchHeadId) : undefined;
    const reason =
      r.how === "own"
        ? "own position family (branch head has none)"
        : head && head.id !== p.id
          ? `branch of ${head.name}${r.ownTeam && r.ownTeam !== r.proposedTeam ? ` (own family says ${TEAM_NAME[r.ownTeam] ?? r.ownTeam})` : ""}`
          : "own position family";
    changes.push({ id: p.id, name: p.name, from: p.team, to: r.proposedTeam, reason });
  }
  return changes.sort((a, b) => a.name.localeCompare(b.name));
}
