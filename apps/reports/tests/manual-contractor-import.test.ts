import { test } from "node:test";
import assert from "node:assert/strict";
import { parseContractorCsv, parseCsvLine } from "../src/lib/manual-contractor-import";

// ── Contractor timecards imported from a CSV ────────────────────────────────
//
// Paylocity cannot send temp employees in its punch reports, so their hours come
// from transcribed timecards. The import must refuse anything it would otherwise
// have to guess at — a half-imported card looks like a day off.

const HEADER = "employeeName,employeeRef,paylocityId,payPeriod,workDate,in,out,transfer,note";
const csv = (...lines: string[]) => [HEADER, ...lines].join("\n");
const line = (date: string, inT: string, outT: string, transfer = "211/1158/10/Concord", who = "Vipin Vijayan,Temp3,100600") =>
  `${who},2026-08-30..2026-09-12,${date},${inT},${outT},${transfer},`;

test("a standard day is two segments, lunch excluded, hours derived from in/out", () => {
  const { rows, errors } = parseContractorCsv(csv(line("2026-09-01", "08:00", "12:00"), line("2026-09-01", "12:30", "16:30")));
  assert.deepEqual(errors, []);
  assert.equal(rows.length, 2);
  assert.equal(rows.reduce((s, r) => s + r.hours, 0), 8);
  assert.equal(rows[0].jobNumber, "1158");
  assert.equal(rows[0].machineSec, "10");
  assert.equal(rows[0].functionId, "211");
  assert.equal(rows[0].location, "Concord");
});

test("odd-minute segments round to 2dp, like the seed and Paylocity", () => {
  const { rows } = parseContractorCsv(csv(line("2026-09-02", "07:07", "13:51")));
  assert.equal(rows[0].hours, 6.73);
});

test("single-digit hours are padded so the segment key is stable", () => {
  const { rows } = parseContractorCsv(csv(line("2026-09-02", "7:05", "11:05")));
  assert.equal(rows[0].startTime, "07:05");
});

test("comments, blank lines and a BOM are ignored", () => {
  const text = "﻿# note\n\n" + csv("# skip me", line("2026-09-01", "08:00", "12:00"), "");
  const { rows, errors } = parseContractorCsv(text);
  assert.deepEqual(errors, []);
  assert.equal(rows.length, 1);
});

test("quoted names with commas parse", () => {
  assert.deepEqual(parseCsvLine('"Vijayan, Vipin",Temp3'), ["Vijayan, Vipin", "Temp3"]);
});

test("a missing column refuses the whole file", () => {
  const { errors } = parseContractorCsv("employeeName,workDate,in,out\nA,2026-09-01,08:00,12:00");
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /Missing column/);
});

test("bad times, non-positive segments and bad transfers are errors", () => {
  const { rows, errors } = parseContractorCsv(
    csv(line("2026-09-01", "8am", "12:00"), line("2026-09-01", "12:00", "11:00"), line("2026-09-01", "13:00", "14:00", "1158")),
  );
  assert.equal(rows.length, 0);
  assert.equal(errors.length, 3);
});

test("a bad date is an error", () => {
  const { errors } = parseContractorCsv(csv(line("09/01/2026", "08:00", "12:00")));
  assert.match(errors[0].message, /YYYY-MM-DD/);
});

test("overlapping and duplicate segments on one day are errors", () => {
  const overlap = parseContractorCsv(csv(line("2026-09-01", "08:00", "12:00"), line("2026-09-01", "11:30", "16:00")));
  assert.match(overlap.errors[0].message, /Overlaps/);
  const dup = parseContractorCsv(csv(line("2026-09-01", "08:00", "12:00"), line("2026-09-01", "08:00", "12:00")));
  assert.match(dup.errors[0].message, /Duplicate/);
});

test("a transfer change mid-day is two jobs, not an overlap", () => {
  const { rows, errors } = parseContractorCsv(
    csv(line("2026-09-01", "12:30", "15:30", "211/1158/10"), line("2026-09-01", "15:30", "16:30", "312/1160/10")),
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(rows.map((r) => [r.jobNumber, r.hours]), [["1158", 3], ["1160", 1]]);
});

test("one paylocityId naming two people is an error", () => {
  const { errors } = parseContractorCsv(
    csv(line("2026-09-01", "08:00", "12:00"), line("2026-09-02", "08:00", "12:00", "211/1158/10", "Someone Else,Temp3,100600")),
  );
  assert.match(errors[0].message, /paylocityId 100600/);
});

test("a long day is a warning, not an error", () => {
  const { errors, warnings } = parseContractorCsv(csv(line("2026-09-01", "06:00", "12:00"), line("2026-09-01", "12:30", "19:30")));
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 1);
});

test("a punch outside its card's pay period is an error", () => {
  const { errors } = parseContractorCsv(csv(line("2026-09-13", "08:00", "12:00")));
  assert.match(errors[0].message, /outside its pay period/);
});

test("two overlapping cards for one employee are an error; adjacent cards are fine", () => {
  const who = "Vipin Vijayan,Temp3,100600";
  const a = `${who},2026-08-30..2026-09-12,2026-09-01,08:00,12:00,211/1158/10,`;
  const adjacent = `${who},2026-09-13..2026-09-26,2026-09-14,08:00,12:00,211/1158/10,`;
  const overlapping = `${who},2026-09-06..2026-09-19,2026-09-14,08:00,12:00,211/1158/10,`;
  assert.deepEqual(parseContractorCsv(csv(a, adjacent)).errors, []);
  assert.match(parseContractorCsv(csv(a, overlapping)).errors[0].message, /overlap/);
});

test("a malformed pay period is an error", () => {
  const { errors } = parseContractorCsv(csv("Vipin Vijayan,Temp3,100600,08/30-09/12,2026-09-01,08:00,12:00,211/1158/10,"));
  assert.match(errors[0].message, /payPeriod/);
});
