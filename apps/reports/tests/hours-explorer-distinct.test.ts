import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ── No client-side `distinct` on the punch table (2026-09-14) ────────────────
//
// Prisma implements `findMany({ distinct })` in JS: it fetches every matching row and
// de-duplicates after. hours-explorer.ts made six such calls per Hours page render —
// three with no `where` at all — each pulling the whole ~29k-row JobHoursDetail table
// to return a few dozen values. `groupBy` is a real SQL GROUP BY. A source test rather
// than a query test because the property is about which Prisma method is used, and
// this suite runs with no database.

const SRC = readFileSync(join(process.cwd(), "src", "lib", "hours-explorer.ts"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/[^\n]*$/gm, "");

test("hours-explorer.ts never asks Prisma for `distinct`", () => {
  assert.doesNotMatch(SRC, /distinct:\s*\[/, "findMany({ distinct }) fetches every row and de-duplicates in JS");
});

test("the distinct reads go through the three groupBy helpers", () => {
  for (const helper of ["distinctJobPks", "distinctSections", "distinctEmployeeIds"]) {
    assert.match(SRC, new RegExp(`async function ${helper}\\(`), `${helper} must exist`);
  }
  assert.match(SRC, /groupBy\(\{ by: \["jobId"\], where \}\)/);
  assert.match(SRC, /groupBy\(\{ by: \["section"\], where \}\)/);
  assert.match(SRC, /groupBy\(\{ by: \["employeeId"\], where \}\)/);
});

test("the filter menus and the summary strip both use them, with the summary passing its where", () => {
  const options = SRC.slice(SRC.indexOf("export async function getHoursFilterOptions"), SRC.indexOf("type DetailRow"));
  assert.match(options, /distinctJobPks\(\)/);
  assert.match(options, /distinctSections\(\)/);
  assert.match(options, /distinctEmployeeIds\(\)/);
  // The job names used to ride along on the distinct read; groupBy cannot select a
  // relation, so they come from one lookup over the distinct pks.
  assert.match(options, /prisma\.job\.findMany\(\{ where: \{ id: \{ in: jobPks \} \}/);

  const summary = SRC.slice(SRC.indexOf("export async function queryHoursSummary"), SRC.indexOf("export async function queryHoursGrouped"));
  assert.match(summary, /distinctJobPks\(where\)/);
  assert.match(summary, /distinctEmployeeIds\(where\)/);
  assert.match(summary, /distinctSections\(where\)/);
  // Shape unchanged: the counts are still lengths of the distinct lists.
  assert.match(summary, /jobs: jobs\.length/);
  assert.match(summary, /employees: employees\.length/);
  assert.match(summary, /sections: sections\.length/);
});
