import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Manual add (2026-10-29): a row at an Org chart team card's foot added someone
// not in Paylocity (a contractor). The button was removed from the cards
// (2026-10-30); the server action stays.

const src = (rel: string) => readFileSync(join(__dirname, "..", "src", rel), "utf8");

test("the Org chart cards offer no Manual add (removed 2026-10-30)", () => {
  assert.doesNotMatch(src("components/OrgChart.tsx"), /ManualAdd|canManualAdd|addUnder/);
  assert.doesNotMatch(src("components/EmployeesGrid.tsx"), /canManualAdd=/);
});

test("manualAddPerson checks the permission and places the person by supervisor", () => {
  const actions = src("lib/employee-actions.ts");
  const fn = actions.slice(actions.indexOf("export async function manualAddPerson"));
  assert.match(fn, /assertActionPermission\("employees:edit"\)/);
  assert.match(fn, /supervisorId: supervisor\.id/);
  // Set by hand only when the supervisor's team is not the card's (the leader fallback).
  assert.match(fn, /const teamOverride = supervisor\.team === team \? null : team;/);
});
