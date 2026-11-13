"use client";

import { useState, type CSSProperties, type ReactNode } from "react";
import { card, TOOLBAR_BTN_COMPACT, TOOLBAR_BTN_NEUTRAL } from "@/components/ui/classnames";
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
      className={`z-[2] h-2.5 w-2.5 rounded-full ring-2 ring-white motion-interactive hover:scale-150 ${dotClass(p, today, by)}`}
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
}: {
  rows: TimelineRow[];
  asOf: string;
  onOpenPo: (r: OpenPoRow, jobId?: string) => void;
  emptyText: string;
  dotsBy: DotsBy;
  requiredState: RequiredState;
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const start = mondayOf(asOf);
  const slot = (day: string | null) => timelineSlot(day, start, TIMELINE_WEEKS);
  const weekStarts = Array.from({ length: TIMELINE_WEEKS }, (_, i) => addDays(start, i * 7));
  const todayPct = slot(asOf).pct;
  const grid = `minmax(180px, 240px) ${SIDE}px minmax(0, 1fr) ${SIDE}px`;
  // A faint line at each week boundary, drawn as the track's background.
  const weekLines = {
    backgroundImage: `repeating-linear-gradient(to right, transparent 0, transparent calc(100% / ${TIMELINE_WEEKS} - 1px), rgb(226 232 240) calc(100% / ${TIMELINE_WEEKS} - 1px), rgb(226 232 240) calc(100% / ${TIMELINE_WEEKS}))`,
  };
  const todayLine = <div aria-hidden className="pointer-events-none absolute inset-y-0 z-[1] border-l border-dashed border-sdc-navy/60" style={{ left: `${todayPct}%` }} />;
  const sideCell = "border-x border-sdc-border-soft bg-slate-50/60";
  const toggle = (key: string) =>
    setCollapsed((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const byExpected = (a: TimelinePo, b: TimelinePo) => (a.dates.expected ?? "9999").localeCompare(b.dates.expected ?? "9999");

  return (
    <section className={card("p-0 overflow-hidden")} aria-label="Timeline">
      {/* Header: months, then the week each column starts. */}
      <div className="grid border-b border-sdc-border bg-slate-100 text-note text-sdc-gray-600" style={{ gridTemplateColumns: grid }}>
        <span className="flex flex-col justify-center gap-1 px-3 py-1.5">
          <span className="font-semibold" title="One group per project (or supplier), one row per PO still to arrive">
            {rows.length} {rows.length === 1 ? "group" : "groups"} · {rows.reduce((n, r) => n + r.pos.length, 0)} POs
          </span>
          <span className="flex gap-1">
            <button type="button" onClick={() => setCollapsed(new Set())} title="Show every PO's own row" className={`${TOOLBAR_BTN_COMPACT} ${TOOLBAR_BTN_NEUTRAL} !h-6 !px-2`}>
              Expand all
            </button>
            <button
              type="button"
              onClick={() => setCollapsed(new Set(rows.map((r) => r.key)))}
              title="One row of dots per group"
              className={`${TOOLBAR_BTN_COMPACT} ${TOOLBAR_BTN_NEUTRAL} !h-6 !px-2`}
            >
              Collapse all
            </button>
          </span>
        </span>
        <span className="self-center text-center font-bold text-red-700" title={`Expected before the week of ${md(start)} and still not here`}>
          Late
        </span>
        {/* Three tiers so nothing overlaps: month, the day each week starts, Today. */}
        <div className="relative h-[3.25rem]" style={weekLines}>
          {weekStarts.map((w, i) =>
            i === 0 || w.slice(8, 10) <= "07" ? (
              <span key={`m${w}`} className="absolute top-1 font-semibold text-sdc-navy" style={{ left: `calc(${(i / TIMELINE_WEEKS) * 100}% + 4px)` }}>
                {MONTHS[Number(w.slice(5, 7)) - 1]}
              </span>
            ) : null,
          )}
          {weekStarts.map((w, i) => (
            <span
              key={w}
              className="absolute top-[1.15rem] text-label text-sdc-gray-400"
              style={{ left: `calc(${(i / TIMELINE_WEEKS) * 100}% + 4px)` }}
              title={`Week of ${md(w)} to ${md(addDays(w, 6))}`}
            >
              {Number(w.slice(8, 10))}
            </span>
          ))}
          {todayLine}
          <span className="absolute bottom-0.5 z-[1] -translate-x-1/2 rounded bg-sdc-navy px-1 text-micro font-bold text-white" style={{ left: `${todayPct}%` }} title={`Today, ${md(asOf)}`}>
            Today
          </span>
        </div>
        <span className="self-center text-center font-semibold" title={`Expected after ${md(addDays(start, TIMELINE_WEEKS * 7 - 1))}, or no date (hollow)`}>
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
              <div className="grid bg-slate-50" style={{ gridTemplateColumns: grid }}>
                {groupLabel}
                <div className={sideCell} />
                <div className="relative" style={weekLines}>
                  {todayLine}
                </div>
                <div className={sideCell} />
              </div>
              {[...r.pos].sort(byExpected).map((p) => (
                <PoRow key={p.row.poNumber} p={p} asOf={asOf} slot={slot} grid={grid} weekLines={weekLines} todayPct={todayPct} sideCell={sideCell} dotsBy={dotsBy} requiredState={requiredState} onOpenPo={onOpenPo} />
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
          <div key={r.key} className="grid border-b border-sdc-border last:border-b-0" style={{ gridTemplateColumns: grid }}>
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

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-sdc-border bg-white px-3 py-2 text-note text-sdc-gray-600">
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
        <Legend cls="border border-sdc-gray-400 bg-white" label="No date" tip="Total ETO has no expected date for it (in Later)" />
        <span className="inline-flex items-center gap-1.5" title="When the BOM needs the part. The line runs from the dot (expected) to here: green if it arrives in time, red if after">
          <span aria-hidden className="inline-block h-2 w-2 rotate-45 border-2 border-sdc-gray-600 bg-white" />
          Required by the BOM
        </span>
        {requiredState !== "ok" && (
          <span className={requiredState === "failed" ? "text-sdc-red-text" : "text-sdc-gray-400"}>
            {requiredState === "loading" ? "Loading required dates…" : "Required dates couldn't be read from Total ETO"}
          </span>
        )}
        <span className="ml-auto text-sdc-gray-400" title="Click any dot to open its PO">
          Click a dot to open the PO · {usd(rows.reduce((s, r) => s + r.pos.reduce((a, p) => a + p.money.notReceived, 0), 0))} still to arrive
        </span>
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
  todayPct,
  sideCell,
  dotsBy,
  requiredState,
  onOpenPo,
}: {
  p: TimelinePo;
  asOf: string;
  slot: (day: string | null) => TimelineSlot;
  grid: string;
  weekLines: CSSProperties;
  todayPct: number;
  sideCell: string;
  dotsBy: DotsBy;
  requiredState: RequiredState;
  onOpenPo: (r: OpenPoRow, jobId?: string) => void;
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
    <div className="grid border-t border-sdc-border-soft/60 hover:bg-sdc-blue-light/30" style={{ gridTemplateColumns: grid, height: PO_ROW }}>
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
        <div aria-hidden className="pointer-events-none absolute inset-y-0 z-[1] border-l border-dashed border-sdc-navy/60" style={{ left: `${todayPct}%` }} />
      </div>
      <div className={sideCell} style={{ gridRow: 1, gridColumn: 4 }} />
      {/* The dot, diamond and line, over all three columns. */}
      <div className="pointer-events-none relative" style={{ gridRow: 1, gridColumn: "2 / 5" }}>
        {v && left && right && (
          <span aria-hidden className={`absolute top-1/2 h-0.5 -translate-y-1/2 ${lineColor}`} style={{ left, width: `calc((${right}) - (${left}))` }} />
        )}
        {xQ && (
          <span
            title={requiredText(p, requiredState)}
            className={`pointer-events-auto absolute top-1/2 z-[2] h-2 w-2 -translate-x-1/2 -translate-y-1/2 rotate-45 border-2 bg-white ${mark}`}
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

function Legend({ cls, label, tip }: { cls: string; label: string; tip: string }) {
  return (
    <span className="inline-flex items-center gap-1.5" title={tip}>
      <span className={`inline-block h-2.5 w-2.5 rounded-full ${cls}`} />
      {label}
    </span>
  );
}
