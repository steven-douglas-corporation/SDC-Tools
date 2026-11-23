"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { PanZoomCanvas, useCanvasCompact, type PanZoomHandle } from "@/components/PanZoomCanvas";
import type { RosterGroup } from "@/lib/org-chart-roster";
import type { OrgBand, OrgNode, OrgTeamCard } from "@/lib/org-chart";
import { sectionActive, type FunctionGroups } from "@/lib/org-chart-groups";
import { cardId } from "@/lib/org-chart-hiring";
import { countOrgNodes } from "@/lib/org-chart-search";

// ── The Org chart's Canvas view (2026-11-16, experimental) ──────────────────
//
// The function groups as a tree, laid out at a fixed width on a pan-and-zoom
// canvas (PanZoomCanvas.tsx), so nothing has to wrap to the page:
//
//                       [ Leadership ]
//                             │
//        ┌────────────────────┼────────────────────┐
//    [ Growth ]       [ Execution            ]   [ Support ]
//     stacked         [ Project management   ]    stacked
//                     [ Engineering│Operations]
//                        stacked     stacked
//
// Teams no function takes ("Reporting to X") and Not placed sit in a row under
// the tree. Same cards and hiring placement as the other views; OrgChart.tsx
// builds them and hands them over.
//
// What the canvas adds (2026-11-19):
//   - Collapse all (a button; was by zoom until 2026-11-20): every card is a
//     summary in large type (TeamCard `compact`), and a click on one expands
//     all and zooms to it. A search keeps full detail.
//   - A search doesn't remove anyone (that would move every card): non-matches
//     dim, and the canvas jumps between the matches.
//   - Reporting lines: the lines above only say which FUNCTION a card is in;
//     who its people actually report to is a line from that leader's row in
//     the Leadership card, drawn when pointing at a card's "Reports to" line
//     (or all of them, by the toggle).

type Item = { card: OrgTeamCard; heads: OrgNode[] };
type Placed = { band: OrgBand; item: Item };
export type TeamCardFn = (
  b: OrgBand,
  c: OrgTeamCard,
  heads: OrgNode[],
  reportsTo: string | null,
  compact: boolean,
) => React.ReactNode;

const CANVAS_COL = "flex w-[20rem] flex-col gap-3";
// Connectors, the classic CSS tree: each branch draws its share of the bar
// across the top (half of it at the two ends) and a drop to its own centre.
// The bar runs into the gap between branches (-left/-right = half of gap-10).
// (Written out in full: Tailwind only generates what it finds literally.)
const CANVAS_STEM = "h-8 border-l-[1.5px] border-sdc-gray-400";
const CANVAS_BRANCHES = "flex items-start justify-center gap-10";
const CANVAS_BRANCH =
  "relative pt-8 before:absolute before:-left-5 before:-right-5 before:top-0 before:border-t-[1.5px] before:border-sdc-gray-400 before:content-[''] first:before:left-1/2 last:before:right-1/2 after:absolute after:left-1/2 after:top-0 after:h-8 after:border-l-[1.5px] after:border-sdc-gray-400 after:content-['']";

// How many columns each part of Execution spreads its cards over on the canvas.
const CANVAS_PART_COLUMNS: Record<"engineering" | "operations", number> = { engineering: 2, operations: 3 };
const PART_LABEL = { engineering: "Engineering", operations: "Operations" } as const;

// Deals cards into `n` columns, each to the shortest so far, so the columns end
// up about even. A card's height is guessed from what it draws: a header's worth
// plus a row per person shown. In order, so teams still read left to right.
function balanceColumns<T extends { item: { heads: OrgNode[] } }>(cards: T[], n: number): T[][] {
  const cols = Array.from({ length: Math.max(1, Math.min(n, cards.length)) }, () => ({ height: 0, cards: [] as T[] }));
  for (const c of cards) {
    const shortest = cols.reduce((a, b) => (b.height < a.height ? b : a));
    shortest.cards.push(c);
    shortest.height += 4 + countOrgNodes(c.item.heads);
  }
  return cols.map((c) => c.cards);
}

function CanvasPanel({
  id,
  title,
  blurb,
  active,
  accent = false,
  dashed = false,
  children,
}: {
  id: string;
  title: string;
  blurb?: string;
  active?: number;
  /** Execution: tinted, the way the eye should be drawn. */
  accent?: boolean;
  dashed?: boolean;
  children: React.ReactNode;
}) {
  const compact = useCanvasCompact();
  return (
    <section
      data-canvas-item="panel"
      data-canvas-key={`panel:${id}`}
      className={`rounded-2xl border p-4 shadow-sm ${dashed ? "border-dashed" : ""} ${
        accent ? "border-sdc-green/50 bg-sdc-green-bg/70" : "border-sdc-border bg-white/80"
      }`}
    >
      <header className="mb-3 text-center">
        <h3 className={`font-heading font-bold text-sdc-navy ${compact ? "text-3xl" : "text-base"}`}>{title}</h3>
        <p className={`text-sdc-muted ${compact ? "text-2xl" : "text-xs"}`}>
          {blurb}
          {blurb && active != null && " · "}
          {active != null && `${active} active`}
        </p>
      </header>
      {children}
    </section>
  );
}

function CanvasLayout({ leadership, functions, sections, teamCard, others, notPlaced }: OrgChartCanvasProps) {
  const compact = useCanvasCompact();
  const card = ({ band: b, item }: Placed) => teamCard(b, item.card, item.heads, b.leader.name, compact);
  const parts = (["engineering", "operations"] as const).filter((k) => sections[k].cards.length > 0);
  const leadershipCard = leadership(compact);
  return (
    <div className="p-6">
      {leadershipCard && (
        <div className="flex flex-col items-center">
          {/* data-canvas-leaders: where the reporting lines start. */}
          <div data-canvas-leaders="" className="w-[20rem]">
            {leadershipCard}
          </div>
          {functions.length > 0 && <div className={CANVAS_STEM} />}
        </div>
      )}

      <div className={CANVAS_BRANCHES}>
        {functions.map((f) => (
          <div key={f.key} className={leadershipCard ? CANVAS_BRANCH : ""}>
            {f.key === "execution" ? (
              <CanvasPanel id={f.key} title={f.title} blurb={f.blurb} active={f.active} accent>
                {sections.pm.cards.length > 0 && (
                  // Project management sits across the top of the panel, centred,
                  // at most two columns wide (2026-11-19: spanning all five, it was
                  // ~1700px at 100%, and zooming to it left the names unreadable at
                  // the far edge). `w-0 min-w-full` on the row: as wide as the parts
                  // under it, without its own text widening the panel.
                  <div className={`flex justify-center gap-3 ${parts.length ? "w-0 min-w-full" : ""}`}>
                    {sections.pm.cards.map((c) => (
                      <div
                        key={cardId(c.band.leader.id, c.item.card.team)}
                        className={parts.length ? "min-w-0 max-w-[40.75rem] flex-1" : "w-[20rem]"}
                      >
                        {card(c)}
                      </div>
                    ))}
                  </div>
                )}
                {parts.length > 0 && (
                  <div className={`flex items-start gap-4 ${sections.pm.cards.length ? "mt-4" : ""}`}>
                    {parts.map((k) => (
                      <div key={k}>
                        <h4
                          className={`mb-2 text-center font-semibold text-sdc-navy ${compact ? "text-2xl" : "text-xs"}`}
                        >
                          {PART_LABEL[k]}
                          <span className="ml-2 font-normal text-sdc-gray-400">
                            {sectionActive(sections[k])} active
                          </span>
                        </h4>
                        <div className="flex items-start gap-3">
                          {balanceColumns(sections[k].cards, CANVAS_PART_COLUMNS[k]).map((col, i) => (
                            <div key={i} className={CANVAS_COL}>
                              {col.map(card)}
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CanvasPanel>
            ) : (
              <CanvasPanel id={f.key} title={f.title} blurb={f.blurb} active={f.active}>
                <div className={CANVAS_COL}>{f.cards.map(card)}</div>
              </CanvasPanel>
            )}
          </div>
        ))}
      </div>

      {(others.length > 0 || notPlaced) && (
        <div className="mt-12 flex items-start justify-center gap-10">
          {others.map(({ band: b, cards }) => (
            <CanvasPanel
              key={b.leader.id}
              id={`leader:${b.leader.id}`}
              title={`Reporting to ${b.leader.name}`}
              active={cards.reduce((n, x) => n + x.card.active, 0)}
            >
              <div className={CANVAS_COL}>
                {cards.map(({ card: c, heads }) => teamCard(b, c, heads, null, compact))}
              </div>
            </CanvasPanel>
          ))}
          {notPlaced && (
            <CanvasPanel id="not-placed" title="Not placed" dashed>
              <div className="w-[20rem]">{notPlaced}</div>
            </CanvasPanel>
          )}
        </div>
      )}
    </div>
  );
}

// ── Reporting lines ─────────────────────────────────────────────────────────
//
// From a leader's row in the Leadership card ([data-canvas-leaders]
// [data-canvas-person]) to each card of their band ([data-canvas-card-leader]).
// Pointing at a card's "Reports to" line draws its line and lights both ends;
// pointing at a leader draws all of theirs. Not the whole card: the pointer is
// nearly always over some card, and lines across the names at every move were
// noise (tried 2026-11-19). "Show reporting lines" draws every line, faintly.
//
// Measured from the DOM in the chart's own coordinates (unscaled), so the SVG
// sits in the content and pans and zooms with it. Only the SVG re-renders on a
// hover: the chart is `children`, the same element each time.
function ReportingLines({ showAll, children }: { showAll: boolean; children: React.ReactNode }) {
  const wrap = useRef<HTMLDivElement>(null);
  const compact = useCanvasCompact();
  const [hover, setHover] = useState<number | null>(null);
  const [lines, setLines] = useState<{ key: string; d: string; lit: boolean }[]>([]);

  const measure = useCallback(() => {
    const w = wrap.current;
    if (!w) return;
    const wr = w.getBoundingClientRect();
    const k = w.offsetWidth ? wr.width / w.offsetWidth : 1;
    const box = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { x: (r.left - wr.left) / k, y: (r.top - wr.top) / k, w: r.width / k, h: r.height / k };
    };
    w.querySelectorAll("[data-canvas-lit]").forEach((el) => el.removeAttribute("data-canvas-lit"));
    const leadersCard = w.querySelector("[data-canvas-leaders]");
    const out: { key: string; d: string; lit: boolean }[] = [];
    for (const card of w.querySelectorAll("[data-canvas-card-leader]")) {
      const leader = Number(card.getAttribute("data-canvas-card-leader"));
      const lit = leader === hover;
      if (!showAll && !lit) continue;
      // The leader's own row; failing that (not drawn), the Leadership card.
      const from = leadersCard?.querySelector(`[data-canvas-person="${leader}"]`) ?? leadersCard;
      if (!from) continue;
      const [a, b] = [box(from), box(card)];
      const [sx, sy, tx, ty] = [a.x + a.w, a.y + a.h / 2, b.x + b.w / 2, b.y];
      out.push({
        key: card.getAttribute("data-canvas-key") ?? String(out.length),
        lit,
        d: `M ${sx} ${sy} C ${sx + 160} ${sy}, ${tx} ${ty - 220}, ${tx} ${ty}`,
      });
      if (lit) {
        card.setAttribute("data-canvas-lit", "");
        from.setAttribute("data-canvas-lit", "");
      }
    }
    setLines(out);
  }, [hover, showAll]);

  // On a hover, a toggle, or a change of detail (the cards change size).
  useLayoutEffect(measure, [measure, compact]);
  // While every line is shown, follow the layout (a search, Show inactive).
  useEffect(() => {
    const w = wrap.current;
    if (!showAll || !w) return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(w);
    return () => ro.disconnect();
  }, [showAll, measure]);

  const onPointerOver = (e: React.PointerEvent) => {
    const t = e.target as HTMLElement;
    const card = t.closest("[data-canvas-reports-to]")?.closest("[data-canvas-card-leader]");
    const person = t.closest("[data-canvas-leaders] [data-canvas-person]");
    const raw = card?.getAttribute("data-canvas-card-leader") ?? person?.getAttribute("data-canvas-person");
    const id = raw ? Number(raw) : null;
    // A leader only counts if they have cards to draw to.
    const next = id != null && wrap.current?.querySelector(`[data-canvas-card-leader="${id}"]`) ? id : null;
    if (next !== hover) setHover(next);
  };

  return (
    <div ref={wrap} className="relative" onPointerOver={onPointerOver} onPointerLeave={() => setHover(null)}>
      {children}
      <svg aria-hidden className="pointer-events-none absolute left-0 top-0 overflow-visible" width={1} height={1}>
        {lines.map((l) => (
          <path
            key={l.key}
            data-canvas-lit={l.lit ? "" : undefined}
            d={l.d}
            fill="none"
            vectorEffect="non-scaling-stroke"
            strokeWidth={l.lit ? 2.5 : 1.5}
            strokeDasharray={l.lit ? undefined : "6 4"}
            className={l.lit ? "stroke-sdc-blue" : "stroke-sdc-blue/40"}
          />
        ))}
      </svg>
    </div>
  );
}

// ── People list (2026-11-19) ────────────────────────────────────────────────
//
// A sidebar down the canvas's right: everyone by group, then team, in each
// card's own order (lib/org-chart-roster.ts). A click jumps the canvas to the person and
// rings their row. Hidden or shown per browser, like other display preferences.

const PEOPLE_OPEN_KEY = "sdc-org-canvas-people-open";
const PEOPLE_OPEN_EVENT = "sdc-org-canvas-people-change";
function readPeopleOpen(): boolean {
  try {
    return window.localStorage.getItem(PEOPLE_OPEN_KEY) !== "0";
  } catch {
    return true;
  }
}
function writePeopleOpen(open: boolean) {
  try {
    window.localStorage.setItem(PEOPLE_OPEN_KEY, open ? "1" : "0");
  } catch {
    // Storage off: the choice just isn't remembered.
  }
  window.dispatchEvent(new Event(PEOPLE_OPEN_EVENT));
}
function subscribePeopleOpen(onChange: () => void) {
  window.addEventListener(PEOPLE_OPEN_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(PEOPLE_OPEN_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

function PeopleSidebar({
  roster,
  open,
  searching,
  selected,
  onPick,
}: {
  roster: RosterGroup[];
  open: boolean;
  searching: boolean;
  selected: number | null;
  onPick: (id: number) => void;
}) {
  // data-no-pan: presses in here aren't the canvas's drags.
  if (!open) {
    return (
      <div data-no-pan className="hidden w-9 shrink-0 flex-col items-center border-l border-sdc-border bg-white py-2 sm:flex">
        <button
          type="button"
          onClick={() => writePeopleOpen(true)}
          title="Show the list of everyone, by team"
          className="rounded px-1 py-2 text-xs font-semibold text-sdc-gray-600 [writing-mode:vertical-rl] motion-interactive hover:bg-sdc-gray-50 hover:text-sdc-navy"
        >
          Show people
        </button>
      </div>
    );
  }
  const total = roster.reduce((n, g) => n + g.count, 0);
  return (
    <aside data-no-pan className="hidden w-64 shrink-0 flex-col border-l border-sdc-border bg-white sm:flex">
      <header className="flex items-center justify-between gap-2 border-b border-sdc-border px-3 py-2">
        <h3 className="text-sm font-semibold text-sdc-navy">
          People <span className="font-normal text-sdc-muted">{total}</span>
        </h3>
        <button
          type="button"
          onClick={() => writePeopleOpen(false)}
          className="rounded px-1.5 py-0.5 text-xs font-semibold text-sdc-gray-600 motion-interactive hover:bg-sdc-gray-50 hover:text-sdc-navy"
        >
          Hide
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
        <p className="px-1.5 pt-2 text-note text-sdc-muted">
          {searching ? "Matches only. " : ""}By team, in the same order as the cards. Click a name to find them.
        </p>
        {roster.length === 0 && <p className="px-1.5 pt-3 text-xs text-sdc-muted">No one matches.</p>}
        {roster.map((g) => (
          <details key={g.key} open className="group/people mt-2">
            {/* Three tiers, three looks: a group is a shaded band (Execution green,
                as its panel), a team its card's own header colours, a person plain. */}
            <summary
              className={`flex cursor-pointer list-none items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-bold motion-interactive [&::-webkit-details-marker]:hidden ${
                g.key === "execution"
                  ? "bg-sdc-green-bg text-sdc-green-text hover:bg-sdc-green-bg/70"
                  : "bg-sdc-gray-100 text-sdc-navy hover:bg-sdc-gray-50"
              }`}
            >
              <span aria-hidden className="opacity-60 motion-interactive group-open/people:rotate-90">
                ›
              </span>
              {g.title}
              <span className="ml-auto font-normal opacity-70">{g.count}</span>
            </summary>
            {g.teams.map((t) => (
              <div key={t.key} className="mt-1">
                {/* A group of one team named the same (Leadership, Not placed) needs no second heading. */}
                {t.title !== g.title && (
                  <h4
                    className="mx-1 mb-0.5 mt-1.5 flex items-center rounded px-1.5 py-0.5 text-note font-semibold"
                    style={t.colors ? { background: t.colors.bg, color: t.colors.text } : undefined}
                  >
                    {t.title}
                    <span className="ml-auto font-normal opacity-70">{t.count}</span>
                  </h4>
                )}
                {t.sections.map((sec) => (
                  <div key={sec.label ?? "tree"}>
                    {/* The card's own parts, labelled as the card labels them. */}
                    {sec.label && (
                      <p className="px-1.5 pt-1.5 text-label font-semibold uppercase tracking-wider text-sdc-muted">
                        {sec.label}
                      </p>
                    )}
                    <ul>
                      {sec.people.map((p) => (
                        <li key={p.id}>
                          <button
                            type="button"
                            aria-current={selected === p.id ? "true" : undefined}
                            onClick={() => onPick(p.id)}
                            // Indented by depth in the card's tree, as the card draws it.
                            style={{ paddingLeft: `${0.375 + Math.min(p.level, 4) * 0.75}rem` }}
                            className={`flex w-full flex-col rounded py-1 pr-1.5 text-left motion-interactive hover:bg-sdc-gray-50 ${
                              selected === p.id ? "bg-sdc-blue-light" : ""
                            } ${p.active ? "" : "opacity-60"}`}
                          >
                            <span
                              className={`truncate text-sm text-sdc-navy ${p.level === 0 && !sec.label ? "font-semibold" : ""}`}
                            >
                              {p.name}
                              {!p.active && <span className="ml-1 text-note font-normal text-sdc-muted">inactive</span>}
                            </span>
                            {p.title && <span className="truncate text-note text-sdc-muted">{p.title}</span>}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            ))}
          </details>
        ))}
      </div>
    </aside>
  );
}

export type OrgChartCanvasProps = {
  /** The Leadership card, as a summary or in full; null when a search leaves no one on it. */
  leadership: (compact: boolean) => React.ReactNode;
  functions: { key: string; title: string; blurb: string; active: number; cards: Placed[] }[];
  sections: FunctionGroups<Item>["sections"];
  teamCard: TeamCardFn;
  /** Teams no function takes, by band. */
  others: { band: OrgBand; cards: Item[] }[];
  notPlaced: React.ReactNode;
};

export function OrgChartCanvas({
  query,
  roster,
  ...layout
}: OrgChartCanvasProps & { query: string; roster: RosterGroup[] }) {
  const [showAll, setShowAll] = useState(false);
  const needle = query.trim();
  const canvas = useRef<PanZoomHandle>(null);
  const peopleOpen = useSyncExternalStore(subscribePeopleOpen, readPeopleOpen, () => true);
  // Who was picked from the list, under which search: a new search moves the
  // ring to its own matches, so the pick no longer stands.
  const [picked, setPicked] = useState<{ id: number; needle: string } | null>(null);
  const selected = picked && picked.needle === needle ? picked.id : null;
  const onPick = (id: number) => {
    setPicked({ id, needle });
    canvas.current?.focus(`[data-canvas-person="${id}"]`);
  };
  return (
    <PanZoomCanvas
      ref={canvas}
      sidebar={
        <PeopleSidebar roster={roster} open={peopleOpen} searching={!!needle} selected={selected} onPick={onPick} />
      }
      className="h-[max(30rem,calc(var(--app-vh)-16rem))]"
      storageKey="sdc-org-canvas-view-v1"
      allowCompact={!needle}
      matchKey={needle}
      exportTitle="Org chart"
      toolbar={
        <div className="flex overflow-hidden rounded-lg border border-sdc-border bg-white shadow-sm">
          <button
            type="button"
            aria-pressed={showAll}
            onClick={() => setShowAll((x) => !x)}
            title="Lines from each leader to the cards of the people reporting to them. Point at a card's “Reports to” line to see just its own."
            className={`flex h-8 items-center px-2 text-xs font-semibold motion-interactive ${
              showAll
                ? "bg-sdc-blue-light text-sdc-blue-dark"
                : "text-sdc-gray-600 hover:bg-sdc-gray-50 hover:text-sdc-navy"
            }`}
          >
            {showAll ? "Hide reporting lines" : "Show reporting lines"}
          </button>
        </div>
      }
    >
      <ReportingLines showAll={showAll}>
        <CanvasLayout {...layout} />
      </ReportingLines>
    </PanZoomCanvas>
  );
}
