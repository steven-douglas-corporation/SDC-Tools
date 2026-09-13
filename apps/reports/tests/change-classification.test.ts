import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyChange, describeChange } from "../src/lib/change-log";

// added / edited / removed, decided in one place (§33.9).
//
// This drives the banner's WORDING — "changed New ETC from 60 to 55" vs "removed the
// New ETC value of 60" — so every write path in the app has to classify identically or
// the same kind of edit reads differently depending on which tab it came from. Ten
// call sites now depend on this, which is the reason it is a shared function with a
// test rather than an inline ternary repeated per action.

test("blank to a value is an addition", () => {
  assert.equal(classifyChange(null, "55"), "added");
  assert.equal(classifyChange("", "55"), "added");
});

test("a value to blank is a removal", () => {
  assert.equal(classifyChange("60", null), "removed");
  assert.equal(classifyChange("60", ""), "removed");
});

test("value to value is an edit", () => {
  assert.equal(classifyChange("60", "55"), "edited");
});

test("by default a zero is a real figure, not a blank", () => {
  // This app is deliberately careful about the difference: a New ETC of 0 is a
  // manager stating there is no work left, which is NOT the same as not having
  // answered. Collapsing the two is the bug behind the whole newEtcClearedAt design,
  // so the default must never treat "0" as empty.
  assert.equal(classifyChange("60", "0"), "edited");
  assert.equal(classifyChange(null, "0"), "added");
  assert.equal(classifyChange("0", null), "removed");
});

test("with emptyIsBlank, zero and blank are the same thing", () => {
  // For columns where they genuinely are — Projects quoted hours treats an unquoted
  // section as 0, so clearing such a cell back to zero is a removal.
  assert.equal(classifyChange("60", "0", { emptyIsBlank: true }), "removed");
  assert.equal(classifyChange("0", "60", { emptyIsBlank: true }), "added");
  assert.equal(classifyChange("0", "", { emptyIsBlank: true }), "edited", "blank to blank is not a removal");
});

test("blank to blank is an edit, never a spurious add or remove", () => {
  // Reached when a save writes a field whose value did not really move. The callers
  // filter those out, but the classifier must not invent a removal if one slips
  // through.
  assert.equal(classifyChange(null, null), "edited");
  assert.equal(classifyChange("", null), "edited");
});

// ── The wording the banner actually shows ────────────────────────────────────

test("a removal names the figure that went, because nothing is left on screen to say", () => {
  const line = describeChange(
    {
      tab: "Monthly ETC",
      rowRef: "Job 1165",
      columnName: "New ETC",
      previousValue: "60",
      newValue: null,
      changeType: "removed",
    },
    "Abhi",
  );
  // The requirement's own example: "Abhi removed the New ETC value of 60 for Job 1165".
  assert.match(line, /Abhi removed New ETC value 60 for Job 1165/);
});

test("an edit reads as a from/to, matching the requirement's example", () => {
  const line = describeChange(
    {
      tab: "Monthly ETC",
      rowRef: "Job 1165",
      columnName: "New ETC",
      previousValue: "60",
      newValue: "55",
      changeType: "edited",
    },
    "Abhi",
  );
  assert.match(line, /Abhi changed New ETC from 60 to 55 for Job 1165/);
});

test("a blank side is spelled out rather than left as an empty gap", () => {
  const line = describeChange(
    {
      tab: "Projects",
      rowRef: "Job 1105",
      columnName: "Customer",
      previousValue: null,
      newValue: "FIRST SOLAR, INC.",
      changeType: "added",
    },
    "Abhi",
  );
  assert.match(line, /set Customer to FIRST SOLAR, INC\./);
});

test("a refused write is described as refused, with the value that actually stands", () => {
  // recordChanges records rejected writes too, and the reader needs to know their
  // change did NOT win — see §33.4.
  const line = describeChange(
    {
      tab: "Projects",
      rowRef: "Job 1165",
      columnName: "Design & Drawings Quoted Hours",
      previousValue: "40",
      newValue: "72",
      changeType: "rejected",
    },
    "Abhi",
  );
  assert.match(line, /was refused/);
  assert.match(line, /it is now 72/);
});
