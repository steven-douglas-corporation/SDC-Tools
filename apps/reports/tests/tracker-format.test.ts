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

test("a parent's own hours are compared with the cards under it, in words", async () => {
  const { uncountedComparison } = await import("../src/modules/tracker/components/format");
  assert.equal(uncountedComparison(60, 6, 0), "The cards under it have 6 h left, 54 h less than this card says.");
  assert.equal(uncountedComparison(18, 18, 0), "The cards under it have 18 h left, the same as this card says.");
  assert.equal(uncountedComparison(12, 30, 0), "The cards under it have 30 h left, 18 h more than this card says.");
  assert.equal(
    uncountedComparison(60, 6, 2),
    "The cards under it have 6 h left, 54 h less than this card says. 2 of them have no estimate yet, so their total is too low.",
  );
  assert.match(uncountedComparison(60, 6, 1), /1 of them has no estimate yet/);
});

test("what a forecast leaves out is said in whole phrases, without counting a card twice", async () => {
  const { leftOutOfForecast } = await import("../src/modules/tracker/components/format");
  assert.deepEqual(leftOutOfForecast(0, 0, 0), []);
  assert.deepEqual(leftOutOfForecast(1, 1, 0), ["1 card has no forecast date: it has no estimate"]);
  assert.deepEqual(leftOutOfForecast(3, 3, 0), ["3 cards have no forecast date: none of them has an estimate"]);
  assert.deepEqual(leftOutOfForecast(3, 1, 0), ["3 cards have no forecast date, 1 for lack of an estimate"]);
  assert.deepEqual(leftOutOfForecast(2, 0, 1), [
    "2 cards have no forecast date",
    "1 card has hours left that nobody has confirmed lately",
  ]);
});

test("taking a rank another project holds says what moves, and which way", async () => {
  const { rankClashEffect } = await import("../src/modules/tracker/components/format");
  const clash = (moved: number, direction: "down" | "up") => ({ holderKey: "ALPHA", moved, direction });
  assert.equal(rankClashEffect(clash(1, "down")), "ALPHA moves down one place.");
  assert.equal(rankClashEffect(clash(2, "down")), "ALPHA and 1 other project each move down one place.");
  assert.equal(rankClashEffect(clash(4, "up")), "ALPHA and 3 other projects each move up one place.");
});

test("the figures above the project list are sums of its rows, over open projects only", async () => {
  const { portfolioSummary } = await import("../src/modules/tracker/components/format");
  const p = (
    key: string,
    state: string,
    targetDate: string | null,
    atRisk: boolean | null,
    remainingHours: number,
    unscheduledTasks = 0,
    unestimatedTasks = 0,
  ) => ({ key, state, targetDate, atRisk, remainingHours, unscheduledTasks, unestimatedTasks });

  assert.deepEqual(portfolioSummary([], "2026-11-20"), {
    open: 0,
    active: 0,
    withTarget: 0,
    atRisk: 0,
    hoursLeft: 0,
    notForecast: 0,
    noEstimate: 0,
    pastTarget: 0,
    nextTarget: null,
  });

  const s = portfolioSummary(
    [
      p("BRAIN", "active", "2026-12-31", false, 86, 1, 0),
      p("ALPHA", "active", "2026-12-11", true, 42.25, 2, 2),
      p("IDLE", "planned", null, null, 10.5, 2, 1),
      p("LATE", "on_hold", "2026-11-01", true, 4),
      // Finished and cancelled projects are in the list and in none of the figures.
      p("DONE", "completed", "2026-12-01", true, 99, 9, 9),
      p("GONE", "cancelled", "2026-11-25", null, 99, 9, 9),
    ],
    "2026-11-20",
  );
  assert.deepEqual(s, {
    open: 4,
    active: 2,
    withTarget: 3,
    atRisk: 2,
    hoursLeft: 142.8,
    notForecast: 5,
    noEstimate: 3,
    pastTarget: 1,
    // The soonest still to come: not LATE (gone by), not GONE (cancelled).
    nextTarget: { key: "ALPHA", date: "2026-12-11" },
  });
  // A target of today is still to come.
  assert.deepEqual(portfolioSummary([p("NOW", "active", "2026-11-20", false, 1)], "2026-11-20").nextTarget, {
    key: "NOW",
    date: "2026-11-20",
  });
});
