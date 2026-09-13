import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeJobIds, isValidCalendarDate, isValidDateRange, resolveTmDateRange } from "../src/lib/tm-drill-validate";

test("a well-formed date range is valid", () => {
  assert.equal(isValidDateRange("2026-01-01", "2026-03-31"), true);
});

test("wrong shape is rejected", () => {
  assert.equal(isValidCalendarDate("2026/01/01"), false);
  assert.equal(isValidCalendarDate("01-01-2026"), false);
  assert.equal(isValidCalendarDate(""), false);
  assert.equal(isValidCalendarDate("not-a-date"), false);
});

test("a calendar date that doesn't exist is rejected, not silently rolled forward", () => {
  // JS's Date would happily turn this into March 2 — this must catch it first.
  assert.equal(isValidCalendarDate("2026-02-30"), false);
  assert.equal(isValidCalendarDate("2026-04-31"), false);
  assert.equal(isValidCalendarDate("2026-13-01"), false);
});

test("Feb 29 is valid on a leap year, rejected on a non-leap year", () => {
  assert.equal(isValidCalendarDate("2024-02-29"), true); // leap
  assert.equal(isValidCalendarDate("2026-02-29"), false); // not a leap year
});

test("a range with either end invalid is an invalid range", () => {
  assert.equal(isValidDateRange("2026-02-30", "2026-03-31"), false);
  assert.equal(isValidDateRange("2026-01-01", "2026-02-30"), false);
});

test("sanitizeJobIds drops non-strings, empty strings, and anything absurdly long", () => {
  const result = sanitizeJobIds(["1101", "", "x".repeat(21), "1104"]);
  assert.deepEqual(result, ["1101", "1104"]);
});

test("sanitizeJobIds caps the list at 500 entries", () => {
  const many = Array.from({ length: 600 }, (_, i) => String(i));
  assert.equal(sanitizeJobIds(many).length, 500);
});

test("an all-invalid selection sanitizes down to an empty array, not to a single fallback value", () => {
  assert.deepEqual(sanitizeJobIds(["", "x".repeat(50)]), []);
});

test("an already-empty selection stays empty (this is the 'All Jobs' convention upstream, not this function's concern)", () => {
  assert.deepEqual(sanitizeJobIds([]), []);
});

// ── resolveTmDateRange: the T&M filter's own correctness ────────────────────
// Both bugs below were live until 2026-08-24 and are the reason this is a pure
// function rather than four lines inside a server component.

const FS = "2026-05-31"; // default start (Estimated to Complete As Of Date)
const FE = "2026-07-31"; // default end   (Hours Refreshed Thru)

test("resolveTmDateRange: a supplied range is used exactly as given", () => {
  assert.deepEqual(resolveTmDateRange("2026-06-01", "2026-06-30", FS, FE), {
    startDate: "2026-06-01",
    endDate: "2026-06-30",
  });
});

test("resolveTmDateRange: editing one endpoint does not reset the other — the reported bug", () => {
  // A date input reports value="" mid-edit. The old code fell back to BOTH
  // defaults, throwing away the endpoint the user had already committed.
  assert.deepEqual(resolveTmDateRange("", "2026-06-30", FS, FE), {
    startDate: FS,
    endDate: "2026-06-30", // NOT the default end
  });
  assert.deepEqual(resolveTmDateRange("2026-06-01", "", FS, FE), {
    startDate: "2026-06-01", // NOT the default start
    endDate: FE,
  });
});

test("resolveTmDateRange: a rolled-over date is rejected, not silently shifted", () => {
  // "2026-02-30" passes a /\d{4}-\d{2}-\d{2}/ shape test, and new Date() turns it
  // into March 2 — the old code queried those days without saying so.
  for (const bad of ["2026-02-30", "2026-13-01", "2026-00-10", "2026-06-31", "2025-02-29"]) {
    assert.equal(resolveTmDateRange(bad, "2026-06-30", FS, FE).startDate, FS, `${bad} must not be used`);
  }
  // A real leap day still works.
  assert.equal(resolveTmDateRange("2024-02-29", "2026-06-30", FS, FE).startDate, "2024-02-29");
});

test("resolveTmDateRange: an inverted range is ordered, not returned as an empty window", () => {
  // gte start / lte end on an inverted pair matches nothing, which reads as a
  // period with no work rather than as bad input. Both endpoints were chosen.
  assert.deepEqual(resolveTmDateRange("2026-07-31", "2026-05-31", FS, FE), {
    startDate: "2026-05-31",
    endDate: "2026-07-31",
  });
});

test("resolveTmDateRange: a single-day range is preserved", () => {
  assert.deepEqual(resolveTmDateRange("2026-06-15", "2026-06-15", FS, FE), {
    startDate: "2026-06-15",
    endDate: "2026-06-15",
  });
});

test("resolveTmDateRange: cross-year ranges survive string comparison", () => {
  assert.deepEqual(resolveTmDateRange("2025-12-01", "2026-01-31", FS, FE), {
    startDate: "2025-12-01",
    endDate: "2026-01-31",
  });
});

test("resolveTmDateRange: nothing supplied gives exactly the defaults", () => {
  assert.deepEqual(resolveTmDateRange(undefined, undefined, FS, FE), { startDate: FS, endDate: FE });
});
