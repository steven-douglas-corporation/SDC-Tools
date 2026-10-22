import { test } from "node:test";
import assert from "node:assert/strict";
import { readPaylocityWorkbook, worksheetFromPunches, type WarehousePunch, type WorkbookIdentity } from "../src/lib/paylocity-workbook";
import { resolveTempPunches, type AppPerson } from "../src/lib/temp-punch-people";
import {
  EMPTY_TEMP_FEED,
  TEMP_STALE_DAYS,
  describeTempFeed,
  tempFileAge,
  type TempFeed,
} from "../src/lib/temp-punches";
import { feedVersionSha } from "../src/lib/paylocity-import";
import { coveredDays } from "../src/lib/manual-contractor-hours";
import type { JobHoursRow } from "../src/lib/job-hours-source";

// ── The temp punches through the SAME reader as every other hours file ───────
//
// readTempPunches does I/O (the warehouse, the roster), so what is pinned here is what it
// is made of: names become ids, the punches go through readPaylocityWorkbook unchanged, and
// the rest — staleness, the provenance sentence, the same-file test, the day-level
// suppression — are pure functions with their own tests.

const identity = (over: Partial<WorkbookIdentity> = {}): WorkbookIdentity => ({
  path: 'DataWarehouse "Fact"."JobHours" (temp_punches)',
  fileName: "Temp Punches.xls",
  size: 350208,
  modifiedAt: new Date("2026-10-22T09:05:05Z"),
  sha256: "a".repeat(64),
  ...over,
});

const PEOPLE: AppPerson[] = [
  { name: "Casey Lane", paylocityId: "TEMP1", active: true },
  { name: "Drew Harper", paylocityId: "100700", active: true },
];
const KNOWN = new Set(["1158", "1145", "4000"]);
const LABELS = new Map<string, string>();

const punch = (p: Partial<WarehousePunch> & { sheetRow: number }): WarehousePunch => ({
  employeeId: null,
  employeeName: "Casey Lane",
  workDate: "2026-10-05",
  job: "1158",
  jobName: "Panduit",
  section: "10",
  fn: "211",
  hours: 4,
  travel: null,
  ...p,
});

async function read(punches: WarehousePunch[]) {
  const resolved = resolveTempPunches(punches, PEOPLE);
  return readPaylocityWorkbook({
    prebuilt: { identity: identity(), ws: worksheetFromPunches(resolved.punches) },
    knownJobNumbers: KNOWN,
    jobIdByLabel: LABELS,
  });
}

test("a matched punch becomes an ordinary hours row under the person's id, at the home site", async () => {
  const r = await read([punch({ sheetRow: 6 })]);
  assert.equal(r.rejected.length, 0);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].employeeId, "TEMP1");
  assert.equal(r.rows[0].jobId, "1158");
  assert.equal(r.rows[0].section, "10-211");
  assert.equal(r.rows[0].hours, 4);
  assert.equal(r.rows[0].travel, "Concord");
});

test("a punch with a phase but no job is rejected the way every other punch is — it is Paylocity's to fix", async () => {
  const r = await read([punch({ sheetRow: 6, job: null, jobName: null })]);
  assert.equal(r.rows.length, 0);
  assert.equal(r.rejected.length, 1);
  assert.equal(r.rejected[0].reason, "MISSING_JOB_ID");
  assert.equal(r.rejected[0].sourceRow, 6, "the sheet row survives, so it can be found in the report");
  assert.equal(r.rejected[0].employeeId, "TEMP1");
  assert.equal(r.rejected[0].hours, 4);
});

test("a punch with NEITHER job nor phase is rejected on the phase: the reader checks the labor code first", async () => {
  // Why the Data Management findings go by what the punch lacks, not by this reason. It also
  // means these punches are stored under Undefined Hours but do not count toward its KPI,
  // which only counts MISSING_JOB_ID and JOB_NOT_FOUND.
  const r = await read([punch({ sheetRow: 6, job: null, jobName: null, section: null, fn: "118" })]);
  assert.equal(r.rejected[0].reason, "INVALID_LABOR_CODE");
  assert.equal(r.rejected[0].countsTowardKpi, false);
});

test("a job with no phase is rejected as an unusable labor code", async () => {
  const r = await read([punch({ sheetRow: 6, section: null })]);
  assert.equal(r.rows.length, 0);
  assert.equal(r.rejected[0].reason, "INVALID_LABOR_CODE");
});

test("a job the app does not know is rejected as JOB_NOT_FOUND", async () => {
  const r = await read([punch({ sheetRow: 6, job: "9999" })]);
  assert.equal(r.rejected[0].reason, "JOB_NOT_FOUND");
  assert.equal(r.rejected[0].label, "9999");
});

test("an unmatched person's hours still reach the job, under the visible placeholder id", async () => {
  const r = await read([punch({ sheetRow: 6, employeeName: "Quinn Ashby" })]);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].employeeId, "NAME:Quinn Ashby");
  assert.equal(r.rows[0].hours, 4);
});

test("every row is its own punch: two segments on one day both count", async () => {
  const r = await read([
    punch({ sheetRow: 6, hours: 4 }),
    punch({ sheetRow: 8, hours: 3.5, section: "40" }),
    punch({ sheetRow: 9, employeeName: "Drew Harper", fn: "312", hours: 8 }),
  ]);
  assert.equal(r.rows.length, 3);
  assert.equal(r.rows.reduce((s, x) => s + x.hours, 0), 15.5);
});

// ── Freshness ───────────────────────────────────────────────────────────────

test("a file is stale once it is more than two days old", () => {
  assert.equal(TEMP_STALE_DAYS, 2);
  const id = identity({ modifiedAt: new Date("2026-10-20T09:00:00Z") });
  assert.equal(tempFileAge(id, new Date("2026-10-22T08:00:00Z")).stale, false);
  assert.equal(tempFileAge(id, new Date("2026-10-22T10:00:00Z")).stale, true);
  assert.ok(Math.abs(tempFileAge(id, new Date("2026-10-23T09:00:00Z")).ageDays - 3) < 1e-9);
});

test("a file dated in the future is not negative-aged", () => {
  const id = identity({ modifiedAt: new Date("2026-10-22T12:00:00Z") });
  assert.equal(tempFileAge(id, new Date("2026-10-22T09:00:00Z")).ageDays, 0);
});

// ── The sentence the refresh log and the provenance line carry ───────────────

const feed = (over: Partial<TempFeed>): TempFeed => ({ ...EMPTY_TEMP_FEED, ...over });

test("off says nothing; not arrived and failed say so, and a failure says the hours went on without it", () => {
  assert.equal(describeTempFeed(feed({ status: "off" }), 0), "");
  assert.match(describeTempFeed(feed({ status: "not_arrived" }), 0), /no report in the warehouse yet/);
  const failed = describeTempFeed(feed({ status: "failed", error: "connection refused" }), 0);
  assert.match(failed, /could NOT be read \(connection refused\)/);
  assert.match(failed, /hours were refreshed without them/);
});

test("ok states the file, the hours and what reached no job; stale adds the age", () => {
  const ok = feed({
    status: "ok",
    identity: identity(),
    lastWorkDate: new Date("2026-10-21T00:00:00Z"),
    rows: [{ hours: 4 } as JobHoursRow, { hours: 4 } as JobHoursRow],
    rejected: [{ hours: 1.5 } as TempFeed["rejected"][number]],
    ageDays: 3.2,
    stale: true,
  });
  const s = describeTempFeed(ok, 8);
  assert.match(s, /Temp Punches\.xls — 2 punches, 8\.00h, through 2026-10-21/);
  assert.match(s, /1 punch\(es\), 1\.50h, reached no job/);
  assert.match(s, /3 days old/);
});

// ── Same file as last time? ─────────────────────────────────────────────────

test("the feed's version is the workbook's own sha when there is no temp file, so nothing changes for it", () => {
  const wb = identity({ sha256: "b".repeat(64) });
  assert.equal(feedVersionSha({ workbook: wb, temp: { ...EMPTY_TEMP_FEED, rowsResolved: 0, hoursResolved: 0, rowsRejected: 0, hoursRejected: 0 } }), "b".repeat(64));
});

test("a new temp file beside an unchanged workbook is a NEW version, and a given pair is stable", () => {
  const wb = identity({ sha256: "b".repeat(64) });
  const base = { rowsResolved: 0, hoursResolved: 0, rowsRejected: 0, hoursRejected: 0 };
  const t1 = { ...EMPTY_TEMP_FEED, ...base, identity: identity({ sha256: "c".repeat(64) }) };
  const t2 = { ...EMPTY_TEMP_FEED, ...base, identity: identity({ sha256: "d".repeat(64) }) };
  const v1 = feedVersionSha({ workbook: wb, temp: t1 });
  assert.notEqual(v1, "b".repeat(64));
  assert.notEqual(v1, feedVersionSha({ workbook: wb, temp: t2 }));
  assert.equal(v1, feedVersionSha({ workbook: wb, temp: t1 }));
  assert.equal(v1?.length, 64, "still fits a 64-character hash");
});

// ── The typed-in timecards give way to a day Paylocity reports ────────────────

test("a day the temp feed reports covers the typed-in timecards for it, whether or not its punches became rows", () => {
  const row = { employeeId: "TEMP1", date: new Date("2026-10-05T00:00:00Z") } as JobHoursRow;
  const days = coveredDays([row], [
    { employeeId: "100700", workDate: new Date("2026-09-28T00:00:00Z") }, // a punch with no job: rejected, but reported
    { employeeId: "TEMP1", workDate: null }, // no date: nothing to cover
  ]);
  assert.ok(days.has("TEMP1|2026-10-05"));
  assert.ok(days.has("100700|2026-09-28"));
  assert.equal(days.size, 2);
});
