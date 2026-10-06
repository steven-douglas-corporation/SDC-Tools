import { EmptyState } from "@/components/ui/EmptyState";
import { card } from "@/components/ui/classnames";
import { resolveEmployeeGroup } from "@/lib/employee-card-theme";
import type { OrgChart as OrgChartData, OrgNode } from "@/lib/org-chart";
import { DepartmentCardHeader, EmployeePersonRow, HandPlacedSection, TempsSection } from "@/components/EmployeePersonRow";
import { isPaylocityId, comparePositionCode, type EmployeeRow } from "@/lib/employee-row";
import { employeeCapacityHours } from "@/lib/workforce-capacity";
import { hasYearPolicy } from "@/lib/workforce-capacity-policy";
import { hours as fmtHours } from "@/components/ui/format";
import type { CapacityDrillTarget } from "@/components/WorkforceSummaryCards";

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
          <EmployeePersonRow p={row} cardTitle={cardTitle} onSelect={ctx.onSelect} note={n.note} />
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
            <EmployeePersonRow p={row} cardTitle={cardTitle} onSelect={ctx.onSelect} note={n.note} hideLeadershipBadge={ctx.leadershipCard} />
            {n.reports.length > 0 && <Tree nodes={n.reports} cardTitle={cardTitle} ctx={ctx} nested />}
          </li>
        );
      })}
    </ul>
  );
}

// The Cards view's card, minus hiring (switched off — lib/hiring-feature.ts).
// Not overflow-hidden like Cards': a hover note on the first row would be clipped.
function TeamCard({
  team,
  count,
  nodes,
  ctx,
  children,
}: {
  team: string | null;
  count: number;
  /** The card's tree, for its capacity drill. */
  nodes: OrgNode[];
  ctx: Ctx;
  children: (title: string) => React.ReactNode;
}) {
  const group = team ? resolveEmployeeGroup({ team }) : null;
  const title = group?.title ?? "No team";
  // The same "current hrs/yr" line a Cards card carries: active people × the
  // year's hours per person, and a click opens the breakdown by employee.
  const hasCapacityPolicy = ctx.year != null && hasYearPolicy(ctx.year);
  return (
    <section className="flex flex-col rounded-xl border border-sdc-border bg-white shadow-sm">
      <DepartmentCardHeader title={title} colors={group?.colors ?? { bg: "#e2e8f0", text: "#1e293b" }} isAi={group?.key === "ai"} className="rounded-t-[11px]" />
      <div className="flex items-baseline gap-1.5 border-b border-sdc-border bg-sdc-gray-50 px-3.5 py-1.5 text-xs text-sdc-muted">
        <span className="font-bold tabular-nums text-sdc-navy">{count}</span>
        <span>active</span>
      </div>
      {hasCapacityPolicy && ctx.onSelectCapacity && (
        <button
          type="button"
          onClick={() => ctx.onSelectCapacity!({ title: `${title} — Capacity`, employees: rowsIn(nodes, ctx.people), hiringPositions: [] })}
          title="See how this capacity total was built, by employee and open position"
          className="flex items-baseline gap-1.5 border-b border-sdc-border bg-sdc-gray-50 px-3.5 py-1.5 text-left text-xs text-sdc-muted hover:bg-sdc-blue-light/30"
        >
          <span className="font-bold tabular-nums text-sdc-navy">{fmtHours(employeeCapacityHours(count, ctx.year!))}</span>
          <span>current hrs/yr</span>
        </button>
      )}
      {children(title)}
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
}: {
  chart: OrgChartData;
  people: Map<number, EmployeeRow>;
  onSelectPerson?: (row: EmployeeRow) => void;
  /** With onSelectCapacity: each card shows its current hrs/yr and opens the breakdown. */
  year?: number;
  onSelectCapacity?: (target: CapacityDrillTarget) => void;
}) {
  if (!chart.ready) {
    return (
      <EmptyState
        title="Position families haven't been imported yet"
        message="The chart needs Paylocity's Position_Families file. Once the hourly sync has read it (see Data Quality › Position families), this view fills in."
      />
    );
  }
  const ctx: Ctx = { people, onSelect: onSelectPerson, year, onSelectCapacity };
  return (
    // Groups share a line when they fit, the same flow the Cards view uses.
    <div className="flex flex-wrap items-start gap-x-5 gap-y-4">
      <Group title="Leadership" active={chart.leaderCount} cardCount={1}>
        <TeamCard team="exec" count={chart.leaderCount} nodes={chart.leaders} ctx={ctx}>
          {(title) => <Tree nodes={chart.leaders} cardTitle={title} ctx={{ ...ctx, leadershipCard: true }} />}
        </TeamCard>
      </Group>

      {chart.bands.map((b) => (
        <Group key={b.leader.id} title={`Reporting to ${b.leader.name}`} active={b.people} cardCount={b.cards.length}>
          {b.cards.map((c) => (
            <TeamCard key={c.team ?? "none"} team={c.team} count={c.people} nodes={c.heads} ctx={ctx}>
              {(title) => <CardBody nodes={c.heads} cardTitle={title} ctx={ctx} />}
            </TeamCard>
          ))}
        </Group>
      ))}

      {chart.unplaced.length > 0 && (
        <Group title="Not placed" active={chart.unplaced.length} cardCount={1}>
          <section className="flex flex-col rounded-xl border border-dashed border-sdc-border bg-white">
            <p className="rounded-t-[11px] border-b border-sdc-border bg-sdc-gray-50 px-3.5 py-1.5 text-xs text-sdc-muted">
              No Leadership above them — their team is left as it is
            </p>
            <ul className="p-1.5">
              {chart.unplaced.map((u) => {
                const row = people.get(u.id);
                return row ? (
                  <li key={u.id}>
                    <EmployeePersonRow p={row} cardTitle="" onSelect={onSelectPerson} note={u.detail} />
                  </li>
                ) : null;
              })}
            </ul>
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
