import "server-only";
import { prisma } from "@/lib/prisma";
import { codeKey, mergePositionFamilies, type PositionFamilyRow } from "@/lib/position-families-parse";
import { resolveTeams, pendingTeamChanges, TEAM_NAME, type TeamChange } from "@/lib/team-resolution";
import { isPaylocityId as inPaylocity } from "@/lib/employee-row";

// ── The Org Chart page's data (2026-10-02) ──────────────────────────────────
//
// Builds the "SDC Team Branches" chart from live data: Leadership on top, then
// one band per leader with a card per team, each card the branch heads
// reporting to that leader and everyone under them. Teams are the PROPOSALS of
// lib/team-resolution.ts — what the roster sync will write once switched on —
// with the list of what would change alongside. Reads only.
//
// Active people only. Someone hidden is skipped, but their reports are still
// drawn, attached to the nearest shown manager above them.

export type OrgNode = {
  id: number;
  name: string;
  title: string | null;
  positionCode: string | null;
  team: string | null;
  /** Shown beside the name on hover: why this person isn't placed by their own family. */
  note: string | null;
  /** The position code's family comes from the overrides file. */
  override: boolean;
  /** Has someone reporting to them. */
  isHead: boolean;
  reports: OrgNode[];
};

export type OrgTeamCard = { team: string | null; name: string; people: number; heads: OrgNode[] };
export type OrgBand = { leader: { id: number; name: string; title: string | null }; people: number; cards: OrgTeamCard[] };

export type OrgChart = {
  /** False until the position families have been imported at least once. */
  ready: boolean;
  leaders: OrgNode[];
  leaderCount: number;
  bands: OrgBand[];
  /** Shown, not Leadership, with no leader above and no team from the rule. */
  unplaced: { id: number; name: string; title: string | null; detail: string }[];
  pending: (TeamChange & { fromName: string | null; toName: string })[];
};

const teamName = (t: string | null) => (t ? (TEAM_NAME[t] ?? t) : "No team");

// Cards in the order work moves through the teams, as on the Employees page,
// then the back office; "No team" last.
const CARD_ORDER = ["pm", "mech", "controls", "ai", "build", "wire", "service", "mfgops", "ops", "hr", "finance", "growth", "sales", "exec"];
const cardRank = (t: string | null) => (t === null ? CARD_ORDER.length + 1 : CARD_ORDER.indexOf(t) < 0 ? CARD_ORDER.length : CARD_ORDER.indexOf(t));

// Team label → code, for the display fallback below.
const TEAM_BY_LABEL = new Map(Object.entries(TEAM_NAME).map(([code, label]) => [label.toLowerCase(), code]));

export async function getOrgChart(): Promise<OrgChart> {
  const [employees, familyRows] = await Promise.all([
    prisma.employee.findMany({
      select: { id: true, name: true, paylocityId: true, positionTitle: true, positionCode: true, supervisorId: true, active: true, team: true, discipline: true },
    }),
    prisma.positionFamily.findMany({
      select: { positionCode: true, familyCode: true, familyName: true, title: true, headcount: true, source: true },
    }),
  ]);
  return buildOrgChart(employees, familyRows.map((r) => ({ ...r, source: r.source as PositionFamilyRow["source"] })));
}

export type OrgEmployee = {
  id: number;
  name: string;
  paylocityId: string | null;
  positionTitle: string | null;
  positionCode: string | null;
  supervisorId: number | null;
  active: boolean;
  team: string | null;
  /** The app's team label ("AI", "Mechanical Engineers") — a display fallback only. */
  discipline?: string | null;
};

/** The chart from people and family rows — pure, so it is testable without a database. */
export function buildOrgChart(employees: OrgEmployee[], rows: PositionFamilyRow[]): OrgChart {
  const families = mergePositionFamilies(rows);
  const res = resolveTeams(employees, rows);
  const byId = new Map(employees.map((e) => [e.id, e]));

  const reportsOf = new Map<number, typeof employees>();
  for (const e of employees) if (e.supervisorId != null) (reportsOf.get(e.supervisorId) ?? reportsOf.set(e.supervisorId, []).get(e.supervisorId)!).push(e);
  for (const list of reportsOf.values()) list.sort((a, b) => a.name.localeCompare(b.name));

  const isLeader = (id: number) => res.get(id)?.leader === true;

  // The rule's proposal, else the stored team, else — for display only, never
  // written — the app's discipline label (someone not in Paylocity with no code).
  const displayTeam = (e: OrgEmployee) =>
    res.get(e.id)?.proposedTeam ?? e.team ?? TEAM_BY_LABEL.get(e.discipline?.trim().toLowerCase() ?? "") ?? null;

  function noteFor(e: (typeof employees)[number]): string | null {
    const r = res.get(e.id);
    if (!r || r.leader) return null;
    if (!inPaylocity(e.paylocityId)) {
      const sup = e.supervisorId != null ? byId.get(e.supervisorId) : undefined;
      return sup ? `Not in Paylocity · supervisor set here: ${sup.name}` : "Not in Paylocity · no supervisor set yet";
    }
    if (r.how === "branch" && r.ownTeam && r.ownTeam !== r.proposedTeam) return `Placed by reporting line · own family says ${teamName(r.ownTeam)}`;
    if (r.how === "branch" && !e.positionCode && e.supervisorId != null) return "Placed by reporting line · no position code in Paylocity";
    return null;
  }

  // Shown reports, with a hidden manager's own reports lifted to the nearest shown one.
  function shownReports(id: number, seen = new Set<number>()): typeof employees {
    if (seen.has(id)) return [];
    seen.add(id);
    return (reportsOf.get(id) ?? []).flatMap((r) => (r.active ? [r] : shownReports(r.id, seen)));
  }

  function node(e: (typeof employees)[number], onlyLeaders: boolean, seen = new Set<number>()): OrgNode {
    seen.add(e.id);
    const kids = shownReports(e.id).filter((k) => isLeader(k.id) === onlyLeaders && !seen.has(k.id));
    const r = res.get(e.id);
    return {
      id: e.id,
      name: e.name,
      title: e.positionTitle?.trim() || null,
      positionCode: e.positionCode,
      team: displayTeam(e),
      note: noteFor(e),
      override: !!e.positionCode && families.get(codeKey(e.positionCode))?.source === "override",
      isHead: kids.length > 0,
      reports: kids.map((k) => node(k, onlyLeaders, seen)),
    };
  }
  const count = (n: OrgNode): number => 1 + n.reports.reduce((s, k) => s + count(k), 0);

  const shown = employees.filter((e) => e.active);
  const leaders = shown.filter((e) => isLeader(e.id));
  const leaderIds = new Set(leaders.map((l) => l.id));
  // Leadership as its own tree: a leader is a root when nobody shown above them is Leadership.
  const leaderRoots = leaders
    .filter((l) => l.supervisorId == null || !leaderIds.has(l.supervisorId))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((l) => node(l, true));

  // Bands in the leadership tree's own order (top down), then any other leader.
  const ordered: typeof leaders = [];
  const walk = (n: OrgNode) => { ordered.push(byId.get(n.id)!); n.reports.forEach(walk); };
  leaderRoots.forEach(walk);

  const bands: OrgBand[] = [];
  for (const L of ordered) {
    const heads = shownReports(L.id).filter((h) => !isLeader(h.id)).map((h) => node(h, false));
    if (!heads.length) continue;
    const byTeam = new Map<string | null, OrgNode[]>();
    for (const h of heads) (byTeam.get(h.team) ?? byTeam.set(h.team, []).get(h.team)!).push(h);
    const cards = [...byTeam].map(([team, hs]) => ({ team, name: teamName(team), people: hs.reduce((s, h) => s + count(h), 0), heads: hs }));
    cards.sort((a, b) => cardRank(a.team) - cardRank(b.team) || a.name.localeCompare(b.name));
    bands.push({ leader: { id: L.id, name: L.name, title: L.positionTitle?.trim() || null }, people: cards.reduce((s, c) => s + c.people, 0), cards });
  }

  // Shown people the bands don't reach: no Leadership anywhere above them.
  const drawn = new Set<number>();
  const mark = (n: OrgNode) => { drawn.add(n.id); n.reports.forEach(mark); };
  bands.forEach((b) => b.cards.forEach((c) => c.heads.forEach(mark)));
  leaderRoots.forEach(mark);
  const unplaced = shown
    .filter((e) => !drawn.has(e.id))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => ({
      id: e.id,
      name: e.name,
      title: e.positionTitle?.trim() || null,
      detail: !inPaylocity(e.paylocityId) ? "Not in Paylocity — set a supervisor on the Employees page" : e.supervisorId == null ? "No supervisor in Paylocity" : "No Leadership above them",
    }));

  const pending = pendingTeamChanges(employees, res).map((c) => ({ ...c, fromName: c.from ? teamName(c.from) : null, toName: teamName(c.to) }));

  return {
    ready: rows.length > 0,
    leaders: leaderRoots,
    leaderCount: leaders.length,
    bands,
    unplaced,
    pending,
  };
}
