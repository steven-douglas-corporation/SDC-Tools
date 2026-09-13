import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mapPunchToColumns, SECTIONS, SECTION_ALIASES } from "../src/lib/sections";

// ── The 1,410 missing hours on job 1131 (2026-09-02) ────────────────────────
//
// JobHoursDetail.section stores the RAW Paylocity pair and every consumer folds
// it onto the app's fixed columns itself. actual-hours.ts — which defines
// "actual hours worked to date" for the Job Hour Details chart, the Projects
// grid, the Quoted page and the projects export — never did. It grouped by the
// raw pair, and the chart, which iterates the fixed SECTIONS list, then had
// nowhere to put codes like 40-311 or 10-414 and dropped them silently.
//
// Measured on job 1131 before the fix: 3,442.36 punch hours in the table,
// 2,032.03 drawn. After: 3,442.36 = 3,442.36.

test("every raw pair seen on job 1131 lands on a real column or is explicitly unmapped", () => {
  // The exact codes the audit found, with the hours each carried.
  const observed: [string, number][] = [
    ["10-411", 512.22], ["40-311", 490.33], ["10-412", 377.59], ["10-414", 355.48],
    ["40-211", 296.86], ["10-312", 247.8], ["10-413", 200.54], ["10-313", 162.0],
    ["10-211", 160.52], ["13-211", 150.65], ["14-211", 114.98], ["40-412", 77.56],
    ["15-211", 75.41], ["10-311", 63.25], ["10-515", 59.5], ["11-211", 49.5],
    ["40-411", 14.42], ["40-313", 8.25], ["12-211", 8.0], ["70-414", 6.92],
    ["40-312", 4.5], ["50-311", 4.0], ["40-515", 1.5], ["80-414", 0.58],
  ];
  const rawTotal = observed.reduce((s, [, h]) => s + h, 0);

  let folded = 0;
  const unmapped: string[] = [];
  const grid = new Set(SECTIONS.map((s) => s.code));
  for (const [code, hours] of observed) {
    for (const col of mapPunchToColumns(code, hours)) {
      folded += col.hours;
      if (!grid.has(col.section)) unmapped.push(col.section);
    }
  }
  // Nothing may be lost or invented by the fold itself.
  assert.ok(Math.abs(folded - rawTotal) < 0.005, `fold changed the total: ${folded} vs ${rawTotal}`);
  // Only the two genuinely unmappable codes survive without a column, and they
  // are shown as Unmapped rather than dropped.
  assert.deepEqual(unmapped.sort(), ["70-414", "80-414"]);
});

test("the codes that were being dropped each have a signed-off destination", () => {
  // These are not "off-grid codes needing a scope decision" — the reason the
  // earlier fix left them out. They are aliases with a documented target.
  assert.equal(SECTION_ALIASES["40-311"], "40-211");
  assert.equal(SECTION_ALIASES["10-414"], "10-413");
  for (const c of ["11-211", "12-211", "13-211", "14-211", "15-211"]) assert.equal(SECTION_ALIASES[c], "10-211");
  assert.equal(SECTION_ALIASES["40-412"], "40-411");
  assert.equal(SECTION_ALIASES["50-311"], "50-211");
});

test("10-311 fans out 30/70 and still sums back to the punch", () => {
  const cols = mapPunchToColumns("10-311", 63.25);
  assert.deepEqual(cols.map((c) => c.section), ["10-312", "10-313"]);
  assert.ok(Math.abs(cols.reduce((s, c) => s + c.hours, 0) - 63.25) < 1e-9);
});

test("the fold is idempotent — applying it to an already-folded code is a no-op", () => {
  // Relied on by the integration route, which folds the result of
  // loadActualHoursBySection itself (it hit this bug first, in August, and fixed
  // it locally). Now that the loader folds too, that second pass must be safe.
  for (const target of new Set(Object.values(SECTION_ALIASES))) {
    const twice = mapPunchToColumns(target, 100);
    assert.equal(twice.length, 1, `${target} fans out on a second fold`);
    assert.equal(twice[0].section, target, `${target} moves on a second fold`);
    assert.equal(twice[0].hours, 100);
  }
});

test("actual-hours.ts folds punches, and only punches", () => {
  const src = readFileSync(join(process.cwd(), "src", "lib", "actual-hours.ts"), "utf8");
  // Both readers — the cumulative figure and the monthly timeline behind it —
  // must fold, or the drill-down stops adding up to the bar it explains. Counted
  // as CALL sites on a punch row, not mentions: the header note names the
  // function several times.
  assert.equal((src.match(/mapPunchToColumns\(p\.section/g) ?? []).length, 2, "both loaders fold their punch rows");
  // Eras 1 and 2 are app-owned grid data, already keyed by column code. Folding
  // them would be wrong, not merely redundant.
  assert.doesNotMatch(src, /mapPunchToColumns\(h\.section/);
  assert.doesNotMatch(src, /mapPunchToColumns\(f\.section/);
});

test("the chart's totals are summed from the rows it draws", () => {
  // Engineering Total exceeded the Engineering bars because the totals were
  // resummed from every section while the bars excluded the Standard Fees pools.
  const src = readFileSync(join(process.cwd(), "src", "components", "JobHoursDashboard.tsx"), "utf8");
  assert.match(src, /const bgSections = executionSections\.filter/);
});

// ── Standard Fees pools: gated by permission, not hidden from everyone ──────
//
// PM, Manufacturing and both Warranty sections are permission-gated on the
// Quoted page. Job Hour Details excluded all four unconditionally, so hours that
// existed in Paylocity, reached this app's tables and reconciled against them
// were visible at NO permission level — 556h on job 1131, 1,178h on 1104,
// 1,027h on 1118. Hiding a figure from everybody is not access control.

test("the chart shows a pool section only when the role is allowed it", () => {
  const src = readFileSync(join(process.cwd(), "src", "components", "JobHoursDashboard.tsx"), "utf8");
  // The filter must consult the allow-list, not just the restricted set.
  // Matched loosely across whitespace because the same filter also drops PM
  // unconditionally (see the PM test below) and so no longer fits one line —
  // what this pins is the allow-list clause, not the formatting around it.
  assert.match(
    src,
    /!RESTRICTED_SECTION_CODES\.has\(s\.code\)\s*\|\|\s*allowedPools\.has\(s\.code\)/,
  );
  // Defaulting to none matters: a caller that forgets the prop must get the old,
  // narrower behaviour rather than a silent widening of access.
  assert.match(src, /allowedPoolCodes = \[\]/);
});

// ── PM is not drawn on this chart at all (2026-09-02) ──────────────────────
//
// Project Management (10-111) is a company-wide pool allocation, not a per-job
// estimate, so a quoted-vs-actual bar for it compares two incomparable figures.
// It is excluded from `executionSections`, which every part of the chart reads —
// bars, labels, tier headers, drill-through and the Engineering/Shop totals —
// so one filter removes it everywhere rather than four places that can drift.

test("the chart never draws the PM section, at any permission level", () => {
  const src = readFileSync(join(process.cwd(), "src", "components", "JobHoursDashboard.tsx"), "utf8");
  // Excluded ahead of the allow-list clause, so holding the PM grant does not
  // put it back on the chart.
  assert.match(src, /s\.code !== PM_CODE/);
  assert.match(src, /const PM_CODE = POOL_QUOTED_SECTION\.ENGINEERING_PM;/);
  // Chart-only: the punch-table reconciliation total still counts every
  // section, PM included, so removing the bars cannot silently drop hours.
  assert.match(src, /const jobActualTotal = data\.sections\.reduce/);
});

test("the allow-list is derived from the signed-in role, server-side", () => {
  const page = readFileSync(join(process.cwd(), "src", "app", "(app)", "job-hours", "page.tsx"), "utf8");
  assert.match(page, /const role = pageSession\.user\.role;/);
  // The SAME permission helper the Quoted page uses — not a second opinion about
  // who may see these four codes.
  assert.match(page, /restrictedSectionPermission\(code\)/);
  assert.match(page, /hasPermission\(role, permission\)/);
  assert.match(page, /allowedPoolCodes=\{allowedPoolCodes\}/);
});

// ── The other three surfaces that bucket punches (2026-09-02) ───────────────
//
// Found by auditing all 13 readers of JobHoursDetail after the first fix: three
// more consumers keyed the app's fixed columns off the RAW pair. Each is the
// same bug with a different consequence.

test("Job Cost Explorer folds punches — otherHours is never costed", () => {
  const src = readFileSync(join(process.cwd(), "src", "lib", "job-cost-source.ts"), "utf8");
  // Punches fold; the historical and frozen eras are already column-keyed and
  // must not. Measured before this: 45,068h of Eng/Shop labour sat in "other",
  // which computeJobCost prices at zero, overstating profit by ~$7.4M.
  assert.match(src, /for \(const col of mapPunchToColumns\(p\.section/);
  assert.doesNotMatch(src, /mapPunchToColumns\(h\.section/);
  assert.doesNotMatch(src, /mapPunchToColumns\(f\.section/);
  // And it uses the shared billing-group rule rather than its own copy.
  assert.match(src, /billingGroupForSection\(s\.code\)/);
});

test("the Dashboard buckets by the folded column, like every other hours surface", () => {
  const src = readFileSync(join(process.cwd(), "src", "lib", "dashboard-overview.ts"), "utf8");
  // It grouped by the stored `standardDepartment`, the rule book's verdict on the
  // RAW pair, so 13,429h that the chart calls Engineering counted in neither card.
  assert.match(src, /by: \["section"\]/);
  assert.match(src, /mapPunchToColumns\(r\.section/);
  assert.match(src, /billingGroupForSection\(col\.section\)/);
  assert.doesNotMatch(src, /by: \["standardDepartment"\]/);
});

test("the ETC month headcount counts people who booked to an aliased code", () => {
  const src = readFileSync(join(process.cwd(), "src", "lib", "etc-month-kpis.ts"), "utf8");
  assert.match(src, /for \(const col of mapPunchToColumns\(p\.section, 1\)\)/);
  assert.match(src, /SECTION_GROUP\.get\(col\.section\) \?\? billingGroupForSection\(col\.section\)/);
});

test("every consumer that buckets punches into fixed columns folds first", () => {
  // The audit rule itself: if a file both reads JobHoursDetail and maps a section
  // to one of the app's fixed columns, it has to fold. Listed explicitly so a new
  // consumer added without the fold fails here rather than in a report.
  const mustFold = [
    ["lib", "actual-hours.ts"], ["lib", "sync-actuals.ts"], ["lib", "job-hours-detail.ts"],
    ["lib", "tm-hours.ts"], ["lib", "hours-explorer.ts"], ["lib", "job-cost-source.ts"],
    ["lib", "dashboard-overview.ts"], ["lib", "etc-month-kpis.ts"],
  ];
  for (const parts of mustFold) {
    const src = readFileSync(join(process.cwd(), "src", ...parts), "utf8");
    assert.match(src, /mapPunchToColumns/, `${parts.join("/")} reads punches into columns but does not fold`);
  }
});
