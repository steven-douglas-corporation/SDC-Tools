import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ── getPartsCostSpentByJob must never re-acquire a date window (2026-08-07) ──
//
// Reported: Job.costActualHistorical / Job Cost Explorer's "Parts Purchased" (both fed
// by getPartsCostSpentByJob, called lifetime-windowed) undercounted every job carrying
// an open, never-invoiced PO line — by exactly that line's value. `[Invoiced Date]` is
// NULL for a line nothing has been invoiced against yet, and `NULL >= @start` is SQL's
// UNKNOWN, not true, so the row silently dropped out of the WHERE clause NO MATTER HOW
// WIDE the window was — even the 1990-2100 "lifetime" range both callers used. A job
// whose entire history was open/uninvoiced vanished from the result map entirely.
//
// Fixed by dropping the invoiced-date filter (and the now-pointless date parameters)
// so this sums every line a job has, exactly like getJobPartsCost (the drill-through /
// Job Hour Details basis) already does. Live-verified against real jobs: the gap
// between the old figure and getJobPartsCost's total matched the sum of that job's
// zero-invoice lines to the cent, for every job checked.
//
// This can't be a live-DB test (no TotalETO connection in CI), so it inspects the
// source the way tests/parts-spent-drill-invoiced.test.ts already does for the same
// reason — a live re-check lives in scripts/parts-spent-recon.ts and its siblings.

const SRC = join(import.meta.dirname, "..", "src");
function code(...parts: string[]): string {
  return readFileSync(join(SRC, ...parts), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/[^\n]*$/gm, "")
    .replace(/\/\/[^\n"'`]*$/gm, "");
}

function functionSpan(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}`);
  assert.ok(start >= 0, `${name} must exist in the source`);
  const nextExport = source.indexOf("\nexport ", start + 1);
  return nextExport === -1 ? source.slice(start) : source.slice(start, nextExport);
}

const SYNC_TOTALETO = () => code("lib", "sync-totaleto.ts");

test("getPartsCostSpentByJob takes no date-window parameters", () => {
  const src = SYNC_TOTALETO();
  const sig = src.match(/export async function getPartsCostSpentByJob\(([^)]*)\)/);
  assert.ok(sig, "getPartsCostSpentByJob must exist");
  assert.equal(sig![1].trim(), "", "a date-window parameter here is exactly what let the old bug in — this function is lifetime-only, unconditionally");
});

test("getPartsCostSpentByJob's query never filters on Invoiced Date", () => {
  const fn = functionSpan(SYNC_TOTALETO(), "getPartsCostSpentByJob");
  assert.doesNotMatch(
    fn,
    /\[Invoiced Date\]/,
    "a NULL Invoiced Date (never-invoiced line) fails any >= / < comparison in SQL and silently drops the row — see the fix note above",
  );
  assert.match(fn, /WHERE \[Job ID\] IS NOT NULL/, "the only filter should be excluding rows with no job at all");
});

// syncPartsCostActual no longer calls getPartsCostSpentByJob at all — as of
// 2026-08-10 it reads getPartsActualByJob, because [Total Price] is a COMMITMENT
// figure and the column it fills is labelled ACTUAL (see
// tests/parts-actual-gl-posted.test.ts for that fix and its guards). The
// no-window property this test was protecting still matters for the callers that
// legitimately want the commitment figure, so it moved to those.
test("getPartsCostSpentByJob's remaining callers pass no date window", () => {
  const jobCost = code("lib", "job-cost-source.ts");
  assert.match(jobCost, /getPartsCostSpentByJob\(\)/, "Job Cost Explorer's Parts Purchased column must use the fixed, unwindowed query");
  assert.doesNotMatch(
    jobCost,
    /getPartsCostSpentByJob\(\s*[A-Za-z_]/,
    "a date-window argument here is exactly what let the old NULL-Invoiced-Date bug in",
  );
});

test("job-cost-source.ts calls the unwindowed function with no arguments", () => {
  const src = code("lib", "job-cost-source.ts");
  assert.match(src, /getPartsCostSpentByJob\(\)/, "Job Cost Explorer's Parts Purchased column must use the fixed, unwindowed query");
});

test("the frozen legacy copy still has the old (buggy-on-purpose) invoiced-date window, for the archived diagnostics that reproduce it", () => {
  const fn = functionSpan(SYNC_TOTALETO(), "legacyPartsCostSpentByJobWindowed");
  assert.match(fn, /\[Invoiced Date\] >= @start AND \[Invoiced Date\] < @end/);
});
