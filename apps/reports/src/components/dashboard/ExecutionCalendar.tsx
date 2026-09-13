"use client";

import { useMemo, useState } from "react";
import { card } from "@/components/ui/classnames";
import { SectionTitle } from "@/components/ui/Typography";
import type { CalendarEvent, CalendarEventType, ExecutionCalendar as CalendarData } from "@/lib/dashboard-calendar";
import type { KeyDatesResult } from "@/lib/key-dates-anchors";
import { KeyDatesTimeline } from "@/components/dashboard/KeyDatesTimeline";
import { useDashboardMonth, shiftMonth } from "@/components/dashboard/useDashboardMonth";

// ── Execution Calendar — FATs & Customer Visits (2026-08-28) ────────────────
//
// Replaces the "Execution — FATs" list and the separate "Planning — Customer
// Visits" panel with one month grid. Both were lists of the same shape of thing
// on the same page, and neither answered "what is happening the week of the
// 14th" without counting rows.
//
// Calendar and Upcoming are two renderings of ONE filtered array — see
// `shown` below. There is no second query and no second filter path, so the two
// views cannot disagree and the type filters apply identically to both.
//
// ── Colours are the EVENT TYPE, never the machine ───────────────────────────
//
// Blue = FAT, amber = Pre-FAT, purple = Customer Visit. Deliberately not the
// machine palette (lib/job-type-colors.ts and the Scheduler's own M1/M2 colours
// both mean something else): on this grid a colour answers "what kind of event
// is this", and the machine is a text chip inside the event.

const TYPE_META: Record<CalendarEventType, { label: string; dot: string; chip: string; bar: string }> = {
  fat: { label: "FAT", dot: "bg-sdc-blue", chip: "bg-sdc-blue-light text-sdc-blue-dark", bar: "bg-sdc-blue" },
  pre: { label: "Pre-FAT", dot: "bg-sdc-yellow", chip: "bg-sdc-yellow-bg text-sdc-yellow-text", bar: "bg-sdc-yellow" },
  visit: { label: "Customer Visit", dot: "bg-sdc-purple", chip: "bg-sdc-purple/15 text-sdc-purple", bar: "bg-sdc-purple" },
};

const ORDER: CalendarEventType[] = ["fat", "pre", "visit"];

const LONG_DATE = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });


/** "FAT · 1150 · M2 · USEC Heat Shield" — the compact form the cell shows. */
function compactLabel(e: CalendarEvent): string {
  const parts = [TYPE_META[e.eventType].label];
  if (e.jobNumber) parts.push(e.jobNumber);
  if (e.machine) parts.push(e.machine);
  const name = e.jobName ?? (e.eventType === "visit" ? e.customer : e.title);
  if (name) parts.push(name);
  return parts.filter(Boolean).join(" · ");
}

// Declared at module scope, not inside EventDetails: a component created during
// render is a NEW component type on every render, so React remounts it and it
// loses any state it ever gains. Harmless while it is this simple, and exactly
// the kind of thing that stops being harmless later.
function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-2 py-0.5">
      <dt className="text-label text-sdc-gray-400">{label}</dt>
      <dd className="min-w-0 text-sm text-sdc-navy">{value}</dd>
    </div>
  );
}

/** The full detail for one event — the popover the compact chip opens. */
function EventDetails({ e, onClose }: { e: CalendarEvent; onClose: () => void }) {
  const meta = TYPE_META[e.eventType];
  const names = (list: string[], empty: string) =>
    list.length === 0 ? <span className="text-sdc-gray-400">{empty}</span> : list.join(", ");

  return (
    <div className="border-t border-sdc-border bg-sdc-gray-50 px-4 py-3">
      <div className="mb-2 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <span className={`inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-label font-semibold ${meta.chip}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} aria-hidden />
            {meta.label}
          </span>
          <h4 className="mt-1 truncate text-sm font-semibold text-sdc-navy">
            {e.jobNumber ? `${e.jobNumber} · ` : ""}
            {e.jobName ?? e.customer ?? e.title}
          </h4>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded-md border border-sdc-border bg-white px-2 py-0.5 text-note text-sdc-muted motion-interactive hover:text-sdc-navy"
        >
          Close
        </button>
      </div>

      <dl className="grid gap-x-8 sm:grid-cols-2">
        <Row label="Date" value={LONG_DATE.format(new Date(`${e.date}T00:00:00Z`))} />
        <Row label="Customer" value={e.customer ?? <span className="text-sdc-gray-400">—</span>} />
        {e.eventType === "visit" ? (
          <>
            <Row label="Job" value={e.jobNumber ? `${e.jobNumber} · ${e.jobName ?? ""}` : <span className="text-sdc-gray-400">—</span>} />
            <Row label="Owner" value={e.visitOwner ?? <span className="text-sdc-gray-400">—</span>} />
            <Row label="Purpose" value={e.visitNote ?? <span className="text-sdc-gray-400">—</span>} />
          </>
        ) : (
          <>
            {/* A FAT with no machine is not missing data — the Scheduler leaves
                tasks.machine unset when the FAT covers the whole project, so it
                is labelled as such rather than shown as a blank. */}
            <Row
              label="Machine"
              value={e.machine ?? <span className="font-medium text-sdc-gray-600">Project-level FAT</span>}
            />
            <Row label="Schedule" value={e.projectName ?? <span className="text-sdc-gray-400">—</span>} />
            <Row label="Task" value={e.title} />
            <Row label="ME" value={names(e.meOwners, "No named ME")} />
            <Row label="CE" value={names(e.ceOwners, "No named CE")} />
            <Row
              label="Debug Lead"
              value={e.debugLead ?? <span className="text-sdc-gray-400">No Debug Lead</span>}
            />
            <Row label="PM" value={e.pm ?? <span className="text-sdc-gray-400">—</span>} />
          </>
        )}
      </dl>
    </div>
  );
}


const STEP_BTN =
  "rounded-md px-2 py-1 text-sm leading-none font-semibold text-sdc-gray-600 motion-interactive hover:bg-sdc-blue-light disabled:cursor-wait disabled:opacity-50";

const MONTH_ONLY = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
function monthName(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return MONTH_ONLY.format(new Date(Date.UTC(y, m - 1, 1)));
}
function thisMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function isCurrentMonth(month: string): boolean {
  return month === thisMonth();
}

export function ExecutionCalendarSection({
  data,
  monthLabel,
  keyDates,
}: {
  data: CalendarData;
  monthLabel: string;
  keyDates: KeyDatesResult;
}) {
  // ── The month arrows drive the DASHBOARD's month, not a local one ────────
  //
  // Same `?m=YYYY-MM` the month/year dropdowns in the page header set, through
  // the same hook — so stepping the calendar also steps the top KPI strip's FAT
  // count, the hours KPIs and the utilization table. A calendar with its own
  // month would show September beside a strip reading "FATs · August", which is
  // the one thing this section must not do.
  const monthNav = useDashboardMonth(data.month);
  const [enabled, setEnabled] = useState<Set<CalendarEventType>>(new Set(ORDER));
  const [view, setView] = useState<"timeline" | "upcoming">("timeline");
  const [selected, setSelected] = useState<string | null>(null);

  // THE filtered set. Both views render this and nothing else.
  const shown = useMemo(() => data.events.filter((e) => enabled.has(e.eventType)), [data.events, enabled]);

  const selectedEvent = shown.find((e) => e.eventId === selected) ?? null;

  const counts = useMemo(() => {
    const c: Record<CalendarEventType, number> = { fat: 0, pre: 0, visit: 0 };
    for (const e of data.events) c[e.eventType]++;
    return c;
  }, [data.events]);

  const toggleType = (t: CalendarEventType) =>
    setEnabled((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      // Never allow all three off — an empty grid with no explanation reads as
      // "nothing is scheduled" rather than "you filtered everything out".
      return next.size === 0 ? new Set(ORDER) : next;
    });

  return (
    <section aria-label="Execution calendar">
      <div className="mb-2.5 flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <SectionTitle>Key Dates — Execution Milestones</SectionTitle>
          <p className="mt-0.5 text-label text-sdc-gray-400">
            {view === "timeline"
              ? "Pick the milestones and the month range — soonest first · green done · red late"
              : monthNav.pending
                ? `${monthName(monthNav.shown)} · loading…`
                : `${monthLabel} · ${shown.length} event${shown.length === 1 ? "" : "s"}`}
            {data.schedulerAvailable || view === "timeline" ? "" : " · Scheduler unavailable, FATs not shown"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Month stepper. Labelled with the month it goes TO, so the control
              says where it leads rather than making the reader work it out. */}
          <div
            className="flex items-center gap-0.5 rounded-lg border border-sdc-border bg-white p-0.5"
            role="group"
            aria-label="Change the dashboard month"
          >
            <button
              type="button"
              onClick={() => monthNav.shift(-1)}
              disabled={monthNav.pending}
              aria-label={`Previous month — ${monthName(shiftMonth(monthNav.shown, -1))}`}
              title={`Previous month — ${monthName(shiftMonth(monthNav.shown, -1))}`}
              className={STEP_BTN}
            >
              ‹
            </button>
            {!isCurrentMonth(monthNav.shown) && (
              <button
                type="button"
                onClick={() => monthNav.goTo(thisMonth())}
                disabled={monthNav.pending}
                title="Back to the current month"
                className="rounded-md px-2 py-1 text-label font-semibold text-sdc-gray-600 motion-interactive hover:bg-sdc-blue-light disabled:opacity-50"
              >
                Today
              </button>
            )}
            <button
              type="button"
              onClick={() => monthNav.shift(1)}
              disabled={monthNav.pending}
              aria-label={`Next month — ${monthName(shiftMonth(monthNav.shown, 1))}`}
              title={`Next month — ${monthName(shiftMonth(monthNav.shown, 1))}`}
              className={STEP_BTN}
            >
              ›
            </button>
          </div>

          <div className="flex items-center gap-1 rounded-lg border border-sdc-border bg-white p-0.5">
            {(["timeline", "upcoming"] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                aria-pressed={view === v}
                className={`rounded-md px-2.5 py-1 text-label font-semibold capitalize motion-interactive ${
                  view === v ? "bg-sdc-blue text-white" : "text-sdc-gray-600 hover:bg-sdc-blue-light"
                }`}
              >
                {v}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Full width. This was a 2.2fr / 0.8fr grid with the FAT summary cards in
          the right-hand column; those were removed on 2026-08-31 and an empty
          0.8fr track would have left a third of the band blank, so the grid went
          with them rather than being left with one child. */}
      <div className="min-w-0">
        <div className={`${card("p-0")} min-w-0 overflow-hidden`}>
          {/* The FAT / Pre-FAT / Customer Visit legend belongs to the Upcoming
              list. The timeline has its own milestone chips, and two rows of
              filters that mean different things would be a trap. */}
          {view === "upcoming" && (
          <div className="flex flex-wrap items-center gap-2 border-b border-sdc-border px-3 py-2">
            {ORDER.map((t) => {
              const on = enabled.has(t);
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => toggleType(t)}
                  aria-pressed={on}
                  className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-label font-medium motion-interactive ${
                    on ? "border-sdc-border bg-white text-sdc-navy" : "border-transparent bg-sdc-gray-50 text-sdc-gray-400"
                  }`}
                >
                  <span className={`h-2 w-2 rounded-full ${on ? TYPE_META[t].dot : "bg-sdc-gray-400"}`} aria-hidden />
                  {TYPE_META[t].label}
                  <span className="tabular-nums opacity-70">{counts[t]}</span>
                </button>
              );
            })}
            {!data.visitsConfigured && (
              // Compact, inside the filter row — replaces the full-width
              // "No data source yet" explainer panel that used to occupy a
              // section of its own.
              <span className="ml-auto text-label text-sdc-gray-400">
                No customer visits recorded for {monthLabel}
              </span>
            )}
          </div>
          )}

          {view === "timeline" ? (
            // The month grid this replaced answered "what is happening on the 9th".
            // The question the section is for is "which machines are approaching
            // which milestone, and is anything late" — which is a timeline.
            <div className="px-3 py-3">
              <KeyDatesTimeline initial={keyDates} />
            </div>
          ) : (
            <div className="max-h-[26rem] divide-y divide-sdc-border-soft overflow-y-auto">
              {shown.length === 0 ? (
                <p className="px-4 py-6 text-sm text-sdc-gray-400">No events in {monthLabel} for the selected types.</p>
              ) : (
                shown.map((e) => {
                  const meta = TYPE_META[e.eventType];
                  return (
                    <button
                      key={e.eventId}
                      type="button"
                      onClick={() => setSelected((prev) => (prev === e.eventId ? null : e.eventId))}
                      aria-pressed={selected === e.eventId}
                      className={`flex w-full items-center gap-3 px-3 py-2 text-left motion-interactive ${
                        selected === e.eventId ? "bg-sdc-blue-light" : "hover:bg-sdc-blue-light/25"
                      }`}
                    >
                      <span className={`h-2 w-2 shrink-0 rounded-full ${meta.dot}`} aria-hidden />
                      <span className="w-20 shrink-0 text-label tabular-nums text-sdc-gray-600">{e.date.slice(5)}</span>
                      <span className="min-w-0 flex-1 truncate text-sm text-sdc-navy">{compactLabel(e)}</span>
                      <span className="shrink-0 text-label text-sdc-gray-400">{e.customer ?? ""}</span>
                    </button>
                  );
                })
              )}
            </div>
          )}

          {/* Details open in place, under whichever view is showing — no
              navigation and no second page. */}
          {selectedEvent && <EventDetails e={selectedEvent} onClose={() => setSelected(null)} />}
        </div>
      </div>
    </section>
  );
}
