import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ── The roster reconciler has to look BOTH ways ─────────────────────────────
//
// Audit, 2026-08-28: the Employees tab showed 70 active while the Paylocity
// "Employee Status History Records" export contained 83 rows. Reconciled by
// unique Employee Id, that file is:
//
//     83 status-history rows
//   -  4 duplicate/history rows (100098, 100102, 100120, 100174 each have two)
//   = 79 unique employees, EVERY row status "Active" — the export carries no
//        terminated rows at all, so absence from it is the only way it can
//        express "gone"
//      -  7 deactivated in this app by explicit request
//      -  2 never ingested at all
//   = 70 on the Employees tab
//
// The 2 were the actual defect. This script only ever asked "which app rows do
// the sheets not cover" (and deactivated them); it never asked the reverse, so
// a person on the Paylocity roster with no app row was invisible. Both were
// August 2026 new hires — Jason Hitchcock [100804] hired 08-03, Jordan
// Priggins [100806] hired 08-24 — and the sheet that SEEDS employees
// (Employee_Department_Map.xlsx) is hand-maintained, NAME-keyed, and was last
// touched 08-17, before either of them started.
//
// Source-shape guard, in this repo's usual style — the script talks to a live
// database and two workbooks, so this pins the SHAPE of the logic rather than
// re-running it.

const SRC = readFileSync(
  join(import.meta.dirname, "..", "scripts", "reconcile-roster-against-app.ts"),
  "utf8",
);
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("the reconciler computes app-only rows AND roster-only people", () => {
  assert.match(CODE, /const appOnly = /, "the original direction must stay");
  assert.match(CODE, /const missingFromApp = /, "roster people with no app row must be computed");
  assert.match(CODE, /const dormantInApp = /, "roster people whose app row is inactive must be computed");
});

test("roster matching is keyed on paylocityId first, then name", () => {
  // Employee Id is the only stable key — Employee.name is free text with real
  // duplicate spellings in this table ("Steve Toneff" / "Steven Toneoff").
  // Name is the fallback because the temps sheet carries no Paylocity id.
  assert.match(CODE, /appByPid\.get\(p\.pid\) \?\? appByName\.get\(normalizeName\(p\.name\)\)/);
});

test("creating missing people is opt-in and separate from --apply", () => {
  // Creating a person and deactivating one are different decisions. Sharing a
  // switch would mean "tidy up the roster" could also invent employees.
  assert.match(CODE, /const CREATE_MISSING = process\.argv\.includes\("--create-missing"\);/);
  assert.doesNotMatch(CODE, /APPLY \|\| CREATE_MISSING|CREATE_MISSING \|\| APPLY/);
});

test("dormant (deactivated) people are reported but never auto-reactivated", () => {
  // Each of the seven was deactivated by an explicit request. Paylocity still
  // listing them active means the two systems disagree — an HR question, not
  // something this script may silently overturn.
  assert.match(CODE, /dormantInApp/, "they must at least be reported");
  assert.doesNotMatch(
    CODE,
    /dormantInApp[\s\S]{0,400}?data:\s*\{\s*active:\s*true/,
    "the reconciler must not reactivate a deliberately deactivated employee",
  );
});

test("a created employee gets no invented department", () => {
  // The department map is the source for that field and does not know these
  // people either. A guess there is worse than a visible gap — they land under
  // "No department" on the Employees tab, which is findable and fixable.
  const create = CODE.slice(CODE.indexOf("if (CREATE_MISSING)"), CODE.indexOf("if (!APPLY)"));
  assert.match(create, /prisma\.employee\.create/);
  assert.doesNotMatch(create, /department:/, "do not invent a department for a roster-only hire");
  assert.match(create, /paylocityId: p\.pid/, "create keyed on the Paylocity id, not the name");
});

test("the reconciliation is printed as arithmetic that has to foot", () => {
  // The number on its own is not reviewable. Printing rows -> unique ->
  // exclusions -> active is what let this audit be checked by hand.
  assert.match(CODE, /rosterRowCount - roster\.size/, "duplicate history rows must be stated");
  assert.match(CODE, /roster\.size - missingFromApp\.length - dormantInApp\.length/);
});
