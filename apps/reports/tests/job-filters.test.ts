import { test } from "node:test";
import assert from "node:assert/strict";
import { compareJobIds, normalizeJobNumber } from "../src/lib/job-filters";

test("compareJobIds: numeric order, not lexicographic", () => {
  const ids = ["10000", "1020", "979", "1083"];
  ids.sort(compareJobIds);
  assert.deepEqual(ids, ["979", "1020", "1083", "10000"]);
});

test("compareJobIds: zero-padded ids compare by value", () => {
  assert.ok(compareJobIds("0979", "1020") < 0);
  assert.equal(compareJobIds("0100", "100"), 0);
});

test("compareJobIds: non-numeric ids fall back to string compare", () => {
  const ids = ["SVC-2", "1020", "SVC-1"];
  ids.sort(compareJobIds);
  assert.deepEqual(ids, ["1020", "SVC-1", "SVC-2"]);
});

// The one definition shared by job-hours-source.ts's normalizePbiJobId and
// paylocity-workbook.ts's normalizeJobNumber, which were two byte-identical
// copies of this same regex.
test("normalizeJobNumber: strips leading zeros, leaves everything else alone", () => {
  assert.equal(normalizeJobNumber("0114"), "114");
  assert.equal(normalizeJobNumber("00114"), "114");
  assert.equal(normalizeJobNumber("979"), "979");
  assert.equal(normalizeJobNumber("  0114  "), "114"); // trimmed first
  assert.equal(normalizeJobNumber("0"), "0"); // an all-zero id is not "leading" zeros
  assert.equal(normalizeJobNumber("SVC-01"), "SVC-01"); // no digit run at the very start
});
