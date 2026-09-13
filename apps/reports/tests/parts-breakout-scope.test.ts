import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PARTS_BREAKOUT_FIRST_MONTH, showsPartsBreakout } from "../src/lib/parts-breakout-scope";

test("August 2026 is where the columns start", () => {
  assert.equal(PARTS_BREAKOUT_FIRST_MONTH, "2026-08");
  assert.equal(showsPartsBreakout("2026-08"), true, "the first month itself is included");
});

test("no earlier month gets the columns", () => {
  // Every closed month has NULL in both fields — nothing backfills them — so showing
  // the columns there would be two rows of dashes beside a New ETC that was in fact
  // submitted, which reads as data loss.
  for (const m of ["2026-07", "2026-01", "2025-12", "2024-06", "1999-01"]) {
    assert.equal(showsPartsBreakout(m), false, `${m} must not show the breakout`);
  }
});

test("every later month gets them", () => {
  for (const m of ["2026-09", "2026-10", "2026-12", "2027-01", "2030-05"]) {
    assert.equal(showsPartsBreakout(m), true, `${m} should show the breakout`);
  }
});

test("the year boundary is not a string-sort accident", () => {
  // The comparison is lexicographic on `YYYY-MM`, which is only sound because the
  // month is zero-padded and the year is four digits. December -> January is the pair
  // that would expose a bad comparison.
  assert.equal(showsPartsBreakout("2026-12"), true);
  assert.equal(showsPartsBreakout("2027-01"), true);
  assert.equal(showsPartsBreakout("2025-12"), false);
});

test("a month string we cannot parse falls back to the old layout", () => {
  for (const m of [null, undefined, "", "2026", "2026-8", "2026-13", "2026-00", "August", "2026-08-01", " 2026-08"]) {
    assert.equal(showsPartsBreakout(m as string | null | undefined), false, `${JSON.stringify(m)} should be refused`);
  }
});

// ── The rule has exactly one home ──────────────────────────────────────────
//
// The columns touch the header colSpans, the body cells, the totals row and the
// footer's colSpan. Each of those has to agree, and a hand-copied `month >= "2026-08"`
// in any one of them is how a header ends up one cell wider than its body.

test("the ETC page asks this module rather than comparing months itself", () => {
  const src = readFileSync(join(process.cwd(), "src", "app", "(app)", "etc", "page.tsx"), "utf8");
  assert.ok(src.includes("showsPartsBreakout"), "the page must go through the shared predicate");
  const inlined = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .match(/month\s*[<>]=?\s*"20\d\d-\d\d"/g);
  assert.deepEqual(inlined, null, `the page compares a month to a literal itself: ${inlined?.join(", ")}`);
});

// The cell-count guard for these columns already exists and is better placed:
// tests/parts-cost-risk.test.ts owns the Parts Cost row shape and now checks the
// five-column pre-August width there, beside the seven-column one. Duplicating it here
// would give one rule two homes that could disagree.

test("the header, the totals row and the footer all size off the derived list", () => {
  const src = readFileSync(join(process.cwd(), "src", "app", "(app)", "etc", "page.tsx"), "utf8");
  // The full constant may be referenced ONLY where the derived list is built (its own
  // definition, plus the two arms of that ternary). Anywhere else is a colSpan or a map
  // that will not shrink before August, which is how a header and its body disagree.
  const stray = src.match(/PARTS_COST_SUB_COLUMNS/g) ?? [];
  assert.equal(stray.length, 4, `PARTS_COST_SUB_COLUMNS should appear only in its definition and derivation, found ${stray.length}`);
  assert.ok(/colSpan=\{partsCostCols\.length\}/.test(src), "the header spans must follow the derived list");
  assert.ok(/\+ partsCostCols\.length/.test(src), "the footer colSpan must follow it too");
  assert.ok(/partsCostCols\.map\(/.test(src), "the header cells and the no-entry row must map the derived list");
});

test("the upstream call is skipped on a month that cannot show the result", () => {
  // Left to Invoice is seeded from Total ETO and is the ONLY upstream call the Monthly
  // ETC page makes (~3s across 49 jobs). Spending it on a month with nowhere to render
  // it would be a pure regression on every closed month.
  const src = readFileSync(join(process.cwd(), "src", "app", "(app)", "etc", "page.tsx"), "utf8");
  assert.match(src, /showBreakout[\s\S]{0,40}\?[\s\S]{0,120}readPartsEtcBreakout\(/);
});
