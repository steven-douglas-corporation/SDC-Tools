import { test } from "node:test";
import assert from "node:assert/strict";
import { forecastReason, hours, shortDate } from "../src/modules/tracker/components/format";

test("dates are shown as weekday, month and day, without going through a time zone", () => {
  assert.equal(shortDate("2026-11-23"), "Mon Nov 23");
  assert.equal(shortDate("2026-01-01"), "Thu Jan 1");
  assert.equal(shortDate("2026-12-31"), "Thu Dec 31");
  assert.equal(shortDate(null), "—");
  assert.equal(shortDate("not a date"), "not a date");
});

test("hours drop a pointless decimal", () => {
  assert.equal(hours(6), "6 h");
  assert.equal(hours(4.5), "4.5 h");
  assert.equal(hours(10.25), "10.3 h");
  assert.equal(hours(0), "0 h");
  assert.equal(hours(null), "—");
});

const base = {
  driver: null,
  driverTaskKey: null,
  priorityFromKey: null,
  unscheduledReason: null,
  assigneeName: "Ana",
  expectedUnblockDate: null,
  forecastFinish: "2026-11-23",
} as const;

test("a scheduled task says why it starts when it does", () => {
  assert.equal(forecastReason({ ...base, driver: "start" }), "Can start now.");
  assert.equal(
    forecastReason({ ...base, driver: "predecessor", driverTaskKey: "BIN-4" }),
    "Starts after BIN-4 finishes.",
  );
  assert.equal(forecastReason({ ...base, driver: "resource" }), "Starts when Ana is free of higher-priority work.");
  assert.equal(forecastReason({ ...base, driver: "not_before" }), "Starts on its not-before date.");
  assert.equal(
    forecastReason({ ...base, driver: "blocked_until", expectedUnblockDate: "2026-12-05" }),
    "Starts when it is expected to be unblocked (Sat Dec 5).",
  );
});

test("a task pulled forward for more important work says so", () => {
  assert.equal(
    forecastReason({ ...base, driver: "start", priorityFromKey: "TOP-1" }),
    "Can start now. Moved up because TOP-1 waits on it.",
  );
});

test("unscheduled work is explained in plain words, never dropped silently", () => {
  const why = (unscheduledReason: string) => forecastReason({ ...base, forecastFinish: null, unscheduledReason });
  assert.equal(why("no estimate"), "Not forecast: it has no estimate yet.");
  assert.equal(why("no assignee"), "Not forecast: nobody is assigned.");
  assert.equal(why("blocked"), "Not forecast: blocked, with no expected unblock date.");
  assert.equal(why("project has no stack rank"), "Not forecast: the project has no stack rank yet.");
  assert.equal(
    why("blocked by unscheduled predecessor 42"),
    "Not forecast: it waits on work that is not forecast itself.",
  );
  // A reason this file has never heard of is still shown, not swallowed.
  assert.equal(why("something new"), "Not forecast: something new.");
  assert.equal(forecastReason({ ...base, forecastFinish: null }), "No forecast yet.");
});
