import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  activeFilterCount,
  clearDrillFilters,
  dateBounds,
  filterOptions,
  isFiltering,
  matchesDrillFilters,
  NO_DRILL_FILTERS,
  setFilterRange,
  setFilterValues,
  toggleFilterValue,
  type DrillFilters,
} from "../src/lib/drill-filters";

// ── Drill-through filters (§73) ──────────────────────────────────────────────
//
// What these guard is the set of properties that make a filter row trustworthy on a page
// where every drill total is compared against a KPI. All of them have a failure mode that
// is silent — the table just shows the wrong rows — so none of them should be left to a
// code review.

const ROWS = [
  { department: "Mechanical Engineering", employee: "Ann", section: "10-211", job: "1105 — Cell A", date: "2026-07-02", hours: 8 },
  { department: "Mechanical Engineering", employee: "Bob", section: "10-311", job: "1105 — Cell A", date: "2026-07-15", hours: 4 },
  { department: "Controls", employee: "Cid", section: "10-411", job: "1120 — Cell B", date: "2026-07-28", hours: 6 },
  { department: "", employee: "Dee", section: "10-411", job: "", date: "—", hours: 2 },
];

function withValues(values: DrillFilters["values"]): DrillFilters {
  return { ...clearDrillFilters(), values };
}

const shown = (f: DrillFilters) => ROWS.filter((r) => matchesDrillFilters(r, f)).map((r) => r.employee);

// ── An empty selection shows everything ─────────────────────────────────────

test("no filters means every row, not no rows", () => {
  // The state the panel OPENS in. Read the other way — an empty list matching nothing —
  // every drill would open blank, and the fix (tick everything) would be invisible.
  assert.deepEqual(shown(NO_DRILL_FILTERS), ["Ann", "Bob", "Cid", "Dee"]);
  assert.equal(activeFilterCount(NO_DRILL_FILTERS), 0);
  assert.equal(isFiltering(NO_DRILL_FILTERS), false);
});

test("a dimension emptied by Clear inside its own menu stops filtering", () => {
  // setFilterValues DELETES the key rather than storing []. Left as [], anything counting
  // keys would report a filter that is not narrowing anything — the badge saying "1" over
  // a table showing every row.
  const f = setFilterValues(withValues({ department: ["Controls"] }), "department", []);
  assert.deepEqual(shown(f), ["Ann", "Bob", "Cid", "Dee"]);
  assert.equal(activeFilterCount(f), 0);
});

// ── OR within a dimension, AND across dimensions ────────────────────────────

test("two values in one dimension WIDEN the set", () => {
  // The property that makes multi-select safe to reason about: ticking a second department
  // can only ever add rows. Under an AND reading it would empty the table, which is the
  // most common way a hand-rolled multi-select goes wrong.
  const one = withValues({ department: ["Controls"] });
  const two = withValues({ department: ["Controls", "Mechanical Engineering"] });
  assert.deepEqual(shown(one), ["Cid"]);
  assert.deepEqual(shown(two), ["Ann", "Bob", "Cid"]);
});

test("values in different dimensions NARROW the set", () => {
  const f = withValues({ department: ["Mechanical Engineering"], section: ["10-311"] });
  assert.deepEqual(shown(f), ["Bob"]);
  assert.equal(activeFilterCount(f), 2);
});

test("a missing department or job is selectable as the em-dash bucket", () => {
  // Punches with no department still have hours. The rollup already keeps them (groupValue
  // falls back to an em dash) so the group totals sum to the Total; a filter that could not
  // name them would make those rows unreachable in the one panel that exists to find them.
  assert.deepEqual(shown(withValues({ department: ["—"] })), ["Dee"]);
  assert.deepEqual(filterOptions(ROWS, "department"), ["Controls", "Mechanical Engineering", "—"]);
});

test("the em-dash bucket sorts last, because it is the absence of a value", () => {
  assert.equal(filterOptions(ROWS, "job").at(-1), "—");
});

// ── Dates ───────────────────────────────────────────────────────────────────

test("the date range is inclusive at both ends", () => {
  assert.deepEqual(shown(setFilterRange(clearDrillFilters(), "2026-07-02", "2026-07-15")), ["Ann", "Bob"]);
  assert.deepEqual(shown(setFilterRange(clearDrillFilters(), "2026-07-15", "")), ["Bob", "Cid"]);
  assert.deepEqual(shown(setFilterRange(clearDrillFilters(), "", "2026-07-02")), ["Ann"]);
});

test("a row with no usable date is excluded by a date filter and kept without one", () => {
  // "Unknown" is not an answer to "when". It cannot quietly drop hours from an unfiltered
  // total, because with no bound set the date is never looked at.
  assert.ok(shown(NO_DRILL_FILTERS).includes("Dee"));
  assert.ok(!shown(setFilterRange(clearDrillFilters(), "2026-07-01", "2026-07-31")).includes("Dee"));
});

test("the date range counts as ONE filter however many ends are set", () => {
  // It is one control in the row, so counting it twice would make the badge disagree with
  // what the reader can see.
  assert.equal(activeFilterCount(setFilterRange(clearDrillFilters(), "2026-07-01", "")), 1);
  assert.equal(activeFilterCount(setFilterRange(clearDrillFilters(), "2026-07-01", "2026-07-31")), 1);
});

test("dateBounds ignores rows with no usable date", () => {
  assert.deepEqual(dateBounds(ROWS), { min: "2026-07-02", max: "2026-07-28" });
  assert.deepEqual(dateBounds([{ date: "—" }]), { min: "", max: "" });
});

// ── The count is of filters, never of rows (§62) ────────────────────────────

test("the active count counts dimensions and the date range, not rows", () => {
  const f = setFilterRange(withValues({ department: ["Controls", "Mechanical Engineering"], job: ["1105 — Cell A"] }), "2026-07-01", "");
  // Two dimensions (one of them holding two values) plus the range = 3. Not 4, and
  // certainly not the number of rows shown — §62 removed row counts from these panels.
  assert.equal(activeFilterCount(f), 3);
});

// ── Immutability ────────────────────────────────────────────────────────────

test("every mutator returns a new object and leaves the old one alone", () => {
  // These are held in React state and compared by identity by the memos that re-filter the
  // rows. An in-place mutation shows as "the filter did nothing until I clicked twice".
  const a = withValues({ department: ["Controls"] });
  const b = toggleFilterValue(a, "department", "Mechanical Engineering");
  assert.notEqual(a, b);
  assert.deepEqual(a.values.department, ["Controls"]);
  assert.deepEqual(b.values.department, ["Controls", "Mechanical Engineering"]);
  // Toggling the same value again removes it.
  assert.deepEqual(toggleFilterValue(b, "department", "Controls").values.department, ["Mechanical Engineering"]);
});

test("clearDrillFilters hands back a fresh object, not the shared constant", () => {
  // Aliasing NO_DRILL_FILTERS into state is one accidental mutation away from every open
  // drill in the app sharing a filter set.
  assert.notEqual(clearDrillFilters(), NO_DRILL_FILTERS);
  assert.deepEqual(clearDrillFilters(), NO_DRILL_FILTERS);
});

// ── Group By and the filters stay independent (§73) ─────────────────────────

const SRC = join(import.meta.dirname, "..", "src");
// Comments stripped, same as tests/drill-design.test.ts does: these files EXPLAIN what
// they deliberately avoid ("nothing here touches the router"), and a raw-text assertion
// would fail on the sentence describing the property it is checking.
const read = (p: string) =>
  readFileSync(join(SRC, p), "utf8")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/[^\n]*$/gm, "")
    .replace(/\/\/[^\n"'`]*$/gm, "");

test("nothing in the filter model reads or writes a grouping dimension", () => {
  // The requirement is explicit that the two are independent. The way that comes undone is
  // a convenience — "filtering to one department should also drop it from the rollup" —
  // and it makes a filter change reshape the table, which is the rollup's job.
  const model = read(join("lib", "drill-filters.ts"));
  assert.doesNotMatch(model, /groupBy|GroupKey|groupHoursRows/, "the filter model must not know about grouping");
});

test("every Monthly ETC drill offers filters through the shared row", () => {
  // Four drills: Engineering/Shop hours, Undefined hours, Parts spent, Hours off the grid.
  // Two of them (the hand-rolled pair on the KPI strip) had no filters at all before §73,
  // and the point of routing all four through one component is that a fifth cannot be added
  // with a fourth opinion about what a filter row looks like.
  for (const f of [
    join("components", "HoursDetailPanel.tsx"),
    join("components", "UndefinedHoursPanel.tsx"),
    join("components", "EtcMonthKpiCards.tsx"),
  ]) {
    assert.match(read(f), /DrillFilterRow/, `${f} must use the shared filter row`);
  }
});

test("the filter menus are multi-select, not the single-choice select they replaced", () => {
  const drill = read(join("components", "ui", "Drill.tsx"));
  assert.doesNotMatch(drill, /export function DrillSelect/, "the single-choice pill is gone");
  assert.match(drill, /export function DrillFilterMenu/);
  // Checkbox rows, reusing the app's one menu vocabulary rather than a second set.
  assert.match(drill, /MenuCheckbox/);
});

test("a filter change cannot reload the Monthly ETC page", () => {
  // The requirement says so outright, and the rows are already in the panel: filtering is a
  // synchronous re-filter of an array. A router push here would make every tick cost a full
  // re-render of the heaviest route in the app.
  const hook = read(join("components", "useDrillFilters.ts"));
  assert.doesNotMatch(hook, /useRouter|router\.|searchParams/, "drill filters are local state, not URL state");
  // And no debounce: §32.7 forbids one on a checkbox, and with nothing to wait for it would
  // be pure added latency on the single-tick case.
  assert.doesNotMatch(hook, /setTimeout|debounce/i, "there is nothing to wait for");
});
