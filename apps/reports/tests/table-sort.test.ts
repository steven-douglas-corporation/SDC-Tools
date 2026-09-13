import { test } from "node:test";
import assert from "node:assert/strict";
import { cycleSortState, compareByType, sortRows, type SortState } from "../src/lib/table-sort";
import { groupHoursRows } from "../src/components/HoursDetailPanel";
import type { JobHoursDetail } from "../src/lib/job-hours-detail";

// table-sort.ts is the one sort mechanism every drill-through table shares. The
// invariant that matters most, mirrored from hours-detail-grouping.test.ts's own
// philosophy: sorting must never drop, duplicate, or change the VALUE of a row — only
// its position.

test("first click on a column sorts ascending", () => {
  const s = cycleSortState<"hours">(null, "hours");
  assert.deepEqual(s, { key: "hours", direction: "asc" });
});

test("second click on the SAME column sorts descending", () => {
  const s1 = cycleSortState<"hours">(null, "hours");
  const s2 = cycleSortState(s1, "hours");
  assert.deepEqual(s2, { key: "hours", direction: "desc" });
});

test("third click on the same column returns to the default (unsorted) state", () => {
  const s1 = cycleSortState<"hours">(null, "hours");
  const s2 = cycleSortState(s1, "hours");
  const s3 = cycleSortState(s2, "hours");
  assert.equal(s3, null);
});

test("clicking a DIFFERENT column restarts at ascending, whatever the previous direction was", () => {
  const descOnHours: SortState<"hours" | "date"> = { key: "hours", direction: "desc" };
  const s = cycleSortState(descOnHours, "date");
  assert.deepEqual(s, { key: "date", direction: "asc" });
});

// ── compareByType ────────────────────────────────────────────────────────────

test("numbers, currency and hours compare numerically, not lexicographically", () => {
  for (const type of ["number", "currency", "hours"] as const) {
    assert.ok(compareByType(type, 2, 10, "asc") < 0, `${type}: 2 before 10 ascending`);
    assert.ok(compareByType(type, 10, 2, "asc") > 0, `${type}: 10 after 2 ascending`);
    assert.ok(compareByType(type, 2, 10, "desc") > 0, `${type}: 2 after 10 descending`);
    assert.equal(compareByType(type, 5, 5, "asc"), 0);
  }
});

test("id sorts numerically when both sides parse as numbers — 979 before 1020 before 10000", () => {
  const ids = ["10000", "979", "1020"];
  ids.sort((a, b) => compareByType("id", a, b, "asc"));
  assert.deepEqual(ids, ["979", "1020", "10000"]);
});

test("a non-numeric id falls back to alphabetical rather than comparing as NaN", () => {
  const ids = ["PN-200", "PN-100", "PN-50"];
  ids.sort((a, b) => compareByType("id", a, b, "asc"));
  assert.deepEqual(ids, ["PN-100", "PN-200", "PN-50"], "plain string order — 'PN-50' sorts after '5' lexicographically");
});

test("text, status and date compare alphabetically via localeCompare", () => {
  assert.ok(compareByType("text", "Apple", "Banana", "asc") < 0);
  assert.ok(compareByType("status", "Active", "Complete", "asc") < 0);
});

test("dates already in YYYY-MM-DD form sort chronologically as plain strings", () => {
  const dates = ["2026-07-31", "2025-01-06", "2026-01-01"];
  dates.sort((a, b) => compareByType("date", a, b, "asc"));
  assert.deepEqual(dates, ["2025-01-06", "2026-01-01", "2026-07-31"]);
});

test("YYYY-MM month strings sort chronologically too", () => {
  const months = ["2026-01", "2025-12", "2026-08"];
  months.sort((a, b) => compareByType("date", a, b, "asc"));
  assert.deepEqual(months, ["2025-12", "2026-01", "2026-08"]);
});

test("a null/undefined value sorts LAST in both directions", () => {
  assert.ok(compareByType("number", null, 5, "asc") > 0, "null after a real value, ascending");
  assert.ok(compareByType("number", 5, null, "asc") < 0);
  assert.ok(compareByType("number", null, 5, "desc") > 0, "null STILL after a real value, descending — not multiplied by direction");
  assert.ok(compareByType("number", 5, null, "desc") < 0);
  assert.equal(compareByType("text", null, undefined, "asc"), 0, "two blanks are equal to each other");
});

test("null-last holds across every column type", () => {
  for (const type of ["text", "status", "id", "date", "number", "currency", "hours"] as const) {
    assert.ok(compareByType(type, null, "x", "asc") > 0, `${type} ascending`);
    assert.ok(compareByType(type, null, "x", "desc") > 0, `${type} descending`);
  }
});

// ── sortRows ─────────────────────────────────────────────────────────────────

type Row = { id: number; name: string; amount: number | null };
const ROWS: Row[] = [
  { id: 1, name: "Charlie", amount: 30 },
  { id: 2, name: "Alice", amount: null },
  { id: 3, name: "Bob", amount: 10 },
];
const COLUMNS = {
  name: { type: "text" as const, value: (r: Row) => r.name },
  amount: { type: "number" as const, value: (r: Row) => r.amount },
};

test("sortRows returns a NEW array and never mutates the input", () => {
  const before = [...ROWS];
  const sorted = sortRows(ROWS, { key: "name", direction: "asc" }, COLUMNS);
  assert.notEqual(sorted, ROWS, "must be a different array reference");
  assert.deepEqual(ROWS, before, "the input array's order must be untouched");
});

test("sortRows with sort: null returns the input's own order, unchanged", () => {
  const sorted = sortRows(ROWS, null, COLUMNS);
  assert.deepEqual(sorted.map((r) => r.id), [1, 2, 3]);
});

test("sortRows with an unknown sort key is a no-op rather than throwing", () => {
  // The realistic case: a rollup's sort key survives a groupBy change that dropped the
  // dimension it was sorting on.
  const sorted = sortRows(ROWS, { key: "not_a_real_column", direction: "asc" } as never, COLUMNS);
  assert.deepEqual(sorted.map((r) => r.id), [1, 2, 3]);
});

test("sortRows sorts text ascending and descending", () => {
  const asc = sortRows(ROWS, { key: "name", direction: "asc" }, COLUMNS).map((r) => r.name);
  assert.deepEqual(asc, ["Alice", "Bob", "Charlie"]);
  const desc = sortRows(ROWS, { key: "name", direction: "desc" }, COLUMNS).map((r) => r.name);
  assert.deepEqual(desc, ["Charlie", "Bob", "Alice"]);
});

test("sortRows keeps a null value last whichever direction is chosen", () => {
  const asc = sortRows(ROWS, { key: "amount", direction: "asc" }, COLUMNS).map((r) => r.id);
  assert.deepEqual(asc, [3, 1, 2], "10, 30, then the null row");
  const desc = sortRows(ROWS, { key: "amount", direction: "desc" }, COLUMNS).map((r) => r.id);
  assert.deepEqual(desc, [1, 3, 2], "30, 10, then STILL the null row last");
});

// ── Composition with grouping (groupHoursRows) ──────────────────────────────
// Same REAL fixture hours-detail-grouping.test.ts uses, so a sort applied to its output
// is proven not to disturb the one invariant that test file exists to protect: the
// group total footing to the ungrouped total.

const row = (over: Partial<JobHoursDetail["rows"][number]> = {}): JobHoursDetail["rows"][number] =>
  ({
    date: "2026-07-31",
    job: "1148 BISCUIT QTY 10",
    employee: "Jake Wiegand",
    department: "Mechanical Engineering",
    section: "10-211",
    sectionName: "ME Gen",
    hours: 8,
    ...over,
  }) as JobHoursDetail["rows"][number];

const REAL = [
  row({ employee: "Jake Wiegand", department: "Mechanical Engineering", hours: 8 }),
  row({ employee: "Jake Wiegand", department: "Mechanical Engineering", hours: 9 }),
  row({ employee: "Jake Wiegand", department: "Mechanical Engineering", hours: 10 }),
  row({ employee: "Robert Brooks", department: "Electrical Build", section: "10-412", sectionName: "Elec Build", hours: 0.4 }),
  row({ employee: "Samuel Adams", department: "Mechanical Build / Manufacturing", section: "10-411", sectionName: "Mech Build", hours: 4 }),
  row({ employee: "Paul Vinci", department: "Mechanical Engineering", hours: 5 }),
];

test("sorting a grouped rollup by Hours reorders the groups without changing the total", () => {
  const groups = groupHoursRows(REAL, ["employee"])!;
  const expectedTotal = groups.reduce((s, g) => s + g.hours, 0);

  const sorted = sortRows(groups, { key: "hours", direction: "asc" }, {
    hours: { type: "hours", value: (g) => g.hours },
  });

  assert.equal(sorted.length, groups.length, "no group gained or lost");
  assert.equal(sorted.reduce((s, g) => s + g.hours, 0), expectedTotal, "the total must foot exactly the same after re-ordering");
  for (let i = 1; i < sorted.length; i++) {
    assert.ok(sorted[i].hours >= sorted[i - 1].hours, "ascending by hours");
  }
  // The un-sorted default (hours-descending, from groupHoursRows itself) must be the
  // opposite order of the ascending sort we just asked for, over the same groups.
  assert.deepEqual(
    sorted.map((g) => g.key),
    [...groups].sort((a, b) => a.hours - b.hours).map((g) => g.key),
  );
});

test("sorting a grouped rollup by its dimension label sorts alphabetically, ties broken stably", () => {
  const groups = groupHoursRows(REAL, ["employee"])!;
  const sorted = sortRows(groups, { key: "employee", direction: "asc" }, {
    employee: { type: "text", value: (g) => g.values[0] },
  });
  assert.deepEqual(
    sorted.map((g) => g.values[0]),
    ["Jake Wiegand", "Paul Vinci", "Robert Brooks", "Samuel Adams"],
  );
});
