import { test } from "node:test";
import assert from "node:assert/strict";
import { cardStats } from "../src/lib/card-stats";

// The stat block on a department card (2026-10-08). See src/lib/card-stats.ts.
const fmt = (n: number) => n.toLocaleString("en-US");

test("no openings: one row, drawn as a single line", () => {
  const s = cardStats({ active: 21, hiringOpenings: 0, currentHours: 43680, hiringHours: 0 }, fmt);
  assert.equal(s.table, false);
  assert.deepEqual(s.rows, [{ key: "current", label: "Current", people: "21", hours: "43,680" }]);
});

test("with openings: current, hiring and planned, as a table", () => {
  const s = cardStats({ active: 21, hiringOpenings: 2, currentHours: 43680, hiringHours: 4160 }, fmt);
  assert.equal(s.table, true);
  assert.deepEqual(s.rows.map((r) => [r.label, r.people, r.hours]), [
    ["Current", "21", "43,680"],
    ["+ Hiring", "+2", "+4,160"],
    ["Planned", "23", "47,840"],
  ]);
});

test("without a capacity policy there is no hours column, with or without openings", () => {
  assert.deepEqual(cardStats({ active: 5, hiringOpenings: 0, currentHours: null, hiringHours: 0 }, fmt).rows.map((r) => r.hours), [null]);
  const hiring = cardStats({ active: 5, hiringOpenings: 1, currentHours: null, hiringHours: 999 }, fmt);
  assert.deepEqual(hiring.rows.map((r) => [r.people, r.hours]), [["5", null], ["+1", null], ["6", null]], "hiring hours are ignored when the year has no policy");
});

test("inactive people are a separate count that never enters the numbers", () => {
  const s = cardStats({ active: 21, inactive: 3, hiringOpenings: 2, currentHours: 43680, hiringHours: 4160 }, fmt);
  assert.equal(s.inactive, 3);
  assert.equal(s.rows[2].people, "23", "planned is active + openings only");
  assert.equal(cardStats({ active: 1, hiringOpenings: 0, currentHours: 0, hiringHours: 0 }, fmt).inactive, 0);
  assert.equal(cardStats({ active: 1, inactive: -2, hiringOpenings: 0, currentHours: 0, hiringHours: 0 }, fmt).inactive, 0, "never negative");
});

test("an empty card still reads as zero, not blank", () => {
  const s = cardStats({ active: 0, hiringOpenings: 0, currentHours: 0, hiringHours: 0 }, fmt);
  assert.deepEqual(s.rows[0], { key: "current", label: "Current", people: "0", hours: "0" });
});
