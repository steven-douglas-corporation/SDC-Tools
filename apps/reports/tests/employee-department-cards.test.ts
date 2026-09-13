import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDepartmentCards, resolvePlaceholderGroup } from "../src/lib/employee-department-cards";
import { DASH, type EmployeeRow } from "../src/lib/employee-row";
import type { SchedulerPlaceholder } from "../src/lib/scheduler-db";

let nextId = 1;
function row(overrides: Partial<EmployeeRow>): EmployeeRow {
  return {
    id: nextId++,
    name: "Test Person",
    discipline: DASH,
    positionTitle: DASH,
    supervisor: DASH,
    department: "",
    team: null,
    active: true,
    billingGroup: "",
    paylocityId: "",
    isLead: false,
    specialty: null,
    sortOrder: null,
    ...overrides,
  };
}

test("rows fold into one card per resolved group, not one per raw department spelling", () => {
  const cards = buildDepartmentCards(
    [row({ name: "A", team: "mech" }), row({ name: "B", department: "Mechanical Engineering" })],
    [],
  );
  assert.equal(cards.length, 1);
  assert.equal(cards[0].key, "mech");
  assert.equal(cards[0].people.length, 2);
});

test("a placeholder with nobody real on it yet still gets its own card", () => {
  const placeholders: SchedulerPlaceholder[] = [{ discipline: "wire", name: "Wire Placeholder" }];
  const cards = buildDepartmentCards([], placeholders);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].key, "wire");
  assert.equal(cards[0].people.length, 0);
  assert.equal(cards[0].placeholders.length, 1);
});

test("a placeholder for an already-populated team joins that SAME card, not a duplicate", () => {
  const cards = buildDepartmentCards([row({ team: "build" })], [{ discipline: "build", name: "Build Placeholder" }]);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].people.length, 1);
  assert.equal(cards[0].placeholders.length, 1);
});

test("resolvePlaceholderGroup resolves a non-team discipline (finance) to its own named card, not a raw-code bucket", () => {
  const group = resolvePlaceholderGroup({ discipline: "finance", name: "Finance Placeholder" });
  assert.equal(group?.key, "finance");
  assert.equal(group?.title, "Finance");
});

test("a placeholder for an unrecognized discipline code falls into the same 'No department' catch-all a person with no department would", () => {
  const cards = buildDepartmentCards([], [{ discipline: "totally-unknown-code", name: "Ghost Placeholder" }]);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].title, "No department");
  assert.equal(cards[0].placeholders.length, 1);
});

test("people within a card sort lead-first, then by sortOrder, then by name", () => {
  const cards = buildDepartmentCards(
    [
      row({ name: "Zoe", team: "mech", isLead: false, sortOrder: 1 }),
      row({ name: "Amy", team: "mech", isLead: true, sortOrder: 5 }),
      row({ name: "Bob", team: "mech", isLead: false, sortOrder: null }),
    ],
    [],
  );
  assert.deepEqual(
    cards[0].people.map((p) => p.name),
    ["Amy", "Zoe", "Bob"],
  );
});

test("Unassigned produces no card, but Operations now gets one", () => {
  // Operations was in HIDDEN_DEPARTMENT_CARDS alongside Unassigned until
  // 2026-08-24, which meant its one employee appeared on no card anywhere. The
  // request asks for an Operations card, so it was taken out of that set.
  //
  // "Unassigned" stays hidden, and for a different reason that has not changed:
  // it is not a department at all, it is the absence of one, and the
  // NO_DEPARTMENT bucket already covers those people.
  assert.equal(buildDepartmentCards([row({ department: "Unassigned" })], []).length, 0);

  const opsCards = buildDepartmentCards([row({ department: "Operations" })], []);
  assert.equal(opsCards.length, 1);
  assert.equal(opsCards[0].key, "operations");
  assert.equal(opsCards[0].title, "Operations");
});

test("cards come back in the canonical delivery-team order, not insertion order", () => {
  const cards = buildDepartmentCards([row({ team: "service" }), row({ team: "pm" }), row({ team: "mech" })], []);
  assert.deepEqual(
    cards.map((c) => c.key),
    ["pm", "mech", "service"],
  );
});
