import { test } from "node:test";
import assert from "node:assert/strict";
import { abbreviateLabel } from "../src/lib/abbrev";
import { SECTIONS } from "../src/lib/sections";

// globals.css refuses to break a word inside a label — "the fix is always a wider
// column, a shorter label or a smaller font, never a broken word" — so a section
// name with a word too long for the Projects grid's 72px column overflows into its
// neighbour. That is what happened to HMI/Robot/Vision/Device Programming.
//
// These tests pin the "shorter label" side of that contract: no section name may
// contain a word longer than the longest one the column width was measured
// against.

// The measurement basis, from the DATA_COL comment in quoted/page.tsx: "SOFTWARE"
// is the longest header word the 4.7rem/72px content box was sized for.
const LONGEST_MEASURED_WORD = "SOFTWARE".length; // 8

test("Programming is abbreviated — the reported overflow", () => {
  assert.equal(abbreviateLabel("HMI Programming"), "HMI Prog");
  assert.equal(abbreviateLabel("Robot Programming"), "Robot Prog");
  assert.equal(abbreviateLabel("Vision Programming"), "Vision Prog");
  assert.equal(abbreviateLabel("Device Programming"), "Device Prog");
});

test("no abbreviated section name contains a word wider than the column was measured for", () => {
  const offenders: string[] = [];
  for (const s of SECTIONS) {
    for (const word of abbreviateLabel(s.name).split(/[\s&]+/).filter(Boolean)) {
      if (word.length > LONGEST_MEASURED_WORD) offenders.push(`${s.code} "${s.name}" -> "${word}" (${word.length} chars)`);
    }
  }
  assert.deepEqual(offenders, [], "a word this long cannot break and will overflow its column");
});

test("the raw names still contain the long word — abbreviation is display-only", () => {
  // The point of doing this at render time: logic keys, filter params and colour
  // maps all still see the full string.
  const raw = SECTIONS.map((s) => s.name);
  assert.ok(raw.some((n) => /Programming/.test(n)), "SECTIONS itself must be untouched");
});

test("existing abbreviations still hold", () => {
  assert.equal(abbreviateLabel("General Engineering"), "Gen Eng");
  assert.equal(abbreviateLabel("Mechanical Build"), "Mech Build");
  assert.equal(abbreviateLabel("Electrical Build"), "Elec Build");
  assert.equal(abbreviateLabel("General"), "Gen");
  assert.equal(abbreviateLabel("Shop"), "Shop", "a word with no rule is left alone");
});

test("abbreviation only fires on whole words", () => {
  // "Programmingly" is not a word anyone will use, but the \b guard is what stops
  // a rule chewing into the middle of an unrelated one.
  assert.equal(abbreviateLabel("Reprogramming"), "Reprogramming");
  assert.equal(abbreviateLabel("Generalist"), "Generalist");
});
