"use client";

import { useEffect, useMemo, useState, useSyncExternalStore, useTransition } from "react";
import { loadKeyDates } from "@/lib/key-dates-actions";
import { KEY_DATE_ANCHORS, type KeyDatesResult, type KeyDateRow } from "@/lib/key-dates-anchors";
import { readKeyDates, serverKeyDates, subscribeKeyDates, writeKeyDates } from "@/lib/key-dates-prefs";

// ── Key Dates: the execution timeline that replaced the month grid ──────────
//
// The Dashboard used to show a month-cell calendar of FATs and Customer Visits.
// A boxed month answers "what is happening on the 9th"; the question this
// section is actually for is "which machines are approaching which milestone,
// and is anything late" — which is a timeline, one row per project·machine, time
// running left to right.
//
// Deliberately the same view the SDC Scheduler already calls "Key Dates", down
// to the anchor list and the green-done / red-late / blue-upcoming diamonds, so
// the Dashboard and the Scheduler are two windows onto one schedule rather than
// two opinions about it. The milestones come from the Scheduler's own
// `tasks.anchor_key` (lib/dashboard-key-dates.ts).
//
// ── Positioning ─────────────────────────────────────────────────────────────
//
// Markers are placed by PERCENTAGE across the selected range, inside one
// relatively-positioned track per row, with the month gridlines drawn from the
// same percentages. So the axis, the gridlines, the today line and every diamond
// derive from a single date->offset function and cannot drift apart. The track
// gets a min-width, which is what makes a long range scroll horizontally instead
// of compressing until the dates are unreadable.

const MS_DAY = 86_400_000;
/** Enough width per month that "Mech 1 · 09/08" stays readable; the track scrolls past this. */
const MIN_MONTH_PX = 260;
/** What the server's first paint asked for — see getDashboardOverview. */
const DEFAULT_ANCHOR = "mech_release_1";


function ymOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function addMonths(ym: string, n: number): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return ymOf(d);
}
/** Local midnight for a "YYYY-MM-DD" — never Date.parse, which reads it as UTC and can shift the day. */
function dayMs(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).getTime();
}
function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let cur = from;
  // Bounded by the action's own 24-month cap; the guard is belt-and-braces
  // against a bad preference in localStorage.
  for (let i = 0; i < 36 && cur <= to; i++) {
    out.push(cur);
    cur = addMonths(cur, 1);
  }
  return out;
}
function shortDate(iso: string): string {
  return `${iso.slice(5, 7)}/${iso.slice(8, 10)}`;
}
function monthLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleString("en-US", { month: "short" }) + (m === 1 ? ` ${y}` : "");
}

export function KeyDatesTimeline({ initial }: { initial: KeyDatesResult }) {
  // Chips and range live in the browser, like the Scheduler's own Key Dates —
  // a per-person view preference, not something to put in the URL where it would
  // travel into a shared Dashboard link.
  //
  // Read through useSyncExternalStore, not restored with a setState in an effect:
  // localStorage is invisible to the server, so reading it in render hydrates
  // differently from the HTML, and restoring it in an effect shows the default
  // for a frame on every load. Same primitive, same reason, as AppZoom.
  const stored = useSyncExternalStore(subscribeKeyDates, readKeyDates, serverKeyDates);
  // The store holds "" for a range nobody has chosen yet, so the server's own
  // opening window fills in. Done here rather than by writing the defaults into
  // the store during render — that would be a side effect in render, and it would
  // also persist a range the user never picked.
  const prefs = {
    anchors: stored.anchors,
    from: stored.from || initial.from,
    to: stored.to || initial.to,
  };
  const { anchors, from, to } = prefs;
  const [data, setData] = useState<KeyDatesResult>(initial);
  const [pending, start] = useTransition();

  // Refetch whenever the selection changes. The FIRST render already has its
  // data from the server (`initial`), so this only fires once the stored
  // preference differs from the defaults that produced it.
  const signature = `${from}|${to}|${[...anchors].sort().join(",")}`;
  // What the server already answered for. `initial` was built with the default
  // anchor and the default window, so while the selection still matches that,
  // refetching would ask the same question twice.
  const servedSignature = `${initial.from}|${initial.to}|${DEFAULT_ANCHOR}`;
  useEffect(() => {
    if (signature === servedSignature) return;
    start(async () => {
      try {
        setData(await loadKeyDates(from, to, anchors));
      } catch {
        // Keep what is on screen rather than blanking it: the range inputs are
        // the only way back, and they need the component to still be there.
      }
    });
    // `signature` is the whole dependency — the three values it is built from.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  const months = useMemo(() => monthsBetween(from <= to ? from : to, from <= to ? to : from), [from, to]);
  const spanStartMs = useMemo(() => dayMs(`${months[0] ?? from}-01`), [months, from]);
  const spanEndMs = useMemo(() => {
    const last = months[months.length - 1] ?? to;
    return dayMs(`${addMonths(last, 1)}-01`);
  }, [months, to]);
  const spanMs = Math.max(spanEndMs - spanStartMs, MS_DAY);

  /** Where a date sits across the track, 0–100. The one function the axis, the gridlines and every marker use. */
  const pct = (iso: string) => ((dayMs(iso) - spanStartMs) / spanMs) * 100;

  const todayIso = useMemo(() => {
    const n = new Date();
    return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
  }, []);
  const todayPct = pct(todayIso);
  const todayVisible = todayPct >= 0 && todayPct <= 100;

  const toggle = (key: string) =>
    writeKeyDates({
      ...prefs,
      anchors: anchors.includes(key) ? anchors.filter((k) => k !== key) : [...anchors, key],
    });

  const trackMinWidth = Math.max(months.length * MIN_MONTH_PX, 480);

  return (
    <div className="min-w-0">
      {/* ── Controls: milestone chips, then the month range ── */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {KEY_DATE_ANCHORS.map((a) => {
            const on = anchors.includes(a.key);
            // An anchor with nothing in the current range is dimmed rather than
            // hidden: "Panel Ready has no data" is information, and a chip that
            // vanishes reads as a bug.
            const empty = !data.presentAnchors.includes(a.key);
            return (
              <button
                key={a.key}
                type="button"
                onClick={() => toggle(a.key)}
                aria-pressed={on}
                title={empty ? `${a.short} — nothing scheduled in this range` : `Show or hide ${a.short}`}
                className={`rounded-full border px-2.5 py-1 text-note font-semibold motion-interactive ${
                  on
                    ? "border-sdc-blue bg-sdc-blue text-white"
                    : `border-sdc-border bg-white hover:bg-sdc-blue-light/30 ${empty ? "text-sdc-gray-400" : "text-sdc-gray-700"}`
                }`}
              >
                {a.short}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-2 text-note text-sdc-gray-600">
          <label className="flex items-center gap-1.5">
            From
            <input
              type="month"
              value={from}
              onChange={(e) => e.target.value && writeKeyDates({ ...prefs, from: e.target.value })}
              className="rounded-md border border-sdc-border px-2 py-1 text-sdc-navy"
            />
          </label>
          <label className="flex items-center gap-1.5">
            To
            <input
              type="month"
              value={to}
              onChange={(e) => e.target.value && writeKeyDates({ ...prefs, to: e.target.value })}
              className="rounded-md border border-sdc-border px-2 py-1 text-sdc-navy"
            />
          </label>
        </div>
      </div>

      {!data.schedulerAvailable ? (
        <p className="rounded-lg border border-sdc-yellow bg-sdc-yellow-bg px-3 py-2 text-note text-sdc-yellow-text">
          The Scheduler could not be reached, so no milestones can be shown. This is not the same as there being none.
        </p>
      ) : anchors.length === 0 ? (
        <p className="rounded-lg border border-sdc-border bg-sdc-gray-50 px-3 py-2 text-note text-sdc-gray-600">
          Pick a milestone above to see it across every project.
        </p>
      ) : data.rows.length === 0 ? (
        <p className="rounded-lg border border-sdc-border bg-sdc-gray-50 px-3 py-2 text-note text-sdc-gray-600">
          Nothing scheduled for {anchors.length === 1 ? "that milestone" : "those milestones"} between{" "}
          {monthLabel(months[0] ?? from)} and {monthLabel(months[months.length - 1] ?? to)}.
        </p>
      ) : (
        <div className={`overflow-x-auto rounded-xl border border-sdc-border bg-white ${pending ? "opacity-60" : ""}`}>
          {/* One grid, two columns: a sticky label column and the scrolling track.
              Both header and rows use the same template, so the axis stays aligned
              with the diamonds under it at any scroll position. */}
          <div style={{ minWidth: `calc(15rem + ${trackMinWidth}px)` }}>
            {/* Axis */}
            <div className="sticky top-0 z-20 grid grid-cols-[15rem_1fr] border-b border-sdc-border bg-white">
              <div className="sticky left-0 z-30 border-r border-sdc-border bg-white px-3 py-1.5 text-label font-bold uppercase tracking-wide text-sdc-gray-600">
                Project
              </div>
              <div className="relative h-7">
                {months.map((m) => (
                  <div
                    key={m}
                    className="absolute top-0 h-full border-l border-sdc-border-soft pl-1.5 text-note text-sdc-gray-600"
                    style={{ left: `${pct(`${m}-01`)}%` }}
                  >
                    {monthLabel(m)}
                  </div>
                ))}
                {todayVisible && (
                  <div className="absolute top-0 h-full border-l-2 border-dashed border-sdc-blue" style={{ left: `${todayPct}%` }}>
                    <span className="ml-1 text-micro font-semibold text-sdc-blue">Today</span>
                  </div>
                )}
              </div>
            </div>

            {data.rows.map((row) => (
              <TimelineRow key={row.rowKey} row={row} pct={pct} months={months} todayPct={todayVisible ? todayPct : null} />
            ))}
          </div>
        </div>
      )}

      <p className="mt-2 text-micro text-sdc-muted">
        {data.rows.length} row{data.rows.length === 1 ? "" : "s"} · soonest first · green done · red late · one row per
        project and machine. Milestones come from the Scheduler.
      </p>
    </div>
  );
}

function TimelineRow({
  row,
  pct,
  months,
  todayPct,
}: {
  row: KeyDateRow;
  pct: (iso: string) => number;
  months: string[];
  todayPct: number | null;
}) {
  return (
    <div className="grid grid-cols-[15rem_1fr] border-b border-sdc-border-soft/70 last:border-b-0 hover:bg-sdc-blue-light/15">
      <div
        className="sticky left-0 z-10 truncate border-r border-sdc-border bg-white px-3 py-1.5 text-note font-medium text-sdc-navy"
        title={row.label}
      >
        {row.label}
      </div>
      <div className="relative h-8">
        {/* Month gridlines, from the same pct() the markers use. */}
        {months.map((m) => (
          <div key={m} className="absolute top-0 h-full border-l border-sdc-border-soft" style={{ left: `${pct(`${m}-01`)}%` }} />
        ))}
        {todayPct !== null && (
          <div className="absolute top-0 h-full border-l-2 border-dashed border-sdc-blue/50" style={{ left: `${todayPct}%` }} />
        )}
        {row.markers.map((m) => {
          const tone = m.done
            ? "text-sdc-green-text"
            : m.late
              ? "text-sdc-red-text"
              : "text-sdc-blue-dark";
          return (
            <span
              key={m.id}
              className={`absolute top-1/2 flex -translate-y-1/2 items-center gap-1 whitespace-nowrap text-micro font-semibold ${tone}`}
              style={{ left: `${pct(m.date)}%` }}
              title={`${m.label} · ${m.date}${m.done ? " · done" : m.late ? " · late" : ""}\n${row.label}\n${m.title}${m.assignee ? `\n${m.assignee}` : ""}`}
            >
              {/* A diamond, as in the Scheduler — a rotated square so it needs no icon font. */}
              <span aria-hidden className="inline-block h-2 w-2 rotate-45 border border-current bg-current/25" />
              {m.label} · {shortDate(m.date)}
            </span>
          );
        })}
      </div>
    </div>
  );
}
