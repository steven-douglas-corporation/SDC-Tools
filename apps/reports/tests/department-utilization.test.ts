import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyUtilizationPunch,
  BELLCO_JOB_ID,
  OVERHEAD_JOB_IDS,
  UTILIZATION_TEAM_CODES,
  HOURS_PER_WORKING_DAY,
  type PunchBucket,
} from "../src/lib/department-utilization";
import { normalizeTravel } from "../src/lib/paylocity-workbook";

// ── The billable rule table, asserted directly ──────────────────────────────
//
// classifyUtilizationPunch is the one decision behind seven of the section's
// figures (Billable Total / Active / Warranty / Service / Spare Parts / Bellco /
// Non-Billable). In the Power BI report those are seven independent CALCULATE
// filters that only happen to partition the data; here they are one function, so
// the partition is testable — which is the whole reason it was written that way.
//
// The expected values below come from the report's own DAX (Measure Tables.tmdl),
// not from the rendered visual: `Hours Actual Billable`, `Hours Actual Billable
// Active`, `... Warranty`, `... Service`, `... Spare Parts`, `... Bellco` and
// `Hours Actual Non-Billable`.

const OPEN = null; // an active job — Effective Close Date is BLANK
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

function bucket(jobNumber: string, rawSection: string, workDate: string, close: Date | null = OPEN): PunchBucket {
  return classifyUtilizationPunch({ jobNumber, rawSection, workDate: day(workDate), effectiveCloseDate: close });
}

test("an ordinary punch on an open job is billable-active", () => {
  assert.equal(bucket("1130", "10", "2026-07-15"), "billableActive");
  assert.equal(bucket("1130", "40", "2026-07-15"), "billableActive");
});

test("sections 70/80/90 are their own billable buckets, open or closed", () => {
  assert.equal(bucket("1130", "70", "2026-07-15"), "warranty");
  assert.equal(bucket("1130", "80", "2026-07-15"), "service");
  assert.equal(bucket("1130", "90", "2026-07-15"), "spareParts");
  // The report keeps these billable AFTER the job closes — that is the entire
  // point of the close-date branch in `Hours Actual Billable`.
  const closed = day("2026-06-30");
  assert.equal(bucket("1130", "70", "2026-07-15", closed), "warranty");
  assert.equal(bucket("1130", "80", "2026-07-15", closed), "service");
  assert.equal(bucket("1130", "90", "2026-07-15", closed), "spareParts");
});

test("section 98 (Invalid) is never billable, even on an open job", () => {
  assert.equal(bucket("1130", "98", "2026-07-15"), "nonBillable");
  assert.equal(bucket("1130", "98", "2026-07-15", day("2026-06-30")), "nonBillable");
});

test("ordinary work booked AFTER the job closed falls out of billable", () => {
  const closed = day("2026-06-30");
  assert.equal(bucket("1130", "10", "2026-07-01", closed), "nonBillable");
  // The boundary is inclusive on the close date itself: `Date <= Effective Close Date`.
  assert.equal(bucket("1130", "10", "2026-06-30", closed), "billableActive");
  assert.equal(bucket("1130", "10", "2026-06-29", closed), "billableActive");
});

test("the four overhead jobs are non-billable whatever the section", () => {
  for (const job of OVERHEAD_JOB_IDS) {
    assert.equal(bucket(job, "10", "2026-07-15"), "nonBillable", `job ${job} section 10`);
    // Even a warranty code cannot rescue an overhead job — the report excludes
    // these jobs in EVERY billable measure, including the warranty one.
    assert.equal(bucket(job, "70", "2026-07-15"), "nonBillable", `job ${job} section 70`);
  }
});

test("Bellco is its own bucket, carved out of both billable and non-billable", () => {
  assert.equal(bucket(BELLCO_JOB_ID, "10", "2026-07-15"), "bellco");
  assert.equal(bucket(BELLCO_JOB_ID, "70", "2026-07-15"), "bellco");
  // Bellco is NOT one of the overhead jobs, and must not be treated as one.
  assert.ok(!OVERHEAD_JOB_IDS.includes(BELLCO_JOB_ID));
});

test("every punch lands in exactly one bucket — the partition Billable+NonBillable+Bellco = Actual rests on", () => {
  const jobs = ["1130", BELLCO_JOB_ID, ...OVERHEAD_JOB_IDS];
  const sections = ["1", "10", "40", "50", "70", "80", "90", "98"];
  const closes = [OPEN, day("2026-06-30")];
  const valid = new Set<PunchBucket>(["billableActive", "warranty", "service", "spareParts", "bellco", "nonBillable"]);
  for (const j of jobs)
    for (const s of sections)
      for (const c of closes) {
        const b = bucket(j, s, "2026-07-15", c);
        assert.ok(valid.has(b), `${j}/${s} -> ${b}`);
      }
});

test("a 1-digit section is ordinary work, matching PBI's LEFT(code,2) giving \"1-\"", () => {
  // The report reads LEFT('Section-Function Code', 2). For "1-311" that is "1-",
  // which matches none of 70/80/90/98 — so the punch is ordinary billable work.
  // This app compares the normalized section ("1") instead, and must agree.
  assert.equal(bucket("1130", "1", "2026-07-15"), "billableActive");
  assert.equal(bucket("1130", "5", "2026-07-15"), "billableActive");
});

// ── The scope constant ──────────────────────────────────────────────────────

test("the utilization scope is the five delivery teams, without Service or PM", () => {
  assert.deepEqual([...UTILIZATION_TEAM_CODES].sort(), ["build", "controls", "mech", "mfgops", "wire"]);
  // Service Engineering and PM are outside the report's five departments. If either
  // is ever added, Utilization % stops being comparable to the report — so this is
  // asserted rather than left to a comment.
  assert.ok(!UTILIZATION_TEAM_CODES.includes("service"));
  assert.ok(!UTILIZATION_TEAM_CODES.includes("pm"));
});

test("theoretical hours use an 8-hour day, per the report's own constant", () => {
  assert.equal(HOURS_PER_WORKING_DAY, 8);
});

// ── Travel normalization ────────────────────────────────────────────────────
//
// The report's Power Query does exactly two replacements on this column
// (expressions.tmdl): "Not Defined" -> "Concord", then "TRAVEL" -> "Travel". Only
// the literal "Travel" counts as travel hours, so getting this wrong silently
// moves the Travel column.

test("normalizeTravel reproduces the report's two replacements", () => {
  assert.equal(normalizeTravel("TRAVEL"), "Travel");
  assert.equal(normalizeTravel("Travel"), "Travel");
  assert.equal(normalizeTravel("Not Defined"), "Concord");
  assert.equal(normalizeTravel("Concord"), "Concord");
});

test("normalizeTravel keeps an unrecognised site rather than bucketing it", () => {
  // Inventing a bucket for an unknown site would hide a real one; it is passed
  // through, counts as "known", and simply is not travel.
  assert.equal(normalizeTravel("Toronto"), "Toronto");
  assert.notEqual(normalizeTravel("Toronto"), "Travel");
});

test("a blank Travel cell stays blank — \"not known\", never \"Concord\"", () => {
  // This is what separates NULL travelHours (no data) from 0 (measured zero). An
  // export saved without the column must not be read as "nobody travelled".
  assert.equal(normalizeTravel(""), "");
  assert.equal(normalizeTravel("   "), "");
});
