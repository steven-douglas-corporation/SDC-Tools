import { test } from "node:test";
import assert from "node:assert/strict";
import { filterOrgNodes, countOrgNodes } from "../src/lib/org-chart-search";
import { rowMatchesSearch } from "../src/lib/employee-row";
import type { OrgNode } from "../src/lib/org-chart";

// The Org chart's search (2026-10-08): a match keeps the managers above it.

const node = (id: number, reports: OrgNode[] = []): OrgNode =>
  ({ id, name: `P${id}`, title: null, positionCode: null, active: true, team: null, note: null, override: false, byHand: false, isHead: reports.length > 0, reports });

//   1
//   ├─ 2
//   │  └─ 4
//   └─ 3
const TREE = [node(1, [node(2, [node(4)]), node(3)])];
const ids = (ns: OrgNode[]): number[] => ns.flatMap((n) => [n.id, ...ids(n.reports)]);

test("a match keeps the managers above it, and drops what doesn't lead to one", () => {
  assert.deepEqual(ids(filterOrgNodes(TREE, (id) => id === 4)), [1, 2, 4], "3 is neither a match nor above one");
  assert.deepEqual(ids(filterOrgNodes(TREE, (id) => id === 3)), [1, 3]);
});

test("a matching manager does not bring their whole team with them", () => {
  assert.deepEqual(ids(filterOrgNodes(TREE, (id) => id === 2)), [1, 2], "4 reports to 2 but does not match");
});

test("no match leaves nothing; every match leaves everything; the input is untouched", () => {
  assert.deepEqual(filterOrgNodes(TREE, () => false), []);
  assert.deepEqual(ids(filterOrgNodes(TREE, () => true)), [1, 2, 4, 3]);
  assert.deepEqual(ids(TREE), [1, 2, 4, 3]);
});

test("countOrgNodes counts managers and all", () => {
  assert.equal(countOrgNodes(TREE), 4);
  assert.equal(countOrgNodes(filterOrgNodes(TREE, (id) => id === 4)), 3);
  assert.equal(countOrgNodes([]), 0);
});

const row = { name: "Jane Doe", discipline: "Mechanical Engineers", positionTitle: "Senior Engineer", supervisor: "Pat Boss", department: "Mechanical Engineering" };

test("rowMatchesSearch: the Cards view's fields, case-insensitive, blank matches everyone", () => {
  for (const q of ["jane", "MECHANICAL", "senior", "pat b", "engineering"]) assert.equal(rowMatchesSearch(row, q), true, q);
  assert.equal(rowMatchesSearch(row, "controls"), false);
  assert.equal(rowMatchesSearch(row, ""), true);
  assert.equal(rowMatchesSearch(row, "   "), true);
  assert.equal(rowMatchesSearch({ ...row, department: null }, "mechanical"), true, "still matches on discipline");
  assert.equal(rowMatchesSearch({ ...row, department: undefined }, "zzz"), false, "a missing department is not a crash");
});
