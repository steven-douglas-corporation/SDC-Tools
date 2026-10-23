import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { drawDownEtc } from "../src/lib/job-cost-etc-drawdown";

// ETC on Profitability is the latest SUBMITTED New ETC drawn down by activity since. The
// rule is the Monthly ETC grid's own (suggestNewEtc), per section and month.

const m = (o: Record<string, number>) => new Map(Object.entries(o));

test("no activity leaves the submitted figure exactly as submitted", () => {
  assert.equal(drawDownEtc(584, undefined), 584);
  assert.equal(drawDownEtc(584, m({})), 584);
  assert.equal(drawDownEtc(584, m({ "2026-10": 0 })), 584);
});

test("job 1130 Electrical Build: 584 submitted, 37.95h worked since -> 546.05 left", () => {
  assert.equal(drawDownEtc(584, m({ "2026-10": 37.95 })), 546.05);
});

test("Parts: $23,941.35 submitted, $7,564.03 invoiced since -> $16,377.32 still to come", () => {
  assert.equal(drawDownEtc(23941.35, m({ "2026-10": 7564.03 })), 16377.32);
});

test("a section is floored at zero — overrun never goes negative and never reaches another section", () => {
  assert.equal(drawDownEtc(10, m({ "2026-10": 25 })), 0);
  // Sections are drawn down independently, so System Design's overrun (ETC 0, 1.5h worked)
  // leaves Machine Testing's 120 alone.
  const sections = [
    { etc: 0, worked: m({ "2026-10": 1.5 }) },
    { etc: 120, worked: undefined },
  ];
  assert.equal(sections.reduce((s, x) => s + drawDownEtc(x.etc, x.worked), 0), 120);
});

test("several months carry forward in order, the way the grid carries New ETC into next month's Prior ETC", () => {
  assert.equal(drawDownEtc(100, m({ "2026-11": 30, "2026-10": 20 })), 50);
  // The floor applies each month: 100 -20 -> 80, -90 -> 0, then 5 more worked stays 0 rather than going negative.
  assert.equal(drawDownEtc(100, m({ "2026-10": 20, "2026-11": 90, "2026-12": 5 })), 0);
});

test("drawing down can only lower an ETC, never raise it", () => {
  for (const start of [0, 0.5, 120, 879]) {
    for (const worked of [0, 1, 38, 5000]) assert.ok(drawDownEtc(start, m({ "2026-10": worked })) <= start);
  }
});

const SRC = join(import.meta.dirname, "..", "src", "lib", "job-cost-source.ts");
const source = readFileSync(SRC, "utf8");

test("only months AFTER the submitted month count, and a historical snapshot stops at its own month", () => {
  const fn = source.slice(source.indexOf("export async function loadEtcActivitySince"));
  assert.match(fn, /const after = \{ gt: etcMonth, \.\.\.\(throughMonth \? \{ lte: throughMonth \} : \{\}\) \}/);
  // All three reads (uncovered-month hours, punches, parts) use that same window.
  assert.equal((fn.match(/\.\.\.after|month: after/g) ?? []).length, 3);
});

test("the draw-down feeds the ETC columns, and parts and both hour buckets all go through it", () => {
  assert.match(source, /loadEtcActivitySince\(jobPks, etcMonth, throughMonth\)\.then\(\(activity\) => getSubmittedEtcSnapshot\(jobPks, etcMonth, activity\)\)/);
  assert.match(source, /etcPartsCost \+= drawDownEtc\(submitted, since\.parts\)/);
  assert.match(source, /etcEngHours \+= drawDownEtc\(submitted, since\.hours\.get\(e\.section\)\)/);
  assert.match(source, /etcShopHours \+= drawDownEtc\(submitted, since\.hours\.get\(e\.section\)\)/);
});
