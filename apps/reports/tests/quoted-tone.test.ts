import { test } from "node:test";
import assert from "node:assert/strict";
import { quotedCellTone, TONE_OVER, TONE_COMPLETE, TONE_UNDER, TONE_CLASSES } from "../src/lib/quoted-tone";

// The Projects grid's over/under tint is decided in two places now — the server
// render in quoted/page.tsx and the live recompute in ProjectsLiveTotals — so the
// rule itself is worth pinning down. A cell that is green on load and yellow after
// a keystroke is the failure this guards.

test("nothing quoted and nothing worked is untinted", () => {
  assert.equal(quotedCellTone({ quoted: 0, actual: 0, jobComplete: false }), "");
  assert.equal(quotedCellTone({ quoted: 0, actual: 0, jobComplete: true }), "");
});

test("actual past quoted reads over, whatever the status", () => {
  assert.equal(quotedCellTone({ quoted: 100, actual: 101, jobComplete: false }), TONE_OVER);
  assert.equal(quotedCellTone({ quoted: 100, actual: 101, jobComplete: true }), TONE_OVER);
  // The case the live recompute exists for: raising the quote past the actual
  // must clear the red rather than leave it until a reload.
  assert.equal(quotedCellTone({ quoted: 200, actual: 101, jobComplete: false }), TONE_UNDER);
});

test("equal is NOT over — exactly on the quote is still under", () => {
  assert.equal(quotedCellTone({ quoted: 100, actual: 100, jobComplete: false }), TONE_UNDER);
  assert.equal(quotedCellTone({ quoted: 100, actual: 100, jobComplete: true }), TONE_COMPLETE);
});

test("a complete job at or under quoted reads complete", () => {
  assert.equal(quotedCellTone({ quoted: 100, actual: 40, jobComplete: true }), TONE_COMPLETE);
  assert.equal(quotedCellTone({ quoted: 100, actual: 40, jobComplete: false }), TONE_UNDER);
});

test("hours worked with nothing quoted still reads over", () => {
  // 0 quoted and any real actual is an overrun, not an empty cell.
  assert.equal(quotedCellTone({ quoted: 0, actual: 5, jobComplete: false }), TONE_OVER);
});

test("quoted with no hours worked yet is not untinted", () => {
  // A quote exists, so the cell has something to say even before any time lands.
  assert.equal(quotedCellTone({ quoted: 40, actual: 0, jobComplete: false }), TONE_UNDER);
});

test("TONE_CLASSES covers every class the rule can return", () => {
  const returned = new Set(
    [
      { quoted: 0, actual: 5, jobComplete: false },
      { quoted: 100, actual: 40, jobComplete: true },
      { quoted: 100, actual: 40, jobComplete: false },
    ].map(quotedCellTone),
  );
  // The removal list in ProjectsLiveTotals strips TONE_CLASSES before applying a
  // new tone; a class the rule can return but the list omits would stack up.
  for (const cls of returned) assert.ok((TONE_CLASSES as readonly string[]).includes(cls), `${cls} missing from TONE_CLASSES`);
});
