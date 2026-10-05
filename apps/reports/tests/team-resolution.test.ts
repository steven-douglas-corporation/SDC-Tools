import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTeams, pendingTeamChanges, planTeamWrites, pickFamily, departmentLeads, type TeamPerson } from "../src/lib/team-resolution";
import type { PositionFamilyRow } from "../src/lib/position-families-parse";

// The reporting-line team rule (2026-10-02). See the header of
// src/lib/team-resolution.ts. People and codes below are the real cases from
// the 2 Oct 2026 roster that settled each part of the rule.

const fam = (positionCode: string, familyCode: string, source: PositionFamilyRow["source"] = "paylocity"): PositionFamilyRow =>
  ({ positionCode, familyCode, familyName: "", title: null, headcount: null, source });

const ROWS: PositionFamilyRow[] = [
  fam("PRES", "100"), fam("VPO", "100"), fam("CFO", "100"),
  fam("SEM", "500", "override"), fam("SVCTECH", "404"), fam("SCE", "106"), fam("SCE", "301"), fam("SCE", "500"),
  fam("PROMGR", "107", "override"), fam("IC", "107"), fam("IC", "404"), fam("BSPC", "107"),
  fam("ME CHIEF", "201"), fam("ME SR", "201"), fam("AP01", "104"), fam("AII", "108", "override"),
];

const p = (id: number, name: string, positionCode: string | null, supervisorId: number | null, team: string | null = null): TeamPerson & { active: boolean } =>
  ({ id, name, positionCode, supervisorId, team, active: true });

const PEOPLE = [
  p(1, "Dan Belliveau", "PRES", null, "exec"),
  p(2, "Pat Morrison", "VPO", 1, null),
  p(3, "Lisa Andreani", "CFO", 1, "finance"),
  p(10, "Monica Saggio", "SEM", 2, "service"),
  p(11, "Billy Cantrell", "SVCTECH", 10, "mfgops"),
  p(12, "Ivan Galvez", "SCE", 10, "service"),
  p(20, "Patrick Laffey", "PROMGR", 2, "finance"),
  p(21, "Jackie Hlavaty", "IC", 20, "mfgops"),
  p(22, "Ryan Belliveau", null, 20, null),
  p(30, "Michael Czenszak", "ME CHIEF", 1, "mech"),
  p(31, "Ian Milne", "ME SR", 30, "mech"),
  p(32, "Lahu Shedole", null, 30, "mech"),
  p(40, "Sandra Morrison", "AP01", 3, "finance"),
  p(50, "Moses Vest", "AII", 1, null),
  p(60, "Deborah Belliveau", null, null, null),
];

const R = resolveTeams(PEOPLE, ROWS);
const team = (id: number) => R.get(id)?.proposedTeam;

test("pickFamily: 500 wins, else the lowest family", () => {
  assert.equal(pickFamily(["106", "301", "500"]), "500");
  assert.equal(pickFamily(["404", "107"]), "107");
  assert.equal(pickFamily([]), null);
});

test("Leadership keeps the team it has, wherever that is", () => {
  assert.deepEqual([R.get(1)?.how, team(1)], ["leader", "exec"]);
  assert.equal(team(3), "finance", "the CFO stays on Finance");
  assert.equal(team(2), null, "the VP of Operations has no team stored, and none is invented");
});

test("everyone takes their branch head's team", () => {
  assert.equal(team(11), "service", "Service Technician under the Service Engineering Manager");
  assert.equal(R.get(11)?.ownTeam, "mfgops");
  assert.equal(team(21), "ops", "Jackie follows Pat Laffey into Operations");
  assert.equal(team(22), "ops", "no position code: still placed by the branch");
  assert.equal(team(12), "service", "SCE is in 106/301/500 — 500 wins");
  assert.equal(R.get(21)?.branchHeadId, 20);
  assert.equal(team(50), "ai", "reports straight to Leadership, so heads their own branch");
});

test("no family anywhere: no proposal", () => {
  assert.deepEqual([R.get(60)?.how, team(60)], ["none", null]);
});

test("a supervisor loop in the data ends instead of spinning", () => {
  const loop = resolveTeams([p(1, "A", "ME SR", 2), p(2, "B", "AP01", 1)], ROWS);
  assert.ok(loop.get(1)?.proposedTeam);
});

test("pending changes: only shown, non-Leadership people whose team would move", () => {
  const changes = pendingTeamChanges(PEOPLE, R);
  assert.deepEqual(
    changes.map((c) => [c.name, c.from, c.to]),
    [
      ["Billy Cantrell", "mfgops", "service"],
      ["Jackie Hlavaty", "mfgops", "ops"],
      ["Moses Vest", null, "ai"],
      ["Patrick Laffey", "finance", "ops"],
      ["Ryan Belliveau", null, "ops"],
    ],
  );
  assert.match(changes[0].reason, /branch of Monica Saggio \(own family says Manufacturing Operations\)/);
});

test("planTeamWrites: hidden people too, never Leadership, never a blank", () => {
  const people = [...PEOPLE, { ...p(70, "Hidden Builder", "ME SR", 30, null), active: false }];
  const writes = planTeamWrites(people, ROWS);
  assert.ok(writes.some((w) => w.name === "Hidden Builder" && w.to === "mech"), "a hidden new hire is placed before anyone shows them");
  assert.ok(!writes.some((w) => w.id === 2 || w.id === 3), "Leadership is never written");
  assert.ok(!writes.some((w) => w.id === 60), "no proposal, no write");
  assert.deepEqual(planTeamWrites(people.map((x) => ({ ...x, team: writes.find((w) => w.id === x.id)?.to ?? x.team })), ROWS), [], "a second pass writes nothing");
});

test("departmentLeads: the top of each team, only when it is the one top and leads someone", () => {
  const rows = [...ROWS, fam("SAE", "105"), fam("BDM", "105")];
  const people = [
    ...PEOPLE,
    p(80, "Ashley Cohen", "PRES", 1, "growth"), // Leadership, so Sales below reports straight to it
    p(81, "David Culbertson", "SAE", 80),
    p(82, "Jason Hitchcock", "BDM", 80),
    p(90, "Shashank Bemberkar", "AII", 1),
    { ...p(91, "Hidden Builder", "ME SR", 30, "mech"), active: false },
  ];
  const leads = departmentLeads(people, resolveTeams(people, rows));
  const names = (ids: Set<number>) => people.filter((x) => ids.has(x.id)).map((x) => x.name).sort();
  assert.deepEqual(names(leads), ["Michael Czenszak", "Monica Saggio", "Patrick Laffey"]);
  // Sales: two people each report straight to Leadership — no single top.
  // AI: Moses and Shashank both report to the President — no star either.
  // Finance: Sandra heads it alone but nobody reports to her.
  assert.ok(!leads.has(81) && !leads.has(82) && !leads.has(50) && !leads.has(90) && !leads.has(40));
});
