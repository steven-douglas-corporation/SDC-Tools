import { EmptyState } from "@/components/ui/EmptyState";
import { card } from "@/components/ui/classnames";
import { resolveEmployeeGroup } from "@/lib/employee-card-theme";
import type { OrgChart as OrgChartData, OrgNode } from "@/lib/org-chart";
import { DepartmentCardHeader, EmployeePersonRow, HandPlacedSection, TempsSection } from "@/components/EmployeePersonRow";
import { isPaylocityId, comparePositionCode, rowMatchesSearch, type EmployeeRow } from "@/lib/employee-row";
import { filterOrgNodes, countOrgNodes } from "@/lib/org-chart-search";
import { employeeCapacityHours, hiringCapacityHours } from "@/lib/workforce-capacity";
import { hasYearPolicy } from "@/lib/workforce-capacity-policy";
import { CardStats } from "@/components/CardStats";
import type { CapacityDrillTarget } from "@/components/WorkforceSummaryCards";
import { OpenPositionsDropdown } from "@/components/OpenPositionsDropdown";
import type { HiringPosition } from "@/lib/hiring-positions";
import { countOpenings } from "@/lib/hiring-openings";
import { cardId, LEADERS_CARD, placeHiringOnChart } from "@/lib/org-chart-hiring";

// The Employees page's Org chart view (2026-10-02): the same department cards
// as the Cards view — same header, same "N active" line, same person rows
// (EmployeePersonRow.tsx) — arranged by reporting line instead of by
// department group. Each group is headed by who it reports to, the way Cards
// heads its groups with Engineering / Shop / PM, and inside a card everyone
// hangs off their manager on connector lines. Data and the rule behind the
// teams: lib/org-chart.ts. No hooks, so it renders on server or client.

// Connectors: an elbow into each person at their name's height, and a trunk
// down past every sibling but the last. Pseudo-elements, so the tree is plain
// nested lists of the same rows Cards draws.
const TREE_UL = "ml-4 pl-3";
const TREE_LI =
  "relative before:absolute before:-left-3 before:top-0 before:h-4 before:w-2.5 before:rounded-bl-[5px] before:border-b-[1.5px] before:border-l-[1.5px] before:border-sdc-gray-400 before:content-[''] not-last:after:absolute not-last:after:-left-3 not-last:after:top-4 not-last:after:bottom-0 not-last:after:border-l-[1.5px] not-last:after:border-sdc-gray-400 not-last:after:content-['']";

type Ctx = {
  people: Map<number, EmployeeRow>;
  onSelect?: (row: EmployeeRow) => void;
  leadershipCard?: boolean;
  /** For the per-card capacity hours (workforce-capacity-policy); absent = no hours line. */
  year?: number;
  onSelectCapacity?: (target: CapacityDrillTarget) => void;
  /** Open positions placed on each card (lib/org-chart-hiring.ts), by card id. */
  hiringByCard: Map<string, HiringPosition[]>;
  onSelectHiring?: (position: HiringPosition) => void;
  /** A viewer who can assign hiring also sees positions hidden from everyone else. */
  canAssignHiring?: boolean;
  /** While searching: whether a person matches. Anyone drawn who doesn't is a manager shown for context, and is dimmed. */
  match?: (id: number) => boolean;
};

// Every shown person in a card's tree, for its capacity drill. Same people the
// card's "N active" counts: the chart only ever contains shown people.
function rowsIn(nodes: OrgNode[], people: Map<number, EmployeeRow>): EmployeeRow[] {
  return nodes.flatMap((n) => {
    const row = people.get(n.id);
    return [...(row && row.active ? [row] : []), ...rowsIn(n.reports, people)];
  });
}

// A card has up to three parts, top to bottom, as on Cards: the Paylocity roster
// as a tree, then people whose team was set by hand, then contractors (not in
// Paylocity). The last two leave the tree for their own section; anyone who
// reported to someone who left moves up to their place, so nobody disappears
// with them. A contractor stays a contractor even if their team was set by hand.
function splitSections(nodes: OrgNode[], ctx: Ctx): { tree: OrgNode[]; hand: OrgNode[]; temps: OrgNode[] } {
  const hand: OrgNode[] = [];
  const temps: OrgNode[] = [];
  const walk = (list: OrgNode[]): OrgNode[] =>
    list.flatMap((n) => {
      const reports = walk(n.reports);
      if (!isPaylocityId(ctx.people.get(n.id)?.paylocityId)) {
        temps.push(n);
        return reports;
      }
      if (n.byHand) {
        hand.push(n);
        return reports;
      }
      return [{ ...n, reports }];
    });
  const tree = walk(nodes);
  const byCode = (a: OrgNode, b: OrgNode) => comparePositionCode(ctx.people.get(a.id) ?? a, ctx.people.get(b.id) ?? b);
  return { tree, hand: hand.sort(byCode), temps: temps.sort(byCode) };
}

function CardBody({ nodes, cardTitle, ctx }: { nodes: OrgNode[]; cardTitle: string; ctx: Ctx }) {
  const { tree, hand, temps } = splitSections(nodes, ctx);
  const rows = (list: OrgNode[]) =>
    list.map((n) => {
      const row = ctx.people.get(n.id);
      return row ? (
        <li key={n.id}>
          <EmployeePersonRow p={row} cardTitle={cardTitle} onSelect={ctx.onSelect} note={n.note} dimmed={!!ctx.match && !ctx.match(n.id)} />
        </li>
      ) : null;
    });
  return (
    <>
      {(tree.length > 0 || (hand.length === 0 && temps.length === 0)) && <Tree nodes={tree} cardTitle={cardTitle} ctx={ctx} />}
      {hand.length > 0 && <HandPlacedSection last={temps.length === 0}>{rows(hand)}</HandPlacedSection>}
      {temps.length > 0 && <TempsSection>{rows(temps)}</TempsSection>}
    </>
  );
}

function Tree({ nodes, cardTitle, ctx, nested }: { nodes: OrgNode[]; cardTitle: string; ctx: Ctx; nested?: boolean }) {
  return (
    <ul className={nested ? TREE_UL : "min-h-[72px] p-1.5"}>
      {nodes.map((n) => {
        const row = ctx.people.get(n.id);
        if (!row) return null;
        return (
          <li key={n.id} className={nested ? TREE_LI : ""}>
            <EmployeePersonRow p={row} cardTitle={cardTitle} onSelect={ctx.onSelect} note={n.note} hideLeadershipBadge={ctx.leadershipCard} dimmed={!!ctx.match && !ctx.match(n.id)} />
            {n.reports.length > 0 && <Tree nodes={n.reports} cardTitle={cardTitle} ctx={ctx} nested />}
          </li>
        );
      })}
    </ul>
  );
}

function visibleTo(positions: HiringPosition[], ctx: Ctx): HiringPosition[] {
  return positions.filter((p) => p.isVisible || ctx.canAssignHiring);
}

// The Cards view's card, with its open positions as a dropdown at the foot
// (the positions placed on THIS card by lib/org-chart-hiring.ts).
// Not overflow-hidden like Cards': a hover note on the first row would be clipped.
function TeamCard({
  id,
  team,
  count,
  inactive = 0,
  shown = null,
  nodes,
  ctx,
  children,
}: {
  /** cardId() — which positions are placed here. */
  id: string;
  team: string | null;
  /** ACTIVE people only: it is the headcount, and the capacity hours are built on it. */
  count: number;
  /** Inactive people drawn on the card (only with "Show inactive"); never counted in the hours. */
  inactive?: number;
  /** While searching: how many of the card's people the search leaves drawn. */
  shown?: { shown: number; of: number } | null;
  /** The card's WHOLE tree, for its capacity drill — a search narrows what is drawn, not what the card is. */
  nodes: OrgNode[];
  ctx: Ctx;
  children: (title: string) => React.ReactNode;
}) {
  const group = team ? resolveEmployeeGroup({ team }) : null;
  const title = group?.title ?? "No team";
  // The same "current hrs/yr" line a Cards card carries: active people × the
  // year's hours per person, and a click opens the breakdown by employee.
  const hasCapacityPolicy = ctx.year != null && hasYearPolicy(ctx.year);
  // Hours are shown only when there is a policy for the year AND a breakdown to
  // open: nothing to click, nothing offered.
  const canOpenCapacity = hasCapacityPolicy && !!ctx.onSelectCapacity;
  // Counts and hours take every open position placed here; the dropdown lists
  // only what the viewer may see — the same split the Cards view makes.
  const cardHiring = ctx.hiringByCard.get(id) ?? [];
  const hiringOpenings = countOpenings(cardHiring);
  const hiringHours = hasCapacityPolicy ? hiringCapacityHours(cardHiring, ctx.year!) : 0;
  const currentHours = hasCapacityPolicy ? employeeCapacityHours(count, ctx.year!) : 0;
  return (
    <section className="flex flex-col rounded-xl border border-sdc-border bg-white shadow-sm">
      <DepartmentCardHeader title={title} colors={group?.colors ?? { bg: "#e2e8f0", text: "#1e293b" }} isAi={group?.key === "ai"} className="rounded-t-[11px]" />
      <CardStats
        stats={{ active: count, inactive, hiringOpenings, currentHours: canOpenCapacity ? currentHours : null, hiringHours }}
        shown={shown}
        onOpen={
          canOpenCapacity
            ? () => ctx.onSelectCapacity!({ title: `${title} — Capacity`, employees: rowsIn(nodes, ctx.people), hiringPositions: cardHiring })
            : undefined
        }
      />
      {children(title)}
      <OpenPositionsDropdown positions={visibleTo(cardHiring, ctx)} onSelect={ctx.onSelectHiring} />
    </section>
  );
}

// The Cards view's group heading, naming who the group reports to.
function Group({ title, active, cardCount, children }: { title: string; active: number; cardCount: number; children: React.ReactNode }) {
  return (
    <div className="min-w-0 max-w-full flex-1" style={{ flexBasis: `${Math.max(1, cardCount) * 17}rem` }}>
      <h3 className="mb-2 border-b border-sdc-border pb-1 text-xs font-bold uppercase tracking-wider text-sdc-muted">
        {title}
        <span className="ml-2 font-normal normal-case tracking-normal text-sdc-gray-400">{active} active</span>
      </h3>
      <div className="grid items-start gap-3 [grid-template-columns:repeat(auto-fill,minmax(15rem,1fr))]">{children}</div>
    </div>
  );
}

/**
 * `people` is the Employees page's own rows, so each person renders exactly as
 * on a Cards card; `onSelectPerson` opens their panel.
 */
export function OrgChart({
  chart,
  people,
  onSelectPerson,
  year,
  onSelectCapacity,
  hiringPositions,
  onSelectHiringPosition,
  canAssignHiring,
  query = "",
}: {
  chart: OrgChartData;
  /** The Employees page's search text: narrows the chart to matches and the managers above them. */
  query?: string;
  people: Map<number, EmployeeRow>;
  onSelectPerson?: (row: EmployeeRow) => void;
  /** With onSelectCapacity: each card shows its current hrs/yr and opens the breakdown. */
  year?: number;
  onSelectCapacity?: (target: CapacityDrillTarget) => void;
  /** Open positions, placed on the hiring manager's card or under Not placed. Omitted, the chart draws no hiring. */
  hiringPositions?: HiringPosition[];
  onSelectHiringPosition?: (position: HiringPosition) => void;
  canAssignHiring?: boolean;
}) {
  if (!chart.ready) {
    return (
      <EmptyState
        title="Position families haven't been imported yet"
        message="The chart needs Paylocity's Position_Families file. Once the hourly sync has read it (see Data Quality › Position families), this view fills in."
      />
    );
  }
  const placement = placeHiringOnChart(hiringPositions ?? [], chart, people);
  // A search narrows what is DRAWN to the matches and the managers above them; the
  // cards' own numbers, and what their capacity breakdown lists, stay the whole card's.
  const needle = query.trim();
  const match = needle
    ? (id: number) => {
        const row = people.get(id);
        return !!row && rowMatchesSearch(row, needle);
      }
    : undefined;
  const ctx: Ctx = {
    people,
    onSelect: onSelectPerson,
    year,
    onSelectCapacity,
    hiringByCard: placement.byCard,
    onSelectHiring: onSelectHiringPosition,
    canAssignHiring,
    match,
  };
  const narrow = (nodes: OrgNode[]) => (match ? filterOrgNodes(nodes, match) : nodes);
  const shownOf = (drawn: OrgNode[], whole: OrgNode[]) => {
    const [d, w] = [countOrgNodes(drawn), countOrgNodes(whole)];
    return match && d !== w ? { shown: d, of: w } : null;
  };
  const leaders = narrow(chart.leaders);
  const bands = chart.bands
    .map((band) => ({ band, cards: band.cards.map((card) => ({ card, heads: narrow(card.heads) })).filter((x) => !match || x.heads.length > 0) }))
    .filter((x) => x.cards.length > 0);
  const unplaced = match ? chart.unplaced.filter((u) => match(u.id)) : chart.unplaced;
  // Open positions aren't searched, so a search hides the ones that have no card.
  const unplacedHiring = match ? [] : visibleTo(placement.unplaced, ctx);
  if (match && leaders.length === 0 && bands.length === 0 && unplaced.length === 0) {
    return <EmptyState title="No one matches" message={`Nothing on the chart matches “${needle}”. Inactive people only show with Show inactive.`} />;
  }
  return (
    // Groups share a line when they fit, the same flow the Cards view uses.
    <div className="flex flex-wrap items-start gap-x-5 gap-y-4">
      {(!match || leaders.length > 0) && (
        <Group title="Leadership" active={chart.leaderActive} cardCount={1}>
          <TeamCard
            id={LEADERS_CARD}
            team="exec"
            count={chart.leaderActive}
            inactive={chart.leaderCount - chart.leaderActive}
            shown={shownOf(leaders, chart.leaders)}
            nodes={chart.leaders}
            ctx={ctx}
          >
            {(title) => <Tree nodes={leaders} cardTitle={title} ctx={{ ...ctx, leadershipCard: true }} />}
          </TeamCard>
        </Group>
      )}

      {bands.map(({ band: b, cards }) => (
        <Group key={b.leader.id} title={`Reporting to ${b.leader.name}`} active={b.active} cardCount={cards.length}>
          {cards.map(({ card: c, heads }) => (
            <TeamCard
              key={c.team ?? "none"}
              id={cardId(b.leader.id, c.team)}
              team={c.team}
              count={c.active}
              inactive={c.people - c.active}
              shown={shownOf(heads, c.heads)}
              nodes={c.heads}
              ctx={ctx}
            >
              {(title) => <CardBody nodes={heads} cardTitle={title} ctx={ctx} />}
            </TeamCard>
          ))}
        </Group>
      ))}

      {(unplaced.length > 0 || unplacedHiring.length > 0) && (
        <Group title="Not placed" active={unplaced.filter((u) => u.active).length} cardCount={1}>
          <section className="flex flex-col rounded-xl border border-dashed border-sdc-border bg-white">
            <p className="rounded-t-[11px] border-b border-sdc-border bg-sdc-gray-50 px-3.5 py-1.5 text-xs text-sdc-muted">
              {unplaced.length > 0
                ? "No Leadership above them — their team is left as it is"
                : "Open positions whose hiring manager isn't on the chart — open one to place it"}
            </p>
            <ul className="p-1.5">
              {unplaced.map((u) => {
                const row = people.get(u.id);
                return row ? (
                  <li key={u.id}>
                    <EmployeePersonRow p={row} cardTitle="" onSelect={onSelectPerson} note={u.detail} />
                  </li>
                ) : null;
              })}
            </ul>
            <OpenPositionsDropdown positions={unplacedHiring} onSelect={ctx.onSelectHiring} />
          </section>
        </Group>
      )}
    </div>
  );
}

/** Team changes the rule has worked out but the hourly sync has not written yet. */
export function PendingTeamChanges({ pending }: { pending: OrgChartData["pending"] }) {
  return (
    <section className={card("p-5")} aria-labelledby="pending-h">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="pending-h" className="font-heading text-base font-bold text-sdc-navy">
          Waiting for the next hourly sync
        </h2>
        <span className="text-xs text-sdc-gray-600">
          {`${pending.length} ${pending.length === 1 ? "team change" : "team changes"} — the chart already shows them`}
        </span>
      </div>
      <div className="mt-3 max-h-80 overflow-auto rounded-lg border border-sdc-border">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 bg-sdc-gray-50 text-label font-semibold uppercase tracking-[0.04em] text-sdc-gray-600">
            <tr>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Team today</th>
              <th className="px-3 py-2">Would become</th>
              <th className="px-3 py-2">Why</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-sdc-border-soft">
            {pending.map((c) => (
              <tr key={c.id}>
                <td className="px-3 py-1.5 font-medium text-sdc-navy">{c.name}</td>
                <td className="px-3 py-1.5 text-sdc-gray-600">{c.fromName ?? "—"}</td>
                <td className="px-3 py-1.5 font-semibold text-sdc-navy">{c.toName}</td>
                <td className="px-3 py-1.5 text-sdc-gray-600">{c.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
