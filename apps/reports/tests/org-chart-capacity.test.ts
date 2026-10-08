import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OrgChart } from "../src/components/OrgChart";
import { buildOrgChart, type OrgEmployee } from "../src/lib/org-chart";
import type { PositionFamilyRow } from "../src/lib/position-families-parse";
import type { EmployeeRow } from "../src/lib/employee-row";
import type { HiringPosition } from "../src/lib/hiring-positions";
import { employeeCapacityHours } from "../src/lib/workforce-capacity";
import { hours as fmtHours } from "../src/components/ui/format";

// Each team card on the Employees page's chart carries the same "current hrs/yr"
// line a Cards card does (2026-10-06): its active people × the year's hours per
// person, as a button that opens the capacity breakdown. See OrgChart.tsx.

const fam = (positionCode: string, familyCode: string): PositionFamilyRow =>
  ({ positionCode, familyCode, familyName: "", title: null, headcount: null, source: "paylocity" });
const ROWS = [fam("PRES", "100"), fam("ME CHIEF", "201"), fam("ME SR", "201")];

const person = (id: number, name: string, positionCode: string, supervisorId: number | null): OrgEmployee =>
  ({ id, name, paylocityId: String(100000 + id), positionTitle: null, positionCode, supervisorId, active: true, team: null });
const PEOPLE = [person(1, "Dan", "PRES", null), person(2, "Chief", "ME CHIEF", 1), person(3, "Ian", "ME SR", 2), person(4, "Zed", "ME SR", 2)];

const row = (p: OrgEmployee): EmployeeRow => ({
  id: p.id, name: p.name, discipline: "—", positionTitle: "—", supervisor: "—", department: "", team: p.team, active: true,
  billingGroup: "", paylocityId: p.paylocityId ?? "", isLead: false, specialty: null, sortOrder: null,
});

const chart = buildOrgChart(PEOPLE, ROWS);
const people = new Map(PEOPLE.map((p) => [p.id, row(p)]));
const render = (props: { year?: number; onSelectCapacity?: () => void }) =>
  renderToStaticMarkup(createElement(OrgChart, { chart, people, ...props }));

test("every card shows its current hrs/yr, from its active headcount", () => {
  const html = render({ year: 2026, onSelectCapacity: () => {} });
  assert.equal((html.match(/hrs\/yr/g) ?? []).length, 2, "the Leadership card and the Mechanical card");
  // Mechanical Engineering: Chief, Ian and Zed.
  assert.ok(html.includes(fmtHours(employeeCapacityHours(3, 2026))));
  // Executive Leadership: Dan alone.
  assert.ok(html.includes(fmtHours(employeeCapacityHours(1, 2026))));
});

test("no hours line without a drill handler, or for a year with no capacity policy", () => {
  assert.ok(!render({ year: 2026 }).includes("hrs/yr"), "nothing to open, so nothing offered");
  assert.ok(!render({ year: 1999, onSelectCapacity: () => {} }).includes("hrs/yr"), "no policy for that year");
  assert.ok(render({ year: 1999, onSelectCapacity: () => {} }).includes("people"), "the headcount is still there");
});

// The stat block (2026-10-08): one line without openings, a small table with them,
// and a search that narrows what is drawn without changing what a card is.
const render2 = (props: Record<string, unknown>) =>
  renderToStaticMarkup(createElement(OrgChart, { chart, people, year: 2026, onSelectCapacity: () => {}, ...props }));

test("a card with no openings reads as one line", () => {
  const html = render2({});
  assert.ok(html.includes(" people"), "N people · hours");
  assert.ok(!html.includes("Planned"), "no table without openings");
});

test("a card with an open position shows current, hiring and planned", () => {
  // Two openings, placed on Chief's card (the Mechanical one) through their hiring manager.
  const position = {
    sourceId: "p1", title: "ME", status: "Published", subStatus: null, isOpen: true, quantity: 2, filledCount: 0, remainingQuantity: 2,
    source: "workbook", workforceGroup: null, department: null, hiringManagerIds: ["100002"], isManuallyAssigned: false,
    expectedStartDate: null, isVisible: true,
  } as unknown as HiringPosition;
  const html = render2({ hiringPositions: [position] });
  for (const word of ["Current", "+ Hiring", "Planned", "People", "Hrs/yr"]) assert.ok(html.includes(word), word);
  assert.ok(html.includes(">+2<"), "two openings");
  assert.ok(html.includes(">5<"), "planned: three people and two openings");
});

test("a search draws the matches and the managers above them, dims those managers, and keeps the card's own numbers", () => {
  const html = render2({ query: "Ian" });
  assert.ok(html.includes("Ian"), "the match");
  assert.ok(html.includes("Chief"), "the manager above them, for context");
  assert.ok(!html.includes("Zed"), "a colleague who doesn't match is not drawn");
  assert.ok(html.includes("2 of 3 shown"), "Chief and Ian are drawn of the card's three");
  assert.ok(html.includes(fmtHours(employeeCapacityHours(3, 2026))), "the card's hours still count all three");
  assert.ok(html.includes("opacity-50"), "the context manager is dimmed");
});

test("a search with no match says so, and a blank one changes nothing", () => {
  assert.ok(render2({ query: "nobody by that name" }).includes("No one matches"));
  assert.equal(render2({ query: "   " }), render2({}), "whitespace is no search");
});

// A card reads top to bottom: the Paylocity roster, then people whose team was set
// by hand (their own colour), then contractors (2026-10-06, by request).
test("a card lists the roster, then team set by hand, then contractors", () => {
  const rows = [...ROWS, fam("CTRL CHIEF", "301"), fam("CTRL SR", "301")];
  const all: OrgEmployee[] = [
    ...PEOPLE,
    person(5, "Cora", "CTRL CHIEF", 1),
    person(6, "Rick", "CTRL SR", 5),
    { ...person(7, "Hank", "ME SR", 2), teamOverride: "controls" },
    { ...person(8, "Temp", "", 5), paylocityId: "TEMP1", team: "controls" },
  ];
  const c = buildOrgChart(all, rows);
  const ppl = new Map(all.map((p) => [p.id, row(p)]));
  const html = renderToStaticMarkup(createElement(OrgChart, { chart: c, people: ppl }));
  const at = (s: string) => html.indexOf(s);
  assert.ok(at("Rick") > -1 && at("Hank") > -1 && at("Temp") > -1, "all three appear");
  assert.ok(at("Rick") < at("Team set by hand"), "roster first");
  assert.ok(at("Team set by hand") < at("Hank"), "hand-placed under its heading");
  assert.ok(at("Hank") < at("Contractors"), "hand-placed above contractors");
  assert.ok(at("Contractors") < at("Temp"), "contractors last");
});
