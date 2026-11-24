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

test("hours drop a pointless decimal", async () => {
  assert.equal(hours(6), "6 h");
  assert.equal(hours(4.5), "4.5 h");
  assert.equal(hours(10.25), "10.3 h");
  assert.equal(hours(0), "0 h");
  assert.equal(hours(3494), "3,494 h");

  const F = await import("../src/modules/tracker/components/format");
  assert.equal(F.notInForecast(0, 0), null, "every card dated: nothing to say");
  assert.equal(F.notInForecast(1, 1), "1 card is not in this forecast: it has no estimate. The real finish is later.");
  assert.equal(
    F.notInForecast(6, 4),
    "6 cards are not in this forecast, 4 for lack of an estimate. The real finish is later.",
  );
  // Progress is by hours when there are estimates: one big card done counts for more than its number.
  assert.deepEqual(F.progress({ taskCount: 4, doneCount: 1, remainingHours: 20, estimatedHours: 100 }), {
    percent: 80,
    byHours: true,
    doneHours: 80,
  });
  assert.deepEqual(F.progress({ taskCount: 4, doneCount: 1, remainingHours: 0, estimatedHours: 0 }), {
    percent: 25,
    byHours: false,
    doneHours: 0,
  });
  assert.equal(F.progress({ taskCount: 0, doneCount: 0, remainingHours: 0, estimatedHours: 0 }).percent, 0);
  // Four finished cards with no estimate beside ten estimated ones of 10 h each, none started:
  // they count as 40 h done of 140, not as nothing.
  assert.equal(
    F.progress({
      taskCount: 14,
      doneCount: 4,
      remainingHours: 100,
      estimatedHours: 100,
      estimatedCards: 10,
      unestimatedDoneCards: 4,
      unestimatedTasks: 0,
    }).percent,
    29,
  );
  // An open card with no estimate makes the whole larger, so it cannot flatter the figure.
  assert.equal(
    F.progress({
      taskCount: 3,
      doneCount: 1,
      remainingHours: 0,
      estimatedHours: 20,
      estimatedCards: 2,
      unestimatedDoneCards: 0,
      unestimatedTasks: 2,
    }).percent,
    50,
  );
  assert.equal(
    F.progress({ taskCount: 2, doneCount: 0, remainingHours: 50, estimatedHours: 40 }).percent,
    0,
    "never below zero",
  );
  assert.equal(hours(12345.67), "12,345.7 h");
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
    "1 card has hours left that have not been updated in over a week",
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
  ) => ({ key, name: `${key} project`, state, targetDate, atRisk, remainingHours, unscheduledTasks, unestimatedTasks });

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
    nextTarget: { key: "ALPHA", name: "ALPHA project", date: "2026-12-11" },
  });
  // A target of today is still to come.
  assert.deepEqual(portfolioSummary([p("NOW", "active", "2026-11-20", false, 1)], "2026-11-20").nextTarget, {
    key: "NOW",
    name: "NOW project",
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
  const none = { forIds: [], byIds: [], grouped: false, lens: "for", level: "group" };
  assert.deepEqual(departmentView({}), none);
  assert.deepEqual(departmentView({ for: "12", group: "1" }), { ...none, forIds: [12], grouped: true });
  // Several at once, in either filter, and both together.
  assert.deepEqual(departmentView({ for: "12,14", by: "7" }), { ...none, forIds: [12, 14], byIds: [7] });
  assert.deepEqual(departmentView({ for: ["7,7,x,-3", "9"] }).forIds, [7], "repeats and non-ids are dropped");
  // The grouping says which department the headings are, and at which level.
  assert.deepEqual(departmentView({ group: "team" }), { ...none, grouped: true, level: "team" });
  assert.deepEqual(departmentView({ group: "by" }), { ...none, grouped: true, lens: "by" });
  assert.deepEqual(departmentView({ group: "by-team" }), { ...none, grouped: true, lens: "by", level: "team" });
  assert.deepEqual(departmentView({ group: "yes" }), none, "not a grouping");
  assert.deepEqual(departmentView({ for: "abc" }).forIds, []);

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
    forIds: [],
    byIds: [],
    grouped: false,
    lens: "for",
    level: "group",
    sort: "rank",
    only: null,
    q: "",
    states: [],
    valueIds: [],
    assignees: [],
    risk: [],
    progressMin: null,
    progressMax: null,
    hoursMin: null,
    hoursMax: null,
    dateField: "target",
    dateFrom: null,
    dateTo: null,
  };
  assert.deepEqual(F.listView({}), plain);
  assert.deepEqual(
    F.listView({
      sort: "nonsense",
      only: "everything",
      q: "   ",
      state: "bogus",
      value: "x",
      risk: "nope",
      pmin: "abc",
      from: "notadate",
    }),
    plain,
    "unknown values are ignored",
  );
  const busy = F.listView({
    for: "12",
    group: "1",
    sort: "value",
    only: "at-risk",
    q: "  ware ",
    state: "active,completed",
    value: "3,7",
    who: "Alice Smith,Bob Jones",
    risk: "at-risk,none",
    pmin: "10",
    pmax: "90",
    hmin: "5",
    hmax: "40",
    datef: "forecast",
    from: "2026-01-01",
    to: "2026-12-31",
  });
  assert.deepEqual(busy, {
    forIds: [12],
    byIds: [],
    grouped: true,
    lens: "for",
    level: "group",
    sort: "value",
    only: "at-risk",
    q: "ware",
    states: ["active", "completed"],
    valueIds: [3, 7],
    assignees: ["Alice Smith", "Bob Jones"],
    risk: ["at-risk", "none"],
    progressMin: 10,
    progressMax: 90,
    hoursMin: 5,
    hoursMax: 40,
    dateField: "forecast",
    dateFrom: "2026-01-01",
    dateTo: "2026-12-31",
  });

  assert.equal(F.listHref(F.listView({})), "/tracker");
  // Round trip: whatever busy writes to reads back as busy.
  assert.deepEqual(F.listView(Object.fromEntries(new URLSearchParams(F.listHref(busy).split("?")[1]))), busy);
  assert.equal(F.listHref(F.listView({}), { only: "incomplete" }), "/tracker?only=incomplete");
  // A few written forms, for readability.
  assert.equal(F.listHref({ ...plain, states: ["active"] }), "/tracker?state=active");
  assert.equal(F.listHref({ ...plain, progressMin: 10, progressMax: 50 }), "/tracker?pmin=10&pmax=50");
  assert.equal(F.listHref({ ...plain, hoursMin: 5 }), "/tracker?hmin=5");
  assert.equal(
    F.listHref({ ...plain, dateFrom: "2026-01-01" }),
    "/tracker?from=2026-01-01",
    "target is the default date, so it is not written",
  );
  assert.equal(
    F.listHref({ ...plain, dateField: "forecast", dateFrom: "2026-01-01" }),
    "/tracker?datef=forecast&from=2026-01-01",
  );
  assert.equal(F.listHref({ ...plain, dateField: "forecast" }), "/tracker", "the date only matters with a range");

  // Ranks are changed only with every project in view, in rank order.
  assert.equal(F.ranksLocked(plain), false);
  assert.equal(F.listHref({ ...plain, lens: "by", grouped: true }), "/tracker?group=by");
  assert.equal(F.listHref({ ...plain, forIds: [3, 5], byIds: [9] }), "/tracker?for=3%2C5&by=9");
  assert.equal(F.ranksLocked({ ...plain, byIds: [9] }), true, "filtered by who does the work");
  assert.equal(F.ranksLocked({ ...plain, lens: "by" }), false, "the same list as ever until it is grouped");
  assert.equal(F.ranksLocked({ ...plain, lens: "by", grouped: true }), true, "grouped by who does the work");
  assert.equal(F.listHref({ ...plain, grouped: true, level: "team" }), "/tracker?group=for-team");
  assert.equal(F.ranksLocked({ ...plain, grouped: true, level: "team" }), true, "grouped by department within a group");
  assert.equal(F.ranksLocked({ ...plain, grouped: true }), false);
  assert.equal(F.ranksLocked({ ...plain, forIds: [3] }), true);
  assert.equal(F.ranksLocked({ ...plain, sort: "name" }), true);
  assert.equal(F.ranksLocked({ ...plain, only: "active" }), true);
  assert.equal(F.ranksLocked({ ...plain, q: "x" }), true);
  assert.equal(F.ranksLocked({ ...plain, states: ["active"] }), true, "a state filter locks ranks");
  assert.equal(F.ranksLocked({ ...plain, valueIds: [3] }), true);
  assert.equal(F.ranksLocked({ ...plain, assignees: ["Alice Smith"] }), true);
  assert.equal(F.ranksLocked({ ...plain, risk: ["at-risk"] }), true);
  assert.equal(F.ranksLocked({ ...plain, progressMin: 10 }), true);
  assert.equal(F.ranksLocked({ ...plain, hoursMax: 40 }), true);
  assert.equal(F.ranksLocked({ ...plain, dateFrom: "2026-01-01" }), true);
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
      remainingHours: number;
      estimatedHours: number;
      estimatedCards: number;
      unestimatedDoneCards: number;
      unestimatedTasks: number;
      taskCount: number;
      doneCount: number;
      assigneeNames: string[];
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
    remainingHours: 0,
    estimatedHours: 0,
    estimatedCards: 0,
    unestimatedDoneCards: 0,
    unestimatedTasks: 0,
    taskCount: 0,
    doneCount: 0,
    assigneeNames: [] as string[],
    ...more,
  });
  // In stack-rank order, as the service hands them over, finished last.
  const all = [
    p("WH", "Warehouse", "active", {
      targetDate: "2026-12-31",
      forecastFinish: "2027-01-10",
      atRisk: true,
      valueBucketId: 2,
      valueSort: 5,
      remainingHours: 40,
      estimatedHours: 100, // 60% done
      assigneeNames: ["Alice Smith"],
    }),
    p("ETC", "ETC roll-up", "active", {
      targetDate: "2026-12-11",
      forecastFinish: "2026-12-01",
      atRisk: false,
      valueBucketId: 3,
      valueSort: 3,
      forDepartmentId: 7,
      forGroupSort: 1,
      remainingHours: 10,
      estimatedHours: 20, // 50% done
      assigneeNames: ["Bob Jones"],
    }),
    p("OLD", "Legacy tidy", "planned", {
      unscheduledTasks: 2,
      justification: null,
      valueBucketId: null,
      valueSort: null,
      remainingHours: 5, // 0% done, no estimated hours
    }),
    p("PAY", "Paylocity time off", "on_hold", {
      forecastFinish: "2026-11-30",
      valueBucketId: 3,
      valueSort: 3,
      forDepartmentId: null,
      forGroupSort: null,
      remainingHours: 0,
      estimatedHours: 10, // 100% done
    }),
    p("DONE", "Warehouse phase one", "completed", { valueBucketId: 4, valueSort: 4 }),
    p("DROP", "Abandoned", "cancelled"),
  ];
  const keys = (v: Partial<typeof view>, scope: Set<number> | null = null) =>
    F.narrowProjects(all, { ...view, ...v }, scope).shown.map((x) => x.key);
  const ALL_STATES = ["planned", "active", "on_hold", "completed", "cancelled"];

  assert.deepEqual(
    keys({}),
    ["WH", "ETC", "OLD", "PAY"],
    "finished and cancelled are left out unless a state is chosen",
  );
  assert.deepEqual(
    keys({ states: ALL_STATES }),
    ["WH", "ETC", "OLD", "PAY", "DONE", "DROP"],
    "every state shows them all",
  );
  assert.deepEqual(keys({ states: ["active"] }), ["WH", "ETC"], "one state");
  assert.deepEqual(keys({ states: ["completed", "cancelled"] }), ["DONE", "DROP"], "the finished states");
  assert.deepEqual(keys({ q: "ware" }), ["WH"], "the name, any case; the finished one stays hidden");
  assert.deepEqual(keys({ q: "WARE", states: ALL_STATES }), ["WH", "DONE"]);
  assert.deepEqual(keys({ q: "etc" }), ["ETC"], "or the key");
  assert.deepEqual(keys({}, new Set([7])), ["ETC"]);

  // The new column filters.
  assert.deepEqual(keys({ valueIds: [3] }), ["ETC", "PAY"], "a value bucket");
  assert.deepEqual(keys({ assignees: ["Alice Smith"] }), ["WH"], "assignee by name");
  assert.deepEqual(keys({ risk: ["at-risk"] }), ["WH"]);
  assert.deepEqual(keys({ risk: ["on-track"] }), ["ETC"]);
  assert.deepEqual(keys({ risk: ["none"] }), ["OLD", "PAY"], "not yet forecast");
  assert.deepEqual(keys({ progressMin: 60 }), ["WH", "PAY"], "60% and up");
  assert.deepEqual(keys({ progressMax: 50 }), ["ETC", "OLD"], "50% and under");
  assert.deepEqual(keys({ hoursMin: 10 }), ["WH", "ETC"], "10 hours left and up");
  assert.deepEqual(keys({ hoursMax: 5 }), ["OLD", "PAY"], "5 hours left and under");
  assert.deepEqual(keys({ dateFrom: "2026-12-20" }), ["WH"], "target on or after a day");
  assert.deepEqual(
    keys({ dateField: "forecast", dateTo: "2026-12-05" }),
    ["ETC", "PAY"],
    "forecast on or before a day",
  );

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
