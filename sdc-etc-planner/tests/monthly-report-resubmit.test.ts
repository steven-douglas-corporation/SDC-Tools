import { test } from "node:test";
import assert from "node:assert/strict";
import { newEtcForSubmission, newEtcSeedText, suggestNewEtc, type NewEtcCellState } from "../src/lib/etc";

// ── Re-submitting a reopened month must not replace what managers typed ──────
//
// 2026-09-11: August 2026 was submitted, reopened and submitted again. The first
// submission consumed every draft; the reopen restored nothing; the second read
// `draft ?? suggestion` and froze the carry-forward over 161 hours cells that had a
// manager's figure in them. These pin the rule that fixed it — the submission freezes
// exactly what the cell shows (newEtcSeedText), rung for rung.

const base = { priorEtc: 148, hoursWorked: 54.5 };

test("a reopened row with no new edit keeps the figure it was confirmed at", () => {
  // 1122 ME & CE: confirmed at 160 by the first submission, no draft after the reopen.
  assert.equal(newEtcForSubmission({ ...base, draft: null, confirmed: 160, cleared: false }), 160);
  // NOT the suggestion (148 − 54.5 = 93.5), which is what the second submission wrote.
  assert.notEqual(newEtcForSubmission({ ...base, draft: null, confirmed: 160, cleared: false }), suggestNewEtc(148, 54.5));
});

test("a draft saved after the reopen wins over the confirmed figure", () => {
  assert.equal(newEtcForSubmission({ ...base, draft: 175, confirmed: 160, cleared: false }), 175);
  // 0 is a figure, not a blank.
  assert.equal(newEtcForSubmission({ ...base, draft: 0, confirmed: 160, cleared: false }), 0);
});

test("a cell deliberately cleared after the reopen submits as the suggestion, as its tooltip says", () => {
  assert.equal(newEtcForSubmission({ ...base, draft: null, confirmed: 160, cleared: true }), 93.5);
});

test("a never-submitted row with no draft still submits as the suggestion", () => {
  assert.equal(newEtcForSubmission({ ...base, draft: null, confirmed: null, cleared: false }), 93.5);
  // Zero hours worked carries the prior forward.
  assert.equal(newEtcForSubmission({ priorEtc: 20, hoursWorked: 0, draft: null, confirmed: null, cleared: false }), 20);
});

test("what is frozen is what the cell was showing, for every seed rung", () => {
  const states: NewEtcCellState[] = [
    { ...base, draft: 175, confirmed: 160, cleared: false, locked: false, monthComplete: true },
    { ...base, draft: null, confirmed: 160, cleared: false, locked: false, monthComplete: true },
    { ...base, draft: null, confirmed: 400, cleared: false, locked: false, monthComplete: true },
    { priorEtc: 20, hoursWorked: 0, draft: null, confirmed: null, cleared: false, locked: false, monthComplete: true },
  ];
  for (const s of states) {
    const shown = newEtcSeedText(s);
    assert.notEqual(shown, "", "these cells all show a figure");
    assert.equal(newEtcForSubmission(s), Number(shown));
  }
});

test("rounding matches the stored Decimal(10,2)", () => {
  assert.equal(newEtcForSubmission({ ...base, draft: 12.345, confirmed: null, cleared: false }), 12.35);
  assert.equal(newEtcForSubmission({ ...base, draft: null, confirmed: 12.344, cleared: false }), 12.34);
});
