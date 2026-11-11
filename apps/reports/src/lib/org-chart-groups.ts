import type { OrgBand, OrgTeamCard } from "@/lib/org-chart";

// ── The Org chart arranged by function (2026-11-11) ─────────────────────────
//
// lib/org-chart.ts builds a band per leader ("Reporting to X"), each with a card
// per team. This regroups those same cards by what the team does:
//
//   Growth     (win the work)      Sales, Marketing
//   Execution  (quote to ship)     Project management;
//                                  Engineering: Mechanical, Controls, General
//                                  Operations: Mech build, Elec build, Mfg ops,
//                                              Procurement, Service
//   Support    (run the business)  Finance, HR, AI
//
// Cards are not merged: a team with people under two leaders keeps two cards,
// so each card's id (and the open positions placed on it) is unchanged, and
// each keeps its band, so who it reports to is never typed in. A team this
// table doesn't know (or no team) goes to `other`, still by band. Pure and
// React-free so it is testable.

export type SectionKey = "growth" | "pm" | "engineering" | "operations" | "support";

const SECTION_OF: Record<string, SectionKey> = {
  sales: "growth",
  growth: "growth",
  pm: "pm",
  mech: "engineering",
  controls: "engineering",
  geneng: "engineering",
  build: "operations",
  wire: "operations",
  mfgops: "operations",
  ops: "operations",
  service: "operations",
  finance: "support",
  hr: "support",
  ai: "support",
};

// Card order inside a section: the order work moves through the teams.
const TEAM_ORDER = Object.keys(SECTION_OF);

export const sectionOf = (team: string | null): SectionKey | null => (team ? (SECTION_OF[team] ?? null) : null);

export type PlacedCard<C> = { band: OrgBand; item: C };
export type ChartSection<C> = { key: SectionKey; cards: PlacedCard<C>[] };
export type FunctionGroups<C> = {
  sections: Record<SectionKey, ChartSection<C>>;
  /** Cards of a team no section takes, kept with their band. */
  other: { band: OrgBand; cards: C[] }[];
};

/**
 * Regroups the chart's bands by function. `bands` is the chart's own bands, or a
 * search-narrowed copy of them; `item` is whatever the caller keeps per card, as
 * long as it carries the card.
 */
export function groupByFunction<C extends { card: OrgTeamCard }>(bands: { band: OrgBand; cards: C[] }[]): FunctionGroups<C> {
  const keys: SectionKey[] = ["growth", "pm", "engineering", "operations", "support"];
  const sections = Object.fromEntries(keys.map((k) => [k, { key: k, cards: [] }])) as unknown as Record<SectionKey, ChartSection<C>>;
  const other: FunctionGroups<C>["other"] = [];

  bands.forEach(({ band, cards }) => {
    const leftover: C[] = [];
    for (const item of cards) {
      const key = sectionOf(item.card.team);
      if (!key) {
        leftover.push(item);
        continue;
      }
      sections[key].cards.push({ band, item });
    }
    if (leftover.length) other.push({ band, cards: leftover });
  });

  // Stable sort: team order first, then the bands' own order (already top down).
  const rank = (t: string | null) => TEAM_ORDER.indexOf(t ?? "");
  for (const s of Object.values(sections)) s.cards.sort((a, b) => rank(a.item.card.team) - rank(b.item.card.team));
  return { sections, other };
}

/** Active people across a section's cards. */
export const sectionActive = <C extends { card: OrgTeamCard }>(s: ChartSection<C>) => s.cards.reduce((n, c) => n + c.item.card.active, 0);
