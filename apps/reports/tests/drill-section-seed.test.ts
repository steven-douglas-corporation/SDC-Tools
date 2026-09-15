import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { seedSectionFilter, matchesDrillFilters, clearDrillFilters, activeFilterCount } from "../src/lib/drill-filters";
import { mapPunchToColumns, rawCodesFoldingInto, SECTION_ALIASES } from "../src/lib/sections";

// ── The section bar and the panel it opens must count the same punches (2026-09-14) ──
//
// JobHoursDashboard passes the clicked bar's COLUMN code (40-211) as initialSection.
// The panel filters getJobHoursDetail's rows, whose `section` is the RAW Paylocity pair,
// while the bar's Actual is the fold of every raw code onto the column (actual-hours.ts
// via mapPunchToColumns). Seeding the bare column code matched only punches literally
// coded 40-211: a 634h Machine Testing bar opened a panel showing ~149h, and since Clear
// filters returns to the seed, the other 485h were unreachable. Known bug class — every
// consumer that narrows JobHoursDetail by a standardized code must widen through
// rawCodesFoldingInto first.

// Job 1131's real Machine Testing punches (tests/actual-hours-fold.test.ts lists the
// audit), by raw code.
const RAW_PUNCHES: [string, number][] = [
  ["40-211", 296.86],
  ["40-311", 490.33],
  ["40-312", 4.5],
  ["40-313", 8.25],
  ["40-515", 1.5],
  // Other columns on the same job, which the 40-211 seed must NOT pick up.
  ["40-411", 14.42],
  ["40-412", 77.56],
  ["10-211", 160.52],
  ["10-311", 63.25],
];

const rows = RAW_PUNCHES.map(([section, hours], i) => ({
  section,
  hours,
  employee: `E${i}`,
  department: "Mechanical Engineering",
  date: "2026-07-15",
}));
const availableCodes = [...new Set(rows.map((r) => r.section))];

/** What the bar shows: every punch folded onto the column, summed. */
function barTotal(column: string): number {
  let total = 0;
  for (const r of rows) for (const col of mapPunchToColumns(r.section, r.hours)) if (col.section === column) total += col.hours;
  return total;
}

test("the seeded filter for 40-211 includes every raw code that folds onto it and is present", () => {
  const seeded = seedSectionFilter("40-211", availableCodes);
  assert.ok(seeded);
  assert.deepEqual(seeded.sort(), ["40-211", "40-311", "40-312", "40-313", "40-515"]);
  // And nothing from another column — 40-411/40-412 fold onto 40-411, not here.
  assert.ok(!seeded.includes("40-411") && !seeded.includes("40-412"));
});

test("the panel opened from the 40-211 bar sums to exactly the bar", () => {
  const seeded = seedSectionFilter("40-211", availableCodes)!;
  const filters = { ...clearDrillFilters(), values: { section: seeded } };
  const shown = rows.filter((r) => matchesDrillFilters(r, filters)).reduce((s, r) => s + r.hours, 0);
  assert.ok(Math.abs(shown - barTotal("40-211")) < 1e-9, `panel ${shown} vs bar ${barTotal("40-211")}`);
  // The number the report was about: well above the ~149h the bare seed showed.
  assert.ok(shown > 600, `expected the full Machine Testing figure, got ${shown}`);
  // The seed IS a filter, so the total row reads "Shown" and Clear returns here.
  assert.equal(activeFilterCount(filters), 1);
});

test("the bare column code alone would have shown only the literal 40-211 punches — the bug", () => {
  const filters = { ...clearDrillFilters(), values: { section: ["40-211"] } };
  const shown = rows.filter((r) => matchesDrillFilters(r, filters)).reduce((s, r) => s + r.hours, 0);
  assert.equal(shown, 296.86);
  assert.ok(shown < barTotal("40-211"));
});

test("a split target seeds the split source too: 10-312 pulls in raw 10-311", () => {
  // 10-311 fans 30/70 onto 10-312/10-313, so a panel opened from either bar must show
  // the raw 10-311 punches (whole, as the drill lists punches, not allocations).
  const seeded = seedSectionFilter("10-312", ["10-312", "10-311", "10-313"]);
  assert.deepEqual(seeded?.sort(), ["10-311", "10-312"]);
});

test("the seed is intersected with the codes the detail holds — the menu can untick everything it ticks", () => {
  // A value the Section menu does not offer would be a filter nobody could see or
  // remove. 40-516/40-518 fold onto 40-211 but nobody booked them on this job.
  const seeded = seedSectionFilter("40-211", availableCodes)!;
  for (const code of seeded) assert.ok(availableCodes.includes(code), `${code} is seeded but not in the menu`);
  assert.ok(rawCodesFoldingInto(["40-211"]).includes("40-516"), "sanity: 40-516 does fold onto 40-211");
  assert.ok(!seeded.includes("40-516"));
});

test("the Monthly ETC drill is unchanged: an already-folded detail seeds exactly the column", () => {
  // getEtcMonthHoursDetail folds before it returns, so its sections are ETC column codes
  // only; the raw-only codes are never present and the intersection is the seed itself.
  const foldedCodes = ["10-211", "10-312", "10-313", "40-211", "40-411"];
  assert.deepEqual(seedSectionFilter("40-211", foldedCodes), ["40-211"]);
});

test("no seed, or a seed nothing matches, means no section filter", () => {
  assert.equal(seedSectionFilter(null, availableCodes), null);
  assert.equal(seedSectionFilter(undefined, availableCodes), null);
  assert.equal(seedSectionFilter("50-211", availableCodes), null); // nobody booked Teardown here
});

test("the alias table still says what this test assumes", () => {
  for (const c of ["40-311", "40-312", "40-313", "40-515"]) assert.equal(SECTION_ALIASES[c], "40-211");
  assert.equal(SECTION_ALIASES["40-412"], "40-411");
});

// ── Wiring ───────────────────────────────────────────────────────────────────

test("HoursDetailPanel seeds through seedSectionFilter, not by matching the bare code", () => {
  const src = readFileSync(join(process.cwd(), "src", "components", "HoursDetailPanel.tsx"), "utf8");
  assert.match(src, /seedSectionFilter\(/);
  assert.match(src, /values: seededSections \? \{ section: seededSections \} : \{\}/);
  assert.doesNotMatch(src, /detail\.sections\.some\(\(s\) => s\.code === initialSection\)/, "the bare-code seed is the bug");
});

test("JobHoursDashboard still hands the panel the column code — the widening is the panel's job", () => {
  const src = readFileSync(join(process.cwd(), "src", "components", "JobHoursDashboard.tsx"), "utf8");
  assert.match(src, /initialSection=\{drillRow\.code\}/);
});
