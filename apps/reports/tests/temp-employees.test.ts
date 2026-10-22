import { test } from "node:test";
import assert from "node:assert/strict";
import { planTempEmployees, describeRegisteredTemps, type KnownPerson } from "../src/lib/temp-employees";

// ── A temp the roster has never heard of is added; nobody else is touched ─────
//
// Pure: who gets a row, who gets an id, who is left for a person. The planner only ever adds
// or fills in an id, and it refuses the case most likely to be a duplicate: the same last name.

const person = (id: number, name: string, paylocityId: string | null): KnownPerson => ({ id, name, paylocityId });

const ROSTER: KnownPerson[] = [
  person(1, "Casey Lane", "TEMP1"),
  person(2, "Drew Harper", "100700"),
  person(3, "Morgan Pike", "TEMP4"),
  person(4, "Pat Smith", "100010"),
  person(5, "Robin Vale", null), // typed in by hand, never given an id
];

test("a name nobody has is added, with the next placeholder id after the highest TEMP number", () => {
  const plan = planTempEmployees([{ name: "Quinn Ashby", reportId: null }], ROSTER);
  assert.deepEqual(plan.create, [{ name: "Quinn Ashby", paylocityId: "TEMP5", placeholder: true }]);
  assert.deepEqual(plan.adopt, []);
  assert.deepEqual(plan.skipped, []);
});

test("several new temps get consecutive placeholders, in the order seen", () => {
  const plan = planTempEmployees(
    [
      { name: "Quinn Ashby", reportId: null },
      { name: "Jamie Fox", reportId: null },
    ],
    ROSTER,
  );
  assert.deepEqual(plan.create.map((c) => c.paylocityId), ["TEMP5", "TEMP6"]);
});

test("a placeholder never reuses an id on a still-active typed-in timecard", () => {
  const plan = planTempEmployees([{ name: "Quinn Ashby", reportId: null }], ROSTER, ["TEMP6", "TEMP8"]);
  assert.equal(plan.create[0].paylocityId, "TEMP9");
});

test("someone already on the roster by name is left alone, whatever their id looks like", () => {
  const plan = planTempEmployees(
    [
      { name: "casey LANE", reportId: null }, // case and spacing do not matter
      { name: "Drew Harper", reportId: null },
      { name: "Pat Smith", reportId: null },
    ],
    ROSTER,
  );
  assert.deepEqual(plan, { create: [], adopt: [], skipped: [] });
});

test("a same-named row with no id is given the id instead of being duplicated", () => {
  const plan = planTempEmployees([{ name: "Robin Vale", reportId: null }], ROSTER);
  assert.deepEqual(plan.adopt, [{ employeeId: 5, name: "Robin Vale", paylocityId: "TEMP5" }]);
  assert.deepEqual(plan.create, []);
});

test("two same-named rows with no id are not guessed between", () => {
  const plan = planTempEmployees([{ name: "Robin Vale", reportId: null }], [...ROSTER, person(6, "Robin Vale", null)]);
  assert.equal(plan.adopt.length, 0);
  assert.equal(plan.create.length, 0);
  assert.match(plan.skipped[0].reason, /several people here have this name and no ID/);
});

test("a name sharing a last name with someone on the roster is NOT added: a nickname is likelier than two people", () => {
  const plan = planTempEmployees(
    [
      { name: "Mike Pike", reportId: null }, // "Morgan Pike" is on the roster
      { name: "Quinn Ashby", reportId: null },
    ],
    ROSTER,
  );
  assert.deepEqual(plan.create.map((c) => c.name), ["Quinn Ashby"]);
  assert.equal(plan.skipped.length, 1);
  assert.equal(plan.skipped[0].name, "Mike Pike");
  assert.match(plan.skipped[0].reason, /same|last name/i);
});

test("the report's own id is used as it is when it has one, and never a placeholder", () => {
  const plan = planTempEmployees([{ name: "Quinn Ashby", reportId: "100777" }], ROSTER);
  assert.deepEqual(plan.create, [{ name: "Quinn Ashby", paylocityId: "100777", placeholder: false }]);
});

test("a report id that already belongs to someone else is refused, not reassigned", () => {
  const plan = planTempEmployees([{ name: "Quinn Ashby", reportId: "100700" }], ROSTER);
  assert.equal(plan.create.length, 0);
  assert.match(plan.skipped[0].reason, /already belongs to someone else/);
});

test("the same name twice in the report is added once", () => {
  const plan = planTempEmployees(
    [
      { name: "Quinn Ashby", reportId: null },
      { name: "  quinn ashby ", reportId: null },
    ],
    ROSTER,
  );
  assert.equal(plan.create.length, 1);
});

test("with nobody on the roster yet, numbering starts at TEMP1", () => {
  assert.equal(planTempEmployees([{ name: "Quinn Ashby", reportId: null }], []).create[0].paylocityId, "TEMP1");
});

test("the sentence for the step detail says what happened and is empty when nothing did", () => {
  assert.equal(describeRegisteredTemps({ created: [], adopted: [], skipped: [], error: null }), "");
  assert.equal(
    describeRegisteredTemps({ created: ["A B", "C D"], adopted: ["E F"], skipped: [{ name: "G H", reason: "x" }], error: null }),
    "added 2 to the roster (No department); gave 1 existing person(s) an ID; 1 left for a person (see Data Management)",
  );
  assert.match(describeRegisteredTemps({ created: [], adopted: [], skipped: [], error: "boom" }), /could not check the roster.*boom/);
});
