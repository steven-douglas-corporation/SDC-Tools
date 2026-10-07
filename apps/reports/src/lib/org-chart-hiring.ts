import { resolveEmployeeGroup } from "@/lib/employee-card-theme";
import type { HiringPosition } from "@/lib/hiring-positions";
import type { OrgChart, OrgNode } from "@/lib/org-chart";
import { isPaylocityId, type EmployeeRow } from "@/lib/employee-row";

// ── Where an open position sits on the Org chart (2026-10-07) ───────────────
//
// The chart has a card per team inside each leader's band, so one team can have
// several cards, and a position's department alone doesn't say which. Pure and
// React-free so the rule is directly testable.
//
//   • A position nobody has assigned goes on the card its hiring manager is on —
//     the first manager listed who appears on the chart.
//   • A position someone assigned by hand (the override) goes on a card of the
//     team they chose; when that team has several cards, the one carrying the
//     hiring manager, else the first.
//   • Anything else — no manager on the chart, no team chosen, or a team with no
//     card — is "not placed".
//
// A card is identified by cardId(): "leaders" for the Leadership card, otherwise
// the band's leader id and the card's team.

export const LEADERS_CARD = "leaders";
export const cardId = (leaderId: number, team: string | null) => `${leaderId}:${team ?? ""}`;

export type HiringPlacement = {
  byCard: Map<string, HiringPosition[]>;
  unplaced: HiringPosition[];
};

type CardInfo = { id: string; teamKey: string | null };

function collectPaylocityIds(nodes: OrgNode[], people: ReadonlyMap<number, EmployeeRow>, into: Set<string>) {
  for (const n of nodes) {
    const pid = people.get(n.id)?.paylocityId;
    if (isPaylocityId(pid)) into.add(pid!.trim());
    collectPaylocityIds(n.reports, people, into);
  }
}

export function placeHiringOnChart(
  positions: readonly HiringPosition[],
  chart: OrgChart,
  people: ReadonlyMap<number, EmployeeRow>,
): HiringPlacement {
  // Every card, with the card key positions use for their department, and who is on it.
  const cards: CardInfo[] = [{ id: LEADERS_CARD, teamKey: resolveEmployeeGroup({ team: "exec" })?.key ?? "exec" }];
  const members = new Map<string, Set<string>>();
  const leaderIds = new Set<string>();
  collectPaylocityIds(chart.leaders, people, leaderIds);
  members.set(LEADERS_CARD, leaderIds);
  for (const band of chart.bands) {
    for (const c of band.cards) {
      const id = cardId(band.leader.id, c.team);
      cards.push({ id, teamKey: c.team ? (resolveEmployeeGroup({ team: c.team })?.key ?? c.team) : null });
      const ids = new Set<string>();
      collectPaylocityIds(c.heads, people, ids);
      members.set(id, ids);
    }
  }

  const cardOfManager = (p: HiringPosition): string | null => {
    for (const mid of p.hiringManagerIds) {
      const hit = cards.find((c) => members.get(c.id)?.has(mid));
      if (hit) return hit.id;
    }
    return null;
  };

  const byCard = new Map<string, HiringPosition[]>();
  const unplaced: HiringPosition[] = [];
  for (const p of positions) {
    const managerCard = cardOfManager(p);
    let target: string | null;
    if (p.isManuallyAssigned) {
      const candidates = p.department ? cards.filter((c) => c.teamKey === p.department) : [];
      target = candidates.find((c) => c.id === managerCard)?.id ?? candidates[0]?.id ?? null;
    } else {
      target = managerCard;
    }
    if (!target) {
      unplaced.push(p);
      continue;
    }
    const list = byCard.get(target);
    if (list) list.push(p);
    else byCard.set(target, [p]);
  }
  return { byCard, unplaced };
}
