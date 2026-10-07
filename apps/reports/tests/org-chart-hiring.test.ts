import { test } from "node:test";
import assert from "node:assert/strict";
import { cardId, LEADERS_CARD, placeHiringOnChart } from "../src/lib/org-chart-hiring";
import type { OrgChart, OrgNode } from "../src/lib/org-chart";
import type { HiringPosition } from "../src/lib/hiring-positions";
import type { EmployeeRow } from "../src/lib/employee-row";

function node(id: number, team: string | null = null, reports: OrgNode[] = []): OrgNode {
  return { id, name: `P${id}`, title: null, positionCode: null, team, note: null, override: false, byHand: false, isHead: reports.length > 0, reports };
}

// employee id → Paylocity id: 1→100 (a leader), 2→200 and 5→500 (Mechanical, under leader 1),
// 3→300 (Controls, under leader 1), 4→400 (Mechanical, under leader 9).
const PAYLOCITY: Record<number, string> = { 1: "100", 2: "200", 3: "300", 4: "400", 5: "500" };
const people = new Map<number, EmployeeRow>(
  Object.entries(PAYLOCITY).map(([id, pid]) => [Number(id), { id: Number(id), paylocityId: pid } as unknown as EmployeeRow]),
);

const chart: OrgChart = {
  ready: true,
  leaders: [node(1)],
  leaderCount: 1,
  bands: [
    {
      leader: { id: 1, name: "Leader One", title: null },
      people: 4,
      cards: [
        { team: "mech", name: "Mechanical Engineering", people: 2, heads: [node(2, "mech", [node(5, "mech")])] },
        { team: "controls", name: "Controls Engineering", people: 1, heads: [node(3, "controls")] },
      ],
    },
    {
      leader: { id: 9, name: "Leader Nine", title: null },
      people: 1,
      cards: [{ team: "mech", name: "Mechanical Engineering", people: 1, heads: [node(4, "mech")] }],
    },
  ],
  unplaced: [],
  pending: [],
};

function position(overrides: Partial<HiringPosition>): HiringPosition {
  return {
    sourceId: "p",
    title: "Position",
    status: "Published",
    subStatus: null,
    isOpen: true,
    quantity: 1,
    filledCount: 0,
    remainingQuantity: 1,
    source: "workbook",
    workforceGroup: null,
    department: null,
    hiringManagerIds: [],
    isManuallyAssigned: false,
    expectedStartDate: null,
    isVisible: true,
    functionDescription: null,
    sectionDescription: null,
    workLocDescription: null,
    createdDate: null,
    createdBy: null,
    modifiedBy: null,
    remote: false,
    internal: false,
    ...overrides,
  };
}

const place = (p: HiringPosition) => placeHiringOnChart([p], chart, people);

test("an unassigned position lands on its hiring manager's card, in the right band", () => {
  const second = place(position({ hiringManagerIds: ["400"] }));
  assert.equal(second.byCard.get(cardId(9, "mech"))?.length, 1);
  assert.equal(second.byCard.get(cardId(1, "mech")), undefined);
  assert.equal(second.unplaced.length, 0);

  const first = place(position({ hiringManagerIds: ["200"] }));
  assert.equal(first.byCard.get(cardId(1, "mech"))?.length, 1);
});

test("a manager deeper in a card's tree still places the position on that card", () => {
  assert.equal(place(position({ hiringManagerIds: ["500"] })).byCard.get(cardId(1, "mech"))?.length, 1);
});

test("a manager who is a leader puts the position on the Leadership card", () => {
  assert.equal(place(position({ hiringManagerIds: ["100"] })).byCard.get(LEADERS_CARD)?.length, 1);
});

test("the first listed manager found on the chart wins", () => {
  assert.equal(place(position({ hiringManagerIds: ["404", "300", "400"] })).byCard.get(cardId(1, "controls"))?.length, 1);
});

test("no manager, or none on the chart, is not placed", () => {
  assert.equal(place(position({ hiringManagerIds: [] })).unplaced.length, 1);
  assert.equal(place(position({ hiringManagerIds: ["999"] })).unplaced.length, 1);
});

test("an override puts it on a card of the chosen team: the manager's card if that team has it, else the first", () => {
  const withManager = place(position({ isManuallyAssigned: true, department: "mech", hiringManagerIds: ["400"] }));
  assert.equal(withManager.byCard.get(cardId(9, "mech"))?.length, 1);

  const noManager = place(position({ isManuallyAssigned: true, department: "mech" }));
  assert.equal(noManager.byCard.get(cardId(1, "mech"))?.length, 1);
});

test("an override beats the manager: assigned to Controls, it leaves the manager's Mechanical card", () => {
  const out = place(position({ isManuallyAssigned: true, department: "controls", hiringManagerIds: ["400"] }));
  assert.equal(out.byCard.get(cardId(1, "controls"))?.length, 1);
  assert.equal(out.byCard.get(cardId(9, "mech")), undefined);
});

test("an override to Unassigned, or to a team with no card, is not placed", () => {
  assert.equal(place(position({ isManuallyAssigned: true, department: null, hiringManagerIds: ["400"] })).unplaced.length, 1);
  assert.equal(place(position({ isManuallyAssigned: true, department: "build" })).unplaced.length, 1);
});

test("a manually created position (no manager) goes by its department", () => {
  const out = place(position({ source: "manual", isManuallyAssigned: true, department: "controls", hiringManagerIds: [] }));
  assert.equal(out.byCard.get(cardId(1, "controls"))?.length, 1);
});
