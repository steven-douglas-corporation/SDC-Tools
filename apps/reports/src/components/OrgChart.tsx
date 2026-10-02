import { card } from "@/components/ui/classnames";
import { SectionTitle } from "@/components/ui/Typography";
import { EmptyState } from "@/components/ui/EmptyState";
import { teamColors } from "@/lib/employee-card-theme";
import type { OrgChart as OrgChartData, OrgNode } from "@/lib/org-chart";

// The Org Chart page (2026-10-02): the "SDC Team Branches" chart drawn from live
// data — Leadership centred on top, then a band per leader with a card per
// team, each card the branch heads and everyone under them on connector lines.
// No hooks: the hover notes are CSS (group-hover / focus), so it renders as a
// server or a client component. The Employees page uses it as a view. Data
// and the rule behind the teams: lib/org-chart.ts.

// Connectors: an elbow into each person, and a trunk down past every sibling
// but the last. Pseudo-elements, so the tree is plain nested lists.
const TREE_UL = "mt-1.5 ml-[7px] grid gap-1.5 pl-4";
const TREE_LI =
  "relative before:absolute before:-left-4 before:-top-1.5 before:h-4 before:w-[11px] before:rounded-bl-[5px] before:border-b-[1.5px] before:border-l-[1.5px] before:border-sdc-gray-400 before:content-[''] not-last:after:absolute not-last:after:-left-4 not-last:after:top-2.5 not-last:after:-bottom-1.5 not-last:after:border-l-[1.5px] not-last:after:border-sdc-gray-400 not-last:after:content-['']";

function Note({ text }: { text: string }) {
  return (
    <span
      tabIndex={0}
      role="note"
      aria-label={text}
      className="group/note inline-grid size-[15px] flex-none cursor-help place-items-center rounded-full border border-sdc-yellow-text font-mono text-label font-bold italic leading-none text-sdc-yellow-text focus-visible:outline-2 focus-visible:outline-sdc-blue"
    >
      i
      <span className="pointer-events-none absolute bottom-[calc(100%+4px)] left-0 z-10 w-max max-w-full rounded bg-sdc-navy px-2 py-1 font-sans text-note font-medium not-italic leading-snug text-white opacity-0 shadow-sm motion-interactive group-hover/note:opacity-100 group-focus/note:opacity-100">
        {text}
      </span>
    </span>
  );
}

type Select = ((id: number) => void) | undefined;

function Person({ n, root, onSelect }: { n: OrgNode; root?: boolean; onSelect: Select }) {
  const nameCls = `text-sm text-sdc-navy ${root || n.isHead ? "font-semibold" : "font-medium"}`;
  return (
    <div className="relative grid gap-px">
      <span className="flex items-center gap-1.5">
        {onSelect ? (
          <button type="button" onClick={() => onSelect(n.id)} className={`${nameCls} rounded-sm text-left hover:text-sdc-blue hover:underline focus-visible:outline-2 focus-visible:outline-sdc-blue`}>
            {n.name}
          </button>
        ) : (
          <span className={nameCls}>{n.name}</span>
        )}
        {n.note && <Note text={n.note} />}
      </span>
      <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-sdc-gray-600">
        {n.title && <span>{n.title}</span>}
        {n.positionCode && <span className="font-mono text-[0.7rem]">{n.positionCode}</span>}
        {n.override && (
          <span className="rounded border border-sdc-gray-400 px-1 text-label font-semibold" title="Family from the overrides file">
            override
          </span>
        )}
      </span>
    </div>
  );
}

function Tree({ nodes, roots, onSelect }: { nodes: OrgNode[]; roots?: boolean; onSelect: Select }) {
  return (
    <ul className={roots ? "grid gap-2.5" : TREE_UL}>
      {nodes.map((n) => (
        <li key={n.id} className={roots ? "" : TREE_LI}>
          <Person n={n} root={roots} onSelect={onSelect} />
          {n.reports.length > 0 && <Tree nodes={n.reports} onSelect={onSelect} />}
        </li>
      ))}
    </ul>
  );
}

function TeamCard({ team, title, count, children, className = "" }: { team: string | null; title: string; count: number; children: React.ReactNode; className?: string }) {
  const c = teamColors(team);
  return (
    <article className={`rounded-xl border border-sdc-border bg-white shadow-sm ${className}`}>
      <div className="flex items-baseline justify-between gap-2 rounded-t-xl px-3 py-2" style={{ background: c.bg, color: c.text }}>
        <h3 className="font-heading text-sm font-bold">{title}</h3>
        <span className="font-mono text-xs tabular-nums">{count}</span>
      </div>
      <div className="px-3 pt-2.5 pb-3">{children}</div>
    </article>
  );
}

/** `onSelectPerson` makes each name a button (the Employees page opens that person's panel). */
export function OrgChart({ chart, onSelectPerson }: { chart: OrgChartData; onSelectPerson?: (id: number) => void }) {
  if (!chart.ready) {
    return (
      <EmptyState
        title="Position families haven't been imported yet"
        message="The chart needs Paylocity's Position_Families file. Once the hourly sync has read it (see Data Quality › Position families), this page fills in."
      />
    );
  }
  return (
    <div className="grid gap-8">
      <section className="flex justify-center" aria-label="Executive Leadership">
        <TeamCard team="exec" title="Executive Leadership" count={chart.leaderCount} className="w-full max-w-sm">
          <Tree nodes={chart.leaders} roots onSelect={onSelectPerson} />
        </TeamCard>
      </section>

      {chart.bands.map((b) => (
        <section key={b.leader.id} className="grid gap-3">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b-2 border-sdc-navy pb-1.5">
            <SectionTitle>Reporting to {b.leader.name}</SectionTitle>
            <span className="text-sm text-sdc-gray-600 tabular-nums">
              {b.leader.title ? `${b.leader.title} · ` : ""}
              {b.people} {b.people === 1 ? "person" : "people"}
            </span>
          </div>
          <div className="grid items-start gap-3.5 [grid-template-columns:repeat(auto-fill,minmax(270px,1fr))]">
            {b.cards.map((c) => (
              <TeamCard key={c.team ?? "none"} team={c.team} title={c.name} count={c.people}>
                <Tree nodes={c.heads} roots onSelect={onSelectPerson} />
              </TeamCard>
            ))}
          </div>
        </section>
      ))}

      {chart.unplaced.length > 0 && (
        <section className="grid gap-3">
          <div className="flex flex-wrap items-baseline gap-x-3 border-b-2 border-sdc-navy pb-1.5">
            <SectionTitle>Not placed</SectionTitle>
            <span className="text-sm text-sdc-gray-600">no Leadership above them — their team is left as it is</span>
          </div>
          <div className={`${card("p-0")} max-w-xl divide-y divide-sdc-border-soft`}>
            {chart.unplaced.map((u) => (
              <div key={u.name} className="grid gap-px px-3 py-2">
                <span className="text-sm font-medium text-sdc-navy">{u.name}</span>
                <span className="text-xs text-sdc-gray-600">{[u.title, u.detail].filter(Boolean).join(" · ")}</span>
              </div>
            ))}
          </div>
        </section>
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
      {pending.length > 0 && (
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
      )}
    </section>
  );
}
