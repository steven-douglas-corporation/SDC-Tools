import { test } from "node:test";
import assert from "node:assert/strict";
import { directReports, hoursByJob, reportingChain } from "../src/lib/employee-panel-view";
import type { EmployeeMonthPunch } from "../src/lib/employee-punch-drill";

const p = (id: number, name: string, supervisorId: number | null, active = true) => ({ id, name, supervisorId, active });

test("reportingChain lists managers nearest first, hidden ones included", () => {
  const rows = [p(1, "Ceo", null), p(2, "Vp", 1, false), p(3, "Lead", 2), p(4, "Tech", 3)];
  assert.deepEqual(reportingChain(rows, 4).map((r) => r.name), ["Lead", "Vp", "Ceo"]);
  assert.deepEqual(reportingChain(rows, 1), []);
});

test("reportingChain stops at a supervisor loop and at a missing manager", () => {
  const loop = [p(1, "A", 2), p(2, "B", 1)];
  assert.deepEqual(reportingChain(loop, 1).map((r) => r.name), ["B"]);
  assert.deepEqual(reportingChain([p(1, "A", 99)], 1), []);
});

test("directReports: shown people first, then by name; never the person themself", () => {
  const rows = [p(1, "Boss", null), p(2, "Zed", 1), p(3, "Amy", 1, false), p(4, "Bob", 1), p(5, "Other", 2)];
  assert.deepEqual(directReports(rows, 1).map((r) => r.name), ["Bob", "Zed", "Amy"]);
  assert.deepEqual(directReports([p(7, "Self", 7)], 7), []);
});

const punch = (jobId: string, hours: number, billable: boolean): EmployeeMonthPunch => ({
  date: "2026-10-01",
  jobId,
  jobName: `Job ${jobId}`,
  section: "10-400",
  sectionName: "x",
  hours,
  bucket: billable ? "billableActive" : "nonBillable",
  billable,
  closeDate: null,
});

test("hoursByJob sums per job, splits billable, and sorts biggest first", () => {
  const out = hoursByJob([punch("A1", 2.5, true), punch("B2", 8, false), punch("A1", 3.25, false), punch("A1", 1, true)]);
  assert.deepEqual(out.map((j) => j.jobId), ["B2", "A1"]);
  assert.deepEqual(out[1], { jobId: "A1", jobName: "Job A1", hours: 6.75, billableHours: 3.5, punches: 3 });
});
