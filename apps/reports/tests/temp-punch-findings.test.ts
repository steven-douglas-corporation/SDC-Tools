import { test } from "node:test";
import assert from "node:assert/strict";
import { tempPunchFindings, FINDING_ROW_LIMIT, type StagingPunch } from "../src/lib/temp-punch-findings";
import { EMPTY_TEMP_FEED, type TempFeed } from "../src/lib/temp-punches";
import type { TempPersonSummary } from "../src/lib/temp-punch-people";
import type { RejectedPunch } from "../src/lib/paylocity-workbook";

// ── What Data Management lists for the temp punches ──────────────────────────
//
// The findings are the hours reader's own rejections (so they cannot disagree with Undefined
// Hours) plus what only the staging view can see: a punch with no clock-out, and the people
// the app cannot tie to a Paylocity ID.

const stage = (s: Partial<StagingPunch> & { sheetRow: number }): StagingPunch => ({
  name: "Quinn Ashby",
  workDate: "2026-10-06",
  punchIn: "08:00",
  punchOut: "12:00",
  isOpen: false,
  hours: 4,
  jobCode: null,
  sectionCode: null,
  functionCode: "311",
  ...s,
});

const rejected = (r: Partial<RejectedPunch> & { sourceRow: number; reason: RejectedPunch["reason"] }): RejectedPunch => ({
  month: "2026-10",
  label: "(blank)",
  workDate: new Date("2026-10-06T00:00:00Z"),
  employeeId: "NAME:Quinn Ashby",
  section: "-311",
  hours: 4,
  countsTowardKpi: true,
  ...r,
});

const summary = (p: Partial<TempPersonSummary> & { name: string; person: TempPersonSummary["person"] }): TempPersonSummary => ({
  employeeId: null,
  punches: 3,
  hours: 12,
  firstDate: "2026-10-06",
  lastDate: "2026-10-09",
  ...p,
});

const feed = (over: Partial<TempFeed>): TempFeed => ({ ...EMPTY_TEMP_FEED, status: "ok", ...over });

test("no job, no phase and unknown job each go to their own finding, with the row to look for", () => {
  const f = tempPunchFindings({
    staging: [
      stage({ sheetRow: 10 }),
      stage({ sheetRow: 11, jobCode: "1145", sectionCode: null, functionCode: "211" }),
      stage({ sheetRow: 12, jobCode: "9999", sectionCode: "10", functionCode: "211" }),
      stage({ sheetRow: 13, jobCode: null, sectionCode: "10", functionCode: "211" }),
    ],
    feed: feed({
      rejected: [
        rejected({ sourceRow: 10, reason: "INVALID_LABOR_CODE" }), // no job AND no phase: the reader reports the phase first
        rejected({ sourceRow: 13, reason: "MISSING_JOB_ID", hours: 3 }),
        rejected({ sourceRow: 11, reason: "INVALID_LABOR_CODE", label: "(blank)", hours: 2 }),
        rejected({ sourceRow: 12, reason: "JOB_NOT_FOUND", label: "9999", hours: 1.5 }),
      ],
    }),
    missingColumns: [],
  });
  // Both are "no job", whichever code the reader gave them; the first lacks the phase as well.
  assert.equal(f.noJob.count, 2);
  assert.equal(f.noJob.hours, 7);
  assert.equal(f.noJob.rows[0].sheetRow, 10);
  assert.equal(f.noJob.rows[0].name, "Quinn Ashby");
  assert.equal(f.noJob.rows[0].times, "08:00–12:00");
  assert.equal(f.noJob.rows[0].detail, "No job and no phase (function 311)");
  assert.equal(f.noJob.rows[1].detail, "No job (function 211)");
  assert.equal(f.noPhase.count, 1);
  assert.match(f.noPhase.rows[0].detail, /Job 1145: no phase/);
  assert.equal(f.noPhase.hours, 2);
  assert.equal(f.jobNotFound.count, 1);
  assert.match(f.jobNotFound.rows[0].detail, /9999/);
  assert.equal(f.jobNotFound.hours, 1.5);
});

test("an ambiguous name is a name finding, not a punch finding", () => {
  const f = tempPunchFindings({
    staging: [stage({ sheetRow: 10 })],
    feed: feed({ rejected: [rejected({ sourceRow: 10, reason: "EMPLOYEE_NOT_MAPPED", employeeId: "", countsTowardKpi: false })] }),
    missingColumns: [],
  });
  assert.equal(f.noJob.count + f.noPhase.count + f.jobNotFound.count, 0);
});

test("a punch with no clock-out is listed even though it carries 0 hours and the reader never sees it", () => {
  const f = tempPunchFindings({
    staging: [
      stage({ sheetRow: 20, name: "Casey Lane", workDate: "2026-10-22", punchIn: "02:34", punchOut: null, isOpen: true, hours: 0, jobCode: "1145" }),
      stage({ sheetRow: 21, name: "Casey Lane", workDate: "2026-10-14", punchIn: "13:00", punchOut: null, isOpen: true, hours: 0 }),
      stage({ sheetRow: 22, jobCode: "1158" }),
    ],
    feed: feed({}),
    missingColumns: [],
  });
  assert.equal(f.open.count, 2);
  assert.deepEqual(f.open.rows.map((r) => r.date), ["2026-10-14", "2026-10-22"], "oldest first");
  assert.match(f.open.rows[0].detail, /no clock-out · no job/);
  assert.match(f.open.rows[1].detail, /job 1145/);
  assert.equal(f.open.hours, 0);
});

test("names: nobody by that name, a placeholder id and an ambiguous name are listed; a real id is not", () => {
  const f = tempPunchFindings({
    staging: [],
    feed: feed({
      people: [
        summary({ name: "Quinn Ashby", person: { kind: "unmatched", reportId: null }, employeeId: "NAME:Quinn Ashby" }),
        summary({ name: "Casey Lane", person: { kind: "matched", employeeId: "TEMP1", via: "name", reportId: null }, employeeId: "TEMP1" }),
        summary({ name: "Morgan Pike", person: { kind: "matched", employeeId: "TEMP4", via: "typed-in", reportId: null }, employeeId: "TEMP4" }),
        summary({ name: "Alex Twin", person: { kind: "ambiguous", candidates: ["100020", "100021"] } }),
        summary({ name: "Drew Harper", person: { kind: "matched", employeeId: "100700", via: "name", reportId: null }, employeeId: "100700" }),
        summary({ name: "Robin Vale", person: { kind: "matched", employeeId: "100600", via: "id", reportId: "100600" }, employeeId: "100600" }),
      ],
    }),
    missingColumns: [],
  });
  const byName = Object.fromEntries(f.names.map((n) => [n.name, n]));
  assert.deepEqual(Object.keys(byName).sort(), ["Quinn Ashby", "Alex Twin", "Casey Lane", "Morgan Pike"].sort());
  assert.equal(byName["Quinn Ashby"].kind, "no-person");
  assert.match(byName["Quinn Ashby"].detail, /did not add them/);
  assert.equal(byName["Casey Lane"].kind, "placeholder");
  assert.match(byName["Casey Lane"].detail, /TEMP1.*isn't a Paylocity ID/);
  assert.equal(byName["Morgan Pike"].kind, "placeholder");
  assert.match(byName["Morgan Pike"].detail, /typed-in timecards/);
  assert.equal(byName["Alex Twin"].kind, "ambiguous");
  assert.match(byName["Alex Twin"].detail, /100020, 100021/);
  assert.equal(byName["Drew Harper"], undefined, "a real Paylocity id needs nothing");
  assert.equal(byName["Robin Vale"], undefined);
});

test("when Paylocity's report id differs from the app's, it is said and the app's is used", () => {
  const f = tempPunchFindings({
    staging: [],
    feed: feed({
      people: [summary({ name: "Pat Smith", person: { kind: "matched", employeeId: "100010", via: "name", reportId: "100999" }, employeeId: "100010" })],
    }),
    missingColumns: [],
  });
  assert.equal(f.names[0].kind, "id-differs");
  assert.match(f.names[0].detail, /100999.*100010/);
});

test("changed report columns are passed through, and nothing is claimed when there is no feed", () => {
  assert.deepEqual(tempPunchFindings({ staging: [], feed: feed({}), missingColumns: ["Jobs"] }).missingColumns, ["Jobs"]);
  const none = tempPunchFindings({ staging: [], feed: null, missingColumns: [] });
  assert.equal(none.noJob.count + none.open.count + none.names.length, 0);
  assert.equal(none.file, null);
});

test("the counts are complete even when the lists are capped", () => {
  const n = FINDING_ROW_LIMIT + 25;
  const staging = Array.from({ length: n }, (_, i) => stage({ sheetRow: 100 + i }));
  const f = tempPunchFindings({
    staging,
    feed: feed({ rejected: staging.map((s) => rejected({ sourceRow: s.sheetRow, reason: "MISSING_JOB_ID", hours: 1 })) }),
    missingColumns: [],
  });
  assert.equal(f.noJob.count, n);
  assert.equal(f.noJob.hours, n);
  assert.equal(f.noJob.rows.length, FINDING_ROW_LIMIT);
});
