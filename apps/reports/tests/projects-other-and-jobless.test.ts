import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SECTIONS, PARTS_COST_SECTION, mapPunchToColumns, otherActualHours } from "../src/lib/sections";
import { JOBLESS_REASONS, SNAPSHOT_THROUGH_MONTH, supersededBySnapshot } from "../src/lib/actual-hours";

const code = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), "utf8");

// ── The migration snapshot already contains January 2025 (2026-09-28) ───────
//
// `Hours Through 20250131.xlsx` totals every job through 2025-01-31, and the punch
// feed starts 2025-01-06. Measured in production: 37 jobs with a snapshot carried
// 5,618.35h of January punches that were being counted a second time; 9 jobs with
// no snapshot carried 799.14h that exist nowhere else.

test("a job's January 2025 punches are dropped only when it has a snapshot", () => {
  assert.equal(SNAPSHOT_THROUGH_MONTH, "2025-01");
  // Job 1105: 8.89h in January, snapshot 8.89h — the snapshot IS January.
  assert.equal(supersededBySnapshot("2025-01", true), true);
  // Job 6000 (Bellco Feeders): no snapshot, so its January punches are all there is.
  assert.equal(supersededBySnapshot("2025-01", false), false);
  // Anything after the snapshot's end is never inside it.
  assert.equal(supersededBySnapshot("2025-02", true), false);
  // And anything before it is, when the job has one.
  assert.equal(supersededBySnapshot("2024-11", true), true);
});

test("every era-2 and era-3 read applies the snapshot rule", () => {
  // Two per reader in actual-hours.ts (the cumulative figure and its timeline), one
  // for each Hours-export frozen-month query, and both reads in Job Cost Explorer. A
  // reader without it double-counts January again.
  const actual = code("src", "lib", "actual-hours.ts");
  assert.equal((actual.match(/AND: \[OUTSIDE_SNAPSHOT\]/g) ?? []).length, 6);
  const jobCost = code("src", "lib", "job-cost-source.ts");
  assert.equal((jobCost.match(/AND: \[OUTSIDE_SNAPSHOT\]/g) ?? []).length, 2);
});

// ── Other / unmapped ────────────────────────────────────────────────────────

test("Other counts only codes with no grid column", () => {
  const bySection = new Map<string, number>([
    ["10-211", 100], // a real column — not other
    ["70-211", 40], // permission-gated, but still a column — not other
    ["80-311", 25.5],
    ["90-211", 4.5],
    [PARTS_COST_SECTION, 99_999], // dollars, never hours
  ]);
  const other = otherActualHours(bySection);
  assert.equal(other.total, 30);
  assert.deepEqual(other.codes, [
    { code: "80-311", hours: 25.5 },
    { code: "90-211", hours: 4.5 },
  ]);
});

test("Other plus the section columns adds back up to every folded punch", () => {
  // Codes from UNMAPPED-HOURS.md plus ones that do fold. Nothing may fall between.
  const punches: [string, number][] = [["10-211", 10], ["40-311", 7], ["10-311", 5], ["80-311", 3], ["10-400", 2], ["70-414", 1]];
  const bySection = new Map<string, number>();
  for (const [raw, hours] of punches) {
    for (const col of mapPunchToColumns(raw, hours)) bySection.set(col.section, (bySection.get(col.section) ?? 0) + col.hours);
  }
  const inColumns = SECTIONS.reduce((s, sec) => s + (bySection.get(sec.code) ?? 0), 0);
  const total = punches.reduce((s, [, h]) => s + h, 0);
  assert.ok(Math.abs(inColumns + otherActualHours(bySection).total - total) < 1e-9);
});

// ── No Job ID ───────────────────────────────────────────────────────────────

test("the No Job ID row takes only the two job-number reasons", () => {
  // Both are raised after the year-ownership gate, so an overlapping workbook
  // cannot put a punch in twice. Control totals, zero-hour rows and the pre-gate
  // reasons stay out.
  assert.deepEqual([...JOBLESS_REASONS].sort(), ["JOB_NOT_FOUND", "MISSING_JOB_ID"]);
  const reader = code("src", "lib", "paylocity-workbook.ts");
  const gate = reader.indexOf("if (ownsYear && !ownsYear(");
  assert.ok(gate > 0);
  for (const reason of JOBLESS_REASONS) {
    const first = reader.indexOf(`reject("${reason}"`);
    assert.ok(first > gate, `${reason} is raised before the year gate`);
  }
});

// ── The grid stays column-aligned ───────────────────────────────────────────

test("the Other column is counted and present in every kind of row", () => {
  const page = code("src", "app", "(app)", "quoted", "page.tsx");
  assert.match(page, /\}, 0\) \+ 3;/, "dataColumnCount counts Eng, Shop and Other");
  assert.match(page, /otherActualHours\(actualBySection\)/);
  assert.match(page, /<tfoot className="actuals-only/);
  // Unsaved rows render the same columns, or everything after them shifts.
  assert.match(code("src", "components", "NewProjectRows.tsx"), /className="actuals-only/);
  assert.match(code("src", "app", "globals.css"), /table\[data-grid="projects"\]\.hide-actuals \.actuals-only/);
});
