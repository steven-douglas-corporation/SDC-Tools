import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRosterGrid } from "../src/lib/paylocity-roster-parse";
import { parsePositionFamiliesGrid } from "../src/lib/position-families-parse";
import { positionFamilyGrid, rosterGrid, type WarehouseEmployee } from "../src/lib/paylocity-warehouse";
import { REQUIRED_HEADERS, OPTIONAL_HEADERS, worksheetFromPunches } from "../src/lib/paylocity-workbook";

// Since 2026-10-04 the Paylocity readers take their rows from the DataWarehouse
// instead of the SFTP share. Each warehouse reader rebuilds the grid the file
// produced, so the existing parsers apply every rule unchanged. These tests pin
// that the rebuilt grids are ones those parsers accept and read correctly.

const employee = (e: Partial<WarehouseEmployee> & { employeeId: string }): WarehouseEmployee => ({
  firstName: "Pat",
  lastName: "Smith",
  jobTitle: "Machine Builder",
  supervisorEmployeeId: "100042",
  isActive: true,
  positionCode: "MB01",
  positionJobTitle: "Machine Builder",
  ...e,
});

test("roster grid from the warehouse parses like the roster file", () => {
  const rows = parseRosterGrid(
    rosterGrid([
      employee({ employeeId: "100042", firstName: "Pat", lastName: "Boss", jobTitle: "President", supervisorEmployeeId: null }),
      employee({ employeeId: "100167", isActive: false, positionCode: null }),
    ]),
  );
  assert.deepEqual(rows, [
    { paylocityId: "100042", name: "Pat Boss", positionTitle: "President", supervisorPaylocityId: null, paylocityActive: true, positionCode: "MB01" },
    { paylocityId: "100167", name: "Pat Smith", positionTitle: "Machine Builder", supervisorPaylocityId: "100042", paylocityActive: false, positionCode: null },
  ]);
});

test("roster grid keeps the parser's broken-export guard", () => {
  assert.throws(
    () => parseRosterGrid(rosterGrid([employee({ employeeId: "1", supervisorEmployeeId: null }), employee({ employeeId: "2", supervisorEmployeeId: null })])),
    /Supervisor's Employee ID .* blank/,
  );
});

test("position family grid from the warehouse parses like the Position_Families file", () => {
  const rows = parsePositionFamiliesGrid(
    positionFamilyGrid([
      { familyCode: "201", familyName: "Mechanical Engineering", positionCode: "ME CHIEF", title: "Chief Mechanical Engineer", totalHeadcount: 1 },
      { familyCode: "500", familyName: "Service", positionCode: "AFSE", title: null, totalHeadcount: null },
    ]),
    "paylocity",
  );
  assert.deepEqual(rows, [
    { positionCode: "ME CHIEF", familyCode: "201", familyName: "Mechanical Engineering", title: "Chief Mechanical Engineer", headcount: 1, source: "paylocity" },
    // A blank headcount reads as 0, exactly as a blank cell in the file does
    // (parsePositionFamiliesGrid: Number("") is 0). Same behaviour, not a new one.
    { positionCode: "AFSE", familyCode: "500", familyName: "Service", title: null, headcount: 0, source: "paylocity" },
  ]);
});

test("hours worksheet puts each punch back on its original row, under the file's headers", () => {
  const ws = worksheetFromPunches([
    { sheetRow: 2, employeeId: "100605", workDate: "2026-03-11", job: "0114", jobName: "IER_WALBRO", section: "80", fn: "311", hours: 2.5, travel: "Concord" },
    // Row 3 is missing on purpose: a punch the warehouse left out keeps its gap,
    // so sourceRow in the Undefined Hours drill still points at the file's row.
    { sheetRow: 4, employeeId: "100606", workDate: "2026-03-12", job: null, jobName: null, section: "10", fn: "211", hours: -1, travel: null },
  ]);
  assert.deepEqual(
    (ws.getRow(1).values as unknown[]).slice(1),
    [...REQUIRED_HEADERS, ...OPTIONAL_HEADERS],
  );
  assert.deepEqual((ws.getRow(2).values as unknown[]).slice(1), ["100605", "2026-03-11", "0114", "IER_WALBRO", "80", "311", 2.5, "Concord"]);
  assert.equal(ws.getRow(3).hasValues, false);
  assert.equal(ws.getRow(4).getCell(3).value, null); // a blank job stays blank, so it is rejected as MISSING_JOB_ID
  assert.equal(ws.getRow(4).getCell(7).value, -1); // corrections keep their sign
  assert.equal(ws.rowCount, 4);
});
