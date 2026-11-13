"use client";

import { useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import { card, TOOLBAR_BTN_ACTIVE, TOOLBAR_BTN_COMPACT, TOOLBAR_BTN_NEUTRAL } from "@/components/ui/classnames";
import { usd, usdExact } from "@/components/ui/format";
import { fmtDate } from "@/lib/po-detail";
import { addDays, daysBetween, mondayOf, stackLines, timelineSlot, vsRequired, type OpenPoMoney, type OpenPoRow, type PoDates, type TimelineSlot } from "@/lib/open-pos-rules";

// ── Open POs timeline: when each PO is expected, against when the BOM needs it ─────────────
//
// Laid out like the Scheduler's timelines: a month and week header, a dashed Today line,
// calendar weeks from this Monday (the same weeks as the chart above). Anything before them
// sits in the Late column, anything after in Later.
//
// One group per project (or supplier), expanded by default into one row per PO. A PO row is
// two points: a dot at the date it is expected (its next line still to arrive) and a diamond
// at the date the BOM needs that same line's part, joined by a line, green when it arrives on
// or before that day and red when after. Collapsed, a group is one row of dots, as before.
//
// The dots are coloured by status (late, partly received, on schedule) or, with the toggle,
// the same green / red as their line. Both are offered so the two can be tried side by side.

export const TIMELINE_WEEKS = 12;

export type TimelinePo = {
  row: OpenPoRow;
  money: OpenPoMoney;
  dates: PoDates;
  /** Shown beside the PO number and in the hover text: the supplier on project rows, the job on supplier rows. */
  other: string;
  /** Project rows: the row's job, so a click opens that job's view of the PO. */
  jobId?: string;
};

export type TimelineRow = { key: string; label: ReactNode; sublabel: string; title: string; pos: TimelinePo[] };

/** What the dots' colour says. */
export type DotsBy = "status" | "required";
/** Whether the BOM's required dates have arrived (they are read when the timeline opens). */
export type RequiredState = "loading" | "ok" | "failed";

const LINE = 15; // px between stacked dots in a collapsed group
const GAP_PCT = 1.6; // dots closer than this (% of the track) stack on the next line
const SIDE_PER_LINE = 4; // dots per line in the Late / Later columns
const SIDE = 72; // px, the Late and Later columns
const PO_ROW = 24; // px, one PO row
const MIN_FILL = 360; // px, the shortest the timeline gets when filling the window

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const md = (day: string) => `${MONTHS[Number(day.slice(5, 7)) - 1]} ${Number(day.slice(8, 10))}`;
const days = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;

function statusClass(p: TimelinePo, today: string): string {
  if (!p.dates.expected) return "border border-sdc-gray-400 bg-white";
  if (p.dates.expected < today) return "bg-sdc-red";
  if (p.row.partiallyReceived) return "bg-sdc-yellow";
  return "bg-sdc-blue";
}

function dotClass(p: TimelinePo, today: string, by: DotsBy): string {
  if (by === "status") return statusClass(p, today);
  if (!p.dates.expected) return "border border-sdc-gray-400 bg-white";
  const v = vsRequired(p.dates.expected, p.dates.required);
  return v == null ? "bg-sdc-gray-400" : v.onTime ? "bg-green-600" : "bg-red-600";
}

function requiredText(p: TimelinePo, state: RequiredState): string {
  if (state === "loading") return "Required date: loading from the BOM";
  if (state === "failed") return "Required date: couldn't be read from the BOM";
  const { expected, required } = p.dates;
  if (!required) return "Not on the job's BOM, so there is no required date";
  const v = vsRequired(expected, required);
  if (!v) return `Required by the BOM ${fmtDate(required)}`;
  return `Required by the BOM ${fmtDate(required)}: ${v.days === 0 ? "arrives the day it's needed" : v.onTime ? `arrives ${days(v.days)} before it's needed` : `arrives ${days(v.days)} after it's needed`}`;
}

function tip(p: TimelinePo, today: string, state: RequiredState): string {
  const { expected, original, revised } = p.dates;
  const when = !expected
    ? "No expected date in Total ETO"
    : expected < today
      ? `Late: expected ${fmtDate(expected)}, ${days(daysBetween(expected, today))} ago`
      : `Expected ${fmtDate(expected)}`;
  const slip = revised && original && original !== expected ? ` (re-promised; the PO first asked for ${fmtDate(original)})` : "";
  return `PO ${p.row.poNumber} · ${p.other}\n${when}${slip}\n${requiredText(p, state)}\n${usdExact(p.money.notReceived)} not yet received. Click to open`;
}

function Dot({
  p,
  today,
  by,
  state,
  onOpen,
  style,
}: {
  p: TimelinePo;
  today: string;
  by: DotsBy;
  state: RequiredState;
  onOpen: (r: OpenPoRow, jobId?: string) => void;
  style?: CSSProperties;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(p.row, p.jobId)}
      title={tip(p, today, state)}
      aria-label={`PO ${p.row.poNumber}, ${p.dates.expected ? `expected ${md(p.dates.expected)}` : "no date"}`}
      className={`z-[2] h-2.5 w-2.5 rounded-full ring-2 ring-white motion-timeline-move hover:ring-sdc-navy ${dotClass(p, today, by)}`}
      style={style}
    />
  );
}

/**
 * Where a date sits across the Late column, the track and the Later column, as a CSS left
 * offset inside a box spanning all three. `f` places it inside a side column (0 to 1).
 */
function xOf(slot: TimelineSlot, f = 0.5): string {
  if (slot.lane === "late") return `${f * SIDE}px`;
  if (slot.lane === "track") return `calc(${SIDE}px + (100% - ${2 * SIDE}px) * ${slot.pct / 100})`;
  return `calc(100% - ${SIDE}px + ${f * SIDE}px)`;
}

export function PoTimeline({
  rows,
  asOf,
  onOpenPo,
  emptyText,
  dotsBy,
  requiredState,
  controls,
}: {
  rows: TimelineRow[];
  asOf: string;
  onOpenPo: (r: OpenPoRow, jobId?: string) => void;
  emptyText: string;
  dotsBy: DotsBy;
  requiredState: RequiredState;
  /** The page's own controls for this view (group order, dot colour), shown in the timeline's bar. */
  controls?: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  // Zoom (weeks shown) and pan (weeks from this Monday). Calendar weeks either way.
  const [weeks, setWeeks] = useState<number>(TIMELINE_WEEKS);
  const [offset, setOffset] = useState(0);
  // The PO under the pointer: it stands out wherever it appears (a PO split across jobs is
  // on several rows), and the rest dims.
  const [hoverPo, setHoverPo] = useState<string | null>(null);
  const thisMonday = mondayOf(asOf);
  const start = addDays(thisMonday, offset * 7);
  const end = addDays(start, weeks * 7 - 1);
  const slot = (day: string | null) => timelineSlot(day, start, weeks);
  const weekStarts = Array.from({ length: weeks }, (_, i) => addDays(start, i * 7));
  const todaySlot = slot(asOf);
  const todayPct = todaySlot.pct;
  const todayShown = todaySlot.lane === "track";
  // Every week's start date while there is room for it; every other one when zoomed out.
  const labelEvery = weeks > 16 ? 2 : 1;
  const grid = `minmax(180px, 240px) ${SIDE}px minmax(0, 1fr) ${SIDE}px`;
  // A faint line at each week boundary, drawn as the track's background.
  const weekLines = {
    backgroundImage: `repeating-linear-gradient(to right, transparent 0, transparent calc(100% / ${weeks} - 1px), rgb(226 232 240) calc(100% / ${weeks} - 1px), rgb(226 232 240) calc(100% / ${weeks}))`,
  };
  const todayLine = todayShown ? (
    <div aria-hidden className="pointer-events-none absolute inset-y-0 z-[1] border-l border-dashed border-sdc-navy/60 motion-timeline-move" style={{ left: `${todayPct}%` }} />
  ) : null;

  // ── Drag to pan ─────────────────────────────────────────────────────────────────
  // Press anywhere on the timeline and drag sideways: it moves a whole week at a time, by
  // the width of one week on screen. A press that doesn't move is still a click (a dot, a
  // PO, an arrow); one that did move swallows the click that follows, so letting go over a
  // dot doesn't also open it. No wheel / trackpad panning: wheel handling belongs to
  // ScrollHandoff alone (tests/scroll-handoff.test.ts), and drag plus ◂ ▸ cover it.
  const trackRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; offset: number; moved: boolean } | null>(null);
  const swallowClick = useRef(false);
  const [dragging, setDragging] = useState(false);
  const weekPx = () => (trackRef.current?.clientWidth ?? 600) / weeks;
  const onPointerDown = (e: PointerEvent<HTMLElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("[data-no-pan]")) return;
    drag.current = { x: e.clientX, offset, moved: false };
  };
  const onPointerMove = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    if (!d.moved && Math.abs(dx) < 5) return;
    if (!d.moved) {
      d.moved = true;
      setDragging(true);
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    setOffset(d.offset - Math.round(dx / weekPx()));
  };
  const onPointerUp = () => {
    if (drag.current?.moved) swallowClick.current = true;
    drag.current = null;
    setDragging(false);
  };
  const onClickCapture = (e: MouseEvent<HTMLElement>) => {
    if (!swallowClick.current) return;
    swallowClick.current = false;
    e.stopPropagation();
    e.preventDefault();
  };

  const sideCell = "border-x border-sdc-border-soft bg-slate-50/60";
  const toggle = (key: string) =>
    setCollapsed((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const byExpected = (a: TimelinePo, b: TimelinePo) => (a.dates.expected ?? "9999").localeCompare(b.dates.expected ?? "9999");

  // ── Fill the rest of the window, without the page scrolling ─────────────────────
  // The timeline takes whatever height is left below everything above it, less whatever
  // follows it on the page, so the page itself doesn't scroll and the rows scroll inside
  // (under a sticky week header). Measured in screen px and converted to the section's own
  // CSS px, because the app's zoom makes the two differ. One correction pass trims any
  // overflow the estimate left (the page's own bottom padding). Never under MIN_FILL px.
  const sectionRef = useRef<HTMLElement>(null);
  const [fillHeight, setFillHeight] = useState<number | null>(null);
  const pad = useRef(0);
  useLayoutEffect(() => {
    const el = sectionRef.current;
    const parent = el?.parentElement;
    if (!el || !parent) return;
    const scroller = scrollParent(el);
    const isDoc = scroller === document.scrollingElement;
    let frame = 0;
    const measure = (correct: boolean) => {
      const r = el.getBoundingClientRect();
      const sEl = el.offsetHeight ? r.height / el.offsetHeight : 1;
      const sr = scroller.getBoundingClientRect();
      const sSc = isDoc || !scroller.offsetHeight ? 1 : sr.height / scroller.offsetHeight;
      const viewTop = isDoc ? 0 : sr.top;
      const view = scroller.clientHeight * sSc;
      if (correct) {
        const over = (scroller.scrollHeight - scroller.clientHeight) * sSc;
        if (over > 0.5) pad.current += over;
      }
      const topInContent = r.top - viewTop + scroller.scrollTop * sSc;
      const after = parent.getBoundingClientRect().bottom - r.bottom;
      const h = Math.max(MIN_FILL, Math.floor((view - topInContent - after - pad.current) / sEl));
      setFillHeight(h);
    };
    const run = () => {
      cancelAnimationFrame(frame);
      measure(false);
      frame = requestAnimationFrame(() => measure(true));
    };
    run();
    const ro = new ResizeObserver(run);
    ro.observe(scroller);
    for (const sib of Array.from(parent.children)) if (sib !== el) ro.observe(sib);
    window.addEventListener("resize", run);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      window.removeEventListener("resize", run);
    };
  }, []);

  const atToday = offset === 0;
  const ctl = `${TOOLBAR_BTN_COMPACT} !h-7 !px-2`;

  return (
    <section
      ref={sectionRef}
      className={card(`flex flex-col p-0 overflow-hidden select-none ${dragging ? "cursor-grabbing" : "cursor-grab"}`)}
      style={{ height: fillHeight ?? undefined }}
      aria-label="Timeline"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onClickCapture={onClickCapture}
      onMouseLeave={() => setHoverPo(null)}
    >
      {/* Controls: rows on the left, zoom and pan on the right. Not a drag handle. */}
      <div data-no-pan className="flex cursor-default flex-wrap items-center gap-2 border-b border-sdc-border bg-white px-3 py-2 text-note text-sdc-gray-600">
        <span className="font-semibold" title="One group per project (or supplier), one row per PO still to arrive">
          {rows.length} {rows.length === 1 ? "group" : "groups"} · {rows.reduce((n, r) => n + r.pos.length, 0)} POs
        </span>
        <button type="button" onClick={() => setCollapsed(new Set())} title="Show every PO's own row" className={`${ctl} ${TOOLBAR_BTN_NEUTRAL}`}>
          Expand all
        </button>
        <button type="button" onClick={() => setCollapsed(new Set(rows.map((r) => r.key)))} title="One row of dots per group" className={`${ctl} ${TOOLBAR_BTN_NEUTRAL}`}>
          Collapse all
        </button>
        {controls && (
          <>
            <span aria-hidden className="hidden h-6 w-px bg-sdc-border sm:block" />
            <span className="flex flex-wrap items-center gap-x-4 gap-y-2">{controls}</span>
          </>
        )}
        <span className="ml-auto flex items-center gap-1" role="group" aria-label="Move the weeks shown">
          <button type="button" onClick={() => setOffset((o) => o - Math.max(1, Math.floor(weeks / 4)))} title="Earlier weeks (or drag the timeline to the right)" aria-label="Earlier weeks" className={`${ctl} ${TOOLBAR_BTN_NEUTRAL}`}>
            ◂
          </button>
          <button
            type="button"
            onClick={() => setOffset(0)}
            disabled={atToday}
            title={atToday ? "Already starting this week" : "Back to this week"}
            className={`${ctl} ${TOOLBAR_BTN_NEUTRAL} disabled:opacity-50`}
          >
            Today
          </button>
          <button type="button" onClick={() => setOffset((o) => o + Math.max(1, Math.floor(weeks / 4)))} title="Later weeks (or drag the timeline to the left)" aria-label="Later weeks" className={`${ctl} ${TOOLBAR_BTN_NEUTRAL}`}>
            ▸
          </button>
          <span className="ml-1 tabular-nums text-sdc-gray-400" title="The weeks shown">
            {md(start)} – {md(end)}
          </span>
        </span>
        <span className="flex items-center gap-1" role="group" aria-label="Weeks shown">
          {[4, 8, 12, 26].map((n) => (
            <button
              key={n}
              type="button"
              aria-pressed={weeks === n}
              onClick={() => setWeeks(n)}
              title={`Show ${n} weeks`}
              className={`${ctl} ${weeks === n ? TOOLBAR_BTN_ACTIVE : TOOLBAR_BTN_NEUTRAL}`}
            >
              {n}w
            </button>
          ))}
        </span>
      </div>

      {/* Below the controls: the weeks and rows (scrolling under a sticky header), then the key. */}
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-y-auto styled-scrollbar">
      {/* Header: months, then the week each column starts. */}
      <div className="sticky top-0 z-[5] grid border-b border-sdc-border bg-slate-100 text-note text-sdc-gray-600" style={{ gridTemplateColumns: grid }}>
        <span className="self-center px-3 text-label text-sdc-gray-400" title="Drag the timeline sideways to move through the weeks">
          Weeks of
        </span>
        <span
          className={`self-center text-center font-bold ${atToday ? "text-red-700" : "text-sdc-gray-600"}`}
          title={atToday ? `Expected before the week of ${md(start)} and still not here` : `Expected before ${md(start)}`}
        >
          {atToday ? "Late" : "Earlier"}
        </span>
        {/* Three tiers so nothing overlaps: month, the day each week starts, Today. */}
        <div ref={trackRef} className="relative h-[3.25rem] overflow-hidden" style={weekLines}>
          {weekStarts.map((w, i) =>
            i === 0 || w.slice(8, 10) <= "07" ? (
              <span key={`m${w}`} className="absolute top-1 whitespace-nowrap font-semibold text-sdc-navy" style={{ left: `calc(${(i / weeks) * 100}% + 4px)` }}>
                {MONTHS[Number(w.slice(5, 7)) - 1]}
                {w.slice(5, 7) === "01" || i === 0 ? ` '${w.slice(2, 4)}` : ""}
              </span>
            ) : null,
          )}
          {weekStarts.map((w, i) =>
            i % labelEvery === 0 ? (
              <span
                key={w}
                className="absolute top-[1.15rem] text-label text-sdc-gray-400"
                style={{ left: `calc(${(i / weeks) * 100}% + 4px)` }}
                title={`Week of ${md(w)} to ${md(addDays(w, 6))}`}
              >
                {Number(w.slice(8, 10))}
              </span>
            ) : null,
          )}
          {todayLine}
          {todayShown && (
            <span className="absolute bottom-0.5 z-[1] -translate-x-1/2 rounded bg-sdc-navy px-1 text-micro font-bold text-white" style={{ left: `${todayPct}%` }} title={`Today, ${md(asOf)}`}>
              Today
            </span>
          )}
        </div>
        <span className="self-center text-center font-semibold" title={`Expected after ${md(end)}, or no date (hollow)`}>
          Later
        </span>
      </div>

      {rows.length === 0 && <p className="px-4 py-8 text-center text-sm text-sdc-gray-400">{emptyText}</p>}
      {rows.map((r) => {
        const open = !collapsed.has(r.key);
        const groupLabel = (
          <button
            type="button"
            onClick={() => toggle(r.key)}
            aria-expanded={open}
            title={`${r.title}. Click the arrow to ${open ? "collapse to one row of dots" : "show each PO's row"}`}
            className="flex min-w-0 items-start gap-1.5 px-3 py-1.5 text-left leading-tight"
          >
            <span aria-hidden className="mt-0.5 w-3 shrink-0 text-sdc-gray-400">{open ? "▾" : "▸"}</span>
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-bold text-sdc-navy">{r.label}</span>
              <span className="truncate text-label text-sdc-gray-400">{r.sublabel}</span>
            </span>
          </button>
        );

        if (open) {
          return (
            <div key={r.key} className="border-b border-sdc-border last:border-b-0">
              <div className="grid bg-slate-50" style={{ gridTemplateColumns: grid }} onMouseEnter={() => setHoverPo(null)}>
                {groupLabel}
                <div className={sideCell} />
                <div className="relative" style={weekLines}>
                  {todayLine}
                </div>
                <div className={sideCell} />
              </div>
              {[...r.pos].sort(byExpected).map((p) => (
                <PoRow
                  key={p.row.poNumber}
                  p={p}
                  asOf={asOf}
                  slot={slot}
                  grid={grid}
                  weekLines={weekLines}
                  todayLine={todayLine}
                  sideCell={sideCell}
                  dotsBy={dotsBy}
                  requiredState={requiredState}
                  onOpenPo={onOpenPo}
                  hover={hoverPo == null ? null : hoverPo === p.row.poNumber}
                  onHover={setHoverPo}
                />
              ))}
            </div>
          );
        }

        // Collapsed: one row of dots, stacked where they would overlap, as before.
        const late = r.pos.filter((p) => slot(p.dates.expected).lane === "late");
        const later = r.pos.filter((p) => ["later", "none"].includes(slot(p.dates.expected).lane));
        const onTrack = r.pos.filter((p) => slot(p.dates.expected).lane === "track");
        const slots = onTrack.map((p) => slot(p.dates.expected).pct);
        const lines = stackLines(slots, GAP_PCT);
        const trackLines = onTrack.length ? Math.max(...lines) + 1 : 1;
        const sideLines = Math.ceil(Math.max(late.length, later.length) / SIDE_PER_LINE) || 1;
        const height = Math.max(trackLines, sideLines) * LINE + 12;
        const side = (pos: TimelinePo[]) => (
          <div className={`flex flex-wrap content-start justify-center gap-[5px] px-1 py-[5px] ${sideCell}`}>
            {pos.map((p) => (
              <Dot key={p.row.poNumber} p={p} today={asOf} by={dotsBy} state={requiredState} onOpen={onOpenPo} />
            ))}
          </div>
        );
        return (
          <div key={r.key} className="grid border-b border-sdc-border last:border-b-0" style={{ gridTemplateColumns: grid }} onMouseEnter={() => setHoverPo(null)}>
            {groupLabel}
            {side(late)}
            <div className="relative" style={{ ...weekLines, height }}>
              {todayLine}
              {onTrack.map((p, i) => (
                <Dot
                  key={p.row.poNumber}
                  p={p}
                  today={asOf}
                  by={dotsBy}
                  state={requiredState}
                  onOpen={onOpenPo}
                  style={{ position: "absolute", left: `${slots[i]}%`, top: 6 + lines[i] * LINE, transform: "translateX(-50%)" }}
                />
              ))}
            </div>
            {side(later)}
          </div>
        );
      })}

        </div>

        {/* The key, down the right side. Not a drag handle. */}
        <aside data-no-pan aria-label="Key" className="flex w-48 shrink-0 cursor-default flex-col gap-4 overflow-y-auto border-l border-sdc-border bg-white px-3 py-3 text-note text-sdc-gray-600">
          <KeyGroup title="Dots" tip={dotsBy === "status" ? "Coloured by where the PO stands" : "Coloured like the line: does it arrive before the BOM needs it?"}>
            {dotsBy === "status" ? (
              <>
                <Legend cls="bg-sdc-red" label="Late" tip="Expected before today and not here" />
                <Legend cls="bg-sdc-yellow" label="Partly received" tip="Some of the order has arrived" />
                <Legend cls="bg-sdc-blue" label="On schedule" tip="Nothing here yet, and not late" />
              </>
            ) : (
              <>
                <Legend cls="bg-green-600" label="Arrives in time" tip="Expected on or before the day the BOM needs it" />
                <Legend cls="bg-red-600" label="Arrives after it's needed" tip="Expected after the day the BOM needs it" />
                <Legend cls="bg-sdc-gray-400" label="No required date" tip="Not on the job's BOM" />
              </>
            )}
            <Legend cls="border border-sdc-gray-400 bg-white" label="No expected date" tip="Total ETO has no expected date for it (in Later)" />
          </KeyGroup>
          <KeyGroup title="Lines" tip="Each PO row runs from when it's expected (the dot) to when the BOM needs it (the diamond)">
            <span className="inline-flex items-center gap-1.5" title="When the BOM needs the part">
              <span aria-hidden className="inline-block h-2 w-2 shrink-0 rotate-45 border-2 border-sdc-gray-600 bg-white" />
              Required by the BOM
            </span>
            <span className="inline-flex items-center gap-1.5" title="Expected on or before the day the BOM needs it">
              <span aria-hidden className="inline-block h-0.5 w-4 shrink-0 bg-green-600" />
              Arrives in time
            </span>
            <span className="inline-flex items-center gap-1.5" title="Expected after the day the BOM needs it">
              <span aria-hidden className="inline-block h-0.5 w-4 shrink-0 bg-red-600" />
              Arrives after it&apos;s needed
            </span>
            {requiredState !== "ok" && (
              <span className={requiredState === "failed" ? "text-sdc-red-text" : "text-sdc-gray-400"}>
                {requiredState === "loading" ? "Loading required dates…" : "Required dates couldn't be read from Total ETO"}
              </span>
            )}
          </KeyGroup>
          <KeyGroup title="Using it" tip="How to move around the timeline">
            <span>Drag sideways to move through the weeks</span>
            <span>Hover a PO to pick it out</span>
            <span>Click a dot or PO number to open it</span>
          </KeyGroup>
          <span className="mt-auto border-t border-sdc-border-soft pt-2 text-sdc-gray-400" title="Value not yet received on the POs shown, at PO price">
            <span className="block font-heading text-base font-bold tabular-nums text-sdc-navy">
              {usd(rows.reduce((s, r) => s + r.pos.reduce((a, p) => a + p.money.notReceived, 0), 0))}
            </span>
            still to arrive
          </span>
        </aside>
      </div>
    </section>
  );
}

// One PO: its label, then a box across Late, the track and Later holding the dot (expected),
// the diamond (required) and the line between them.
function PoRow({
  p,
  asOf,
  slot,
  grid,
  weekLines,
  todayLine,
  sideCell,
  dotsBy,
  requiredState,
  onOpenPo,
  hover,
  onHover,
}: {
  p: TimelinePo;
  asOf: string;
  slot: (day: string | null) => TimelineSlot;
  grid: string;
  weekLines: CSSProperties;
  todayLine: ReactNode;
  sideCell: string;
  dotsBy: DotsBy;
  requiredState: RequiredState;
  onOpenPo: (r: OpenPoRow, jobId?: string) => void;
  /** True: this PO is under the pointer (on this row or another). False: another PO is. Null: none. */
  hover: boolean | null;
  onHover: (po: string | null) => void;
}) {
  const { expected, required } = p.dates;
  const e = slot(expected);
  const q = required ? slot(required) : null;
  const v = vsRequired(expected, required);
  // Both in the same side column: the earlier one to the left of the later one.
  const same = q && e.lane !== "track" && e.lane === q.lane;
  const fE = same ? (v?.onTime ? 0.3 : 0.7) : 0.5;
  const fQ = same ? (v?.onTime ? 0.7 : 0.3) : 0.5;
  const xE = xOf(e.lane === "none" ? { lane: "later", pct: 0 } : e, fE);
  const xQ = q ? xOf(q, fQ) : null;
  const [left, right] = v ? (v.onTime ? [xE, xQ!] : [xQ!, xE]) : [null, null];
  const lineColor = v ? (v.onTime ? "bg-green-600/70" : "bg-red-600/70") : "";
  const mark = v ? (v.onTime ? "border-green-600" : "border-red-600") : "border-sdc-gray-600";
  return (
    <div
      className={`grid border-t border-sdc-border-soft/60 motion-timeline-move ${hover ? "bg-sdc-blue-light/60" : hover === false ? "opacity-35" : ""}`}
      style={{ gridTemplateColumns: grid, height: PO_ROW }}
      onMouseEnter={() => onHover(p.row.poNumber)}
    >
      <button
        type="button"
        onClick={() => onOpenPo(p.row, p.jobId)}
        title={tip(p, asOf, requiredState)}
        className="flex min-w-0 items-center gap-2 pl-8 pr-2 text-left"
        style={{ gridRow: 1, gridColumn: 1 }}
      >
        <span className="shrink-0 font-mono text-note font-semibold text-sdc-blue underline decoration-dotted underline-offset-2">{p.row.poNumber}</span>
        <span className="truncate text-label text-sdc-gray-600">{p.other}</span>
      </button>
      <div className={sideCell} style={{ gridRow: 1, gridColumn: 2 }} />
      <div className="relative" style={{ ...weekLines, gridRow: 1, gridColumn: 3 }}>
        {todayLine}
      </div>
      <div className={sideCell} style={{ gridRow: 1, gridColumn: 4 }} />
      {/* The dot, diamond and line, over all three columns. */}
      <div className="pointer-events-none relative" style={{ gridRow: 1, gridColumn: "2 / 5" }}>
        {v && left && right && (
          <span aria-hidden className={`absolute top-1/2 -translate-y-1/2 motion-timeline-move ${hover ? "h-1" : "h-0.5"} ${lineColor}`} style={{ left, width: `calc((${right}) - (${left}))` }} />
        )}
        {xQ && (
          <span
            title={requiredText(p, requiredState)}
            className={`pointer-events-auto absolute top-1/2 z-[2] h-2 w-2 -translate-x-1/2 -translate-y-1/2 rotate-45 border-2 bg-white motion-timeline-move ${mark}`}
            style={{ left: xQ }}
          />
        )}
        <Dot
          p={p}
          today={asOf}
          by={dotsBy}
          state={requiredState}
          onOpen={onOpenPo}
          style={{ position: "absolute", left: xE, top: "50%", transform: "translate(-50%, -50%)", pointerEvents: "auto" }}
        />
      </div>
    </div>
  );
}

/** The element whose scrolling moves `el`: the nearest ancestor that scrolls vertically, else the page. */
function scrollParent(el: HTMLElement): HTMLElement {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === "auto" || oy === "scroll") && p.clientHeight > 0) return p;
  }
  return (document.scrollingElement as HTMLElement) ?? document.documentElement;
}

function KeyGroup({ title, tip, children }: { title: string; tip: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-micro font-bold uppercase tracking-wider text-sdc-gray-400" title={tip}>
        {title}
      </span>
      {children}
    </div>
  );
}

function Legend({ cls, label, tip }: { cls: string; label: string; tip: string }) {
  return (
    <span className="inline-flex items-center gap-1.5" title={tip}>
      <span className={`inline-block h-2.5 w-2.5 rounded-full ${cls}`} />
      {label}
    </span>
  );
}
