"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { BTN_H_STANDARD, TOOLBAR_MIN_W } from "@/components/ui/classnames";
import { isEtcDirty } from "@/lib/etc-dirty-tracker";

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

// Month + Year picker for the Monthly ETC page. Only months that exist (or
// the next startable month) are selectable — months must still be started in
// order so the Prior ETC carry-forward stays intact; everything else is
// disabled rather than hidden so the full year is visible.
export function MonthYearSelect({
  months,
  current,
  basePath = "/etc",
  lockedMonths = [],
  nextStartable,
}: {
  months: string[];
  current: string; // "YYYY-MM"
  basePath?: string;
  lockedMonths?: string[];
  // Offered once the latest month is locked — otherwise there would be no
  // way to navigate to the next month to start it.
  nextStartable?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // The month the user just picked, held only while the navigation is in
  // flight. See `shown*` below for why it has to exist at all.
  const [target, setTarget] = useState<string | null>(null);
  const locked = new Set(lockedMonths);

  let selectable = months;
  if (nextStartable && !selectable.includes(nextStartable)) selectable = [nextStartable, ...selectable];
  if (!selectable.includes(current)) selectable = [current, ...selectable];
  const allowed = new Set(selectable);

  // What the two dropdowns DISPLAY, which is not the same as the month the
  // page is currently rendering.
  //
  // `current` is a server prop, so it can't change until the new page commits.
  // Both selects are controlled on it, and React's controlled-input restore
  // puts a <select> straight back to its prop value the moment an onChange
  // doesn't move that value — so picking "July" snapped the box back to "June"
  // instantly and left it there for the whole server round-trip. On a page
  // this size (48 jobs x every tracked section, plus the Standard Fees panel
  // and the KPI strip) that is long enough to read as "the filter is broken",
  // and the natural response is to pick again, queuing a second navigation.
  //
  // So while the navigation is in flight, show the month that was PICKED.
  // No effect and no cleanup: when the transition ends this falls back to
  // `current` on its own, which by then is the month that was picked. If the
  // unsaved-changes confirm below is cancelled, no transition ever starts and
  // this stays on `current` — the correct answer for that path too.
  const shown = pending && target ? target : current;
  const [shownYear, shownMonth] = shown.split("-");
  // shownYear is folded in so the year box can display an in-flight jump to a
  // year that has no entries yet (starting the first month of a new year).
  const years = Array.from(new Set([...selectable.map((m) => m.slice(0, 4)), shownYear])).sort().reverse();

  // Switching months remounts the whole grid (key={month} on its form), which
  // wipes any typed-but-unsaved New ETC values outright — a plain client-side
  // route change like this never fires the browser's native beforeunload
  // warning, so this is the only guard that would ever catch it.
  const go = (ym: string) => {
    if (ym === current) return;
    if (isEtcDirty() && !window.confirm("You have unsaved New ETC changes. Switching months will lose them — continue anyway?")) {
      return;
    }
    setTarget(ym);
    // In a transition so `pending` reports the whole server round-trip, the
    // same way every other filter control on this app does it (see
    // ProjectsShowAllSwitch, useDraftParamMenu).
    startTransition(() => {
      router.push(`${basePath}?month=${ym}`, { scroll: false });
    });
  };

  // Switching years jumps to that year's latest selectable month.
  const onYearChange = (year: string) => {
    if (year === shownYear) return;
    const inYear = selectable.filter((m) => m.startsWith(`${year}-`)).sort().reverse();
    if (inYear[0]) go(inYear[0]);
  };

  const statusSuffix = (ym: string) =>
    !months.includes(ym) ? " (new)" : locked.has(ym) ? " — locked" : " — in progress";

  // ── The same geometry as the buttons beside it (§41.21) ───────────────────
  //
  // `py-1.5` put these at 34px in a row of 36px buttons — the two-pixel mismatch that
  // reads as a jagged toolbar rather than as anything nameable. BTN_H_STANDARD is the
  // one height token; TOOLBAR_MIN_W keeps the YEAR select (which holds four characters)
  // from sitting at 76px beside controls half again its width.
  //
  // The month select stays wider than the floor because its widest OPTION sets its
  // width, and that is right: the thing it has to fit is "September · in progress".
  const selectClass =
    `${BTN_H_STANDARD} ${TOOLBAR_MIN_W} rounded-lg border border-sdc-border bg-white px-3 text-sm font-medium text-sdc-navy shadow-sm outline-none motion-interactive focus:border-sdc-blue disabled:cursor-wait`;

  return (
    <span className="inline-flex items-center gap-2">
      <select
        value={shownMonth}
        onChange={(e) => go(`${shownYear}-${e.target.value}`)}
        // Disabled mid-flight so a second pick can't queue another navigation
        // behind the first — that used to land the two out of order and leave
        // the page on a month nobody chose last.
        disabled={pending}
        className={`${selectClass} ${pending ? "opacity-60" : ""}`}
        aria-label="Month"
        aria-busy={pending}
      >
        {MONTH_NAMES.map((name, i) => {
          const mm = String(i + 1).padStart(2, "0");
          const ym = `${shownYear}-${mm}`;
          return (
            <option key={mm} value={mm} disabled={!allowed.has(ym)}>
              {name}
              {allowed.has(ym) ? statusSuffix(ym) : ""}
            </option>
          );
        })}
      </select>
      <select
        value={shownYear}
        onChange={(e) => onYearChange(e.target.value)}
        disabled={pending}
        className={`${selectClass} ${pending ? "opacity-60" : ""}`}
        aria-label="Year"
        aria-busy={pending}
      >
        {years.map((y) => (
          <option key={y} value={y}>
            {y}
          </option>
        ))}
      </select>
      {/* Says the page is fetching, not just that the box is greyed. Without
          it a disabled dropdown is indistinguishable from a broken one — the
          exact complaint this whole change is about. */}
      {pending && (
        <span role="status" className="flex items-center gap-1.5 text-xs font-medium text-sdc-muted">
          <svg viewBox="0 0 16 16" width="12" height="12" className="animate-spin" aria-hidden>
            <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.25" />
            <path d="M8 2 a6 6 0 0 1 6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          Loading…
        </span>
      )}
    </span>
  );
}
