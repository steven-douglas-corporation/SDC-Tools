import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRoster, flattenTree, type RosterNode } from "../src/lib/org-chart-roster";

// The Canvas view's people list (2026-11-19): groups → teams → the card's own
// parts → people, in the card's order. See src/lib/org-chart-roster.ts.

const n = (id: number, name: string, reports: RosterNode[] = []): RosterNode => ({ id, name, title: null, active: true, reports });
const names = (people: { name: string }[]) => people.map((p) => p.name);

test("a tree is listed as the card draws it: each person, then the people under them", () => {
  const flat = flattenTree([n(1, "Head", [n(2, "Zed", [n(5, "Ann")]), n(3, "Bob"), n(4, "Cal", [n(6, "Dee")])])]);
  assert.deepEqual(names(flat), ["Head", "Zed", "Ann", "Bob", "Cal", "Dee"]);
  assert.deepEqual(flat.map((p) => p.level), [0, 1, 2, 1, 1, 2]);
});

test("a team keeps the card's parts in order: the tree, then set by hand, then contractors", () => {
  const [g] = buildRoster([
    {
      key: "execution",
      title: "Execution",
      teams: [
        {
          title: "Mechanical engineering",
          sections: [
            { label: null, nodes: [n(1, "Amy", [n(2, "Ben")])] },
            { label: "Team set by hand", nodes: [] },
            { label: "Contractors", nodes: [n(3, "Cy")] },
          ],
        },
      ],
    },
  ]);
  const t = g.teams[0];
  assert.deepEqual(t.sections.map((s) => s.label), [null, "Contractors"]); // the empty part is dropped
  assert.deepEqual(names(t.sections[0].people), ["Amy", "Ben"]);
  assert.equal(t.count, 3);
});

test("a team on two cards is one entry: the cards one after the other, part by part", () => {
  const card = (tree: RosterNode[], temps: RosterNode[]) => ({
    title: "Mechanical engineering",
    sections: [
      { label: null, nodes: tree },
      { label: "Team set by hand", nodes: [] },
      { label: "Contractors", nodes: temps },
    ],
  });
  const [g] = buildRoster([
    {
      key: "execution",
      title: "Execution",
      teams: [card([n(1, "Amy", [n(2, "Ben")])], [n(5, "Tem")]), { title: "Controls", sections: [{ label: null, nodes: [n(9, "Cy")] }] }, card([n(3, "Al")], [])],
    },
  ]);
  assert.deepEqual(g.teams.map((t) => t.title), ["Mechanical engineering", "Controls"]);
  assert.deepEqual(g.teams[0].sections.map((s) => [s.label, names(s.people)]), [
    [null, ["Amy", "Ben", "Al"]],
    ["Contractors", ["Tem"]],
  ]);
  assert.equal(g.count, 5);
});

test("a search keeps only its matches, at their depth, and drops what is left empty", () => {
  const roster = buildRoster(
    [
      { key: "growth", title: "Growth", teams: [{ title: "Sales", sections: [{ label: null, nodes: [n(1, "Sam", [n(2, "Sue")])] }] }] },
      { key: "support", title: "Support", teams: [{ title: "Finance", sections: [{ label: null, nodes: [n(3, "Fay")] }] }] },
    ],
    (id) => id === 2,
  );
  assert.deepEqual(roster.map((g) => g.key), ["growth"]);
  assert.deepEqual(roster[0].teams[0].sections[0].people.map((p) => [p.name, p.level]), [["Sue", 1]]);
  assert.equal(roster[0].count, 1);
});

test("someone drawn twice in a team is listed once, where they first appear", () => {
  const shared = n(2, "Twice");
  const [g] = buildRoster([
    {
      key: "x",
      title: "X",
      teams: [{ title: "T", sections: [{ label: null, nodes: [n(1, "Lead", [shared])] }, { label: "Contractors", nodes: [shared] }] }],
    },
  ]);
  assert.deepEqual(g.teams[0].sections.map((s) => [s.label, names(s.people)]), [[null, ["Lead", "Twice"]]]);
});
