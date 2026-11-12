"use client";

import type { CSSProperties, ReactNode } from "react";
import { card } from "@/components/ui/classnames";
import { usd, usdExact } from "@/components/ui/format";
import { fmtDate } from "@/lib/po-detail";
import { addDays, daysBetween, mondayOf, stackLines, timelineSlot, type OpenPoMoney, type OpenPoRow, type poDates } from "@/lib/open-pos-rules";

// ── Open POs timeline: when each PO is expected, per project or per supplier ─────────────
//
// Laid out like the Scheduler's timelines: a month and week header, a dashed Today line, one
// row per project (or supplier). Each PO still to arrive is a dot at its expected date. A PO
// the vendor re-promised also shows a hollow ring at its original due date, joined to the dot,
// so the slip is visible. Calendar weeks from this Monday, the same weeks as the chart above;
// anything due before them sits in the Late column, anything after in Later.

export const TIMELINE_WEEKS = 12;

export type TimelinePo = {
  row: OpenPoRow;
  money: OpenPoMoney;
  dates: ReturnType<typeof poDates>;
  /** Shown in the hover text: the supplier on project rows, the job on supplier rows. */
  other: string;
  /** Project rows: the row's job, so a click opens that job's view of the PO. */
  jobId?: string;
};

export type TimelineRow = { key: string; label: ReactNode; sublabel: string; title: string; pos: TimelinePo[] };

const LINE = 15; // px between stacked dots
const GAP_PCT = 1.6; // dots closer than this (% of the track) stack on the next line
const SIDE_PER_LINE = 4; // dots per line in the Late / Later columns

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const md = (day: string) => `${MONTHS[Number(day.slice(5, 7)) - 1]} ${Number(day.slice(8, 10))}`;

function dotClass(p: TimelinePo, today: string): string {
  if (!p.dates.expected) return "border border-sdc-gray-400 bg-white";
  if (p.dates.expected < today) return "bg-sdc-red";
  if (p.row.partiallyReceived) return "bg-sdc-yellow";
  return "bg-sdc-blue";
}

function tip(p: TimelinePo, today: string): string {
  const { expected, original, revised } = p.dates;
  const when = !expected
    ? "No expected date in Total ETO"
    : `${expected < today ? `Late: expected ${fmtDate(expected)}, ${daysBetween(expected, today)} days ago` : `Expected ${fmtDate(expected)}`}`;
  const slip = revised && original && original !== expected ? `. Originally due ${fmtDate(original)} (moved ${daysBetween(original, expected ?? original)} days)` : "";
  return `PO ${p.row.poNumber} · ${p.other}\n${when}${slip}\n${usdExact(p.money.notReceived)} not yet received. Click to open`;
}

function Dot({ p, today, onOpen, style }: { p: TimelinePo; today: string; onOpen: (r: OpenPoRow, jobId?: string) => void; style?: CSSProperties }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(p.row, p.jobId)}
      title={tip(p, today)}
      aria-label={`PO ${p.row.poNumber}, ${p.dates.expected ? `expected ${md(p.dates.expected)}` : "no date"}`}
      className={`z-[2] h-2.5 w-2.5 rounded-full ring-2 ring-white motion-interactive hover:scale-150 ${dotClass(p, today)}`}
      style={style}
    />
  );
}

function SideLane({ pos, today, onOpen }: { pos: TimelinePo[]; today: string; onOpen: (r: OpenPoRow, jobId?: string) => void }) {
  return (
    <div className="flex flex-wrap content-start justify-center gap-[5px] border-x border-sdc-border-soft bg-slate-50/60 px-1 py-[5px]">
      {pos.map((p) => (
        <Dot key={p.row.poNumber} p={p} today={today} onOpen={onOpen} />
      ))}
    </div>
  );
}

export function PoTimeline({ rows, asOf, onOpenPo, emptyText }: { rows: TimelineRow[]; asOf: string; onOpenPo: (r: OpenPoRow, jobId?: string) => void; emptyText: string }) {
  const start = mondayOf(asOf);
  const weekStarts = Array.from({ length: TIMELINE_WEEKS }, (_, i) => addDays(start, i * 7));
  const todayPct = timelineSlot(asOf, start, TIMELINE_WEEKS).pct;
  const grid = "minmax(160px, 220px) 72px minmax(0, 1fr) 72px";
  // A faint line at each week boundary, drawn as the track's background.
  const weekLines = {
    backgroundImage: `repeating-linear-gradient(to right, transparent 0, transparent calc(100% / ${TIMELINE_WEEKS} - 1px), rgb(226 232 240) calc(100% / ${TIMELINE_WEEKS} - 1px), rgb(226 232 240) calc(100% / ${TIMELINE_WEEKS}))`,
  };
  const todayLine = <div aria-hidden className="pointer-events-none absolute inset-y-0 z-[1] border-l border-dashed border-sdc-navy/60" style={{ left: `${todayPct}%` }} />;

  return (
    <section className={card("p-0 overflow-hidden")} aria-label="Timeline">
      {/* Header: months, then the week each column starts. */}
      <div className="grid border-b border-sdc-border bg-slate-100 text-note text-sdc-gray-600" style={{ gridTemplateColumns: grid }}>
        <span className="px-3 py-2 font-semibold" title="One row per project (or supplier), its POs still to arrive">
          {rows.length} {rows.length === 1 ? "row" : "rows"}
        </span>
        <span className="py-2 text-center font-bold text-red-700" title={`Expected before the week of ${md(start)} and still not here`}>
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
        <span className="py-2 text-center font-semibold" title={`Expected after ${md(addDays(start, TIMELINE_WEEKS * 7 - 1))}, or no date (hollow)`}>
          Later
        </span>
      </div>

      {rows.length === 0 && <p className="px-4 py-8 text-center text-sm text-sdc-gray-400">{emptyText}</p>}
      {rows.map((r) => {
        const late = r.pos.filter((p) => timelineSlot(p.dates.expected, start, TIMELINE_WEEKS).lane === "late");
        const later = r.pos.filter((p) => ["later", "none"].includes(timelineSlot(p.dates.expected, start, TIMELINE_WEEKS).lane));
        const onTrack = r.pos.filter((p) => timelineSlot(p.dates.expected, start, TIMELINE_WEEKS).lane === "track");
        const slots = onTrack.map((p) => timelineSlot(p.dates.expected, start, TIMELINE_WEEKS).pct);
        // Where each re-promised PO's line starts (its original date, or the track's edge).
        const froms = onTrack.map((p) => {
          const { revised, original, expected } = p.dates;
          if (!revised || !original || original === expected) return null;
          const o = timelineSlot(original, start, TIMELINE_WEEKS);
          return o.lane === "track" ? o.pct : o.lane === "late" ? 0 : 100;
        });
        const lines = stackLines(
          slots.map((at, i) => (froms[i] == null ? at : { from: froms[i]!, to: at })),
          GAP_PCT,
        );
        const trackLines = onTrack.length ? Math.max(...lines) + 1 : 1;
        const sideLines = Math.ceil(Math.max(late.length, later.length) / SIDE_PER_LINE) || 1;
        const height = Math.max(trackLines, sideLines) * LINE + 12;
        return (
          <div key={r.key} className="grid border-b border-sdc-border-soft last:border-b-0" style={{ gridTemplateColumns: grid }}>
            <div className="flex min-w-0 flex-col justify-center px-3 py-1.5 leading-tight" title={r.title}>
              <span className="truncate text-sm font-bold text-sdc-navy">{r.label}</span>
              <span className="truncate text-label text-sdc-gray-400">{r.sublabel}</span>
            </div>
            <SideLane pos={late} today={asOf} onOpen={onOpenPo} />
            <div className="relative" style={{ ...weekLines, height }}>
              {todayLine}
              {onTrack.map((p, i) => {
                const top = 6 + lines[i] * LINE;
                const at = slots[i];
                const { original } = p.dates;
                const from = froms[i];
                const orig = from != null ? timelineSlot(original, start, TIMELINE_WEEKS) : null;
                return (
                  <span key={p.row.poNumber}>
                    {from != null && (
                      <>
                        <span
                          aria-hidden
                          className="absolute h-px bg-sdc-blue/60"
                          style={{ left: `${Math.min(from, at)}%`, width: `${Math.abs(at - from)}%`, top: top + 5 }}
                        />
                        {/* At its date, or at the track's edge when it was due before (or after)
                            the weeks shown; the line still runs to where it is expected now. */}
                        <span
                          aria-hidden
                          title={`PO ${p.row.poNumber} was originally due ${fmtDate(original)}${orig!.lane === "track" ? "" : orig!.lane === "late" ? ", before the weeks shown" : ", after the weeks shown"}`}
                          className={`absolute h-2.5 w-2.5 rounded-full border-2 border-sdc-blue/70 bg-white ${orig!.lane === "track" ? "-translate-x-1/2" : orig!.lane === "late" ? "" : "-translate-x-full"}`}
                          style={{ left: `${from}%`, top }}
                        />
                      </>
                    )}
                    <Dot p={p} today={asOf} onOpen={onOpenPo} style={{ position: "absolute", left: `${at}%`, top, transform: "translateX(-50%)" }} />
                  </span>
                );
              })}
            </div>
            <SideLane pos={later} today={asOf} onOpen={onOpenPo} />
          </div>
        );
      })}

      <div className="flex flex-wrap items-center gap-4 border-t border-sdc-border bg-white px-3 py-2 text-note text-sdc-gray-600">
        <Legend cls="bg-sdc-red" label="Late" tip="Expected before today and not here" />
        <Legend cls="bg-sdc-yellow" label="Partly received" tip="Some of the order has arrived" />
        <Legend cls="bg-sdc-blue" label="On schedule" tip="Nothing here yet, and not late" />
        <Legend cls="border-2 border-sdc-blue/70 bg-white" label="Originally due" tip="Where a re-promised PO was first due; the line shows how far it moved" />
        <Legend cls="border border-sdc-gray-400 bg-white" label="No date" tip="Total ETO has no expected date for it (in Later)" />
        <span className="ml-auto text-sdc-gray-400" title="Click any dot to open its PO">
          Click a dot to open the PO · {usd(rows.reduce((s, r) => s + r.pos.reduce((a, p) => a + p.money.notReceived, 0), 0))} still to arrive
        </span>
      </div>
    </section>
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
