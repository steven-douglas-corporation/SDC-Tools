import "server-only";
import { prisma } from "@/lib/prisma";
import { codeKey, mergePositionFamilies, type PositionFamilyRow } from "@/lib/position-families-parse";
import { resolveTeams, pendingTeamChanges, type TeamChange } from "@/lib/team-resolution";
import { TEAM_NAME, TEAM_CODES } from "@/lib/team-names";
import { isPaylocityId as inPaylocity, comparePositionCode } from "@/lib/employee-row";

// ── The Org Chart page's data (2026-10-02) ──────────────────────────────────
//
// Builds the "SDC Team Branches" chart from live data: Leadership on top, then
// one band per leader with a card per team, each card the branch heads
// reporting to that leader and everyone under them. Teams are the PROPOSALS of
// lib/team-resolution.ts — what the roster sync will write once switched on —
// with the list of what would change alongside. Reads only.
//
// Active people only, unless `includeInactive` (the page's "Show inactive"). Someone
// hidden is skipped, but their reports are still drawn, attached to the nearest
// shown manager above them. With inactive people included nobody is skipped, so
// everyone sits under their own manager; counts still say how many are active, so
// the "N active" figures and the capacity hours built on them don't move.

export type OrgNode = {
  id: number;
  name: string;
  title: string | null;
  positionCode: string | null;
  /** False for someone hidden — only ever drawn with `includeInactive`. */
  active: boolean;
  team: string | null;
  /** Shown beside the name on hover: why this person isn't placed by their own family. */
  note: string | null;
  /** The position code's family comes from the overrides file. */
  override: boolean;
  /** Team set by hand and different from the reporting line: shown in its own section on the card. */
  byHand: boolean;
  /** Has someone reporting to them. */
  isHead: boolean;
  reports: OrgNode[];
};

/** `people` is everyone drawn; `active` is the active ones among them (the same number unless inactive people are included). */
export type OrgTeamCard = { team: string | null; name: string; people: number; active: number; heads: OrgNode[] };
export type OrgBand = { leader: { id: number; name: string; title: string | null }; people: number; active: number; cards: OrgTeamCard[] };

export type OrgChart = {
  /** False until the position families have been imported at least once. */
  ready: boolean;
  leaders: OrgNode[];
  leaderCount: number;
  /** The active leaders among `leaderCount`. */
  leaderActive: number;
  bands: OrgBand[];
  /** Shown, not Leadership, with no leader above and no team from the rule. */
  unplaced: { id: number; name: string; title: string | null; detail: string; active: boolean }[];
  pending: (TeamChange & { fromName: string | null; toName: string })[];
};

const teamName = (t: string | null) => (t ? (TEAM_NAME[t] ?? t) : "No team");

// Cards in the order work moves through the teams, as on the Employees page,
// then the back office; "No team" last.
const cardRank = (t: string | null) => (t === null ? TEAM_CODES.length + 1 : TEAM_CODES.indexOf(t) < 0 ? TEAM_CODES.length : TEAM_CODES.indexOf(t));

// Team label → code, for the display fallback below.
const TEAM_BY_LABEL = new Map(Object.entries(TEAM_NAME).map(([code, label]) => [label.toLowerCase(), code]));

export async function getOrgChart(): Promise<OrgChart> {
  const [employees, familyRows] = await Promise.all([
    prisma.employee.findMany({
      select: { id: true, name: true, paylocityId: true, positionTitle: true, positionCode: true, supervisorId: true, active: true, team: true, teamOverride: true, discipline: true },
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
  /** A team set by hand (Employee.teamOverride): wins over the rule. */
  teamOverride?: string | null;
  /** The app's team label ("AI", "Mechanical Engineers") — a display fallback only. */
  discipline?: string | null;
};

/** The chart from people and family rows — pure, so it is testable without a database. */
export function buildOrgChart(employees: OrgEmployee[], rows: PositionFamilyRow[], opts: { includeInactive?: boolean } = {}): OrgChart {
  const isShown = (e: OrgEmployee) => !!opts.includeInactive || e.active;
  const families = mergePositionFamilies(rows);
  const res = resolveTeams(employees, rows);
  const byId = new Map(employees.map((e) => [e.id, e]));

  const reportsOf = new Map<number, typeof employees>();
  for (const e of employees) if (e.supervisorId != null) (reportsOf.get(e.supervisorId) ?? reportsOf.set(e.supervisorId, []).get(e.supervisorId)!).push(e);
  // Same order as a Cards card: grouped by position code, then name.
  for (const list of reportsOf.values()) list.sort(comparePositionCode);

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
    // A team set by hand is the one placement worth a note: it is deliberate, and
    // it puts the person on a card their manager is not on.
    if (r.overridden) {
      const sup = e.supervisorId != null ? byId.get(e.supervisorId) : undefined;
      return sup ? `Team set by hand · reports to ${sup.name}` : "Team set by hand";
    }
    // Nobody is flagged for being placed by their reporting line (2026-10-05,
    // by request) — not for having no usable position code, and not for a code
    // whose family differs from the branch they sit in. Both are the rule
    // working as intended (or a gap on Paylocity's side), and nothing on this
    // page can act on them. Only people not in Paylocity get a note: their
    // supervisor is set here.
    return null;
  }

  // Shown reports, with a hidden manager's own reports lifted to the nearest shown one.
  function shownReports(id: number, seen = new Set<number>()): typeof employees {
    if (seen.has(id)) return [];
    seen.add(id);
    return (reportsOf.get(id) ?? []).flatMap((r) => (isShown(r) ? [r] : shownReports(r.id, seen)));
  }

  const orgNode = (e: (typeof employees)[number], reports: OrgNode[]): OrgNode => ({
    id: e.id,
    name: e.name,
    title: e.positionTitle?.trim() || null,
    positionCode: e.positionCode,
    active: e.active,
    team: displayTeam(e),
    note: noteFor(e),
    override: !!e.positionCode && families.get(codeKey(e.positionCode))?.source === "override",
    byHand: res.get(e.id)?.overridden === true,
    isHead: reports.length > 0,
    reports,
  });

  // Leadership: its own tree, each leader under the leader they report to.
  function leaderNode(e: (typeof employees)[number], seen = new Set<number>()): OrgNode {
    seen.add(e.id);
    const kids = shownReports(e.id).filter((k) => isLeader(k.id) && !seen.has(k.id));
    return orgNode(e, kids.map((k) => leaderNode(k, seen)));
  }
  const count = (n: OrgNode): number => 1 + n.reports.reduce((s, k) => s + count(k), 0);
  const countActive = (n: OrgNode): number => (n.active ? 1 : 0) + n.reports.reduce((s, k) => s + countActive(k), 0);

  const shown = employees.filter(isShown);
  const leaders = shown.filter((e) => isLeader(e.id));
  const leaderIds = new Set(leaders.map((l) => l.id));
  // Leadership as its own tree: a leader is a root when nobody shown above them is Leadership.
  const leaderRoots = leaders
    .filter((l) => l.supervisorId == null || !leaderIds.has(l.supervisorId))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((l) => leaderNode(l));

  // Bands in the leadership tree's own order (top down), then any other leader.
  const ordered: typeof leaders = [];
  const walk = (n: OrgNode) => { ordered.push(byId.get(n.id)!); n.reports.forEach(walk); };
  leaderRoots.forEach(walk);

  const bands: OrgBand[] = [];
  for (const L of ordered) {
    // Everyone shown in this leader's branch (not Leadership), a hidden manager's
    // reports lifted to the nearest shown one.
    const members: typeof employees = [];
    const collect = (id: number, seen = new Set<number>()) => {
      for (const k of shownReports(id)) {
        if (isLeader(k.id) || seen.has(k.id)) continue;
        seen.add(k.id);
        members.push(k);
        collect(k.id, seen);
      }
    };
    collect(L.id);
    if (!members.length) continue;

    // One card per team. Inside a card each person hangs off the nearest manager
    // ABOVE them who is on the same card, else they head their own line. For a
    // normal branch that is the supervisor, as ever; for someone whose team was set
    // by hand it puts them on the card they were given — under a manager there if
    // they have one, on their own if not — and leaves their reports where they were.
    const memberIds = new Set(members.map((m) => m.id));
    const teamOf = new Map(members.map((m) => [m.id, displayTeam(m)]));
    const parentInCard = (m: (typeof employees)[number]): number | null => {
      const team = teamOf.get(m.id);
      const seen = new Set<number>([m.id]);
      for (let cur = m.supervisorId; cur != null && !seen.has(cur); ) {
        seen.add(cur);
        const up = byId.get(cur);
        if (!up) return null;
        if (memberIds.has(up.id) && teamOf.get(up.id) === team) return up.id;
        cur = up.supervisorId;
      }
      return null;
    };
    const kidsOf = new Map<number | null, typeof employees>();
    for (const m of members) {
      const p = parentInCard(m);
      (kidsOf.get(p) ?? kidsOf.set(p, []).get(p)!).push(m);
    }
    const build = (m: (typeof employees)[number]): OrgNode =>
      orgNode(m, (kidsOf.get(m.id) ?? []).sort(comparePositionCode).map(build));
    const byTeam = new Map<string | null, OrgNode[]>();
    for (const m of (kidsOf.get(null) ?? []).sort(comparePositionCode)) {
      const t = teamOf.get(m.id) ?? null;
      (byTeam.get(t) ?? byTeam.set(t, []).get(t)!).push(build(m));
    }
    const cards = [...byTeam].map(([team, hs]) => ({
      team,
      name: teamName(team),
      people: hs.reduce((n, h) => n + count(h), 0),
      active: hs.reduce((n, h) => n + countActive(h), 0),
      heads: hs,
    }));
    cards.sort((a, b) => cardRank(a.team) - cardRank(b.team) || a.name.localeCompare(b.name));
    bands.push({
      leader: { id: L.id, name: L.name, title: L.positionTitle?.trim() || null },
      people: cards.reduce((s, c) => s + c.people, 0),
      active: cards.reduce((s, c) => s + c.active, 0),
      cards,
    });
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
      active: e.active,
      detail: !inPaylocity(e.paylocityId) ? "Not in Paylocity — set a supervisor on the Employees page" : e.supervisorId == null ? "No supervisor in Paylocity" : "No Leadership above them",
    }));

  const pending = pendingTeamChanges(employees, res).map((c) => ({ ...c, fromName: c.from ? teamName(c.from) : null, toName: teamName(c.to) }));

  return {
    ready: rows.length > 0,
    leaders: leaderRoots,
    leaderCount: leaders.length,
    leaderActive: leaders.filter((l) => l.active).length,
    bands,
    unplaced,
    pending,
  };
}
