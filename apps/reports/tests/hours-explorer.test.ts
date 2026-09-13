import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildHoursWhere, rollupByOperationalTier, narrowFiltersForGroupValue, parseHoursGroupByList, reconcileGroupRowHours, departmentFilterRank } from "../src/lib/hours-filters";

// Source-inspection helper, same pattern tests/parts-actual-gl-posted.test.ts already
// uses (no database in CI) — for the regression guard at the bottom of this file.
const ROOT = join(import.meta.dirname, "..");
function code(...parts: string[]): string {
  return readFileSync(join(ROOT, ...parts), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/[^\n]*$/gm, "")
    .replace(/\/\/[^\n"'`]*$/gm, "");
}

function functionSpan(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}`);
  assert.ok(start >= 0, `${name} must exist in the source`);
  const nextExport = source.indexOf("\nexport ", start + 1);
  return nextExport === -1 ? source.slice(start) : source.slice(start, nextExport);
}

// hours-filters.ts is the I/O-free half of the Hours tab's query layer (hours-explorer.ts
// does the actual Prisma calls) — same split as undefined-hours-rules.ts / sections.ts,
// and for the same reason: these are the two places a filter or a rollup could silently
// disagree with what the table and the summary strip both show, so they get a test that
// doesn't need a database.

test("empty filters put no constraint on the query", () => {
  assert.deepEqual(buildHoursWhere({}), {});
});

test("jobIds filters through the job relation", () => {
  const where = buildHoursWhere({ jobIds: ["1148", "1150"] });
  assert.deepEqual(where.job, { jobId: { in: ["1148", "1150"] } });
});

test("sections filters directly on the section column", () => {
  const where = buildHoursWhere({ sections: ["10-211", "10-312"] });
  assert.deepEqual(where.section, { in: ["10-211", "10-312"] });
});

test("employeeIds alone filters employeeId", () => {
  const where = buildHoursWhere({ employeeIds: ["100605"] });
  assert.deepEqual(where.employeeId, { in: ["100605"] });
});

test("departments alone filters employeeId through the resolved employee list", () => {
  const where = buildHoursWhere({ departments: ["Mechanical Engineering"] }, ["100605", "100108"]);
  assert.deepEqual(where.employeeId, { in: ["100605", "100108"] });
});

test("a department that resolves to nobody matches nothing, not everybody", () => {
  const where = buildHoursWhere({ departments: ["Astrology"] }, []);
  assert.deepEqual(where.employeeId, { in: [] });
});

test("employee AND department together intersect rather than each independently widening the match", () => {
  const where = buildHoursWhere(
    { employeeIds: ["100605", "999999"], departments: ["Mechanical Engineering"] },
    ["100605", "100108"], // department resolves to these two
  );
  // Only 100605 is in both the explicit employee pick and the department's employee list.
  assert.deepEqual(where.employeeId, { in: ["100605"] });
});

test("date range sets both bounds, inclusive of the whole `to` day", () => {
  const where = buildHoursWhere({ from: "2026-07-01", to: "2026-07-31" });
  const workDate = where.workDate as { gte: Date; lte: Date };
  assert.equal(workDate.gte.toISOString(), "2026-07-01T00:00:00.000Z");
  assert.equal(workDate.lte.toISOString(), "2026-07-31T23:59:59.999Z");
});

test("a one-sided date range only sets the bound that was given", () => {
  const fromOnly = buildHoursWhere({ from: "2026-07-01" });
  assert.deepEqual(fromOnly.workDate, { gte: new Date("2026-07-01T00:00:00.000Z") });
  const toOnly = buildHoursWhere({ to: "2026-07-31" });
  assert.deepEqual(toOnly.workDate, { lte: new Date("2026-07-31T23:59:59.999Z") });
});

test("a malformed date string is ignored rather than reaching Prisma as an Invalid Date", () => {
  const where = buildHoursWhere({ from: "not-a-date" });
  assert.equal(where.workDate, undefined);
});

test("every dimension combines with AND — job, section and date range all apply at once", () => {
  const where = buildHoursWhere({ jobIds: ["1148"], sections: ["10-211"], from: "2026-07-01" });
  assert.deepEqual(where.job, { jobId: { in: ["1148"] } });
  assert.deepEqual(where.section, { in: ["10-211"] });
  assert.ok(where.workDate);
});

// ── months (a group-by-tree "month" node's own filter dimension) ────────────

test("months filters directly on the month column", () => {
  const where = buildHoursWhere({ months: ["2026-07"] });
  assert.deepEqual(where.month, { in: ["2026-07"] });
});

test("months and a partial from/to range apply TOGETHER, neither clobbers the other", () => {
  // Regression test: narrowing a "month" group-by node must AND with whatever from/to
  // range the parent already had, never widen/replace it — otherwise a child node's
  // total could include days its parent's own query never counted.
  const where = buildHoursWhere({ months: ["2026-07"], from: "2026-07-15", to: "2026-07-31" });
  assert.deepEqual(where.month, { in: ["2026-07"] });
  assert.ok(where.workDate);
  const workDate = where.workDate as { gte: Date; lte: Date };
  assert.equal(workDate.gte.toISOString(), "2026-07-15T00:00:00.000Z");
  assert.equal(workDate.lte.toISOString(), "2026-07-31T23:59:59.999Z");
});

// ── narrowFiltersForGroupValue ───────────────────────────────────────────────

test("narrows job by setting jobIds to exactly the one value", () => {
  assert.deepEqual(narrowFiltersForGroupValue({}, "job", "1148").jobIds, ["1148"]);
});

test("narrows employee by setting employeeIds to exactly the one value", () => {
  assert.deepEqual(narrowFiltersForGroupValue({}, "employee", "100605").employeeIds, ["100605"]);
});

// "sectionNumber"/"functionId" narrow via a raw prefix/suffix match (buildHoursWhere),
// NOT by expanding into an enumerated `sections` list the way the other four
// operational tiers do — see narrowFiltersForGroupValue's own header for why: a
// reverse index built only from OPERATIONAL_GROUPING's known codes would silently
// exclude a section number or Function ID the standard mapping has never seen, which
// is exactly the "standardization decides existence" bug the 2026-08-21 ingestion fix
// closed for storage. These tests pin the field, not an expanded list; buildHoursWhere's
// own tests below prove the prefix/suffix match actually reaches unmapped codes.
// Updated 2026-08-21: these narrow on the RAW COLUMNS now, not on the standardized
// code's prefix/suffix. The old behaviour was the defect — `sectionNumber: "10"` matched
// `section startsWith "10-"`, so drilling into Function 413 returned every row stored
// on a `-413` column, INCLUDING raw 414 punches folded there. The parent group said 413
// and its children said 414. Narrowing on rawSection/rawFunction makes a child row's
// filter a strict subset of what its parent group was keyed on.
test("narrows sectionNumber by setting the RAW section field, not the standardized prefix", () => {
  const narrowed = narrowFiltersForGroupValue({}, "sectionNumber", "10");
  assert.equal(narrowed.rawSectionNumber, "10");
  assert.equal(narrowed.sectionNumber, undefined, "must not fall back to the standardized-code prefix match");
  assert.equal(narrowed.sections, undefined);
});

test("narrows functionId by setting the RAW function field, not the standardized suffix", () => {
  const narrowed = narrowFiltersForGroupValue({}, "functionId", "313");
  assert.equal(narrowed.rawFunctionId, "313");
  assert.equal(narrowed.functionId, undefined, "must not fall back to the standardized-code suffix match");
  assert.equal(narrowed.sections, undefined);
});

// The regression this whole change exists to prevent, pinned as a test.
test("narrowing Function 413 cannot pull in raw 414 punches (the folded-column defect)", () => {
  const narrowed = narrowFiltersForGroupValue({}, "functionId", "413");
  assert.equal(narrowed.rawFunctionId, "413");
  // A suffix match on the standardized column is what let 10-414 (stored as 10-413)
  // answer to "413". If this field is ever set again, that door is reopened.
  assert.equal(narrowed.functionId, undefined);
});

test("buildHoursWhere: sectionNumber matches by raw prefix, reaching a section number the standard mapping has never seen", () => {
  const where = buildHoursWhere({ sectionNumber: "25" });
  assert.deepEqual(where.section, { startsWith: "25-" });
});

test("buildHoursWhere: functionId matches by raw suffix, reaching a Function ID the standard mapping has never seen", () => {
  const where = buildHoursWhere({ functionId: "999" });
  assert.deepEqual(where.section, { endsWith: "-999" });
});

test("buildHoursWhere: sections, sectionNumber and functionId all compose with AND when set together", () => {
  const where = buildHoursWhere({ sections: ["10-313", "10-312"], sectionNumber: "10", functionId: "313" });
  assert.deepEqual(where.AND, [
    { section: { in: ["10-313", "10-312"] } },
    { section: { startsWith: "10-" } },
    { section: { endsWith: "-313" } },
  ]);
});

// "department" narrows like the other operational tiers (expanding into
// `sections`), NEVER by setting `.departments` (the employee HR filter) —
// see the regression-guard tests near the bottom of this file for why that
// distinction is pinned as hard as possible.
test("narrows department by expanding into every raw code that operational department covers", () => {
  const narrowed = narrowFiltersForGroupValue({}, "department", "Mechanical Engineering");
  // Widened through rawCodesFoldingInto (2026-08-21): "10-211" is what
  // codesInDepartment itself returns, but `section` is stored raw now, so every raw
  // pair that folds ONTO 10-211 (12/13/14-211 and the rest of SECTION_ALIASES' phase
  // fold) must also be included, or expanding this group would silently drop them.
  assert.deepEqual(
    [...(narrowed.sections ?? [])].sort(),
    ["10-211", "11-211", "12-211", "13-211", "14-211", "15-211", "16-211", "17-211", "18-211", "25-211"],
  );
  assert.equal(narrowed.departments, undefined, "must not touch the HR-department filter field");
});

test("narrows month by setting months, not by widening from/to", () => {
  const narrowed = narrowFiltersForGroupValue({}, "month", "2026-07");
  assert.deepEqual(narrowed.months, ["2026-07"]);
  assert.equal(narrowed.from, undefined);
  assert.equal(narrowed.to, undefined);
});

test("narrows date by pinning both from and to to the same single day", () => {
  const narrowed = narrowFiltersForGroupValue({}, "date", "2026-07-15");
  assert.equal(narrowed.from, "2026-07-15");
  assert.equal(narrowed.to, "2026-07-15");
});

test("chaining two narrowings accumulates both rather than dropping the first", () => {
  const step1 = narrowFiltersForGroupValue({ sections: ["10-211"] }, "job", "1148");
  const step2 = narrowFiltersForGroupValue(step1, "employee", "100605");
  assert.deepEqual(step2.sections, ["10-211"]);
  assert.deepEqual(step2.jobIds, ["1148"]);
  assert.deepEqual(step2.employeeIds, ["100605"]);
});

test("narrowing the same dimension twice replaces rather than unions", () => {
  const step1 = narrowFiltersForGroupValue({}, "job", "1148");
  const step2 = narrowFiltersForGroupValue(step1, "job", "1150");
  assert.deepEqual(step2.jobIds, ["1150"]);
});

// ── The operational-hierarchy dimensions narrow by expanding into `sections` ────

test("narrows sectionName by expanding into every raw code that section covers", () => {
  const narrowed = narrowFiltersForGroupValue({}, "sectionName", "10");
  assert.ok(narrowed.sections!.includes("10-313"));
  assert.ok(narrowed.sections!.includes("10-111"));
  assert.ok(!narrowed.sections!.includes("40-211"));
});

test("narrows functionGroup by expanding across every section that uses that label", () => {
  const narrowed = narrowFiltersForGroupValue({}, "functionGroup", "Engineering");
  assert.ok(narrowed.sections!.includes("40-211"));
  assert.ok(narrowed.sections!.includes("70-211"));
  assert.ok(narrowed.sections!.includes("80-211"));
});

test("narrows taskDescription by expanding into every raw code sharing that task", () => {
  const narrowed = narrowFiltersForGroupValue({}, "taskDescription", "Manufacturing");
  assert.ok(narrowed.sections!.includes("10-413"));
  assert.ok(narrowed.sections!.includes("90-414"));
});

// ── parseHoursGroupByList ─────────────────────────────────────────────────────

test("parses a comma-joined groupBy param, preserving order", () => {
  assert.deepEqual(parseHoursGroupByList("job,employee,sectionNumber"), ["job", "employee", "sectionNumber"]);
});

test("a bookmarked single-value groupBy (pre-multi-level) still parses to a one-item list", () => {
  assert.deepEqual(parseHoursGroupByList("job"), ["job"]);
});

test("undefined or empty groupBy parses to an empty list", () => {
  assert.deepEqual(parseHoursGroupByList(undefined), []);
  assert.deepEqual(parseHoursGroupByList(""), []);
});

test("an unknown dimension is dropped, not the whole list", () => {
  assert.deepEqual(parseHoursGroupByList("job,bogus,employee"), ["job", "employee"]);
});

test("a repeated dimension is de-duped, keeping its first position", () => {
  assert.deepEqual(parseHoursGroupByList("job,employee,job"), ["job", "employee"]);
});

// ── Group By: Department is Section+Function-derived — regression fix
// (2026-08-17: this had fallen back to the raw employee/HR department field
// a second time, via `queryHoursGrouped`'s own separate `employeeId` ->
// `Employee.department` code path and the now-deleted `rollupByDepartment`) ──

test("rollupByOperationalTier's department tier rolls several codes into the standard operational groups", () => {
  const bySection = [
    { section: "10-211", hours: 10, punchCount: 3 }, // Mechanical Engineering
    { section: "10-312", hours: 5, punchCount: 2 }, // Controls Engineering
    { section: "10-313", hours: 3, punchCount: 1 }, // Controls Engineering (same department as 10-312)
  ];
  const g = rollupByOperationalTier(bySection, "department");
  const me = g.find((x) => x.key === "Mechanical Engineering")!;
  assert.equal(me.hours, 10);
  const ce = g.find((x) => x.key === "Controls Engineering")!;
  assert.equal(ce.hours, 8, "10-312 and 10-313 both roll into ONE Controls Engineering bucket");
  // None of the invalid, HR-sourced groups a regression would produce.
  for (const invalid of ["Mechanical Build / Manufacturing", "Manufacturing", "Machine Wiring", "Electrical Engineering", "Unassigned", "—"]) {
    assert.ok(!g.some((x) => x.key === invalid), `"${invalid}" is a raw HR department value and must never appear under Group By: Department`);
  }
});

test("department rollup splits Section 10's Shop into Mechanical Build / Electrical Build / Manufacturing", () => {
  // Unlike Function Group, which collapses all three into one "Shop" —
  // Department is deliberately more granular here, by request. "Manufacturing
  // Operations" -> "Manufacturing" (2026-08-20): the centralized canonical
  // section name for Function 413/414, not the HR/Employee.department string
  // of the same near-spelling — see paylocity-canonical.ts.
  const bySection = [
    { section: "10-411", hours: 4, punchCount: 1 },
    { section: "10-412", hours: 6, punchCount: 1 },
    { section: "10-413", hours: 9, punchCount: 1 },
  ];
  const g = rollupByOperationalTier(bySection, "department");
  assert.deepEqual(
    g.map((x) => x.key).sort(),
    ["Electrical Build", "Manufacturing", "Mechanical Build"],
  );
});

test("department rollup combines Section Name + Engineering/Shop for Sections 40/50/70/80/90", () => {
  const bySection = [
    { section: "40-211", hours: 1, punchCount: 1 },
    { section: "50-411", hours: 1, punchCount: 1 },
    { section: "70-211", hours: 1, punchCount: 1 },
    { section: "80-411", hours: 1, punchCount: 1 },
    { section: "90-211", hours: 1, punchCount: 1 },
  ];
  const g = rollupByOperationalTier(bySection, "department");
  assert.deepEqual(
    g.map((x) => x.key).sort(),
    ["Machine Testing — Engineering", "Service — Shop", "Spare Parts — Engineering", "Teardown & Install — Shop", "Warranty — Engineering"].sort(),
  );
});

test("an unmapped code lands under Undefined / Unmapped, never silently joins another department", () => {
  const g = rollupByOperationalTier([{ section: "99-999", hours: 4, punchCount: 1 }], "department");
  assert.equal(g.length, 1);
  assert.equal(g[0].key, "Undefined / Unmapped");
  assert.equal(g[0].hours, 4, "the hours are still counted, just under the honest label");
});

test("department rollup preserves the total — nothing is dropped or double-counted", () => {
  const bySection = [
    { section: "10-211", hours: 10, punchCount: 3 },
    { section: "10-312", hours: 5, punchCount: 2 },
    { section: "99-999", hours: 2.5, punchCount: 1 }, // deliberately unmapped
  ];
  const expected = bySection.reduce((s, r) => s + r.hours, 0);
  const g = rollupByOperationalTier(bySection, "department");
  const got = g.reduce((s, x) => s + x.hours, 0);
  assert.ok(Math.abs(got - expected) < 1e-9);
  assert.equal(
    g.reduce((s, x) => s + x.punchCount, 0),
    bySection.reduce((s, r) => s + r.punchCount, 0),
  );
});

// ── The regression guard itself ─────────────────────────────────────────────
//
// Source-inspection, not just behavioral tests above: those prove the CURRENT
// wiring is correct, but the actual incident was a SECOND implementation
// quietly growing back next to the first. These assert the dangerous shapes
// are structurally absent, so a future edit that reintroduces either one
// fails a test immediately rather than shipping silently.

test("rollupByDepartment no longer exists — there is exactly one rollup path for every operational tier", () => {
  const src = code("src", "lib", "hours-filters.ts");
  assert.doesNotMatch(src, /export function rollupByDepartment/, "the HR-department rollup must stay deleted, not just unused");
});

test("queryHoursGrouped's 'department' branch groups by section, never by employeeId + Employee.department", () => {
  // Scoped to the specific if-block handling "department" — not the whole
  // function, which also has a legitimate "employee" branch that DOES call
  // prisma.employee.findMany (to resolve names for display, an unrelated
  // concern), and not the whole file, which legitimately selects
  // Employee.department elsewhere (the Department FILTER's own option list).
  const fn = functionSpan(code("src", "lib", "hours-explorer.ts"), "queryHoursGrouped");
  const start = fn.indexOf('groupBy === "sectionName"');
  assert.ok(start >= 0, "the merged operational-tier branch (sectionName/functionGroup/taskDescription/department) must exist");
  const branch = fn.slice(start, fn.indexOf("\n  }", start) + 4);
  assert.match(branch, /groupBy === "department"/, "the department case must be part of this ONE branch, not a separate one");
  assert.doesNotMatch(branch, /employeeId/, "the department branch must never touch employeeId at all");
  assert.doesNotMatch(branch, /prisma\.employee\.findMany/, 'must never look up Employee rows to answer a "department" group');
  assert.match(branch, /by:\s*\["section"\]/, "must group the punch table by section, the same aggregate every other operational tier uses");
});

test("narrowFiltersForGroupValue's department case expands sections (through the raw fold), never sets the HR departments field", () => {
  const src = code("src", "lib", "hours-filters.ts");
  const fn = src.slice(src.indexOf("export function narrowFiltersForGroupValue"));
  const caseBlock = fn.slice(fn.indexOf('case "department"'), fn.indexOf('case "department"') + 160);
  assert.match(caseBlock, /sections:\s*rawCodesFoldingInto\(codesInDepartment\(value\)\)/);
  assert.doesNotMatch(caseBlock, /departments:\s*\[value\]/, "narrowing on the HR field is the exact bug being guarded against");
});

// ── reconcileGroupRowHours — the Hours tab never shows a decimal, and a set
// of sibling rows always sums to their own displayed total (2026-08-17) ────

test("reconciled group rows sum to exactly the rows' own rounded total when no target is given (the root-level case)", () => {
  const rows = [
    { key: "a", hours: 10.4 },
    { key: "b", hours: 10.4 },
    { key: "c", hours: 10.4 },
  ];
  const reconciled = reconcileGroupRowHours(rows);
  const sum = [...reconciled.values()].reduce((s, v) => s + v, 0);
  assert.equal(sum, Math.round(31.2), "31, not the naive 30 from summing three independently-rounded 10.4s");
  for (const v of reconciled.values()) assert.equal(v, Math.round(v), "every reconciled value must be a whole number");
});

test("reconciled child rows sum to the PARENT's own displayed figure, not a fresh rounding of their own sum", () => {
  // The parent's own displayed value (e.g. 12, after ITS OWN sibling
  // reconciliation bumped it by one) must be exactly what its children add
  // up to — even though the children's own naive sum would round to 11.
  const children = [
    { key: "x", hours: 5.4 },
    { key: "y", hours: 5.4 },
  ];
  const reconciled = reconcileGroupRowHours(children, 12);
  const sum = [...reconciled.values()].reduce((s, v) => s + v, 0);
  assert.equal(sum, 12, "must match the parent's own number, not the children's independent rounding");
});

test("every row is addressable by its own key regardless of input order", () => {
  const rows = [
    { key: "job-1148", hours: 3.2 },
    { key: "job-1150", hours: 7.8 },
  ];
  const reconciled = reconcileGroupRowHours(rows);
  assert.equal(reconciled.get("job-1148"), 3);
  assert.equal(reconciled.get("job-1150"), 8);
});

test("an empty set of rows reconciles to an empty map, not an error", () => {
  assert.equal(reconcileGroupRowHours([]).size, 0);
});

// ── The Department FILTER's own order — the raw HR strings, ranked by the
// same 7-team business order Monthly ETC/HoursDetailPanel already use
// (2026-08-17) ────────────────────────────────────────────────────────────

test("departmentFilterRank orders the 7 delivery teams in their real sequence, not alphabetically", () => {
  const ranked = ["Project Management", "Mechanical Engineering", "Controls Engineering", "Mechanical Build", "Electrical Build", "Manufacturing Operations", "Service Engineering"];
  for (let i = 1; i < ranked.length; i++) {
    assert.ok(departmentFilterRank(ranked[i - 1]) < departmentFilterRank(ranked[i]), `${ranked[i - 1]} must rank before ${ranked[i]}`);
  }
});

test("departmentFilterRank resolves a legacy/aliased HR spelling to its team's position", () => {
  // "Mechanical Build / Manufacturing" is Build's own legacy alias in
  // employee-teams.ts — it must rank alongside "Mechanical Build", not
  // wherever it would fall alphabetically (after "Mechanical Engineering").
  assert.equal(departmentFilterRank("Mechanical Build / Manufacturing"), departmentFilterRank("Mechanical Build"));
});

test("an unranked real department sorts after every team but before the blank bucket", () => {
  const financeRank = departmentFilterRank("Finance");
  const serviceRank = departmentFilterRank("Service Engineering");
  const blankRank = departmentFilterRank("—");
  assert.ok(financeRank > serviceRank, "an unranked department must sort after all 7 real teams");
  assert.ok(financeRank < blankRank, "an unranked but real department must still sort before the blank bucket");
});

test("the blank department always sorts last of all", () => {
  const allRanks = ["Project Management", "Finance", "Anything", "—"].map(departmentFilterRank);
  assert.equal(Math.max(...allRanks), departmentFilterRank("—"));
});
