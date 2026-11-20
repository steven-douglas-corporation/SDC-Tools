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

test("the roster's teams become departments in two levels, with nothing the tracker made up", async () => {
  const { orgUnits } = await import("../src/modules/tracker/org-units");
  const shape = (teams: (string | null)[]) => orgUnits(teams).map((u) => [u.code, u.name, u.parentCode]);

  assert.deepEqual(shape([]), [["company", "Company-wide", null]], "company-wide is always offered");

  assert.deepEqual(shape(["controls", "mech", null, "pm", "finance", "hr", "mech"]), [
    ["company", "Company-wide", null],
    // One team in its group: it stands alone, not under a group of one.
    ["pm", "Project Management", null],
    ["group:engineering", "Engineering", null],
    ["mech", "Mechanical Engineering", "group:engineering"],
    ["controls", "Controls Engineering", "group:engineering"],
    ["group:support", "Support", null],
    ["hr", "Human Resources", "group:support"],
    ["finance", "Finance", "group:support"],
  ]);

  // Only teams somebody is on, and a code the app has no name for is still listed, by its code.
  const odd = shape(["mech", "skunkworks"]);
  assert.deepEqual(odd, [
    ["company", "Company-wide", null],
    ["mech", "Mechanical Engineering", null],
    ["skunkworks", "skunkworks", null],
  ]);
});

test("the department filter and grouping read the address, and keep rank order inside a department", async () => {
  const { byDepartment, departmentView, projectsFor } = await import("../src/modules/tracker/components/format");
  assert.deepEqual(departmentView({}), { forId: null, grouped: false, lens: "for", level: "group" });
  assert.deepEqual(departmentView({ for: "12", group: "1" }), {
    forId: 12,
    grouped: true,
    lens: "for",
    level: "group",
  });
  assert.deepEqual(departmentView({ dept: "by", group: "1" }), {
    forId: null,
    grouped: true,
    lens: "by",
    level: "group",
  });
  assert.equal(departmentView({ dept: "other" }).lens, "for");
  assert.deepEqual(departmentView({ group: "team" }), { forId: null, grouped: true, lens: "for", level: "team" });
  assert.deepEqual(departmentView({ for: ["7", "9"], group: "yes" }), {
    forId: 7,
    grouped: false,
    lens: "for",
    level: "group",
  });
  assert.deepEqual(
    departmentView({ for: "-3" }),
    { forId: null, grouped: false, lens: "for", level: "group" },
    "not a department's id",
  );
  assert.deepEqual(departmentView({ for: "abc" }).forId, null);

  const p = (key: string, forDepartmentId: number | null, forGroupSort: number | null) => ({
    key,
    forDepartmentId,
    forGroupSort,
  });
  const ranked = [p("A", 5, 3), p("B", null, null), p("C", 2, 1), p("D", 6, 3), p("E", 2, 1)];
  assert.deepEqual(projectsFor(ranked, null), ranked);
  assert.deepEqual(
    projectsFor(ranked, new Set([5, 6])).map((x) => x.key),
    ["A", "D"],
  );
  assert.deepEqual(projectsFor(ranked, new Set([99])), [], "a project with no department is for none");
  assert.deepEqual(
    byDepartment(ranked).map((x) => x.key),
    ["C", "E", "A", "D", "B"],
    "no department goes last",
  );
});

test("the project list's view is read from the address and written back without its defaults", async () => {
  const F = await import("../src/modules/tracker/components/format");
  const plain: ReturnType<typeof F.listView> = {
    forId: null,
    grouped: false,
    lens: "for",
    level: "group",
    sort: "rank",
    only: null,
    q: "",
    finished: false,
  };
  assert.deepEqual(F.listView({}), plain);
  assert.deepEqual(
    F.listView({ sort: "nonsense", only: "everything", q: "   ", done: "yes" }),
    plain,
    "unknown values are ignored",
  );
  const busy = F.listView({ for: "12", group: "1", sort: "value", only: "at-risk", q: "  ware ", done: "1" });
  assert.deepEqual(busy, {
    forId: 12,
    grouped: true,
    lens: "for",
    level: "group",
    sort: "value",
    only: "at-risk",
    q: "ware",
    finished: true,
  });

  assert.equal(F.listHref(F.listView({})), "/tracker");
  assert.equal(F.listHref(busy), "/tracker?for=12&group=1&sort=value&only=at-risk&q=ware&done=1");
  // One thing changed, the rest kept: what a figure's link does.
  assert.equal(F.listHref(busy, { only: null }), "/tracker?for=12&group=1&sort=value&q=ware&done=1");
  assert.equal(F.listHref(F.listView({}), { only: "incomplete" }), "/tracker?only=incomplete");
  // Round trip.
  assert.deepEqual(F.listView(Object.fromEntries(new URLSearchParams(F.listHref(busy).split("?")[1]))), busy);

  // Ranks are changed only with every project in view, in rank order.
  assert.equal(F.ranksLocked(plain), false);
  assert.equal(F.listHref({ ...plain, lens: "by", grouped: true }), "/tracker?group=1&dept=by");
  assert.equal(F.ranksLocked({ ...plain, lens: "by" }), false, "the same list as ever until it is grouped");
  assert.equal(F.ranksLocked({ ...plain, lens: "by", grouped: true }), true, "grouped by who does the work");
  assert.equal(F.listHref({ ...plain, grouped: true, level: "team" }), "/tracker?group=team");
  assert.equal(F.ranksLocked({ ...plain, grouped: true, level: "team" }), true, "grouped by department within a group");
  assert.equal(F.ranksLocked({ ...plain, grouped: true }), false);
  assert.equal(F.ranksLocked({ ...plain, forId: 3 }), true);
  assert.equal(F.ranksLocked({ ...plain, sort: "name" }), true);
  assert.equal(F.ranksLocked({ ...plain, only: "active" }), true);
  assert.equal(F.ranksLocked({ ...plain, q: "x" }), true);
});

test("narrowing the project list: finished hidden, search, one figure, sorting with blanks last", async () => {
  const F = await import("../src/modules/tracker/components/format");
  const view = F.listView({});
  const p = (
    key: string,
    name: string,
    state: string,
    more: Partial<{
      targetDate: string | null;
      forecastFinish: string | null;
      atRisk: boolean | null;
      unscheduledTasks: number;
      justification: string | null;
      valueBucketId: number | null;
      valueSort: number | null;
      forDepartmentId: number | null;
      doneByDepartmentId: number | null;
      forGroupSort: number | null;
    }> = {},
  ) => ({
    key,
    name,
    state,
    targetDate: null,
    forecastFinish: null,
    atRisk: null,
    unscheduledTasks: 0,
    justification: "Saves time.",
    valueBucketId: 1,
    valueSort: 1,
    forDepartmentId: 5,
    doneByDepartmentId: 5,
    forGroupSort: 2,
    ...more,
  });
  // In stack-rank order, as the service hands them over, finished last.
  const all = [
    p("WH", "Warehouse", "active", {
      targetDate: "2026-12-31",
      forecastFinish: "2027-01-10",
      atRisk: true,
      valueSort: 5,
    }),
    p("ETC", "ETC roll-up", "active", {
      targetDate: "2026-12-11",
      forecastFinish: "2026-12-01",
      atRisk: false,
      valueSort: 3,
      forDepartmentId: 7,
      forGroupSort: 1,
    }),
    p("OLD", "Legacy tidy", "planned", {
      unscheduledTasks: 2,
      justification: null,
      valueBucketId: null,
      valueSort: null,
    }),
    p("PAY", "Paylocity time off", "on_hold", {
      forecastFinish: "2026-11-30",
      valueSort: 3,
      forDepartmentId: null,
      forGroupSort: null,
    }),
    p("DONE", "Warehouse phase one", "completed", { valueSort: 4 }),
    p("DROP", "Abandoned", "cancelled"),
  ];
  const keys = (v: Partial<typeof view>, scope: Set<number> | null = null) =>
    F.narrowProjects(all, { ...view, ...v }, scope).shown.map((x) => x.key);

  assert.deepEqual(keys({}), ["WH", "ETC", "OLD", "PAY"], "finished and cancelled are left out unless asked for");
  assert.deepEqual(keys({ finished: true }), ["WH", "ETC", "OLD", "PAY", "DONE", "DROP"]);
  assert.deepEqual(keys({ q: "ware" }), ["WH"], "the name, any case; the finished one stays hidden");
  assert.deepEqual(keys({ q: "WARE", finished: true }), ["WH", "DONE"]);
  assert.deepEqual(keys({ q: "etc" }), ["ETC"], "or the key");
  assert.deepEqual(keys({}, new Set([7])), ["ETC"]);

  assert.deepEqual(keys({ only: "active" }), ["WH", "ETC"]);
  assert.deepEqual(keys({ only: "at-risk" }), ["WH"]);
  assert.deepEqual(keys({ only: "not-forecast" }), ["OLD"]);
  assert.deepEqual(keys({ only: "incomplete" }), ["OLD", "PAY"], "no justification, no value, or no department");
  assert.equal(F.isIncomplete(all[0]!), false);

  assert.deepEqual(keys({ sort: "name" }), ["ETC", "OLD", "PAY", "WH"]);
  assert.deepEqual(keys({ sort: "target" }), ["ETC", "WH", "OLD", "PAY"], "no target goes last, in rank order");
  assert.deepEqual(keys({ sort: "forecast" }), ["PAY", "ETC", "WH", "OLD"]);
  assert.deepEqual(
    keys({ sort: "value" }),
    ["WH", "ETC", "PAY", "OLD"],
    "highest first, ties in rank order, none last",
  );
  assert.deepEqual(keys({ grouped: true }), ["ETC", "WH", "OLD", "PAY"], "by department, no department last");
  assert.deepEqual(keys({ grouped: true, sort: "name" }), ["ETC", "OLD", "WH", "PAY"], "sorted inside each department");

  // The figures describe the list before one of them narrows it.
  const chosen = F.narrowProjects(all, { ...view, only: "at-risk" }, null);
  assert.deepEqual(
    chosen.described.map((x) => x.key),
    ["WH", "ETC", "OLD", "PAY"],
  );
  assert.deepEqual(
    chosen.shown.map((x) => x.key),
    ["WH"],
  );
});
