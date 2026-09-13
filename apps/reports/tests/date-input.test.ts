import { test } from "node:test";
import assert from "node:assert/strict";
import { isRealCalendarDate, isCommittableDate, dateEditOutcome, dateRangeError } from "../src/lib/date-input";
import { countActiveHoursFilters, HOURS_FILTER_PARAMS } from "../src/lib/hours-filters";

// ── Typing a date in the Hours "Dates" menu (2026-09-02) ────────────────────
//
// Reported as the date filter being unusable from the keyboard. Two distinct
// causes, both logic rather than rendering, both pinned here.

test("an impossible day is refused, not rounded into a real one", () => {
  // `new Date("2026-02-31")` yields March 3rd. Silently moving somebody's typed
  // date to a different date is the one thing the request rules out outright.
  assert.equal(isRealCalendarDate("2026-02-31"), false);
  assert.equal(isRealCalendarDate("2026-13-01"), false);
  assert.equal(isRealCalendarDate("2026-04-31"), false);
  assert.equal(isRealCalendarDate("2026-00-10"), false);
  assert.equal(isRealCalendarDate("2026-01-00"), false);
});

test("leap years are decided by the calendar, not by a 28/29 guess", () => {
  assert.equal(isRealCalendarDate("2024-02-29"), true, "2024 is a leap year");
  assert.equal(isRealCalendarDate("2026-02-29"), false, "2026 is not");
  assert.equal(isRealCalendarDate("2000-02-29"), true, "divisible by 400");
  assert.equal(isRealCalendarDate("1900-02-29"), false, "divisible by 100 but not 400");
});

test("month and year boundaries are real days", () => {
  for (const d of ["2026-01-31", "2026-12-31", "2026-01-01", "2026-06-30"]) {
    assert.equal(isRealCalendarDate(d), true, d);
  }
});

// ── Cause 2: the half-typed year ────────────────────────────────────────────
// Typing 2026 into MM/DD/YYYY passes through the years 2, 20 and 202. Each one
// is a complete, valid calendar date, so the menu committed it and queried the
// server. Four requests per date typed, three of them for nothing.

test("a year still being typed is not committed", () => {
  assert.equal(isCommittableDate("0002-09-01"), false);
  assert.equal(isCommittableDate("0020-09-01"), false);
  assert.equal(isCommittableDate("0202-09-01"), false);
  assert.equal(isCommittableDate("2026-09-01"), true, "and the year they meant is");
});

test("a debounce could not have fixed that", () => {
  // Worth stating as a test because it is the reason the guard exists: these are
  // four DIFFERENT values, so no amount of collapsing repeats removes them —
  // only refusing to treat an implausible year as finished does.
  const typed = ["0002-09-01", "0020-09-01", "0202-09-01", "2026-09-01"];
  assert.equal(new Set(typed).size, 4, "every keystroke produces a distinct value");
  assert.deepEqual(typed.filter(isCommittableDate), ["2026-09-01"], "exactly one reaches the server");
});

// ── Cause 1: the field being cleared underneath the typist ──────────────────
// A native date input reports "" for any partial entry. Writing that into state
// re-rendered the field as empty while the user was still typing it.

test("an empty value while the field has focus is mid-edit, not a clear", () => {
  assert.equal(dateEditOutcome("", true), "hold");
});

test("an empty value after leaving the field IS a clear", () => {
  assert.equal(dateEditOutcome("", false), "clear");
});

test("a partial or implausible value is held, whatever the focus", () => {
  for (const focused of [true, false]) {
    assert.equal(dateEditOutcome("0002-09-01", focused), "hold", "half-typed year");
    assert.equal(dateEditOutcome("2026-02-31", focused), "hold", "impossible day");
  }
});

test("a finished date commits", () => {
  assert.equal(dateEditOutcome("2026-09-01", true), "commit");
  assert.equal(dateEditOutcome("2026-09-01", false), "commit");
  assert.equal(dateEditOutcome("  2026-09-01  ", true), "commit", "a pasted value with whitespace");
});

// ── Range validation ────────────────────────────────────────────────────────

test("a backwards range is reported; an equal one is not", () => {
  assert.match(dateRangeError("2026-09-10", "2026-09-01") ?? "", /after/);
  assert.equal(dateRangeError("2026-09-01", "2026-09-01"), null, "one day is a legitimate range");
  assert.equal(dateRangeError("2026-09-01", "2026-09-30"), null);
});

test("an open-ended range is legitimate", () => {
  assert.equal(dateRangeError("2026-09-01", ""), null);
  assert.equal(dateRangeError("", "2026-09-30"), null);
  assert.equal(dateRangeError("", ""), null);
});

test("an impossible date is named before the ordering is judged", () => {
  const err = dateRangeError("2026-02-31", "2026-01-01") ?? "";
  assert.match(err, /not a real date/, "the broken date is the thing to fix first");
  assert.doesNotMatch(err, /after/);
});

// ── Clear filters ───────────────────────────────────────────────────────────

test("nothing is active on a bare visit", () => {
  assert.equal(countActiveHoursFilters({}), 0);
  assert.equal(countActiveHoursFilters({ jobs: "", from: "" }), 0, "present-but-empty is not a filter");
  assert.equal(countActiveHoursFilters({ page: "3" }), 0, "a page number is not a filter");
});

test("a date RANGE counts once, not twice", () => {
  assert.equal(countActiveHoursFilters({ from: "2026-09-01" }), 1);
  assert.equal(countActiveHoursFilters({ from: "2026-09-01", to: "2026-09-30" }), 1);
});

test("each dimension, the grouping, the sort and a loaded view each count once", () => {
  assert.equal(countActiveHoursFilters({ jobs: "1105,1130" }), 1, "two values in one dimension is one filter");
  assert.equal(
    countActiveHoursFilters({ jobs: "1105", employees: "E1", sections: "S1", departments: "Shop", from: "2026-09-01", groupBy: "job", sort: "hours", dir: "desc", view: "Mine" }),
    8,
  );
});

test("the param list covers every filtering param the page reads", () => {
  // A dimension added to the page without being added here would give a Clear
  // button that silently leaves that filter applied.
  for (const p of ["jobs", "employees", "sections", "departments", "from", "to", "groupBy", "sort", "dir", "view", "page"]) {
    assert.ok((HOURS_FILTER_PARAMS as readonly string[]).includes(p), p);
  }
});
