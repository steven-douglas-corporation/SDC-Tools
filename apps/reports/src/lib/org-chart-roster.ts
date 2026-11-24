// ── The Canvas view's people list (2026-11-19) ──────────────────────────────
//
// The sidebar beside the org chart canvas: everyone, by group (Leadership,
// Growth, Execution, Support, "Reporting to X", Not placed), then by team, and
// within a team in the same order as its card (OrgChart.tsx CardBody): the
// reporting tree top down, each manager followed by the people under them (by
// position code, as lib/org-chart.ts sorts them), then "Team set by hand", then
// Contractors. `level` is the depth in that tree, for the indent. Clicking a
// name jumps the canvas to them (OrgChartCanvas.tsx).
//
// A team that appears on two cards (two leaders each with some of it) is one
// entry here: the cards one after the other, in the order the canvas has them.

/** The parts of an OrgNode the list needs (an OrgNode fits). */
export type RosterNode = { id: number; name: string; title: string | null; active: boolean; reports: RosterNode[] };

export type RosterPerson = { id: number; name: string; title: string | null; active: boolean; level: number };
/** A part of a team as the card has it: the tree (label null), "Team set by hand", "Contractors". */
export type RosterSection = { label: string | null; people: RosterPerson[] };
/** A team's header colours, as its card on the canvas has them. */
export type RosterColors = { bg: string; text: string };
export type RosterTeam = { key: string; title: string; colors: RosterColors | null; count: number; sections: RosterSection[] };
export type RosterGroup = { key: string; title: string; count: number; teams: RosterTeam[] };

export type RosterInput = {
  key: string;
  title: string;
  teams: { title: string; colors?: RosterColors | null; sections: { label: string | null; nodes: RosterNode[] }[] }[];
}[];

/** Everyone in the trees, top down: each person, then the people under them. */
export function flattenTree(nodes: RosterNode[], level = 0): RosterPerson[] {
  return nodes.flatMap((n) => [
    { id: n.id, name: n.name, title: n.title, active: n.active, level },
    ...flattenTree(n.reports, level + 1),
  ]);
}

/**
 * Groups → teams → sections → people. Teams with the same title in a group are
 * merged (their same-label sections joined); someone listed twice in a team is
 * kept where they first appear. A `keep` (the page's search) leaves only the
 * people it accepts, and empty sections, teams and groups are dropped.
 */
export function buildRoster(groups: RosterInput, keep?: (id: number) => boolean): RosterGroup[] {
  return groups
    .map((g) => {
      const byTitle = new Map<string, { colors: RosterColors | null; sections: Map<string | null, RosterPerson[]> }>();
      for (const t of g.teams) {
        const team = byTitle.get(t.title) ?? byTitle.set(t.title, { colors: t.colors ?? null, sections: new Map() }).get(t.title)!;
        for (const s of t.sections) {
          const list = team.sections.get(s.label) ?? team.sections.set(s.label, []).get(s.label)!;
          list.push(...flattenTree(s.nodes));
        }
      }
      const teams = [...byTitle].map(([title, { colors, sections }]) => {
        const seen = new Set<number>();
        const kept = [...sections]
          .map(([label, people]) => ({
            label,
            people: people.filter((p) => !seen.has(p.id) && seen.add(p.id) && (!keep || keep(p.id))),
          }))
          .filter((s) => s.people.length > 0);
        return { key: `${g.key}:${title}`, title, colors, count: kept.reduce((n, s) => n + s.people.length, 0), sections: kept };
      });
      const kept = teams.filter((t) => t.count > 0);
      return { key: g.key, title: g.title, count: kept.reduce((n, t) => n + t.count, 0), teams: kept };
    })
    .filter((g) => g.teams.length > 0);
}
