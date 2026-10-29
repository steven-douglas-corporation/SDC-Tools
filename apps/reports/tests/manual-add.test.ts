import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Manual add (2026-10-29): the "+" in an Org chart team card's header adds someone
// not in Paylocity (a contractor). It replaced the Cards view's Add member, the
// only way such a person reached the roster besides the Temp Punches report.

const src = (rel: string) => readFileSync(join(__dirname, "..", "src", rel), "utf8");

test("the Org chart offers Manual add only to employees:edit, and not on the Leadership card", () => {
  assert.match(src("components/EmployeesGrid.tsx"), /canManualAdd=\{canAddEmployees\}/);
  const chart = src("components/OrgChart.tsx");
  assert.match(chart, /ctx\.canManualAdd && addUnder != null && isTeamCode\(team\)/);
  // Team cards pass who the new person reports to; the Leadership card passes none.
  assert.match(chart, /addUnder=\{c\.heads\.find\(/);
  const leadership = chart.slice(chart.indexOf("id={LEADERS_CARD}"), chart.indexOf("</TeamCard>", chart.indexOf("id={LEADERS_CARD}")));
  assert.doesNotMatch(leadership, /addUnder/);
});

test("manualAddPerson checks the permission and places the person by supervisor", () => {
  const actions = src("lib/employee-actions.ts");
  const fn = actions.slice(actions.indexOf("export async function manualAddPerson"));
  assert.match(fn, /assertActionPermission\("employees:edit"\)/);
  assert.match(fn, /supervisorId: supervisor\.id/);
  // Set by hand only when the supervisor's team is not the card's (the leader fallback).
  assert.match(fn, /const teamOverride = supervisor\.team === team \? null : team;/);
});
