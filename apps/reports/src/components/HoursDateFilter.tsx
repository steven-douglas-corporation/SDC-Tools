"use client";

import { TOOLBAR_BTN, TOOLBAR_BTN_ACTIVE, TOOLBAR_BTN_NEUTRAL, INPUT, BUTTON_MENU_LINK } from "@/components/ui/classnames";
import { useDraftParamsMenu } from "@/components/useDraftParamMenu";
import { MenuStatus, MenuApplyHint } from "@/components/MenuStatus";
import { useRef } from "react";
import { dateEditOutcome, dateRangeError } from "@/lib/date-input";

// "Dates ▾" — filter the Hours table to punches whose work date falls in a range.
// Simplified from ProjectsDateFilter.tsx: Hours has exactly one date dimension (the work
// date), so there's no field-to-filter-on toggle to carry.

type Key = "from" | "to";

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Formats a "YYYY-MM-DD" string for display WITHOUT going through `Date` — the same
// discipline table-sort.ts's compareByType uses for the same reason: parsing into a
// Date and re-formatting can shift the displayed day across a UTC/local boundary.
function formatIsoDateShort(iso: string): string {
  const [, m, d] = iso.split("-").map(Number);
  return `${MONTH_ABBR[m - 1]} ${d}`;
}

function formatRangeLabel(from: string, to: string): string {
  if (from && to) return `${formatIsoDateShort(from)} – ${formatIsoDateShort(to)}`;
  if (from) return `From ${formatIsoDateShort(from)}`;
  if (to) return `Until ${formatIsoDateShort(to)}`;
  return "Dates";
}

// Local-calendar-day arithmetic for the presets — deliberately NOT `toISOString()`,
// which converts to UTC and can land on the wrong side of midnight depending on the
// browser's timezone.
function toIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDays(d: Date, n: number): Date {
  const next = new Date(d);
  next.setDate(next.getDate() + n);
  return next;
}

type Preset = { label: string; range: () => { from: string; to: string } };

const PRESETS: Preset[] = [
  { label: "Today", range: () => ({ from: toIsoDate(new Date()), to: toIsoDate(new Date()) }) },
  {
    label: "This Week",
    range: () => {
      const today = new Date();
      const day = today.getDay(); // 0=Sun..6=Sat
      const monday = addDays(today, day === 0 ? -6 : 1 - day);
      return { from: toIsoDate(monday), to: toIsoDate(addDays(monday, 6)) };
    },
  },
  {
    label: "This Month",
    range: () => {
      const today = new Date();
      const first = new Date(today.getFullYear(), today.getMonth(), 1);
      const last = new Date(today.getFullYear(), today.getMonth() + 1, 0);
      return { from: toIsoDate(first), to: toIsoDate(last) };
    },
  },
  {
    label: "Last 30 Days",
    range: () => {
      const today = new Date();
      return { from: toIsoDate(addDays(today, -29)), to: toIsoDate(today) };
    },
  },
];

export function HoursDateFilter({ from, to }: { from: string; to: string }) {
  const committed: Record<Key, string[]> = { from: from ? [from] : [], to: to ? [to] : [] };

  const { draft, setValues, dirty, pending, detailsRef, detailsProps } = useDraftParamsMenu<Key>({
    committed,
    debounceMs: 700, // a date is typed, not clicked — see ProjectsDateFilter's note
    buildParams: (d, qs) => {
      const f = d.from[0] ?? "";
      const t = d.to[0] ?? "";
      if (f) qs.set("from", f);
      else qs.delete("from");
      if (t) qs.set("to", t);
      else qs.delete("to");
      qs.delete("page");
    },
  });

  const draftFrom = draft.from[0] ?? "";
  const draftTo = draft.to[0] ?? "";
  const active = Boolean(from || to);
  const rangeError = dateRangeError(draftFrom, draftTo);

  function applyPreset(range: { from: string; to: string }) {
    setValues("from", [range.from]);
    setValues("to", [range.to]);
  }

  // ── Typing, without the field being overwritten underneath the typist ─────
  //
  // See lib/date-input.ts for the two bugs this replaces. In short: a native
  // date input reports "" for every partial entry, so writing that straight into
  // state wiped whatever the person had typed so far; and it reports year 0002
  // on the way to 2026, so committing every complete-looking value queried the
  // server three times for dates nobody asked for.
  //
  // `dateEditOutcome` decides between the three cases. `hold` is the important
  // one — it means leave the committed value exactly where it is, which is what
  // stops the re-render that was eating the input.
  function onDateChange(key: Key, raw: string, el: HTMLInputElement) {
    const focused = document.activeElement === el;
    const outcome = dateEditOutcome(raw, focused);
    if (outcome === "hold") return;
    setValues(key, outcome === "commit" ? [raw] : []);
  }

  // Leaving the field settles it: an emptied field now really is cleared, and a
  // date that was mid-entry is committed if it turned out to be a real one.
  function onDateBlur(key: Key, raw: string) {
    const outcome = dateEditOutcome(raw, false);
    setValues(key, outcome === "commit" ? [raw] : []);
  }

  const fromRef = useRef<HTMLInputElement>(null);
  const toRef = useRef<HTMLInputElement>(null);

  // Enter commits from the keyboard without reaching for the mouse, and without
  // submitting anything (these inputs are not in a form, but a stray Enter inside
  // a <details> should still do the useful thing rather than nothing).
  function onDateKeyDown(key: Key, e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    onDateBlur(key, e.currentTarget.value);
    // Tab-order courtesy: Enter in "From" moves to "To", which is the order the
    // range is read and typed in.
    if (key === "from") toRef.current?.focus();
    else e.currentTarget.blur();
  }

  return (
    <details ref={detailsRef} {...detailsProps} className="group relative inline-block">
      <summary className={`${TOOLBAR_BTN} ${active ? TOOLBAR_BTN_ACTIVE : TOOLBAR_BTN_NEUTRAL} ${pending ? "opacity-60" : ""}`}>
        {active ? formatRangeLabel(from, to) : "Dates"}
        <MenuStatus pending={pending} />
      </summary>
      {/* right-0/left-auto: this button sits near the right edge of the toolbar (Filters,
          Dates, Group By, Views, Export in a row) — anchoring from the left, like the other
          menus, pushed the panel off the right edge of the viewport. Opening leftward from
          the button's right edge keeps it on-screen regardless of viewport width. */}
      <div className="motion-menu-panel absolute right-0 left-auto top-full z-30 mt-2 w-56 rounded-lg border border-sdc-border bg-white p-2.5 shadow-lg">
        <div className="grid grid-cols-[2.5rem_1fr] items-center gap-x-2 gap-y-1.5">
          <span className="text-note text-sdc-gray-600">From</span>
          {/* `defaultValue`, keyed on the committed value — NOT `value`.
              A controlled native date input is re-rendered from state on every
              keystroke, and since a partial entry reads as "", that render is
              what cleared the field mid-type. Uncontrolled, the browser owns the
              segments while they are being typed, and the `key` still resyncs the
              field whenever the value changes from somewhere else: a preset, the
              Clear button, a saved View, or the Back button. */}
          <input
            key={`from:${draftFrom}`}
            ref={fromRef}
            type="date"
            defaultValue={draftFrom}
            onChange={(e) => onDateChange("from", e.target.value, e.currentTarget)}
            onBlur={(e) => onDateBlur("from", e.target.value)}
            onKeyDown={(e) => onDateKeyDown("from", e)}
            className={`${INPUT} w-full text-xs`}
            aria-label="Work date from"
          />
          <span className="text-note text-sdc-gray-600">To</span>
          <input
            key={`to:${draftTo}`}
            ref={toRef}
            type="date"
            defaultValue={draftTo}
            onChange={(e) => onDateChange("to", e.target.value, e.currentTarget)}
            onBlur={(e) => onDateBlur("to", e.target.value)}
            onKeyDown={(e) => onDateKeyDown("to", e)}
            className={`${INPUT} w-full text-xs`}
            aria-label="Work date to"
          />
        </div>

        {rangeError && (
          <p role="alert" className="mt-2 text-note font-medium text-sdc-red-text">
            {rangeError}
          </p>
        )}
        <p className="mt-1.5 text-note text-sdc-muted">Type MM/DD/YYYY or pick from the calendar. Enter or Tab applies.</p>

        <div className="mt-2 flex flex-wrap gap-1 border-t border-sdc-border-soft pt-2">
          {PRESETS.map((p) => (
            <button key={p.label} type="button" onClick={() => applyPreset(p.range())} className={BUTTON_MENU_LINK}>
              {p.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              setValues("from", []);
              setValues("to", []);
            }}
            disabled={!draftFrom && !draftTo}
            className={BUTTON_MENU_LINK}
          >
            Clear
          </button>
        </div>

        <MenuApplyHint dirty={dirty} />
      </div>
    </details>
  );
}
