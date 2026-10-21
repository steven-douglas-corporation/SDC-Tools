import test from "node:test";
import assert from "node:assert/strict";
import {
  changedYears,
  evaluateRateDraft,
  parseDefaultDraft,
  parseYearDraft,
  toDefaultDraft,
  toYearDraft,
} from "../src/lib/job-cost-rate-draft";

const SAVED = { engRate: 140, shopRate: 113, pmPct: 3.1, mfgPct: 3 };
const SAVED_YEARS = { "2025": { engRate: 140, shopRate: 113, pmPct: 3.1, mfgPct: 3 }, "2018": { engRate: 25 } };

const fresh = () => ({ d: toDefaultDraft(SAVED), y: toYearDraft(SAVED_YEARS) });

test("an untouched draft is not dirty and is valid", () => {
  const { d, y } = fresh();
  const s = evaluateRateDraft(SAVED, SAVED_YEARS, d, y);
  assert.equal(s.dirty, false);
  assert.equal(s.valid, true);
  assert.deepEqual(s.years, []);
});

test("changing a default marks the draft dirty, and typing it back un-dirties it", () => {
  const { d, y } = fresh();
  d.engRate = "150";
  assert.equal(evaluateRateDraft(SAVED, SAVED_YEARS, d, y).dirty, true);
  d.engRate = "140";
  assert.equal(evaluateRateDraft(SAVED, SAVED_YEARS, d, y).dirty, false);
  d.engRate = "140.0"; // same number, different text
  assert.equal(evaluateRateDraft(SAVED, SAVED_YEARS, d, y).dirty, false);
});

test("a changed year cell is dirty and names exactly the years to write", () => {
  const { d, y } = fresh();
  y["2025"] = { ...y["2025"], shopRate: "120" };
  y["2024"] = { pmPct: "4" };
  const s = evaluateRateDraft(SAVED, SAVED_YEARS, d, y);
  assert.equal(s.dirty, true);
  assert.deepEqual(s.years, ["2024", "2025"]);
});

test("clearing every cell of a year removes its override (the year is written so the row is deleted)", () => {
  const { d, y } = fresh();
  y["2018"] = { engRate: "" };
  const s = evaluateRateDraft(SAVED, SAVED_YEARS, d, y);
  assert.deepEqual(s.years, ["2018"]);
  assert.equal(s.overrides["2018"], undefined);
});

test("a blank year cell is 'use the default', not zero", () => {
  const { overrides } = parseYearDraft({ "2026": { engRate: "", shopRate: "120" } });
  assert.deepEqual(overrides, { "2026": { shopRate: 120 } });
});

test("a blank, non-numeric or negative default is invalid and cannot be confirmed", () => {
  for (const bad of ["", "abc", "-5"]) {
    const { d, y } = fresh();
    d.pmPct = bad;
    const s = evaluateRateDraft(SAVED, SAVED_YEARS, d, y);
    assert.equal(s.valid, false, `pmPct=${JSON.stringify(bad)}`);
    assert.equal(s.dirty, true);
    assert.equal(parseDefaultDraft(d), null);
  }
});

test("a negative year cell is invalid; zero is allowed", () => {
  const { d, y } = fresh();
  y["2025"] = { ...y["2025"], mfgPct: "-1" };
  assert.equal(evaluateRateDraft(SAVED, SAVED_YEARS, d, y).valid, false);
  y["2025"] = { ...y["2025"], mfgPct: "0" };
  const s = evaluateRateDraft(SAVED, SAVED_YEARS, d, y);
  assert.equal(s.valid, true);
  assert.equal(s.overrides["2025"].mfgPct, 0);
});

test("changedYears compares field by field and treats a missing field as blank", () => {
  assert.deepEqual(changedYears({ "2025": { engRate: 1 } }, { "2025": { engRate: 1 } }), []);
  assert.deepEqual(changedYears({ "2025": { engRate: 1 } }, { "2025": { engRate: 1, shopRate: 2 } }), ["2025"]);
  assert.deepEqual(changedYears({}, { "2030": { engRate: 9 } }), ["2030"]);
});

test("the matrix modal never writes on its own: Confirm is the only call, and Clear all is gone", async () => {
  const { readFileSync } = await import("node:fs");
  const modal = readFileSync(new URL("../src/components/JobCostRateMatrixModal.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(modal, /onBlur/);
  assert.doesNotMatch(modal, /Clear all/);
  assert.match(modal, /Confirm/);
  assert.match(modal, /beforeunload/);
  const explorer = readFileSync(new URL("../src/components/JobCostExplorer.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(explorer, /clearAllYearRateOverrides/);
  assert.match(explorer, /disabled=\{!ratesEditing\}/);
});
