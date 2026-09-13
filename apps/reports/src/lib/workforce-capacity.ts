// ── Workforce capacity: combining policy hours with real data (2026-08-19) ──
//
// The policy layer (workforce-capacity-policy.ts) answers "how many hours is
// one FTE worth this year." This layer answers "how many hours does OUR
// headcount and OUR open positions represent" — still pure (plain arrays in,
// numbers out, no Prisma/fetch), so it composes with whatever level
// (company/group/department) the caller is already filtering at, exactly the
// same way the existing headcount counts (`.filter(p => p.active).length`)
// do today in WorkforceSummaryCards.tsx/EmployeesCards.tsx.
//
// "Current" (active employees) vs "Hiring" (open positions) vs "Planned"
// (their sum) must never be blended into one unlabeled number — see this
// repo's own Phase-1 cleanup finding on why that distinction matters here.

import { annualCapacityHours, monthlyCapacityHours } from "@/lib/workforce-capacity-policy";

/**
 * Whether a hiring position (by its expected start date) has started as of
 * the given month of the given year. `null` (no date set) is always true —
 * an unknown start date counts as full-year capacity, not zero, so adding a
 * date only ever makes the number MORE accurate, never removes capacity that
 * was already being shown. Otherwise a lexicographic (startYear, startMonth)
 * <= (year, month) compare, which correctly handles a start date in a past
 * year (fully started, same as null), a past month of the displayed year
 * (zero for the prior months, full from the start month on — this is a plan,
 * not a live countdown against today; a stale-looking date is a data-quality
 * question for whoever owns the position, not something this function
 * silently corrects for), and a future year (zero for the whole displayed
 * year). Deliberately no `Date.now()` anywhere here — stays pure and
 * deterministic for tests.
 */
export function isStartedByMonth(expectedStartDate: Date | null, year: number, month: number): boolean {
  if (!expectedStartDate) return true;
  const startYear = expectedStartDate.getUTCFullYear();
  const startMonth = expectedStartDate.getUTCMonth() + 1;
  if (startYear !== year) return startYear < year;
  return startMonth <= month;
}

/** Capacity hours for `activeCount` full-time employees, for one year (100% FTE / 8 hrs/day for every active employee — no per-employee schedule data exists yet, see this module's own header). */
export function employeeCapacityHours(activeCount: number, year: number): number {
  return activeCount * annualCapacityHours(year);
}

/**
 * A single hiring position's own capacity-hours contribution for one year —
 * `annualCapacityHours(year)` exactly for a position with no start date set
 * (matching today's behavior, and avoiding the rounding drift that summing
 * 12 already-rounded monthly figures would introduce for the common no-date
 * case), or the sum of the REAL monthly capacity figure
 * (monthlyCapacityHours) for every month it's started, for a dated one — a
 * position starting in a lighter month (fewer weekdays/more holidays)
 * genuinely contributes fewer hours than one starting in a heavier month, not
 * a flat annual-hours/12 share. Proration is month-granularity, not
 * day-precise — a position starting April 15 counts zero for Jan-Mar and
 * full April onward, a documented simplification matching the feature's
 * monthly granularity elsewhere.
 */
export function hiringPositionCapacityHours(expectedStartDate: Date | null, year: number, openings = 1): number {
  const perPerson = (() => {
    if (!expectedStartDate) return annualCapacityHours(year);
    let total = 0;
    for (let month = 1; month <= 12; month++) {
      if (isStartedByMonth(expectedStartDate, year, month)) total += monthlyCapacityHours(year, month);
    }
    return total;
  })();
  // The request's formula exactly: "Capacity for 1 person based on start date
  // x Quantity". Multiplied AFTER the proration and rounded once at the end,
  // so 2 openings is exactly twice one opening rather than twice a
  // already-rounded figure — otherwise a x7 position drifts from 7x the
  // single-opening number the drawer shows beside it.
  //
  // Defaults to 1 so every existing caller that has no quantity to pass keeps
  // its current behaviour untouched.
  return Math.round(perPerson * Math.max(0, openings) * 10) / 10;
}

/**
 * Capacity hours for a SET of open hiring positions, for one year — the sum of
 * hiringPositionCapacityHours over each, each weighted by how many openings it
 * still has.
 *
 * `remainingQuantity` is optional and treated as 1 when absent, which is what
 * keeps this correct for callers holding a plain {expectedStartDate} shape and
 * for rows predating the quantity columns. It is deliberately the REMAINING
 * count, not `quantity`: an opening that has already been filled is a real
 * employee now, counted under Current capacity, and counting it here as well
 * would double it into Planned.
 */
export function hiringCapacityHours(
  // `number | null` as well as optional: a value read straight off a database
  // row can legitimately be null, and `?? 1` below already treats that as one
  // opening. Narrowing it to `number | undefined` would only push a cast onto
  // every caller holding real row data.
  positions: readonly { expectedStartDate: Date | null; remainingQuantity?: number | null }[],
  year: number,
): number {
  return (
    Math.round(
      positions.reduce((sum, p) => sum + hiringPositionCapacityHours(p.expectedStartDate, year, p.remainingQuantity ?? 1), 0) * 10,
    ) / 10
  );
}
