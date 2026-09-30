import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SECTIONS, PARTS_COST_SECTION, isServiceOrSparePartsCode, mapPunchToColumns, offGridActualHours } from "../src/lib/sections";
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
  // for each Hours-export frozen-month query, the Hours page's "by source" frozen
  // read, and both reads in Job Cost Explorer. A reader without it double-counts
  // January again. (loadHoursBySource's two PUNCH reads are deliberately unfiltered:
  // one is the table's own total, the other is the overlap it then leaves out —
  // see lib/hours-by-source.ts and tests/hours-by-source.test.ts.)
  const actual = code("src", "lib", "actual-hours.ts");
  assert.equal((actual.match(/AND: \[OUTSIDE_SNAPSHOT\]/g) ?? []).length, 7);
  const jobCost = code("src", "lib", "job-cost-source.ts");
  assert.equal((jobCost.match(/AND: \[OUTSIDE_SNAPSHOT\]/g) ?? []).length, 2);
});

// ── Other / unmapped ────────────────────────────────────────────────────────

test("off-grid hours split into Service & Spare Parts and Unmapped, and nothing else", () => {
  const bySection = new Map<string, number>([
    ["10-211", 100], // a real column — in neither bucket
    ["70-211", 40], // permission-gated, but still a column — in neither bucket
    ["80-311", 25.5],
    ["80-312", 3], // not in SERVICE_AND_SPARE_PARTS_CODES, still Service by its phase
    ["90-211", 4.5],
    ["10-400", 8],
    ["1-312", 2], // malformed — unknown, not Service
    [PARTS_COST_SECTION, 99_999], // dollars, never hours
  ]);
  const { service, unmapped } = offGridActualHours(bySection);
  assert.equal(service.total, 33);
  assert.deepEqual(service.codes.map((c) => c.code), ["80-311", "90-211", "80-312"]);
  assert.equal(unmapped.total, 10);
  assert.deepEqual(unmapped.codes.map((c) => c.code), ["10-400", "1-312"]);
});

test("Service & Spare Parts is decided by the 80/90 phase prefix only", () => {
  for (const c of ["80-211", "80-312", "90-414", "80-999"]) assert.equal(isServiceOrSparePartsCode(c), true, c);
  // 180-211 and 8-211 are not phase 80; 10-800 is not either.
  for (const c of ["180-211", "8-211", "10-800", "Not Defined-311", "70-414"]) assert.equal(isServiceOrSparePartsCode(c), false, c);
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
  const { service, unmapped } = offGridActualHours(bySection);
  assert.ok(Math.abs(inColumns + service.total + unmapped.total - total) < 1e-9);
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

test("the two off-grid columns are counted and present in every kind of row", () => {
  const page = code("src", "app", "(app)", "quoted", "page.tsx");
  assert.match(page, /\}, 0\) \+ 4;/, "dataColumnCount counts Eng, Shop, Service & Spare Parts and Unmapped");
  assert.match(page, /\{offGridCells\(actualBySection\)\}/);
  assert.match(page, /\{offGridCells\(row\.bySection\)\}/);
  assert.match(page, /<tfoot className="actuals-only/);
  // Unsaved rows render the same columns, or everything after them shifts.
  const newRows = code("src", "components", "NewProjectRows.tsx");
  assert.equal((newRows.match(/className="actuals-only/g) ?? []).length, 2, "one cell per off-grid column");
  assert.match(code("src", "app", "globals.css"), /table\[data-grid="projects"\]\.hide-actuals \.actuals-only/);
});

// ── The No Job ID switch ────────────────────────────────────────────────────

test("No Job ID is shown unless the param says 0", async () => {
  const { JOBLESS_PARAM, isJoblessShown } = await import("../src/lib/quoted-display-prefs");
  const p = new URLSearchParams();
  assert.equal(isJoblessShown(p), true, "absent = shown");
  p.set(JOBLESS_PARAM, "0");
  assert.equal(isJoblessShown(p), false);
  p.set(JOBLESS_PARAM, "1");
  assert.equal(isJoblessShown(p), true);
});

test("hiding No Job ID swaps the Total for the one without it", () => {
  const page = code("src", "app", "(app)", "quoted", "page.tsx");
  // Both Totals are rendered; CSS picks one, so the switch needs no server render.
  assert.match(page, /key: "total-with-jobless"/);
  assert.match(page, /key: "total-without-jobless"/);
  assert.match(page, /showJobless \? "" : "hide-jobless"/);
  assert.match(page, /<ProjectsShowJoblessSwitch \/>/);
  const css = code("src", "app", "globals.css");
  assert.match(css, /\.hide-jobless \.jobless-row/);
  assert.match(css, /\.hide-jobless \.total-with-jobless/);
  assert.match(css, /:not\(\.hide-jobless\) \.total-without-jobless/);
  // Saved views and split view carry it like any other view param.
  assert.match(code("src", "components", "ProjectViewsMenu.tsx"), /"actuals", "jobless"\]/);
  assert.match(code("src", "lib", "split-view.ts"), /"jobless",/);
});
