import { test } from "node:test";
import assert from "node:assert/strict";
import {
  departmentFromHiringManagers,
  isEvergreenPosting,
  parseManagerIds,
  toHiringPositions,
  type WarehouseHiringRow,
} from "../src/lib/hiring-warehouse-parse";
import { isOpenHiringStatus } from "../src/lib/hiring-position-status";

function row(overrides: Partial<WarehouseHiringRow>): WarehouseHiringRow {
  return {
    hiringJobId: "1",
    jobTitle: "Machine Builder",
    hiringDepartment: null,
    hiringManagers: null,
    jobStatus: "Published",
    jobSubStatus: null,
    publishedAt: null,
    ...overrides,
  };
}

test("parseManagerIds: pulls the bracketed employee ids, in order", () => {
  assert.deepEqual(parseManagerIds("Michael Czenszak [48003015], Daniel Belliveau [48003099]"), ["48003015", "48003099"]);
  assert.deepEqual(parseManagerIds("Neil Simpson [48003052]"), ["48003052"]);
});

test("parseManagerIds: a name with no id, or an empty cell, gives nothing", () => {
  assert.deepEqual(parseManagerIds("Someone Without An Id"), []);
  assert.deepEqual(parseManagerIds(null), []);
  assert.deepEqual(parseManagerIds(""), []);
});

test("isEvergreenPosting: matches the General Job Posting catch-all only", () => {
  assert.equal(isEvergreenPosting("General Job Posting"), true);
  assert.equal(isEvergreenPosting("  general posting "), true);
  assert.equal(isEvergreenPosting("General Engineering Technician"), false);
  assert.equal(isEvergreenPosting("Machine Builder"), false);
  assert.equal(isEvergreenPosting(null), false);
});

test("toHiringPositions: drops the evergreen posting, rows with no id or title, and repeated ids", () => {
  const out = toHiringPositions([
    row({ hiringJobId: "2250605", jobTitle: "General Job Posting", hiringDepartment: "Human Resources" }),
    row({ hiringJobId: null, jobTitle: "No Id" }),
    row({ hiringJobId: "7", jobTitle: "  " }),
    row({ hiringJobId: "4508935", jobTitle: "Machine Builder", hiringManagers: "Sean Hamp [48002907]" }),
    row({ hiringJobId: "4508935", jobTitle: "Machine Builder (duplicate)" }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].row.sourceId, "4508935");
  assert.deepEqual(out[0].managerIds, ["48002907"]);
});

test("toHiringPositions: carries status and sub-status through, formats the published date, nulls what the warehouse lacks", () => {
  const [p] = toHiringPositions([
    row({ jobStatus: "Published", jobSubStatus: "Paused", publishedAt: new Date(2026, 8, 17, 8, 5) }),
  ]);
  assert.equal(p.row.status, "Published");
  assert.equal(p.row.subStatus, "Paused");
  assert.equal(p.row.createdDate, "09/17/2026");
  assert.equal(p.row.functionCode, null);
  assert.equal(p.row.remote, false);
  assert.equal(p.row.archived, false);
});

test("a Paused requisition is not open; Refreshed and plain Published are", () => {
  assert.equal(isOpenHiringStatus("Published", "Paused", false), false);
  assert.equal(isOpenHiringStatus("Published", "Refreshed", false), true);
  assert.equal(isOpenHiringStatus("Published", null, false), true);
});

test("departmentFromHiringManagers: the first manager found on the roster decides; none found is null", () => {
  const cards = new Map([["48003052", "wire"], ["48002907", "build"]]);
  assert.equal(departmentFromHiringManagers(["48003052"], cards), "wire");
  assert.equal(departmentFromHiringManagers(["99999999", "48002907"], cards), "build");
  assert.equal(departmentFromHiringManagers(["99999999"], cards), null);
  assert.equal(departmentFromHiringManagers([], cards), null);
});
