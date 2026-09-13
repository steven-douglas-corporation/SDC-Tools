import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OPERATIONAL_GROUPING,
  UNDEFINED_LABEL,
  DEPARTMENT_ORDER,
  sectionNumberAndName,
  rawSectionNumberAndName,
  functionGroupFor,
  taskFor,
  departmentFor,
  departmentOrderRank,
  codesInSection,
  codesInFunctionGroup,
  codesInTask,
  codesInDepartment,
} from "../src/lib/hours-operational-grouping";
import { HOURS_IMPORT_CODES } from "../src/lib/sections";
import { rollupByOperationalTier, rollupByRawTier } from "../src/lib/hours-filters";

// The Hours tab's acceptance rule is "sum of grouped hours = Total Hours KPI" for
// any filter, and "every recognized code appears under the standard group; an
// unrecognized one is clearly Undefined, never silently folded into another
// group." Both are decidable without a database, so they're tests here rather
// than a claim.

test("every code the app can import resolves to a real (non-Undefined) label at all four tiers", () => {
  for (const code of HOURS_IMPORT_CODES) {
    assert.ok(OPERATIONAL_GROUPING[code], `${code} has no entry in OPERATIONAL_GROUPING`);
    assert.notEqual(sectionNumberAndName(code).sectionName, UNDEFINED_LABEL, `${code} section name`);
    assert.notEqual(functionGroupFor(code), UNDEFINED_LABEL, `${code} function group`);
    assert.notEqual(taskFor(code), UNDEFINED_LABEL, `${code} task`);
    assert.notEqual(departmentFor(code), UNDEFINED_LABEL, `${code} department`);
  }
});

test("a code the table has never seen classifies as Undefined at every tier, not silently as something else", () => {
  const bogus = "99-999";
  assert.equal(sectionNumberAndName(bogus).sectionName, UNDEFINED_LABEL);
  assert.equal(sectionNumberAndName(bogus).sectionNumber, UNDEFINED_LABEL);
  assert.equal(functionGroupFor(bogus), UNDEFINED_LABEL);
  assert.equal(taskFor(bogus), UNDEFINED_LABEL);
  assert.equal(departmentFor(bogus), UNDEFINED_LABEL);
});

test("reverse lookups round-trip the forward map — every code appears under its own section/group/task/department", () => {
  for (const [code, entry] of Object.entries(OPERATIONAL_GROUPING)) {
    assert.ok(codesInSection(entry.sectionNumber).includes(code), `${code} missing from codesInSection(${entry.sectionNumber})`);
    assert.ok(codesInFunctionGroup(entry.functionGroup).includes(code), `${code} missing from codesInFunctionGroup(${entry.functionGroup})`);
    assert.ok(codesInTask(entry.task).includes(code), `${code} missing from codesInTask(${entry.task})`);
    assert.ok(codesInDepartment(entry.department).includes(code), `${code} missing from codesInDepartment(${entry.department})`);
  }
});

// ── Department: its own tier, not an alias for Function Group (2026-08-17) ──

test("department splits Section 10's Shop by exact function — Mechanical Build / Electrical Build / Manufacturing", () => {
  assert.equal(departmentFor("10-411"), "Mechanical Build");
  assert.equal(departmentFor("10-412"), "Electrical Build");
  // "Manufacturing", not "Manufacturing Operations" (2026-08-20) — the
  // centralized canonical SECTION name for Function 413/414.
  assert.equal(departmentFor("10-413"), "Manufacturing");
  // Function Group, by contrast, collapses all three into one "Shop" — the
  // two tiers are deliberately different cuts of the same codes.
  assert.equal(functionGroupFor("10-411"), "Shop");
  assert.equal(functionGroupFor("10-412"), "Shop");
  assert.equal(functionGroupFor("10-413"), "Shop");
});

test("department combines Section Name and Engineering/Shop for 40/50/70/80/90, per request", () => {
  assert.equal(departmentFor("40-211"), "Machine Testing — Engineering");
  assert.equal(departmentFor("40-411"), "Machine Testing — Shop");
  assert.equal(departmentFor("50-211"), "Teardown & Install — Engineering");
  assert.equal(departmentFor("70-411"), "Warranty — Shop");
  assert.equal(departmentFor("80-211"), "Service — Engineering");
  assert.equal(departmentFor("90-411"), "Spare Parts — Shop");
});

test("department never produces a raw employee/HR department string", () => {
  // The exact invalid groups reported in the regression. "Manufacturing" alone is
  // deliberately NOT in this list any more (2026-08-20): it is now the centralized
  // canonical SECTION name for Function 413/414, not an accidental HR-string leak
  // — "Mechanical Build / Manufacturing" (the compound HR spelling) still is.
  const invalid = new Set(["Mechanical Build / Manufacturing", "Machine Wiring", "Electrical Engineering", "Unassigned", "—"]);
  for (const code of HOURS_IMPORT_CODES) {
    assert.ok(!invalid.has(departmentFor(code)), `${code} resolved to "${departmentFor(code)}", a raw HR-looking department value`);
  }
});

test("Function Group rolls up across sections when nothing narrower is chosen — Engineering spans Testing/Teardown/Warranty/Service", () => {
  const engineeringCodes = codesInFunctionGroup("Engineering");
  assert.ok(engineeringCodes.includes("40-211"));
  assert.ok(engineeringCodes.includes("50-211"));
  assert.ok(engineeringCodes.includes("70-211"));
  assert.ok(engineeringCodes.includes("80-211"));
});

test("Spare Parts stays one flat Function Group, per request — no Engineering/Shop split", () => {
  for (const code of ["90-211", "90-311", "90-411", "90-412", "90-414"]) {
    assert.equal(functionGroupFor(code), "Spare parts");
  }
});

test("rollupByOperationalTier: sectionName reconciles to the input total, unmapped code included", () => {
  const bySection = [
    { section: "10-313", hours: 10, punchCount: 2 }, // Complete Design and Build
    { section: "10-411", hours: 5, punchCount: 1 }, // Complete Design and Build
    { section: "80-211", hours: 3, punchCount: 1 }, // Service
    { section: "99-999", hours: 1, punchCount: 1 }, // unmapped
  ];
  const g = rollupByOperationalTier(bySection, "sectionName");
  const expected = bySection.reduce((s, r) => s + r.hours, 0);
  const got = g.reduce((s, r) => s + r.hours, 0);
  assert.ok(Math.abs(got - expected) < 1e-9);
  assert.equal(g.reduce((s, r) => s + r.punchCount, 0), bySection.reduce((s, r) => s + r.punchCount, 0));

  const designBuild = g.find((r) => r.label === "Complete Design and Build")!;
  assert.equal(designBuild.hours, 15);
  const service = g.find((r) => r.label === "Service")!;
  assert.equal(service.hours, 3);
  const undefinedGroup = g.find((r) => r.label === UNDEFINED_LABEL)!;
  assert.equal(undefinedGroup.hours, 1);
});

test("rollupByOperationalTier: functionGroup merges same-named groups across sections", () => {
  const bySection = [
    { section: "40-211", hours: 10, punchCount: 1 }, // Machine Testing / Engineering
    { section: "70-211", hours: 20, punchCount: 1 }, // Warranty / Engineering
  ];
  const g = rollupByOperationalTier(bySection, "functionGroup");
  assert.equal(g.length, 1);
  assert.equal(g[0].label, "Engineering");
  assert.equal(g[0].hours, 30);
});

test("rollupByOperationalTier: taskDescription merges Manufacturing across its two raw sources", () => {
  const bySection = [
    { section: "10-413", hours: 7, punchCount: 1 },
    { section: "90-414", hours: 3, punchCount: 1 }, // same task label, different section
  ];
  const g = rollupByOperationalTier(bySection, "taskDescription");
  const mfg = g.find((r) => r.label === "Manufacturing")!;
  assert.equal(mfg.hours, 10);
});

// ── Department reads in a fixed business order, never by hours (2026-08-17) ─

test("every department a real code can resolve to has a position in DEPARTMENT_ORDER", () => {
  const realDepartments = new Set(Object.values(OPERATIONAL_GROUPING).map((e) => e.department));
  for (const d of realDepartments) {
    assert.ok(DEPARTMENT_ORDER.includes(d), `"${d}" is a real department but missing from DEPARTMENT_ORDER`);
  }
});

test("departmentOrderRank follows the exact given sequence", () => {
  // The canonical wording, not the HR roster's — see paylocity-canonical.ts.
  // Function 111's department was "PM", then "Management" (2026-08-20), and is
  // "Project Management (PM)" since 2026-09-02. "Manufacturing", never
  // "Manufacturing Operations".
  assert.equal(departmentOrderRank("Project Management (PM)"), 0);
  assert.equal(departmentOrderRank("Mechanical Engineering"), 1);
  assert.equal(departmentOrderRank("Controls Engineering"), 2);
  assert.ok(departmentOrderRank("Mechanical Build") < departmentOrderRank("Electrical Build"));
  assert.ok(departmentOrderRank("Electrical Build") < departmentOrderRank("Manufacturing"));
  assert.ok(departmentOrderRank("Manufacturing") < departmentOrderRank("Service — Engineering"));
});

test("an unrecognized department (including UNDEFINED_LABEL) ranks after every real one", () => {
  const maxRealRank = Math.max(...DEPARTMENT_ORDER.map((d) => departmentOrderRank(d)));
  assert.ok(departmentOrderRank(UNDEFINED_LABEL) > maxRealRank);
  assert.ok(departmentOrderRank("Some Made Up Department") > maxRealRank);
});

test("rollupByOperationalTier's department tier sorts by the fixed order, NOT by hours descending", () => {
  // Deliberately built so hours-descending would produce the OPPOSITE order:
  // Manufacturing has the most hours but must still sort AFTER Project
  // Management, which has the fewest.
  const bySection = [
    { section: "10-413", hours: 500, punchCount: 1 }, // Manufacturing
    { section: "10-211", hours: 200, punchCount: 1 }, // Mechanical Engineering
    { section: "10-111", hours: 10, punchCount: 1 }, // Project Management (PM)
  ];
  const g = rollupByOperationalTier(bySection, "department");
  assert.deepEqual(
    g.map((r) => r.label),
    ["Project Management (PM)", "Mechanical Engineering", "Manufacturing"],
    "must follow DEPARTMENT_ORDER, not the 500/200/10 hours ordering",
  );
});

test("the other three tiers are UNAFFECTED — they still sort biggest-first", () => {
  const bySection = [
    { section: "10-111", hours: 10, punchCount: 1 }, // Complete Design and Build
    { section: "80-211", hours: 500, punchCount: 1 }, // Service
  ];
  const bySectionName = rollupByOperationalTier(bySection, "sectionName");
  assert.equal(bySectionName[0].label, "Service", "sectionName must still sort by hours, unchanged by the department fix");
});

// ── Function: phase-agnostic, keyed off the bare Function ID (2026-08-21) ──


// ── Never drops a row for being unmapped (2026-08-21): the raw tier reads the
// raw Function ID regardless of whether the FULL
// section+function combination is in OPERATIONAL_GROUPING — the Hours page must
// keep showing "999", not merge it into one shared "Undefined / Unmapped" bucket
// with every other unrecognized Function ID. UNDEFINED_LABEL is reserved for a
// code with no parseable Function ID at all.



test("rollupByRawTier: functionId merges the SAME raw Function ID across phases (Task, by contrast, does not)", () => {
  const rows = [
    { rawSection: "10", rawFunction: "313", hours: 7, punchCount: 1 }, // Software
    { rawSection: "80", rawFunction: "313", hours: 3, punchCount: 1 }, // same Function ID, Service phase
  ];
  const g = rollupByRawTier(rows, "functionId");
  assert.equal(g.length, 1, "10-313 and 80-313 share one Function bucket");
  assert.equal(g[0].label, "313 — Software");
  assert.equal(g[0].hours, 10);
});

test("rollupByRawTier: functionId preserves the total, and a real-but-unnamed Function ID keeps its own bucket", () => {
  const rows = [
    { rawSection: "10", rawFunction: "313", hours: 7, punchCount: 1 },
    { rawSection: "99", rawFunction: "999", hours: 2, punchCount: 1 }, // Function 999: real id, no canonical name
  ];
  const g = rollupByRawTier(rows, "functionId");
  assert.equal(g.length, 2, "313 and 999 are two distinct buckets, not one shared Undefined bucket");
  const unmapped = g.find((r) => r.key === "999")!;
  assert.equal(unmapped.label, "999", "no canonical name, so the bare id is the label");
  assert.equal(unmapped.hours, 2);
  assert.equal(g.reduce((s, r) => s + r.hours, 0), 9);
});

// ── Section: Section Number + Name together, in phase order (2026-08-21) ───

test("rollupByRawTier: sectionNumber labels as 'Number — Name' and sorts in phase order, not by hours", () => {
  const rows = [
    { rawSection: "80", rawFunction: "211", hours: 500, punchCount: 1 }, // Service (80) — most hours
    { rawSection: "10", rawFunction: "313", hours: 10, punchCount: 1 }, // Complete Design and Build (10)
  ];
  const g = rollupByRawTier(rows, "sectionNumber");
  assert.deepEqual(
    g.map((r) => r.label),
    ["10 — Complete Design and Build", "80 — Service"],
    "must read in phase order (10 before 80), not the 500/10 hours ordering",
  );
});

test("rollupByRawTier: sectionNumber merges every function within a phase into one row", () => {
  const rows = [
    { rawSection: "10", rawFunction: "313", hours: 5, punchCount: 1 },
    { rawSection: "10", rawFunction: "411", hours: 3, punchCount: 1 },
  ];
  const g = rollupByRawTier(rows, "sectionNumber");
  assert.equal(g.length, 1);
  assert.equal(g[0].label, "10 — Complete Design and Build");
  assert.equal(g[0].hours, 8);
});

// A real Paylocity export can carry a non-numeric MachineSec too ("Not Defined"),
// not just this module's own UNDEFINED_LABEL — both are NaN under Number(), and a
// sort comparator that can return NaN has no defined ordering guarantee. Regression
// guard: this must sort after every real phase number, not wherever a NaN happens
// to land.
test("rollupByRawTier: sectionNumber sorts a non-numeric raw section after every real phase number", () => {
  // normalizeSectionId turns a "Not Defined" MachineSec into "", so the blank bucket is
  // what a real export produces here. Either way it must sort after every real phase
  // number rather than wherever a NaN comparator happens to put it.
  const rows = [
    { rawSection: "", rawFunction: "311", hours: 1, punchCount: 1 },
    { rawSection: "80", rawFunction: "211", hours: 1, punchCount: 1 },
    { rawSection: "10", rawFunction: "313", hours: 1, punchCount: 1 },
  ];
  const g = rollupByRawTier(rows, "sectionNumber");
  assert.deepEqual(g.map((r) => r.key), ["10", "80", ""]);
});

// ── Never drops a row for being unmapped (2026-08-21): a raw section number the
// standard mapping has never seen keeps its OWN identity here too, never merging
// with every other unmapped section number into one shared bucket — see
// rawSectionNumberAndName's own header for why this deliberately does not reuse
// sectionNumberAndName/UNDEFINED_LABEL the way "Section Name" still does.

test("rawSectionNumberAndName keeps a real code's exact name, and a genuinely unknown section number its own raw number with a generic name", () => {
  assert.deepEqual(rawSectionNumberAndName("10-313"), { sectionNumber: "10", sectionName: "Complete Design and Build" });
  assert.deepEqual(rawSectionNumberAndName("25-999"), { sectionNumber: "25", sectionName: "Unmapped Section" });
});

test("rollupByRawTier: sectionNumber keeps two different unmapped section numbers apart, and preserves their hours", () => {
  const rows = [
    { rawSection: "10", rawFunction: "313", hours: 5, punchCount: 1 },
    { rawSection: "25", rawFunction: "999", hours: 3, punchCount: 1 },
    { rawSection: "30", rawFunction: "100", hours: 4, punchCount: 1 },
  ];
  const g = rollupByRawTier(rows, "sectionNumber");
  assert.equal(g.length, 3, "25 and 30 must NOT collapse into one shared Undefined/Unmapped row");
  const s25 = g.find((r) => r.key === "25")!;
  const s30 = g.find((r) => r.key === "30")!;
  assert.equal(s25.label, "25 — Unmapped Section");
  assert.equal(s25.hours, 3);
  assert.equal(s30.label, "30 — Unmapped Section");
  assert.equal(s30.hours, 4);
  assert.equal(g.reduce((s, r) => s + r.hours, 0), 12, "no hours lost across mapped and unmapped sections alike");
});
