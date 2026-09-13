"use client";

import { BTN_H_STANDARD, BUTTON_COMPACT } from "@/components/ui/classnames";
import { useDashboardMonth } from "@/components/dashboard/useDashboardMonth";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// ── The Dashboard's month control (2026-08-27) ──────────────────────────────
//
// ONE control for every month-dependent figure on the page — the FAT count, the
// ME/CE split, Engineering and Shop hours, and (once it has a source) customer
// visits. It moves them together because it doesn't move them at all: it sets
// `?m=YYYY-MM` and the server recomputes the whole page from that one string in
// a single pass (lib/dashboard-overview.ts). There is no per-card month state
// that could drift out of step with another card's.
//
// Deliberately NOT MonthYearSelect: that component belongs to the Monthly ETC
// page and carries that page's rules — only started months are selectable (so
// the Prior-ETC carry-forward stays intact), locked/in-progress suffixes, and an
// unsaved-New-ETC confirm on every change. None of those apply here. The
// Dashboard reads FATs from the Scheduler's calendar and hours from punch data,
// both of which exist for months the ETC process has never opened, so gating
// this on ETC months would hide real data. It shares the geometry tokens, which
// is the part that has to match.
export function DashboardMonthSelect({ month }: { month: string }) {
  // The navigation itself lives in useDashboardMonth, shared with the Execution
  // Calendar's ‹ › arrows — one implementation of "go to this month", so the two
  // controls cannot drift apart or end up owning separate months.
  const { shown, pending, goTo } = useDashboardMonth(month);
  const [shownYear, shownMonth] = shown.split("-");

  // A window around the current year rather than a list derived from data:
  // FAT dates in the Scheduler already run from 2025 into 2027, and a manager
  // planning next year must be able to select a month before anything is booked
  // in it. An empty month is a real answer here, not a broken one.
  const thisYear = new Date().getFullYear();
  const years = [thisYear + 2, thisYear + 1, thisYear, thisYear - 1, thisYear - 2].map(String);

  const selectClass = `${BTN_H_STANDARD} rounded-lg border border-sdc-border bg-white px-3 text-sm font-medium text-sdc-navy shadow-sm outline-none motion-interactive focus:border-sdc-blue disabled:cursor-wait ${
    pending ? "opacity-60" : ""
  }`;

  const now = new Date();
  const currentKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  return (
    <div className="flex items-center gap-2">
      <select
        value={shownMonth}
        onChange={(e) => goTo(`${shownYear}-${e.target.value}`)}
        disabled={pending}
        className={selectClass}
        aria-label="Dashboard month"
        aria-busy={pending}
      >
        {MONTH_NAMES.map((name, i) => (
          <option key={name} value={String(i + 1).padStart(2, "0")}>
            {name}
          </option>
        ))}
      </select>
      <select
        value={shownYear}
        onChange={(e) => goTo(`${e.target.value}-${shownMonth}`)}
        disabled={pending}
        className={selectClass}
        aria-label="Dashboard year"
        aria-busy={pending}
      >
        {years.map((y) => (
          <option key={y} value={y}>
            {y}
          </option>
        ))}
      </select>
      {month !== currentKey && (
        <button type="button" onClick={() => goTo(currentKey)} disabled={pending} className={BUTTON_COMPACT}>
          This month
        </button>
      )}
      {/* Says the page is fetching, not just that the boxes are greyed — a
          disabled dropdown with no explanation is indistinguishable from a
          broken one. */}
      {pending && (
        <span role="status" className="flex items-center gap-1.5 text-xs font-medium text-sdc-muted">
          <svg viewBox="0 0 16 16" width="12" height="12" className="animate-spin" aria-hidden>
            <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.25" />
            <path d="M8 2 a6 6 0 0 1 6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          Loading…
        </span>
      )}
    </div>
  );
}
