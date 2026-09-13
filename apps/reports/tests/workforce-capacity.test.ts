import { test } from "node:test";
import assert from "node:assert/strict";
import { isStartedByMonth, employeeCapacityHours, hiringCapacityHours } from "../src/lib/workforce-capacity";
import { annualCapacityHours, monthlyCapacityHours } from "../src/lib/workforce-capacity-policy";

function utcDate(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day));
}

test("isStartedByMonth: no date set (null) counts as started for every month -- unknown is full-year, never zero", () => {
  assert.equal(isStartedByMonth(null, 2026, 1), true);
  assert.equal(isStartedByMonth(null, 2026, 12), true);
});

test("isStartedByMonth: same year, before/at/after the start month", () => {
  const start = utcDate(2026, 7, 15); // July 15, 2026
  assert.equal(isStartedByMonth(start, 2026, 6), false, "June, before the start month");
  assert.equal(isStartedByMonth(start, 2026, 7), true, "July, the start month itself counts in full");
  assert.equal(isStartedByMonth(start, 2026, 8), true, "August, after the start month");
});

test("isStartedByMonth: a start date in a past year counts as fully started, same as null", () => {
  const start = utcDate(2024, 3, 1);
  assert.equal(isStartedByMonth(start, 2026, 1), true);
  assert.equal(isStartedByMonth(start, 2026, 12), true);
});

test("isStartedByMonth: a start date in a future year counts as zero for the whole displayed year", () => {
  const start = utcDate(2027, 1, 1);
  assert.equal(isStartedByMonth(start, 2026, 1), false);
  assert.equal(isStartedByMonth(start, 2026, 12), false);
});

test("isStartedByMonth: year-boundary comparison is a real tuple compare, not just comparing month numbers", () => {
  // A Dec 2024 start must count as started in Jan 2026 -- comparing only
  // "startMonth <= month" (12 <= 1) would wrongly say false here.
  const start = utcDate(2024, 12, 1);
  assert.equal(isStartedByMonth(start, 2026, 1), true);
});

test("employeeCapacityHours: activeCount x annualCapacityHours(year), zero for zero employees", () => {
  assert.equal(employeeCapacityHours(0, 2026), 0);
  assert.equal(employeeCapacityHours(1, 2026), annualCapacityHours(2026));
  assert.equal(employeeCapacityHours(13, 2026), 13 * annualCapacityHours(2026));
});

test("hiringCapacityHours: empty list is zero", () => {
  assert.equal(hiringCapacityHours([], 2026), 0);
});

test("hiringCapacityHours: a position with no start date counts in full (unchanged behavior)", () => {
  assert.equal(hiringCapacityHours([{ expectedStartDate: null }], 2026), annualCapacityHours(2026));
});

test("hiringCapacityHours: a position starting mid-year is prorated by the REAL monthly hours from its start month on, not a flat annual/12 share", () => {
  const start = utcDate(2026, 7, 1); // starts July -- should count July through December
  let expected = 0;
  for (let m = 7; m <= 12; m++) expected += monthlyCapacityHours(2026, m);
  expected = Math.round(expected * 10) / 10;
  assert.equal(hiringCapacityHours([{ expectedStartDate: start }], 2026), expected);
  // And that figure must be LESS than a naive flat 6/12 share of the annual total,
  // since months vary (proving this isn't secretly doing annual/2).
  assert.notEqual(expected, Math.round((annualCapacityHours(2026) / 2) * 10) / 10);
});

test("hiringCapacityHours: sums multiple positions independently, mixing null and dated start dates", () => {
  const positions = [{ expectedStartDate: null }, { expectedStartDate: utcDate(2026, 10, 1) }];
  let octDec = 0;
  for (let m = 10; m <= 12; m++) octDec += monthlyCapacityHours(2026, m);
  const expected = Math.round((annualCapacityHours(2026) + octDec) * 10) / 10;
  assert.equal(hiringCapacityHours(positions, 2026), expected);
});
