import { Fragment } from "react";
import { EmptyState } from "@/components/ui/EmptyState";
import { card } from "@/components/ui/classnames";
import { resolveEmployeeGroup } from "@/lib/employee-card-theme";
import type { OrgBand, OrgChart as OrgChartData, OrgNode, OrgTeamCard } from "@/lib/org-chart";
import { groupByFunction, sectionActive, type SectionKey } from "@/lib/org-chart-groups";
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
// (EmployeePersonRow.tsx). Since 2026-11-11 the groups are by function by
// default — Leadership, Growth, Execution, Support (lib/org-chart-groups.ts) —
// each card naming who it reports to; the page can switch back to a group per
// leader ("Reporting to X"). Inside a card everyone hangs off their manager on
// connector lines. Data and the rule behind the
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
  reportsTo = null,
  children,
}: {
  /** Who the card's people report to (the function groups; a "Reporting to X" heading already says). */
  reportsTo?: string | null;
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
  // The dropdown lists every position placed here, hire requests included
  // (2026-10-30); counts and hours take only the open ones, never a request.
  const listedHiring = ctx.hiringByCard.get(id) ?? [];
  const cardHiring = listedHiring.filter((p) => p.isOpen);
  const hiringOpenings = countOpenings(cardHiring);
  const hiringHours = hasCapacityPolicy ? hiringCapacityHours(cardHiring, ctx.year!) : 0;
  const currentHours = hasCapacityPolicy ? employeeCapacityHours(count, ctx.year!) : 0;
  return (
    <section className="flex flex-col rounded-xl border border-sdc-border bg-white shadow-sm">
      <DepartmentCardHeader
        title={title}
        colors={group?.colors ?? { bg: "#e2e8f0", text: "#1e293b" }}
        isAi={group?.key === "ai"}
        className="rounded-t-[11px]"
      />
      {reportsTo && <p className="px-3.5 pt-1.5 text-xs text-sdc-muted">Reports to {reportsTo}</p>}
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
      {/* No Manual add / Request a hire on the cards (removed 2026-10-30):
          hire requests start from the Hiring tab. */}
      <OpenPositionsDropdown positions={listedHiring} onSelect={ctx.onSelectHiring} />
    </section>
  );
}

// The Cards view's group heading: the function (Growth, Execution, Support), or
// for any other team "Reporting to X". Who a function's cards report to is on
// each card, not in the heading (several leaders in one heading read as a muddle).
function Group({
  title,
  active,
  cardCount,
  bare = false,
  className = "",
  children,
}: {
  title: string;
  /** A number, or (Execution) which number by chart width. */
  active: React.ReactNode;
  cardCount: number;
  /** Children lay themselves out (Execution's parts). */
  bare?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`min-w-0 max-w-full flex-1 ${className}`} style={{ flexBasis: `${Math.max(1, cardCount) * 20}rem` }}>
      <h3 className="mb-2 border-b border-sdc-border pb-1 text-xs font-bold uppercase tracking-wider text-sdc-muted">
        <span>{title}</span>
        <span className="ml-2 font-normal normal-case tracking-normal text-sdc-gray-400">{active} active</span>
      </h3>
      {bare ? children : <div className={CARD_GRID}>{children}</div>}
    </div>
  );
}

// 18rem at the narrowest (was 15rem until 2026-10-30): room for a wrapped
// open-position title beside its status pill.
const CARD_GRID = "grid items-start gap-3 [grid-template-columns:repeat(auto-fill,minmax(18rem,1fr))]";

// A part of Execution (2026-11-11): Project management, Engineering, Operations,
// with a rule dividing it from the part before on the same line. The parts flow like
// the groups do, sharing a line when they fit. Engineering and Operations get a
// small header; Project management is one card already titled that, so its
// header line is left blank (same height, so the cards' tops still line up).
//
// The rule sits in the gap to a part's left (before:-left-2, half of gap-x-4).
// The parts' row clips sideways (PARTS_ROW), so a part that starts a line, the
// first or one that wrapped, has its rule clipped away rather than drawn at
// the edge, and nobody is indented by it.
//
// How Execution gives way as the chart narrows (2026-11-11, by request), by the
// CHART's width (container queries on OrgChart's root, so the app's zoom and the
// sidebar don't matter):
//   1. Project management and Engineering keep their width (one card, two
//      cards: PART_WIDTH); Operations takes the rest of the line and wraps its
//      own cards first, down to two a row.
//   2. Below that (1410px: one + two + two cards and the gaps, 93.5rem at the
//      app's constant 15px root), Project management moves up beside
//      Leadership and Growth, and Engineering and Operations keep the
//      Execution line to themselves.
//   3. Narrower still, the parts and groups wrap as they always have.
// The threshold is in px, not rem: inside a container query `rem` is the
// browser's 16px, not the page's 15px. The app's zoom (CSS zoom on <html>)
// scales the cards and the container alike, so it doesn't move the switch.
// (Classes written out in full: Tailwind only generates what it finds literally.)
const PARTS_ROW = "flex flex-wrap items-start gap-x-4 gap-y-4 overflow-x-clip";
// One card is 18rem; two are 18 + 0.75 (CARD_GRID's gap-3) + 18.
const PART_WIDTH: Partial<Record<SectionKey, string>> = {
  pm: "flex-none w-[18rem]",
  engineering: "flex-none w-[36.75rem]",
  operations: "flex-[1_1_36.75rem]",
};
const PM_IN_EXECUTION = "@max-[1410px]:hidden";
const PM_MOVED_UP = "@min-[1410px]:hidden";
function Part({ label, active, className, children }: { label: string | null; active: number; className: string; children: React.ReactNode }) {
  return (
    <div
      className={`relative min-w-0 max-w-full before:absolute before:inset-y-0 before:-left-2 before:border-l before:border-sdc-border before:content-[''] ${className}`}
    >
      <h4 className={`mb-2 text-xs font-semibold text-sdc-navy ${label ? "" : "invisible"}`} aria-hidden={label ? undefined : true}>
        <span>{label ?? "—"}</span>
        <span className="ml-2 font-normal text-sdc-gray-400">{active} active</span>
      </h4>
      <div className={CARD_GRID}>{children}</div>
    </div>
  );
}

export type OrgChartGrouping = "function" | "leader";

// The function groups, in page order, and which sections of
// lib/org-chart-groups.ts each one draws. Execution draws its sections as Parts.
const FUNCTIONS: { key: "growth" | "execution" | "support"; title: string; sections: SectionKey[] }[] = [
  { key: "growth", title: "Growth", sections: ["growth"] },
  { key: "execution", title: "Execution", sections: ["pm", "engineering", "operations"] },
  { key: "support", title: "Support", sections: ["support"] },
];
// Execution's part headers. Project management has none: its one card already says it.
const PART_LABEL: Partial<Record<SectionKey, string>> = { engineering: "Engineering", operations: "Operations" };

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
  query = "",
  groupBy = "function",
}: {
  chart: OrgChartData;
  /** "function": Growth / Execution / Support (the default since 2026-11-11). "leader": a group per leader, "Reporting to X". */
  groupBy?: OrgChartGrouping;
  /** The Employees page's search text: narrows the chart to matches and the managers above them. */
  query?: string;
  people: Map<number, EmployeeRow>;
  onSelectPerson?: (row: EmployeeRow) => void;
  /** With onSelectCapacity: each card shows its current hrs/yr and opens the breakdown. */
  year?: number;
  onSelectCapacity?: (target: CapacityDrillTarget) => void;
  /** Open positions and hire requests, placed on the hiring manager's card or under Not placed; only open ones count. Omitted, the chart draws no hiring. */
  hiringPositions?: HiringPosition[];
  onSelectHiringPosition?: (position: HiringPosition) => void;
}) {
  if (!chart.ready) {
    return (
      <EmptyState
        title="Position families haven't been imported yet"
        message="The chart needs Paylocity's Position_Families file. Once the hourly sync has read it (see Data Management › Position families), this view fills in."
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
  const unplacedHiring = match ? [] : placement.unplaced;
  if (match && leaders.length === 0 && bands.length === 0 && unplaced.length === 0) {
    return <EmptyState title="No one matches" message={`Nothing on the chart matches “${needle}”. Inactive people only show with Show inactive.`} />;
  }
  // The groups by function instead of a band per leader: the same cards, in the
  // same flow (lib/org-chart-groups.ts). Each card says who its people report
  // to, read off the band it came from.
  const { sections, other } = groupByFunction(bands);
  const functions = FUNCTIONS.map((f) => ({
    ...f,
    sections: f.sections.filter((k) => sections[k].cards.length > 0),
    cards: f.sections.flatMap((k) => sections[k].cards),
    active: f.sections.reduce((n, k) => n + sectionActive(sections[k]), 0),
  })).filter((f) => f.cards.length > 0);
  const teamCard = (b: OrgBand, c: OrgTeamCard, heads: OrgNode[], reportsTo: string | null) => (
    <TeamCard
      key={cardId(b.leader.id, c.team)}
      id={cardId(b.leader.id, c.team)}
      team={c.team}
      count={c.active}
      inactive={c.people - c.active}
      shown={shownOf(heads, c.heads)}
      nodes={c.heads}
      ctx={ctx}
      reportsTo={reportsTo}
    >
      {(title) => <CardBody nodes={heads} cardTitle={title} ctx={ctx} />}
    </TeamCard>
  );
  // A group per leader: the "By reporting line" view, and in the function view
  // any team no function takes. The heading says who, so the cards don't.
  const leaderGroup = (b: OrgBand, cards: { card: OrgTeamCard; heads: OrgNode[] }[], active: number) => (
    <Group key={b.leader.id} title={`Reporting to ${b.leader.name}`} active={active} cardCount={cards.length}>
      {cards.map(({ card: c, heads }) => teamCard(b, c, heads, null))}
    </Group>
  );
  const pmActive = sectionActive(sections.pm);
  return (
    // Groups share a line when they fit, the same flow the Cards view uses. A
    // size container, so Execution can give way by the chart's width (see Part).
    <div className="@container flex flex-wrap items-start gap-x-5 gap-y-4">
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

      {groupBy === "leader" ? (
        // By reporting line: a group per leader, as before 2026-11-11.
        bands.map(({ band: b, cards }) => leaderGroup(b, cards, b.active))
      ) : (
        <>
          {functions.map((f) =>
            f.key === "execution" ? (
              // Execution in its parts, each headed and divided from the one before.
              // Below 1410px (see Part), Project management is drawn up beside Growth
              // instead (the group just before), and the count leaves it out.
              <Fragment key={f.key}>
                {f.sections.includes("pm") && (
                  <Group title="Project management" active={pmActive} cardCount={sections.pm.cards.length} className={PM_MOVED_UP}>
                    {sections.pm.cards.map(({ band: b, item }) => teamCard(b, item.card, item.heads, b.leader.name))}
                  </Group>
                )}
                <Group
                  title={f.title}
                  active={
                    pmActive > 0 ? (
                      <>
                        <span className={PM_IN_EXECUTION}>{f.active}</span>
                        <span className={PM_MOVED_UP}>{f.active - pmActive}</span>
                      </>
                    ) : (
                      f.active
                    )
                  }
                  cardCount={f.cards.length}
                  bare
                >
                  <div className={PARTS_ROW}>
                    {f.sections.map((k) => (
                      <Part key={k} label={PART_LABEL[k] ?? null} active={sectionActive(sections[k])} className={`${PART_WIDTH[k] ?? "flex-1"} ${k === "pm" ? PM_IN_EXECUTION : ""}`}>
                        {sections[k].cards.map(({ band: b, item }) => teamCard(b, item.card, item.heads, b.leader.name))}
                      </Part>
                    ))}
                  </div>
                </Group>
              </Fragment>
            ) : (
              <Group key={f.key} title={f.title} active={f.active} cardCount={f.cards.length}>
                {f.cards.map(({ band: b, item }) => teamCard(b, item.card, item.heads, b.leader.name))}
              </Group>
            ),
          )}

          {/* A team no function takes (lib/org-chart-groups.ts) stays in its leader's band. */}
          {other.map(({ band: b, cards }) => leaderGroup(b, cards, cards.reduce((n, x) => n + x.card.active, 0)))}
        </>
      )}

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
