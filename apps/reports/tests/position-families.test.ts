import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parsePositionFamiliesGrid,
  mergePositionFamilies,
  positionFamilyFindings,
  describeFamilies,
  PositionFamilyFileError,
  type FamilyPerson,
} from "../src/lib/position-families-parse";

// Paylocity's Position_Families report plus our overrides file (2026-10-02):
// one layout, an override row replacing Paylocity's rows for its code. See the
// header of src/lib/position-families-parse.ts.

const HEADER = ["Family Code", "Family Name", "Position Code", "Title", "Total Headcount"];
const grid = (...rows: (string | number | null)[][]) => [HEADER, ...rows];

const PAYLOCITY = parsePositionFamiliesGrid(
  grid(
    ["201", "Mechanical Engineering", "ME SR", "Sr Mechanical Engineer", "4"],
    ["106", "Project Management", "SCE", "Service Engineer - Automated Machines", "2"],
    ["301", "Electrical Controls Engineering", "SCE", "Service Engineer - Automated Machines", "2"],
    ["500", "Service", "SCE", "Service Engineer - Automated Machines", "2"],
    ["100", "Management", "CFO", "Chief Financial Officer", "1"],
    ["107", "Procurement", "IC", "Inventory Coordinator", "1"],
    ["404", "Manufacturing Operations", "IC", "Inventory Coordinator", "1"],
  ),
  "paylocity",
);

test("parse: columns by header name; numeric family codes and headcounts", () => {
  const rows = parsePositionFamiliesGrid(
    [["Title", "Position Code", "Family Name", "Family Code"], ["AI Intern", "AII", "AI + Internal Processes", 108]],
    "override",
  );
  assert.deepEqual(rows, [
    { positionCode: "AII", familyCode: "108", familyName: "AI + Internal Processes", title: "AI Intern", headcount: null, source: "override" },
  ]);
  assert.equal(PAYLOCITY[0].headcount, 4);
});

test("parse: refuses a file it can't trust", () => {
  assert.throws(() => parsePositionFamiliesGrid([["Family Code", "Position Code"]], "paylocity"), /missing column/);
  assert.throws(() => parsePositionFamiliesGrid(grid(["", "Finance", "AP01", "Account Payable", "1"]), "paylocity"), /no Family Code/);
  assert.throws(() => parsePositionFamiliesGrid(grid(), "paylocity"), PositionFamilyFileError);
  // An empty overrides file is "no overrides", not an error.
  assert.deepEqual(parsePositionFamiliesGrid(grid(), "override"), []);
});

test("merge: a code keeps every family Paylocity lists it under", () => {
  const m = mergePositionFamilies(PAYLOCITY);
  assert.deepEqual(m.get("sce")?.families.map((f) => f.code), ["106", "301", "500"]);
  assert.equal(m.get("sce")?.source, "paylocity");
});

test("merge: an override replaces Paylocity's rows for its code, and fills a missing one", () => {
  const overrides = parsePositionFamiliesGrid(
    grid(["107", "Procurement", "ic", "Inventory Coordinator", "1"], ["108", "AI + Internal Processes", "AII", "AI Intern", "1"]),
    "override",
  );
  const m = mergePositionFamilies([...PAYLOCITY, ...overrides]);
  assert.deepEqual(m.get("ic")?.families.map((f) => f.code), ["107"], "case-insensitive match; 404 dropped");
  assert.equal(m.get("ic")?.source, "override");
  assert.deepEqual(m.get("aii")?.families.map((f) => f.code), ["108"]);
  assert.match(describeFamilies([...PAYLOCITY, ...overrides]), /^5 position codes in 7 families, 2 from overrides$/);
});

test("findings: unknown codes, no code, no supervisor (Leadership exempt), covered overrides", () => {
  const overrides = parsePositionFamiliesGrid(grid(["107", "Procurement", "IC", "Inventory Coordinator", "1"], ["301", "Electrical Controls Engineering", "CEM", "Controls Engineering Manager", "1"]), "override");
  const people: FamilyPerson[] = [
    { name: "Lisa Andreani", paylocityId: "100145", positionCode: "CFO", supervisorId: null, active: true },
    { name: "Jackie Hlavaty", paylocityId: "100133", positionCode: "IC", supervisorId: 1, active: true },
    { name: "Heather Fresenko", paylocityId: "100810", positionCode: "HRM", supervisorId: 1, active: true },
    { name: "Ryan Belliveau", paylocityId: "100610", positionCode: null, supervisorId: 1, active: true },
    { name: "Lahu Shedole", paylocityId: "TEMP1", positionCode: null, supervisorId: null, active: true },
    { name: "Gone Person", paylocityId: "100999", positionCode: "ZZZ", supervisorId: null, active: false },
  ];
  const f = positionFamilyFindings(people, [...PAYLOCITY, ...overrides]);
  assert.deepEqual(f.unknownCodes.map((x) => [x.name, x.detail]), [["Heather Fresenko", "Position code HRM"]]);
  assert.deepEqual(f.noCode.map((x) => x.name), ["Lahu Shedole", "Ryan Belliveau"]);
  assert.deepEqual(f.noSupervisor.map((x) => x.name), ["Lahu Shedole"], "the CFO is Leadership; inactive people are skipped");
  assert.deepEqual(f.overridesCovered, [{ positionCode: "IC", override: "107 Procurement", paylocity: "107 Procurement; 404 Manufacturing Operations" }]);
  assert.equal(f.overrides, 2);
});
