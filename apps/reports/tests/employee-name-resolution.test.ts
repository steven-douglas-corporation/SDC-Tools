import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// ── A former employee must still resolve to a name (2026-09-01) ─────────────
//
// Reported as "#100601" and "#100157" showing instead of Denys Biloochenko and
// Brian Mack. Neither had an Employee row at all — they were the only 2 of 81
// distinct punch employee ids in that state — so the fix was data, not code.
//
// What this test guards is the CODE half: every place that turns an employeeId
// into a name joins on Employee.paylocityId, and none of them may filter on
// `active`. The moment one does, every leaver in that view silently reverts to
// a bare id — and their hours can vanish from aggregates too, which is the bug
// department-utilization.ts's own header describes (670 hours dropped from July
// 2026 by exactly this mistake).
//
// A source scan rather than a database test: the rule is "no name lookup filters
// on active", which is a property of the queries themselves, and this file has to
// run under `tsx --test` with no database.

const LIB = join(process.cwd(), "src", "lib");

/** Files that resolve a punch employeeId to a person for DISPLAY. */
const NAME_LOOKUP_FILES = [
  "job-hours-detail.ts",
  "tm-hours.ts",
  "hours-explorer.ts",
  "unattributed-hours.ts",
  "employee-punch-drill.ts",
  "data-quality.ts",
  "data-quality-actions.ts",
  "department-utilization.ts",
];

/** Comments stripped, so prose about "the active slice" cannot look like a filter. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*/g, " ");
}

/**
 * Each `prisma.employee.find...(...)` call, cut at its own matching close paren
 * rather than by a fixed window. The first version took 600 characters and ran
 * straight past the query into the NEXT one, whose comment mentioned "the active
 * slice" — a false positive that would have taught the next reader to distrust
 * this test.
 */
function employeeQueries(source: string): string[] {
  const clean = withoutComments(source);
  const out: string[] = [];
  const re = /prisma\.employee\.find(?:Many|First|Unique)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean)) !== null) {
    let depth = 0;
    let i = m.index + m[0].length - 1; // at the opening paren
    for (; i < clean.length; i++) {
      if (clean[i] === "(") depth++;
      else if (clean[i] === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    out.push(clean.slice(m.index, i + 1));
  }
  return out;
}

test("every employee-name lookup exists and joins on paylocityId", () => {
  for (const file of NAME_LOOKUP_FILES) {
    const source = readFileSync(join(LIB, file), "utf8");
    assert.ok(
      source.includes("paylocityId"),
      `${file} no longer joins on paylocityId — has name resolution moved? This test needs updating with it.`,
    );
  }
});

test("no employee-name lookup filters on `active` — a leaver must still have a name", () => {
  for (const file of NAME_LOOKUP_FILES) {
    const source = readFileSync(join(LIB, file), "utf8");
    for (const q of employeeQueries(source)) {
      if (!/\bactive\b/.test(q)) continue;
      // department-utilization is the one allowed mention, and only in the shape
      // that WIDENS the population rather than narrowing it: active today OR
      // booked hours in the month being reported. Anything else is the bug.
      const widensRatherThanNarrows = /OR:\s*\[\s*\{\s*active:\s*true\s*\}/.test(q);
      assert.ok(
        widensRatherThanNarrows,
        `${file} has an employee lookup mentioning \`active\` that is not the "active OR worked this month" widening form. ` +
          `Filtering name resolution on active makes every former employee display as a bare id.`,
      );
    }
  }
});

test("the employee-name backfill script is present and data-driven", () => {
  // The fix for an unnamed id is a row, added by this script — not a hardcoded
  // map in application code, which would be a second naming path that only some
  // views consulted.
  const script = readFileSync(join(process.cwd(), "scripts", "add-missing-employee-names.ts"), "utf8");
  assert.ok(script.includes("100601") && script.includes("Denys Biloochenko"));
  assert.ok(script.includes("100157") && script.includes("Brian Mack"));
  assert.ok(script.includes("active: false"), "former employees must be created inactive");
  assert.ok(script.includes("canonicalDepartmentFor"), "department must be derived from punched functions, never from the name");
});

test("no lib file hardcodes an employee name against an id", () => {
  // The two ids live in the backfill script and nowhere else. A name appearing in
  // src/lib would mean a lookup table had crept back into application code.
  for (const file of readdirSync(LIB).filter((f) => f.endsWith(".ts"))) {
    const source = readFileSync(join(LIB, file), "utf8");
    for (const name of ["Denys Biloochenko", "Brian Mack"]) {
      assert.ok(!source.includes(name), `${file} hardcodes "${name}" — names belong in the Employee table`);
    }
  }
});
