// ── Workforce capacity: the company-policy layer (2026-08-19) ───────────────
//
// Turns "how many employees do we have" into "how many working hours does
// that represent" — Annual Working Days (real Mon-Fri weekdays in the year)
// minus SDC Paid Holidays minus Vacation minus Sick = Net Available Days,
// times hours per day. Every number here is COMPUTED from the inputs below;
// none of it is a literal hardcoded output — change a holiday list or the
// vacation/sick/hours-per-day policy and every downstream figure
// recalculates. This includes the "Annual Working Days" figure itself:
// unlike the common "52 weeks x 5 days = 260" HR rule-of-thumb, this counts
// REAL weekdays for the specific year asked about, which genuinely varies
// (260/261/262) depending on the year's leap-status and which weekday
// January 1st falls on (confirmed with the user rather than assumed, after
// finding the true 2026 figure is 261, not 260, because Jan 1 2026 is a
// Thursday — see tests/workforce-capacity-policy.test.ts for the math).
//
// Deliberately NOT etc.ts's workingDaysInMonth(): that function is
// intentionally holiday-agnostic (plain Mon-Fri counting, for exact parity
// with a Power BI measure that also ignores holidays) and serves a single
// ETC-page display. This module's whole point is to be holiday-AWARE, for a
// different business question (workforce capacity, not ETC timing) — the two
// must not be conflated or share an implementation.
//
// Also deliberately NOT a reproduction of the SDC Scheduler's own project-
// assignment/utilization forecast ("N people * N hrs * N wks @ 90%" — see
// EmployeesCards.tsx's own comment on why that one is NOT computed here).
// This is a different kind of number: company-HR-policy-derived capacity
// from headcount and a published holiday calendar, not a reproduction of
// Scheduler's per-project scheduling-engine output.

export type Holiday = { date: string; name: string }; // date: "YYYY-MM-DD"

export type YearPolicy = {
  year: number;
  holidays: Holiday[];
  vacationDaysPerYear: number;
  sickDaysPerYear: number;
  hoursPerDay: number;
};

// One entry per year — add next year's here every December (see the note at
// the bottom of this file for exactly what "add a year" means). Holidays are
// a published company calendar, not something derivable by formula (Easter,
// Thanksgiving, and observed-holiday weekend shifts all move independently),
// so they're listed explicitly rather than computed.
const YEAR_POLICIES: Record<number, YearPolicy> = {
  2026: {
    year: 2026,
    holidays: [
      { date: "2026-01-01", name: "New Year's Day" },
      { date: "2026-04-03", name: "Easter" },
      { date: "2026-05-25", name: "Memorial Day" },
      { date: "2026-07-03", name: "Independence Day (observed)" },
      { date: "2026-07-06", name: "Independence Day (extra)" },
      { date: "2026-09-07", name: "Labor Day" },
      { date: "2026-11-26", name: "Thanksgiving" },
      { date: "2026-11-27", name: "Day after Thanksgiving" },
      { date: "2026-12-24", name: "Christmas Eve" },
      { date: "2026-12-25", name: "Christmas Day" },
    ],
    vacationDaysPerYear: 15,
    sickDaysPerYear: 4,
    hoursPerDay: 8,
  },
};

export class UnconfiguredYearError extends Error {
  constructor(public readonly year: number) {
    super(`No workforce capacity policy configured for ${year} yet — add an entry to YEAR_POLICIES in workforce-capacity-policy.ts.`);
    this.name = "UnconfiguredYearError";
  }
}

/** Throws UnconfiguredYearError rather than silently falling back to another year's holidays. */
export function getYearPolicy(year: number): YearPolicy {
  const policy = YEAR_POLICIES[year];
  if (!policy) throw new UnconfiguredYearError(year);
  return policy;
}

/** True if this year has a policy configured — lets a caller show a clean "not configured yet" state instead of catching. */
export function hasYearPolicy(year: number): boolean {
  return year in YEAR_POLICIES;
}

/** Weekday (Mon-Fri) count for the given 1-indexed month. Pure calendar arithmetic — deliberately holiday-agnostic (see this file's header). */
export function weekdaysInMonth(year: number, month: number): number {
  const daysInMonth = new Date(year, month, 0).getDate();
  let count = 0;
  for (let day = 1; day <= daysInMonth; day++) {
    const dow = new Date(year, month - 1, day).getDay();
    if (dow !== 0 && dow !== 6) count++;
  }
  return count;
}

/** Weekday count for the whole year — the sum of every month's weekdaysInMonth, not a separate calculation. */
export function weekdaysInYear(year: number): number {
  let total = 0;
  for (let month = 1; month <= 12; month++) total += weekdaysInMonth(year, month);
  return total;
}

/** How many of this year's configured holidays fall on a weekday within the given month. */
export function holidaysInMonth(year: number, month: number): number {
  const policy = getYearPolicy(year);
  let count = 0;
  for (const h of policy.holidays) {
    const d = new Date(`${h.date}T00:00:00`);
    if (d.getFullYear() !== year || d.getMonth() + 1 !== month) continue;
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) count++;
  }
  return count;
}

/** How many of this year's configured holidays fall on a weekday, total. */
export function holidaysInYear(year: number): number {
  let total = 0;
  for (let month = 1; month <= 12; month++) total += holidaysInMonth(year, month);
  return total;
}

/** Net available (= billable) days for the whole year — computed directly from the annual policy inputs (weekdays − holidays − vacation − sick), so it's exact regardless of monthly rounding below. */
export function netAvailableDaysInYear(year: number): number {
  const policy = getYearPolicy(year);
  return weekdaysInYear(year) - holidaysInYear(year) - policy.vacationDaysPerYear - policy.sickDaysPerYear;
}

/** Capacity hours for one FTE for the whole year — netAvailableDaysInYear x hours/day. This is the exact figure; monthlyCapacityHours below is a rounded-for-display MONTHLY BREAKDOWN of it and will not sum back to this exactly (the same "monthly figures don't perfectly foot to the annual total" rounding every such table has). */
export function annualCapacityHours(year: number): number {
  const policy = getYearPolicy(year);
  return netAvailableDaysInYear(year) * policy.hoursPerDay;
}

/**
 * Net available (= billable) days for one month, for DISPLAY: weekdays minus
 * holidays minus this month's prorated share of annual vacation/sick, each
 * rounded to 1 decimal before subtracting — matching how the reference
 * policy table itself computes a month cell (e.g. Jan: 22 weekdays - 1
 * holiday - 1.3 prorated vacation - 0.3 prorated sick = 19.4). Use
 * netAvailableDaysInYear for the authoritative annual figure, not a sum of
 * these.
 */
export function netAvailableDaysInMonth(year: number, month: number): number {
  const policy = getYearPolicy(year);
  const monthWeekdays = weekdaysInMonth(year, month);
  const annualWeekdays = weekdaysInYear(year);
  const monthShare = monthWeekdays / annualWeekdays;
  const vacation = Math.round(monthShare * policy.vacationDaysPerYear * 10) / 10;
  const sick = Math.round(monthShare * policy.sickDaysPerYear * 10) / 10;
  const holidays = holidaysInMonth(year, month);
  return Math.round((monthWeekdays - holidays - vacation - sick) * 10) / 10;
}

/** Capacity hours for one FTE for one month, for DISPLAY — see netAvailableDaysInMonth's own note on why this doesn't sum back to annualCapacityHours exactly. */
export function monthlyCapacityHours(year: number, month: number): number {
  const policy = getYearPolicy(year);
  return Math.round(netAvailableDaysInMonth(year, month) * policy.hoursPerDay * 10) / 10;
}

// ── Adding a new year ────────────────────────────────────────────────────────
//
// Every December, before the new year starts: add an entry to YEAR_POLICIES
// above with that year's published SDC holiday calendar (exact dates —
// Easter, Labor Day, and Thanksgiving all move independently and are not
// computed here) and the current vacation/sick/hours-per-day policy if
// either has changed. Nothing else in this file or its callers needs to
// change — every figure derives from that one entry.
