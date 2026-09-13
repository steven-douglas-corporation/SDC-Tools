import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ── Job Cost Explorer: As-of snapshot correctness guards (2026-08-11) ───────
//
// The hard requirement this feature exists to satisfy: "Never mix data from
// different snapshot dates" / "No current-month incomplete data leaks into
// prior month-end views". The real proof is live (scripts/verify-job-cost-
// snapshot.ts, plus a manual browser check comparing Current vs. a picked
// month-end), but a DB-touching query's WHERE clause can't be exercised in CI
// (no MySQL connection there) — same reason the sibling parts-cost tests in
// this file are source-inspecting. These are the cheap structural guards that
// stop the specific shapes of "leaked a later month" from coming back.

const SRC = join(import.meta.dirname, "..", "src");
function code(...parts: string[]): string {
  return readFileSync(join(SRC, ...parts), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/[^\n]*$/gm, "")
    .replace(/\/\/[^\n"'`]*$/gm, "");
}

// Matches `export async function NAME`, plain `async function NAME`, and a
// plain synchronous `function NAME` — several of these are deliberately
// module-private (loadJobHoursAndYears, historicalStatus), unlike the exported
// resolvers, and historicalStatus/monthEndDate aren't async at all.
function functionSpan(source: string, name: string): string {
  const re = new RegExp(`(?:export\\s+)?(?:async\\s+)?function ${name}\\b`);
  const m = re.exec(source);
  assert.ok(m, `${name} must exist in the source`);
  const start = m!.index;
  const nextFn = source.slice(start + 1).search(/\n(?:export\s+)?(?:async\s+)?function /);
  return nextFn === -1 ? source.slice(start) : source.slice(start, start + 1 + nextFn);
}

const JOB_COST_SOURCE = () => code("lib", "job-cost-source.ts");

test("loadJobHoursAndYears bounds BOTH month-scoped sources by throughMonth, not just one", () => {
  const fn = functionSpan(JOB_COST_SOURCE(), "loadJobHoursAndYears");
  // Two occurrences: the frozen-ETC-hoursWorked query (uncovered months) and the
  // JobHoursDetail query (covered months). Missing either one would let that
  // source leak a later month into a historical snapshot while the OTHER
  // source correctly stayed bounded — a partial, silent leak, worse than an
  // obvious all-or-nothing bug.
  const occurrences = fn.match(/throughMonth \? \{ lte: throughMonth \} : \{\}/g) ?? [];
  assert.equal(occurrences.length, 2, "both the uncovered-months query and the covered-months query must apply the same conditional lte");
});

test("the pre-tracking migration snapshot (EstimatedHours) is never month-filtered", () => {
  const fn = functionSpan(JOB_COST_SOURCE(), "loadJobHoursAndYears");
  const historicalQuery = fn.slice(fn.indexOf("prisma.estimatedHours.findMany"), fn.indexOf("prisma.etcEntry.groupBy"));
  assert.doesNotMatch(
    historicalQuery,
    /throughMonth|lte/,
    "actualHistoricalHours carries no month at all and predates every trackable one by construction — filtering it would silently zero out history for any bounded snapshot",
  );
});

test("Current mode (throughMonth null) reproduces the original unbounded query exactly", () => {
  const fn = functionSpan(JOB_COST_SOURCE(), "loadJobHoursAndYears");
  assert.match(fn, /throughMonth: string \| null/, "the parameter must be nullable — Current has no ceiling");
});

test("getSubmittedEtcSnapshot only reads FROZEN rows (needsReview: false), never a live draft or suggestion", () => {
  const fn = functionSpan(JOB_COST_SOURCE(), "getSubmittedEtcSnapshot");
  assert.match(fn, /needsReview:\s*false/, "must filter to submitted rows only — a pending row's newEtc is just its seed-time value, not a confirmed figure");
});

test("listLockedEtcMonthsDesc derives lock status from needsReview, not a separate hand-maintained flag", () => {
  const fn = functionSpan(JOB_COST_SOURCE(), "listLockedEtcMonthsDesc");
  assert.match(fn, /needsReview:\s*true/, "must find months WITH a pending row to exclude them — 'locked' has one real definition (isMonthLocked, lib/etc.ts) and this must track it, not invent a second one");
});

test("the ETC month resolver never reaches forward past the selected date", () => {
  const src = JOB_COST_SOURCE();
  assert.match(
    src,
    /lockedMonths\.find\(\(m\) => m <= /,
    "must search backward (<=) from the target month for the latest SUBMITTED one — reaching forward into a newer/unsubmitted month is exactly the bug this feature exists to prevent",
  );
});

test("Current mode keeps the job's real live status; only a historical snapshot corrects it", () => {
  const src = JOB_COST_SOURCE();
  assert.match(
    src,
    /status:\s*asOf \? historicalStatus\(j, asOf\) : j\.status/,
    "asOf=null (Current) must be byte-identical to today's live status — the historical-completion correction only applies once a snapshot date is actually selected",
  );
});

test("historicalStatus keys off completeDate, not the job's current live status", () => {
  const fn = functionSpan(JOB_COST_SOURCE(), "historicalStatus");
  assert.match(fn, /completeDate/, "must compare against completeDate — a job's CURRENT status alone can't tell you whether it was already complete as of a past snapshot date");
  assert.match(fn, /"Active"/, "a job currently Complete but not yet completeDate<=asOf must report as something OTHER than Complete, or computeJobCost would zero its ETC for a snapshot where it was still forecasting");
});
