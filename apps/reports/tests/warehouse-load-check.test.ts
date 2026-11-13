import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateWarehouseLoad, HOURS_JOB, type WarehouseJobHealth } from "../src/lib/warehouse-load-check";

// The rules behind the warehouse_load source. The cases are the real week that
// prompted them: the Paylocity load last succeeded Mon 11/9 05:30, the task could not
// start from 11/10 on, and Job Details sat at 11/06 until 11/13.

function job(over: Partial<WarehouseJobHealth> = {}): WarehouseJobHealth {
  return {
    jobName: HOURS_JOB,
    description: "Paylocity load into the warehouse",
    dueBy: "06:30:00",
    dueSince: new Date("2026-11-13T11:30:00Z"),
    expectedDataThrough: "2026-11-12",
    lastRunAt: new Date("2026-11-13T10:30:03Z"),
    lastRunStatus: "succeeded",
    lastRunError: null,
    lastSucceededAt: new Date("2026-11-13T10:30:14Z"),
    isOverdue: false,
    todayIsBusinessDay: true,
    ...over,
  };
}

test("current load and current hours: ok, with a summary", () => {
  const r = evaluateWarehouseLoad({ jobs: [job()], hoursThrough: "2026-11-12" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.problems, []);
  assert.match(r.summary, /1 warehouse job current/);
  assert.match(r.summary, /hours through Thu, Nov 12/);
});

test("the 11/10-11/12 outage: a task that never started is reported, and says so", () => {
  const r = evaluateWarehouseLoad({
    jobs: [
      job({
        dueSince: new Date("2026-11-12T11:30:00Z"),
        expectedDataThrough: "2026-11-11",
        lastRunAt: new Date("2026-11-09T10:30:03Z"),
        lastSucceededAt: new Date("2026-11-09T10:30:14Z"),
        isOverdue: true,
      }),
    ],
    hoursThrough: "2026-11-06",
  });
  assert.equal(r.ok, false);
  assert.equal(r.problems.length, 1, "overdue explains the old hours; not reported twice");
  assert.match(r.problems[0], /has not succeeded since Mon, Nov 9/);
  assert.match(r.problems[0], /due by 6:30 AM every business day/);
  assert.match(r.problems[0], /No run has started since/);
});

test("an overdue job whose last run FAILED quotes that run's error", () => {
  const r = evaluateWarehouseLoad({
    jobs: [
      job({
        isOverdue: true,
        lastSucceededAt: new Date("2026-11-12T10:30:14Z"),
        lastRunAt: new Date("2026-11-13T10:30:03Z"),
        lastRunStatus: "failed",
        lastRunError: "password authentication failed for user \"dw_loader\"",
      }),
    ],
    hoursThrough: "2026-11-11",
  });
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /failed: password authentication failed/);
  assert.doesNotMatch(r.problems[0], /No run has started/);
});

test("load ran but the hours did not move: reported as a data problem", () => {
  const r = evaluateWarehouseLoad({ jobs: [job()], hoursThrough: "2026-11-10" });
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /Hours only run through Tue, Nov 10 but should run through Thu, Nov 12/);
});

test("Monday: hours through Friday are current", () => {
  const r = evaluateWarehouseLoad({
    jobs: [job({ dueSince: new Date("2026-11-16T11:30:00Z"), expectedDataThrough: "2026-11-13" })],
    hoursThrough: "2026-11-13",
  });
  assert.equal(r.ok, true);
});

test("hours AHEAD of the expected day (weekend punches) are fine", () => {
  const r = evaluateWarehouseLoad({ jobs: [job({ expectedDataThrough: "2026-11-13" })], hoursThrough: "2026-11-15" });
  assert.equal(r.ok, true);
});

test("no hours date yet: only the run check applies", () => {
  const r = evaluateWarehouseLoad({ jobs: [job()], hoursThrough: null });
  assert.equal(r.ok, true);
});

test("another expected job overdue is reported even when the hours job is fine", () => {
  const r = evaluateWarehouseLoad({
    jobs: [job(), job({ jobName: "totaleto_ingest", description: "Total ETO load", isOverdue: true, lastSucceededAt: null, lastRunAt: null, lastRunStatus: null })],
    hoursThrough: "2026-11-12",
  });
  assert.equal(r.ok, false);
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /Total ETO load \(totaleto_ingest\) has never succeeded/);
});

test("weekend: the alert flag is off, the problem is still reported", () => {
  const r = evaluateWarehouseLoad({ jobs: [job({ isOverdue: true, todayIsBusinessDay: false })], hoursThrough: "2026-11-12" });
  assert.equal(r.ok, false);
  assert.equal(r.todayIsBusinessDay, false);
});

test("lastSucceededAt is the newest success across jobs", () => {
  const newer = new Date("2026-11-13T19:36:45Z");
  const r = evaluateWarehouseLoad({ jobs: [job(), job({ jobName: "other", lastSucceededAt: newer })], hoursThrough: "2026-11-12" });
  assert.equal(r.lastSucceededAt?.getTime(), newer.getTime());
});
