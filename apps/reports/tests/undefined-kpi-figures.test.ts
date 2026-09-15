import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { undefinedKpiFigures } from "../src/lib/unattributed-hours";
import { aggregateUndefined, type RejectionLike } from "../src/lib/undefined-hours-rules";

// ── One Undefined Hours figure per file version (2026-09-14) ─────────────────
//
// PaylocityImport.undefinedHours (written at import time) summed every counted
// rejection; the ETC page's KPI card applied roundedHoursVisible, which drops a punch
// whose hours round to 0. The refresh panel and the ETC page therefore disagreed by
// exactly the sub-half-hour punches. Both now go through undefinedKpiFigures.

const row = (over: Partial<RejectionLike> = {}): RejectionLike => ({
  reason: "JOB_NOT_FOUND",
  countsTowardKpi: true,
  month: "2026-07",
  label: "Not Defined",
  hours: 8,
  ...over,
});

test("a punch whose hours round to 0 is out of the hours AND out of the entry count", () => {
  const figures = undefinedKpiFigures([row({ hours: 8 }), row({ hours: 0.25 }), row({ hours: -0.4 }), row({ hours: 0.5 })]);
  // 0.5 rounds to 1 (Math.round) and stays; 0.25 and -0.4 round to 0 and go.
  assert.equal(figures.hours, 8.5);
  assert.equal(figures.entries, 2);
});

test("the naive all-rows sum the import record used to store is the disagreement this closes", () => {
  const rows = [row({ hours: 8 }), row({ hours: 0.25 }), row({ hours: 0.3 })];
  const naive = aggregateUndefined(rows).reduce((s, i) => s + i.hours, 0);
  const shared = undefinedKpiFigures(rows).hours;
  assert.equal(naive, 8.55);
  assert.equal(shared, 8);
  assert.notEqual(naive, shared, "if these agree the test data no longer exercises the rule");
});

test("rows outside the KPI's definition never count, visible or not", () => {
  const figures = undefinedKpiFigures([
    row({ reason: "UNSUPPORTED_CATEGORY", countsTowardKpi: false, hours: 40 }),
    row({ reason: "JOB_NOT_FOUND", countsTowardKpi: false, hours: 6 }), // in-scope reason, but would not have reached the grid
    row({ hours: 2 }),
  ]);
  assert.equal(figures.hours, 2);
  assert.equal(figures.entries, 1);
});

test("issues are the per-month/label groups the card lists, over the same visible rows", () => {
  const figures = undefinedKpiFigures([row({ label: "Not Defined", hours: 3 }), row({ label: "2026", hours: 0.1 }), row({ label: "Not Defined", hours: 4 })]);
  assert.deepEqual(figures.issues, [{ month: "2026-07", label: "Not Defined", rows: 2, hours: 7 }]);
});

// ── Wiring ───────────────────────────────────────────────────────────────────

test("the import record's figure comes from undefinedKpiFigures, not its own sum", () => {
  const src = readFileSync(join(process.cwd(), "src", "lib", "paylocity-import.ts"), "utf8");
  assert.match(src, /import \{ undefinedKpiFigures \} from "@\/lib\/unattributed-hours"/);
  assert.match(src, /const kpi = undefinedKpiFigures\(rounded\)/);
  assert.match(src, /const kpiHours = kpi\.hours/);
  assert.match(src, /const kpiRows = kpi\.entries/);
  assert.doesNotMatch(src, /issues\.reduce\(\(s, i\) => s \+ i\.hours, 0\)/, "the old all-rows sum must be gone");
});

test("the card reads the same function", () => {
  const src = readFileSync(join(process.cwd(), "src", "lib", "unattributed-hours.ts"), "utf8");
  const fn = src.slice(src.indexOf("export async function getUndefinedHoursTotals"), src.indexOf("export type UndefinedKpiFigures"));
  assert.match(fn, /return undefinedKpiFigures\(/);
});
