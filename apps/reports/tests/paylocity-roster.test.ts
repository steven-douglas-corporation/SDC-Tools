import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseRosterGrid,
  planRosterSync,
  isEmptyPlan,
  personName,
  RosterFileError,
  type AppEmployee,
} from "../src/lib/paylocity-roster-parse";

// The Paylocity roster sync's rules (2026-09-30): add everyone, hidden; mirror
// supervisor and title; never deactivate, rename or remove. See the header of
// src/lib/paylocity-roster-parse.ts.

const HEADER = ["Employee Id", "First Name", "Last Name", "Job Title", "Position Family Codes", "Supervisor's Employee ID", "Is Active"];

function grid(...rows: (string | null)[][]) {
  return [HEADER, ...rows];
}

const BOSS = ["100042", "Pat", "Boss", "President", "100", "", "Yes"];

function app(e: Partial<AppEmployee> & { id: number; name: string }): AppEmployee {
  return { paylocityId: null, positionTitle: null, supervisorId: null, active: true, ...e };
}

test("parse: columns by header name, outsourced naming, Not Defined, self-supervision", () => {
  const rows = parseRosterGrid(
    grid(
      BOSS,
      ["100700", "Kedar Tarlekar", "CE Outsourced", "", "", "100042", "No"],
      ["100034", "Michael", "Czenszak", "Not Defined", "201", "100034", "Yes"],
    ),
  );
  assert.deepEqual(rows[1], { paylocityId: "100700", name: "Kedar Tarlekar", positionTitle: null, supervisorPaylocityId: "100042", paylocityActive: false });
  assert.equal(rows[2].positionTitle, null, "Paylocity's placeholder title is a blank");
  assert.equal(rows[2].supervisorPaylocityId, null, "a person listed as their own supervisor has none");
  assert.equal(personName("Jane", "Doe"), "Jane Doe");
});

test("parse: a curly apostrophe or reordered columns still match", () => {
  const header = ["Is Active", "Supervisor’s Employee ID", "Job Title", "Last Name", "First Name", "Employee Id"];
  const rows = parseRosterGrid([header, ["Yes", "", "President", "Boss", "Pat", "100042"], ["Yes", "100042", "Engineer", "Doe", "Jane", "100001"]]);
  assert.equal(rows[1].name, "Jane Doe");
  assert.equal(rows[1].supervisorPaylocityId, "100042");
});

test("parse: refuses a file it can't trust, rather than importing part of it", () => {
  assert.throws(() => parseRosterGrid([["Employee Id", "First Name"]]), RosterFileError);
  assert.throws(() => parseRosterGrid(grid(BOSS, BOSS)), /more than once/);
  assert.throws(() => parseRosterGrid(grid()), /no employee rows/);
  // Every supervisor blank would clear every reporting line — a broken export.
  assert.throws(() => parseRosterGrid(grid(BOSS, ["100001", "Jane", "Doe", "Engineer", "", "", "Yes"])), /Supervisor's Employee ID/);
});

test("plan: new people are created HIDDEN whatever Paylocity says, with their supervisor", () => {
  const file = parseRosterGrid(grid(BOSS, ["100001", "Jane", "Doe", "Engineer", "", "100042", "Yes"]));
  const plan = planRosterSync(file, []);
  assert.equal(plan.create.length, 2);
  // Created rows are written active=false by the sync itself; the plan never
  // carries an active flag for anyone, so nothing can turn a person on or off.
  assert.ok(plan.create.every((r) => !("active" in r)));
  assert.deepEqual(
    plan.supervisorChanges.map((s) => [s.paylocityId, s.toPaylocityId]),
    [["100001", "100042"]],
  );
});

test("plan: existing people get title and supervisor mirrored; name and active are never touched", () => {
  const boss = app({ id: 1, name: "Pat Boss", paylocityId: "100042", positionTitle: "President" });
  const other = app({ id: 2, name: "Old Boss", paylocityId: "100099" });
  const jane = app({ id: 3, name: "Janie Doe (curated)", paylocityId: "100001", positionTitle: "Intern", supervisorId: 2, active: false });
  const file = parseRosterGrid(grid(BOSS, ["100001", "Jane", "Doe", "Engineer", "", "100042", "Yes"]));
  const plan = planRosterSync(file, [boss, other, jane]);
  assert.equal(plan.create.length, 0);
  assert.deepEqual(plan.titleChanges, [{ paylocityId: "100001", name: "Janie Doe (curated)", from: "Intern", to: "Engineer" }]);
  assert.deepEqual(plan.supervisorChanges, [{ paylocityId: "100001", name: "Janie Doe (curated)", fromName: "Old Boss", toPaylocityId: "100042" }]);
  // Old Boss is not in the file and is simply left alone.
  assert.equal(plan.unchanged, 1);
});

test("plan: a blank supervisor in Paylocity clears the app's (Paylocity owns the field)", () => {
  const boss = app({ id: 1, name: "Pat Boss", paylocityId: "100042", positionTitle: "President", supervisorId: 2 });
  const other = app({ id: 2, name: "Jane Doe", paylocityId: "100001", positionTitle: "Engineer", supervisorId: 1 });
  const file = parseRosterGrid(grid(BOSS, ["100001", "Jane", "Doe", "Engineer", "", "100042", "Yes"]));
  const plan = planRosterSync(file, [boss, other]);
  assert.deepEqual(plan.supervisorChanges, [{ paylocityId: "100042", name: "Pat Boss", fromName: "Jane Doe", toPaylocityId: null }]);
});

test("plan: a hand-entered person with no Paylocity id is LINKED by name, not duplicated", () => {
  const boss = app({ id: 1, name: "Pat Boss", paylocityId: "100042", positionTitle: "President" });
  const mike = app({ id: 7, name: "Mike Smith" }); // nickname — same key as Michael
  const file = parseRosterGrid(grid(BOSS, ["100005", "Michael", "Smith", "Builder", "", "100042", "Yes"]));
  const plan = planRosterSync(file, [boss, mike]);
  assert.equal(plan.create.length, 0);
  assert.deepEqual(plan.link, [{ employeeId: 7, name: "Mike Smith", paylocityId: "100005" }]);
  assert.equal(plan.titleChanges[0]?.to, "Builder");
});

test("plan: an ambiguous name is skipped entirely and reported, never guessed", () => {
  const boss = app({ id: 1, name: "Pat Boss", paylocityId: "100042", positionTitle: "President" });
  const a = app({ id: 7, name: "Chris Lee" });
  const b = app({ id: 8, name: "Christopher Lee" });
  const file = parseRosterGrid(grid(BOSS, ["100005", "Chris", "Lee", "Builder", "", "100042", "Yes"]));
  const plan = planRosterSync(file, [boss, a, b]);
  assert.equal(plan.create.length, 0);
  assert.equal(plan.link.length, 0);
  assert.equal(plan.ambiguous.length, 1);
  assert.equal(plan.supervisorChanges.length, 0);
});

test("plan: a supervisor id nobody has leaves the current supervisor alone", () => {
  const boss = app({ id: 1, name: "Pat Boss", paylocityId: "100042", positionTitle: "President" });
  const jane = app({ id: 3, name: "Jane Doe", paylocityId: "100001", positionTitle: "Engineer", supervisorId: 1 });
  const file = parseRosterGrid(grid(BOSS, ["100001", "Jane", "Doe", "Engineer", "", "999999", "Yes"]));
  const plan = planRosterSync(file, [boss, jane]);
  assert.equal(plan.supervisorChanges.length, 0);
  assert.deepEqual(plan.unresolvedSupervisors, [{ paylocityId: "100001", name: "Jane Doe", supervisorPaylocityId: "999999" }]);
});

test("plan: a second pass over the same file changes nothing", () => {
  const boss = app({ id: 1, name: "Pat Boss", paylocityId: "100042", positionTitle: "President" });
  const jane = app({ id: 3, name: "Jane Doe", paylocityId: "100001", positionTitle: "Engineer", supervisorId: 1, active: false });
  const file = parseRosterGrid(grid(BOSS, ["100001", "Jane", "Doe", "Engineer", "", "100042", "No"]));
  const plan = planRosterSync(file, [boss, jane]);
  assert.ok(isEmptyPlan(plan));
  assert.equal(plan.unchanged, 2);
});
