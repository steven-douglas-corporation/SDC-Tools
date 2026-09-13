import { test } from "node:test";
import assert from "node:assert/strict";
import { shiftMonth } from "../src/components/dashboard/useDashboardMonth";
import { isValidMonth } from "../src/lib/etc";

// The Execution Calendar's ‹ › arrows step the DASHBOARD's month — the same
// `?m=YYYY-MM` the header dropdowns set, via the same hook. This pins the one
// piece of arithmetic behind them: month stepping across year boundaries, which
// is the classic place to produce "2026-13" or "2026-00".

test("steps forward and back within a year", () => {
  assert.equal(shiftMonth("2026-08", 1), "2026-09");
  assert.equal(shiftMonth("2026-08", -1), "2026-07");
});

test("rolls over the year in both directions", () => {
  assert.equal(shiftMonth("2026-12", 1), "2027-01");
  assert.equal(shiftMonth("2026-01", -1), "2025-12");
});

test("keeps the zero-padded YYYY-MM shape the URL and the server expect", () => {
  // dashboardMonth() rejects anything isValidMonth() does not accept and falls
  // back to the current month, so a malformed step would silently snap the whole
  // dashboard back rather than erroring — worth pinning.
  for (const start of ["2025-01", "2026-06", "2026-09", "2026-12"]) {
    for (const delta of [-13, -12, -2, -1, 0, 1, 2, 12, 13]) {
      const out = shiftMonth(start, delta);
      assert.match(out, /^\d{4}-(0[1-9]|1[0-2])$/, `${start} ${delta >= 0 ? "+" : ""}${delta} -> ${out}`);
      assert.ok(isValidMonth(out), `${out} is not accepted by isValidMonth`);
    }
  }
});

test("a full year of steps returns to the same month", () => {
  assert.equal(shiftMonth("2026-08", 12), "2027-08");
  assert.equal(shiftMonth("2026-08", -12), "2025-08");
});

test("stepping is reversible", () => {
  for (const m of ["2026-01", "2026-08", "2026-12"]) {
    assert.equal(shiftMonth(shiftMonth(m, 1), -1), m);
    assert.equal(shiftMonth(shiftMonth(m, -1), 1), m);
  }
});

test("does not drift on months with fewer days", () => {
  // Anchored to day 1 in UTC on purpose. Stepping from a 31-day month with a
  // day-of-month carried over is how "Jan 31 + 1 month = Mar 3" bugs happen.
  assert.equal(shiftMonth("2026-01", 1), "2026-02");
  assert.equal(shiftMonth("2026-03", -1), "2026-02");
  assert.equal(shiftMonth("2026-02", 1), "2026-03");
});
