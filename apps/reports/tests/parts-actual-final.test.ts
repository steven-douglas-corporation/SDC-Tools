import { test } from "node:test";
import assert from "node:assert/strict";
import { FINAL_PARTS_ACTUAL_BELOW_JOB, hasFinalPartsActual } from "../src/lib/parts-actual-final";

// Jobs below 1100 carry an imported final Parts Cost Actual; from 1100 up Total ETO is the source. The sync,
// the Job Cost Explorer and the Projects export all branch on this one rule.

test("the cutoff is 1100", () => {
  assert.equal(FINAL_PARTS_ACTUAL_BELOW_JOB, 1100);
});

test("jobs below 1100 are final", () => {
  for (const id of ["810", "999", "1000", "1097", "1099", " 1042 "]) assert.equal(hasFinalPartsActual(id), true, id);
});

test("1100 and above stay on Total ETO", () => {
  for (const id of ["1100", "1101", "1116", "2000"]) assert.equal(hasFinalPartsActual(id), false, id);
});

test("a non-numeric id is never final", () => {
  for (const id of ["", "Report", "NOT DEFINED", "1050A", "10.5"]) assert.equal(hasFinalPartsActual(id), false, id);
});
