import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOrgChart, type OrgEmployee, type OrgNode } from "../src/lib/org-chart";
import type { PositionFamilyRow } from "../src/lib/position-families-parse";

// The Org Chart's shape (2026-10-02): Leadership on top, a band per leader, a
// card per team of the branch heads under that leader. See src/lib/org-chart.ts.

const fam = (positionCode: string, familyCode: string): PositionFamilyRow =>
  ({ positionCode, familyCode, familyName: "", title: null, headcount: null, source: "paylocity" });
const ROWS = [fam("PRES", "100"), fam("VPO", "100"), fam("SEM", "500"), fam("SVCTECH", "404"), fam("MBS", "401"), fam("MB01", "401"), fam("AII", "108")];

const e = (id: number, name: string, positionCode: string | null, supervisorId: number | null, extra: Partial<OrgEmployee> = {}): OrgEmployee =>
  ({ id, name, paylocityId: String(100000 + id), positionTitle: null, positionCode, supervisorId, active: true, team: null, ...extra });

const PEOPLE = [
  e(1, "Dan", "PRES", null),
  e(2, "Pat", "VPO", 1),
  e(10, "Monica", "SEM", 2),
  e(11, "Billy", "SVCTECH", 10),
  e(20, "Sean", "MBS", 2),
  e(21, "Hidden Lead", "MB01", 20, { active: false }),
  e(22, "Frank", "MB01", 21),
  e(30, "Moses", "AII", 1),
  e(31, "Suhith", null, 1, { paylocityId: "TEMP7", discipline: "AI" }),
  e(40, "Deborah", null, null),
];
const chart = buildOrgChart(PEOPLE, ROWS);
const names = (ns: OrgNode[]): string[] => ns.flatMap((n) => [n.name, ...names(n.reports)]);

test("Leadership is its own tree, top down", () => {
  assert.equal(chart.leaderCount, 2);
  assert.deepEqual(names(chart.leaders), ["Dan", "Pat"]);
});

test("a band per leader, cards in delivery order, branch heads with their people", () => {
  assert.deepEqual(chart.bands.map((b) => [b.leader.name, b.people]), [["Dan", 2], ["Pat", 4]]);
  const pat = chart.bands[1];
  assert.deepEqual(pat.cards.map((c) => [c.team, c.people]), [["build", 2], ["service", 2]]);
  assert.deepEqual(names(pat.cards[1].heads), ["Monica", "Billy"]);
});

test("a hidden manager's reports are lifted to the nearest shown manager", () => {
  assert.deepEqual(names(chart.bands[1].cards[0].heads), ["Sean", "Frank"]);
});

test("only people not in Paylocity get a note", () => {
  const billy = chart.bands[1].cards[1].heads[0].reports[0];
  assert.equal(billy.team, "service", "placed by his branch, under the Service Engineering Manager");
  assert.equal(billy.note, null, "a family that differs from the branch is not flagged");
  const suhith = chart.bands[0].cards.flatMap((c) => c.heads).find((h) => h.name === "Suhith")!;
  assert.equal(suhith.note, "Not in Paylocity · supervisor set here: Dan");
  assert.equal(suhith.team, "ai", "no code and no team: the app's discipline label, for display");
});

test("people with no Leadership above them are listed apart", () => {
  assert.deepEqual(chart.unplaced.map((u) => [u.name, u.detail]), [["Deborah", "No supervisor in Paylocity"]]);
});

// "Show inactive" (2026-10-08): hidden people are drawn, each under their own manager —
// nobody is lifted past them — and the counts keep saying how many are ACTIVE.
const withInactive = buildOrgChart(
  [...PEOPLE, e(41, "Gone Gary", null, null, { active: false })],
  ROWS,
  { includeInactive: true },
);

test("with inactive people included, a hidden manager is drawn and keeps their reports", () => {
  const build = withInactive.bands[1].cards[0];
  assert.equal(build.team, "build");
  const sean = build.heads[0];
  assert.deepEqual([sean.name, sean.reports.map((r) => r.name), sean.reports[0].reports.map((r) => r.name)], ["Sean", ["Hidden Lead"], ["Frank"]], "Frank is no longer lifted to Sean");
  assert.equal(sean.reports[0].active, false);
  assert.equal(sean.active, true);
});

test("with inactive people included, counts still separate active from drawn", () => {
  const build = withInactive.bands[1].cards[0];
  assert.deepEqual([build.people, build.active], [3, 2], "Sean, Hidden Lead and Frank are drawn; two are active");
  assert.deepEqual([withInactive.bands[1].people, withInactive.bands[1].active], [5, 4]);
  assert.equal(withInactive.leaderActive, withInactive.leaderCount, "no inactive leader in this data");
});

test("with inactive people included, an unplaced inactive person is listed and flagged", () => {
  assert.deepEqual(withInactive.unplaced.map((u) => [u.name, u.active]), [["Deborah", true], ["Gone Gary", false]]);
});

test("by default nobody inactive is drawn, and active equals drawn everywhere", () => {
  const plain = buildOrgChart([...PEOPLE, e(41, "Gone Gary", null, null, { active: false })], ROWS);
  assert.deepEqual(plain.unplaced.map((u) => u.name), ["Deborah"]);
  assert.ok(plain.bands.every((b) => b.active === b.people && b.cards.every((c) => c.active === c.people)));
  assert.equal(plain.leaderActive, plain.leaderCount);
  assert.ok(!names(plain.bands[1].cards[0].heads).includes("Hidden Lead"));
});

test("an inactive leader appears in Leadership only when inactive people are included", () => {
  const people = [...PEOPLE, e(5, "Retired VP", "VPO", 1, { active: false })];
  const all = buildOrgChart(people, ROWS, { includeInactive: true });
  assert.deepEqual([all.leaderCount, all.leaderActive], [3, 2]);
  assert.equal(names(all.leaders).includes("Retired VP"), true);
  const plain = buildOrgChart(people, ROWS);
  assert.deepEqual([plain.leaderCount, plain.leaderActive], [2, 2]);
  assert.equal(names(plain.leaders).includes("Retired VP"), false);
});

test("pending changes list only what the rule would write", () => {
  assert.deepEqual(chart.pending.map((c) => [c.name, c.to]).sort(), [["Billy", "service"], ["Frank", "build"], ["Monica", "service"], ["Moses", "ai"], ["Sean", "build"]]);
});

// ── A team set by hand (2026-10-06) ─────────────────────────────────────────

const patBand = (c: ReturnType<typeof buildOrgChart>) => c.bands.find((b) => b.leader.name === "Pat")!;
const cardOf = (c: ReturnType<typeof buildOrgChart>, team: string) => patBand(c).cards.find((x) => x.team === team);

test("a person placed by hand sits on the card they were given, in their own leader's group", () => {
  const moved = buildOrgChart(PEOPLE.map((p) => (p.id === 11 ? { ...p, teamOverride: "build" } : p)), ROWS); // Billy, under Monica
  assert.deepEqual(names(cardOf(moved, "build")!.heads), ["Sean", "Frank", "Billy"], "a root of the Builders card, after Sean's line");
  assert.deepEqual(names(cardOf(moved, "service")!.heads), ["Monica"], "gone from where his manager is");
  const billy = cardOf(moved, "build")!.heads.find((h) => h.name === "Billy")!;
  assert.equal(billy.note, "Team set by hand · reports to Monica");
  assert.equal(patBand(moved).people, 4, "the group still counts everyone once");
});

test("moving a manager by hand does not take their reports with them", () => {
  const moved = buildOrgChart(PEOPLE.map((p) => (p.id === 10 ? { ...p, teamOverride: "pm" } : p)), ROWS); // Monica
  assert.deepEqual(names(cardOf(moved, "pm")!.heads), ["Monica"]);
  assert.deepEqual(names(cardOf(moved, "service")!.heads), ["Billy"], "Billy stays on Service, now a line of his own");
});

test("an override that matches the rule changes nothing", () => {
  const same = buildOrgChart(PEOPLE.map((p) => (p.id === 11 ? { ...p, teamOverride: "service" } : p)), ROWS);
  assert.deepEqual(patBand(same).cards.map((c) => [c.team, names(c.heads)]), patBand(chart).cards.map((c) => [c.team, names(c.heads)]));
  assert.equal(cardOf(same, "service")!.heads[0].reports[0].note, null);
});
