import { test } from "node:test";
import assert from "node:assert/strict";
import { applyNavOrder, moveItem, NO_NAV_ORDER } from "../src/lib/nav-order";

const PLANNING = [{ href: "/quoted" }, { href: "/etc" }, { href: "/job-hours" }];

test("no stored order leaves the built-in order untouched", () => {
  assert.deepEqual(applyNavOrder("Planning", PLANNING, NO_NAV_ORDER), PLANNING);
  assert.deepEqual(applyNavOrder("Planning", PLANNING, { Planning: [] }), PLANNING);
});

test("a stored order is applied", () => {
  const out = applyNavOrder("Planning", PLANNING, { Planning: ["/job-hours", "/quoted", "/etc"] });
  assert.deepEqual(out.map((i) => i.href), ["/job-hours", "/quoted", "/etc"]);
});

test("an item missing from the stored order is APPENDED, never dropped", () => {
  // The case that matters on the next release: someone reordered months ago, a new
  // nav item ships. Losing a link outright would be far worse than showing it last.
  const withNew = [...PLANNING, { href: "/reports" }];
  const out = applyNavOrder("Planning", withNew, { Planning: ["/etc", "/quoted", "/job-hours"] });
  assert.deepEqual(out.map((i) => i.href), ["/etc", "/quoted", "/job-hours", "/reports"]);
});

test("a stored href that no longer exists is skipped, not a hole", () => {
  const out = applyNavOrder("Planning", PLANNING, { Planning: ["/etc", "/deleted-page", "/quoted", "/job-hours"] });
  assert.deepEqual(out.map((i) => i.href), ["/etc", "/quoted", "/job-hours"]);
});

test("another group's order doesn't affect this one", () => {
  assert.deepEqual(applyNavOrder("Planning", PLANNING, { Work: ["/employees"] }), PLANNING);
});

test("moveItem: down, up, and no-ops", () => {
  assert.deepEqual(moveItem(PLANNING, 0, 2), ["/etc", "/job-hours", "/quoted"]);
  assert.deepEqual(moveItem(PLANNING, 2, 0), ["/job-hours", "/quoted", "/etc"]);
  assert.deepEqual(moveItem(PLANNING, 1, 1), ["/quoted", "/etc", "/job-hours"]);
});

test("moveItem: out-of-range indexes leave the order alone", () => {
  // Keyboard reorder at the ends hits these every time (Alt+Up on the first item).
  for (const [from, to] of [[0, -1], [2, 3], [-1, 0], [5, 0]] as const) {
    assert.deepEqual(moveItem(PLANNING, from, to), ["/quoted", "/etc", "/job-hours"]);
  }
});
