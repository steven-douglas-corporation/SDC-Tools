import { test } from "node:test";
import assert from "node:assert/strict";
import {
  finiteNumber,
  positiveInt,
  parseAddEntryInput,
  parseConfirmEntryInput,
  parseOverrideHoursInput,
  parseRowId,
} from "../src/lib/job-detail-input";

// The job page's inline actions used to do `Number(formData.get("x"))` and
// write whatever came back — NaN included (2026-09-14). These are the rules
// that now stand in front of every one of those writes.

const form = (fields: Record<string, unknown>) => (name: string) => fields[name];

test("finiteNumber refuses blank, NaN, Infinity and non-numeric text", () => {
  for (const bad of ["", "   ", "abc", "1e999", "NaN", "Infinity", null, undefined]) {
    assert.throws(() => finiteNumber(bad, "Prior ETC"), /Prior ETC/, String(bad));
  }
  assert.equal(finiteNumber("12.5", "x"), 12.5);
  assert.equal(finiteNumber(" 7 ", "x"), 7);
  assert.equal(finiteNumber("", "x", { allowBlankAs: 0 }), 0);
});

test("positiveInt refuses zero, negatives and fractions — a row id must name a real row", () => {
  for (const bad of ["0", "-3", "1.5", "abc", ""]) assert.throws(() => positiveInt(bad, "Row id"), /Row id/, bad);
  assert.equal(positiveInt("42", "Row id"), 42);
});

test("parseAddEntryInput accepts the form as the page posts it", () => {
  assert.deepEqual(parseAddEntryInput(form({ section: " 10-111 ", priorEtc: "120", hoursWorked: "8.25", month: "2026-09" })), {
    section: "10-111",
    priorEtc: 120,
    hoursWorked: 8.25,
    month: "2026-09",
  });
  // Blank hours worked is the form's documented default of 0.
  assert.equal(parseAddEntryInput(form({ section: "10-111", priorEtc: "1", hoursWorked: "", month: "2026-09" })).hoursWorked, 0);
});

test("parseAddEntryInput refuses a bad section code, month, or number", () => {
  const ok = { section: "10-111", priorEtc: "1", hoursWorked: "0", month: "2026-09" };
  assert.throws(() => parseAddEntryInput(form({ ...ok, section: "ME" })), /Section/);
  assert.throws(() => parseAddEntryInput(form({ ...ok, section: "" })), /Section/);
  assert.throws(() => parseAddEntryInput(form({ ...ok, month: "2026-13" })), /month/);
  assert.throws(() => parseAddEntryInput(form({ ...ok, month: "" })), /month/);
  assert.throws(() => parseAddEntryInput(form({ ...ok, priorEtc: "" })), /Prior ETC/);
  assert.throws(() => parseAddEntryInput(form({ ...ok, priorEtc: "abc" })), /Prior ETC/);
  assert.throws(() => parseAddEntryInput(form({ ...ok, priorEtc: "-1" })), /negative/);
  assert.throws(() => parseAddEntryInput(form({ ...ok, hoursWorked: "x" })), /Hours worked/);
});

test("parseConfirmEntryInput needs a real entry id and a finite, non-negative New ETC", () => {
  assert.deepEqual(parseConfirmEntryInput(form({ entryId: "17", newEtc: "55.5" })), { entryId: 17, newEtc: 55.5 });
  assert.throws(() => parseConfirmEntryInput(form({ entryId: "", newEtc: "1" })), /Entry id/);
  assert.throws(() => parseConfirmEntryInput(form({ entryId: "17", newEtc: "" })), /New ETC/);
  assert.throws(() => parseConfirmEntryInput(form({ entryId: "17", newEtc: "-2" })), /negative/);
});

test("parseOverrideHoursInput trims the note, blanks it to null, and bounds it", () => {
  assert.deepEqual(parseOverrideHoursInput(form({ rowId: "3", newHours: "40", note: "  Paylocity miscoded  " })), {
    rowId: 3,
    newHours: 40,
    note: "Paylocity miscoded",
  });
  assert.equal(parseOverrideHoursInput(form({ rowId: "3", newHours: "40", note: "" })).note, null);
  assert.equal(parseOverrideHoursInput(form({ rowId: "3", newHours: "40" })).note, null);
  assert.throws(() => parseOverrideHoursInput(form({ rowId: "3", newHours: "40", note: "x".repeat(501) })), /500/);
  assert.throws(() => parseOverrideHoursInput(form({ rowId: "3", newHours: "" })), /Actual hours/);
  assert.throws(() => parseOverrideHoursInput(form({ rowId: "0", newHours: "1" })), /Row id/);
});

test("parseRowId is positiveInt over the rowId field", () => {
  assert.equal(parseRowId(form({ rowId: "9" })), 9);
  assert.throws(() => parseRowId(form({})), /Row id/);
});
