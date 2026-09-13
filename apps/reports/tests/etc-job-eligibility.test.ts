import { test } from "node:test";
import assert from "node:assert/strict";
import { etcActiveJobFilter, etcEligibleJobFilter, VALID_JOB_TYPES } from "../src/lib/job-filters";

// ── The eligibility / lifecycle split (2026-08-10) ──────────────────────────
//
// A Monthly ETC month has TWO job universes: the live month uses
// etcActiveJobFilter, and a submitted or historical month renders the jobs that
// have entries in it (getEtcMonthJobWhere). Before this split, only the second
// one skipped the billable test — so a month CHANGED SHAPE the moment it locked
// (or the moment a newer month was started, which is how July 2026 came to render
// 55 jobs while its own live filter allowed 48, pulling $29,465 of non-billable
// parts into a signed-off total).
//
// These tests hold the two halves apart. They assert the FILTER OBJECTS rather
// than query results because that is where the rule lives — every consumer
// (grid, KPIs, seeding, pruning, submission) spreads one of these two constants,
// so a regression here is a regression everywhere at once.

test("eligibility excludes non-billable and HeadStart, and is type-gated", () => {
  // Non-billable is the whole reason this constant exists: internal work is not
  // planned job-by-job and must never reach a month's totals, submitted or not.
  assert.equal(etcEligibleJobFilter.billable, true);
  // HeadStart has no PO, so nothing can legitimately be billed against it.
  assert.deepEqual(etcEligibleJobFilter.status, { not: "HeadStart" });
  // The type gate is non-negotiable on every job query in this app.
  assert.deepEqual(etcEligibleJobFilter.type, { in: [...VALID_JOB_TYPES] });
});

test("eligibility says NOTHING about lifecycle — a completed job is still eligible", () => {
  // This is the property that keeps history intact. getEtcMonthJobWhere applies
  // this filter to a LOCKED month, and a job that completed after that month was
  // submitted must still appear in it — 1115 Wet Hi-Pot is exactly that case in
  // June 2026. If `completeDate` or `status: "Active"` ever leaks in here, closed
  // months silently start losing real submitted work.
  assert.equal("completeDate" in etcEligibleJobFilter, false);
  assert.notEqual(etcEligibleJobFilter.status, "Active");
});

test("the live-month filter is eligibility PLUS lifecycle, never less", () => {
  // etcActiveJobFilter must stay strictly narrower than etcEligibleJobFilter: it
  // is derived by spreading it, so the billable and type gates come along for
  // free and cannot be dropped from one without the other.
  assert.equal(etcActiveJobFilter.billable, true);
  assert.deepEqual(etcActiveJobFilter.type, { in: [...VALID_JOB_TYPES] });
  // The lifecycle half, which ONLY the live month applies.
  assert.equal(etcActiveJobFilter.status, "Active");
  assert.equal(etcActiveJobFilter.completeDate, null);
});

test("Active overrides the HeadStart exclusion rather than sitting beside it", () => {
  // Both constants set `status`, and the spread order decides which wins. If that
  // order were reversed, the live month would accept every non-HeadStart job —
  // including Complete ones — and seeding would start creating rows for finished
  // work. Asserting the resolved value is what pins the order down.
  assert.equal(typeof etcActiveJobFilter.status, "string");
  assert.notDeepEqual(etcActiveJobFilter.status, { not: "HeadStart" });
});
