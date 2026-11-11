import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildOrgChart, type OrgEmployee } from "../src/lib/org-chart";
import { groupByFunction, sectionOf } from "../src/lib/org-chart-groups";
import { OrgChart } from "../src/components/OrgChart";
import type { PositionFamilyRow } from "../src/lib/position-families-parse";
import type { EmployeeRow } from "../src/lib/employee-row";

// The Org chart by function (2026-11-11): the same cards, sat under Growth /
// Execution / Support instead of a band per leader. See src/lib/org-chart-groups.ts.

const fam = (positionCode: string, familyCode: string): PositionFamilyRow =>
  ({ positionCode, familyCode, familyName: "", title: null, headcount: null, source: "paylocity" });
const ROWS = [fam("PRES", "100"), fam("VP", "100"), fam("CFO", "100"), fam("PM", "106"), fam("ME", "201"), fam("MB", "401"), fam("HR", "103"), fam("ACC", "104"), fam("SM", "105"), fam("AI", "108")];

const e = (id: number, name: string, positionCode: string | null, supervisorId: number | null, extra: Partial<OrgEmployee> = {}): OrgEmployee =>
  ({ id, name, paylocityId: String(100000 + id), positionTitle: null, positionCode, supervisorId, active: true, team: null, ...extra });

const PEOPLE = [
  e(1, "Dan", "PRES", null),
  e(2, "Pat", "VP", 1), // operations
  e(3, "Ash", "VP", 1), // growth
  e(4, "Lisa", "CFO", 1),
  e(10, "Mike", "ME", 1),
  e(11, "Ian", "ME", 10),
  e(20, "Sean", "MB", 2),
  e(21, "Frank", "MB", 20),
  e(22, "Bob", "ME", 2), // a mechanical engineer under Pat: a second Mechanical card
  e(30, "Greg", "SM", 3),
  e(31, "Heather", "HR", 3),
  e(32, "Sandra", "ACC", 4),
  e(33, "Moses", "AI", 1),
  e(40, "Pam", "PM", 2),
  e(41, "Quinn", "PM", 40),
];
const chart = buildOrgChart(PEOPLE, ROWS);
const groups = groupByFunction(chart.bands.map((band) => ({ band, cards: band.cards.map((card) => ({ card, heads: card.heads })) })));
const teams = (key: keyof typeof groups.sections) => groups.sections[key].cards.map((c) => `${c.item.card.team}@${c.band.leader.name}`);

test("each team goes to its function", () => {
  assert.equal(sectionOf("sales"), "growth");
  assert.equal(sectionOf("pm"), "pm");
  assert.equal(sectionOf("controls"), "engineering");
  assert.equal(sectionOf("ops"), "operations");
  assert.equal(sectionOf("ai"), "support");
  assert.equal(sectionOf(null), null);
  assert.equal(sectionOf("exec"), null);
});

test("cards are regrouped, not merged: a team under two leaders keeps both cards", () => {
  assert.deepEqual(teams("engineering"), ["mech@Dan", "mech@Pat"]);
  assert.deepEqual(teams("pm"), ["pm@Pat"]);
  assert.deepEqual(teams("operations"), ["build@Pat"]);
  assert.deepEqual(teams("growth"), ["sales@Ash"]);
  assert.deepEqual(teams("support"), ["finance@Lisa", "hr@Ash", "ai@Dan"], "in team order");
  assert.equal(groups.other.length, 0);
});

test("a team no function takes stays with its band", () => {
  const odd = groupByFunction(chart.bands.map((band) => ({ band, cards: band.cards.map((card) => ({ card: { ...card, team: "zzz" } })) })));
  assert.ok(odd.other.length > 0);
  assert.ok(Object.values(odd.sections).every((s) => s.cards.length === 0));
});

const row = (p: OrgEmployee): EmployeeRow => ({
  id: p.id, name: p.name, discipline: "â€”", positionTitle: "â€”", supervisor: "â€”", department: "", team: p.team, active: true,
  billingGroup: "", paylocityId: p.paylocityId ?? "", isLead: false, specialty: null, sortOrder: null,
});
const html = renderToStaticMarkup(createElement(OrgChart, { chart, people: new Map(PEOPLE.map((p) => [p.id, row(p)])) }));

test("the groups are Leadership, Growth, Execution and Support, in that order, with no band per leader", () => {
  const at = (s: string) => html.indexOf(s);
  assert.ok(at(">Leadership<") > -1 && at(">Leadership<") < at(">Growth<"));
  assert.ok(at(">Growth<") < at(">Execution<") && at(">Execution<") < at(">Support<"));
  assert.ok(!html.includes("Reporting to"), "no band per leader");
});

// The slice of the page from one group heading to the next.
const group = (title: string, next: string | null) => {
  const from = html.indexOf(`>${title}<`);
  return html.slice(from, next ? html.indexOf(`>${next}<`, from) : undefined);
};

test("Execution is in parts, each with its own header, Engineering before Operations", () => {
  const execution = group("Execution", "Support");
  const at = (s: string) => execution.indexOf(s);
  assert.ok(at(">Engineering<") > -1 && at(">Engineering<") < at(">Operations<"));
  assert.ok(!execution.includes(">Project management<"), "Project management never gets a header: its card says it");
});

// How Execution gives way on a narrow chart (OrgChart.tsx's Part): below 1410px,
// Project management is drawn as its own group beside Growth instead of inside
// Execution, and Execution's count leaves it out. The width rule is CSS, so this
// checks that both forms are in the page with the classes that switch them.
test("Project management is in the page twice, each shown on one side of the 1410px switch", () => {
  const upTop = group("Project management", "Execution");
  assert.ok(html.indexOf(">Project management<") < html.indexOf(">Execution<"), "the moved-up group comes before Execution");
  assert.ok(html.includes('flex-1 @min-[1410px]:hidden" style="flex-basis:20rem"'), "the moved-up group hides on a wide chart");
  assert.ok(upTop.includes("Pam") && upTop.includes("Quinn"));
  const execution = group("Execution", "Support");
  assert.ok(execution.includes("w-[18rem] @max-[1410px]:hidden"), "the Project management part hides on a narrow chart");
  assert.ok(execution.includes("Pam"), "and is drawn in Execution too");
  // Execution's count: everyone on a wide chart (Pam, Quinn; Mike, Ian, Bob; Sean,
  // Frank), everyone but Project management on a narrow one.
  assert.ok(/<span class="@max-\[1410px\]:hidden">7<\/span><span class="@min-\[1410px\]:hidden">5<\/span>/.test(execution), "7 with PM, 5 without");
});

test("grouped by reporting line, the chart is a group per leader with no captions", () => {
  const byLeader = renderToStaticMarkup(createElement(OrgChart, { chart, people: new Map(PEOPLE.map((p) => [p.id, row(p)])), groupBy: "leader" }));
  for (const name of ["Dan", "Pat", "Ash", "Lisa"]) assert.ok(byLeader.includes(`Reporting to ${name}`), name);
  assert.ok(!byLeader.includes(">Execution<") && !byLeader.includes("Reports to"));
});

test("headings name no leaders; every card says who it reports to", () => {
  const heading = (title: string) => html.slice(html.indexOf(`>${title}<`), html.indexOf("</h3>", html.indexOf(`>${title}<`)));
  for (const t of ["Growth", "Execution", "Support"]) assert.ok(!/Ash|Dan|Pat|Lisa/.test(heading(t)), `${t} heading`);
  assert.ok(group("Growth", "Execution").includes("Reports to Ash"));
  const execution = group("Execution", "Support");
  assert.ok(execution.includes("Reports to Dan") && execution.includes("Reports to Pat"));
  const support = group("Support", null);
  for (const name of ["Lisa", "Ash", "Dan"]) assert.ok(support.includes(`Reports to ${name}`), name);
});
