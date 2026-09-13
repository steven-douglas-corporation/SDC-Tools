import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getYearPolicy,
  hasYearPolicy,
  UnconfiguredYearError,
  weekdaysInMonth,
  weekdaysInYear,
  holidaysInMonth,
  holidaysInYear,
  netAvailableDaysInMonth,
  netAvailableDaysInYear,
  monthlyCapacityHours,
  annualCapacityHours,
} from "../src/lib/workforce-capacity-policy";

// These figures are computed via real Gregorian calendar arithmetic for 2026
// (Jan 1, 2026 is a Thursday; verified independently against Date's own
// getDay(), not estimated). They are DELIBERATELY not the "260 working
// days / 1,848 hrs" figure a common HR rule-of-thumb (52 weeks x 5 days)
// would give: 2026 genuinely has 261 weekdays, not 260, because Jan 1 falls
// on a Thursday, producing a 53rd Thursday in the year. By design (confirmed
// with the user rather than assumed), this module always counts REAL
// calendar weekdays for whatever year is asked about, rather than a fixed
// approximation -- so the exact annual total will legitimately vary between
// 260/261/262 depending on the year's leap-status and which weekday Jan 1
// lands on. If these numbers ever need to change, re-derive them from the
// actual calendar, don't just edit them to make a test pass.

const WEEKDAYS_2026 = [22, 20, 22, 22, 21, 22, 23, 21, 22, 22, 21, 23];
const HOLIDAYS_2026 = [1, 0, 0, 1, 1, 0, 2, 0, 1, 0, 2, 2];
const NET_AVAILABLE_2026 = [19.4, 18.6, 20.4, 19.4, 18.5, 20.4, 19.3, 19.5, 19.4, 20.4, 17.5, 19.3];

test("weekdaysInMonth: real Mon-Fri weekday counts for every month of 2026", () => {
  for (let m = 1; m <= 12; m++) {
    assert.equal(weekdaysInMonth(2026, m), WEEKDAYS_2026[m - 1], `month ${m}`);
  }
});

test("weekdaysInYear: 2026 genuinely has 261 weekdays, not the common '260' rule-of-thumb", () => {
  assert.equal(weekdaysInYear(2026), 261);
});

test("holidaysInMonth: matches SDC's published 2026 holiday calendar for every month", () => {
  for (let m = 1; m <= 12; m++) {
    assert.equal(holidaysInMonth(2026, m), HOLIDAYS_2026[m - 1], `month ${m}`);
  }
});

test("holidaysInYear: sums to 10 for 2026", () => {
  assert.equal(holidaysInYear(2026), 10);
});

test("netAvailableDaysInMonth: weekdays minus holidays minus prorated vacation/sick, for every month of 2026", () => {
  for (let m = 1; m <= 12; m++) {
    assert.equal(netAvailableDaysInMonth(2026, m), NET_AVAILABLE_2026[m - 1], `month ${m}`);
  }
});

// The sum of the (rounded, for-display) monthly net-available figures is
// 232.1, not the clean 232 -- ordinary rounding drift, the same reason a
// spreadsheet's monthly cells don't perfectly foot to its own annual total.
// The authoritative annual figure is computed directly from the annual
// inputs instead, never by summing the rounded monthly cells.
test("netAvailableDaysInYear: the clean 232 for 2026, computed from annual inputs (not a sum of the rounded monthly cells, which drifts to 232.1)", () => {
  assert.equal(netAvailableDaysInYear(2026), 232);
  const summedMonths = Math.round(NET_AVAILABLE_2026.reduce((s, v) => s + v, 0) * 10) / 10;
  assert.equal(summedMonths, 232.1);
  assert.notEqual(summedMonths, netAvailableDaysInYear(2026));
});

test("annualCapacityHours: 1,856 for 2026 (232 net available days x 8 hrs/day) -- computed, never hardcoded", () => {
  assert.equal(annualCapacityHours(2026), 1856);
});

test("monthlyCapacityHours: each month's net available days x 8 hrs/day", () => {
  for (let m = 1; m <= 12; m++) {
    const expected = Math.round(NET_AVAILABLE_2026[m - 1] * 8 * 10) / 10;
    assert.equal(monthlyCapacityHours(2026, m), expected, `month ${m}`);
  }
});

test("getYearPolicy: throws UnconfiguredYearError for a year with no policy, rather than falling back to another year's holidays", () => {
  assert.throws(() => getYearPolicy(2099), UnconfiguredYearError);
  assert.equal(hasYearPolicy(2099), false);
  assert.equal(hasYearPolicy(2026), true);
});

test("getYearPolicy: 2026's policy inputs are exactly what the reference table assumes", () => {
  const policy = getYearPolicy(2026);
  assert.equal(policy.vacationDaysPerYear, 15);
  assert.equal(policy.sickDaysPerYear, 4);
  assert.equal(policy.hoursPerDay, 8);
  assert.equal(policy.holidays.length, 10);
});
