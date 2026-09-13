import { test } from "node:test";
import assert from "node:assert/strict";
import { customerBucket } from "../src/lib/dashboard-job-drill";
import { NO_CUSTOMER, ACTIVE_JOB_WHERE, VALID_JOB_TYPES } from "../src/lib/job-filters";

// ── The bar and the table it opens must group identically ───────────────────
//
// customerBucket is the RAW-value helper: what the drill-through shows in its
// "Stored As" column, and the spelling the chart counts per canonical row. It is
// no longer what either side GROUPS by — that is canonicalCustomerKey() in
// lib/customer-canonical.ts, covered by tests/customer-canonical.test.ts. Both
// sides still resolve through exactly one shared function, which is the property
// these tests exist to protect.
//
// The bug that put this file here (2026-08-28): the drill used to narrow in SQL,
// as `where: { customer: value }`. MySQL's default collation is case-insensitive,
// so 'FIRST SOLAR, INC.' also matched the rows stored as 'First Solar, Inc.' —
// a 12-job bar opened a 13-row table, and across the book the drill returned 79
// rows for 59 active jobs. The lesson survives canonical grouping unchanged: the
// danger is one side normalizing and the other not, whichever direction it goes.

test("the bucket is the stored string, trimmed", () => {
  assert.equal(customerBucket("Centrus Energy"), "Centrus Energy");
  assert.equal(customerBucket("  Centrus Energy  "), "Centrus Energy");
});

test("customerBucket preserves case — it reports the STORED spelling, it does not group", () => {
  // The book really does carry all four. customerBucket's job is to hand each
  // one back verbatim for the drill-through's "Stored As" column, so a combined
  // bar can be reconciled against its source rows. Merging them is
  // canonicalCustomerKey()'s job, and doing it in both places would leave the
  // chart with no way to show what it had merged.
  const variants = ["FIRST SOLAR, INC.", "First Solar, Inc.", "FIRST SOLAR INC.", "First Solar Inc."];
  const buckets = new Set(variants.map(customerBucket));
  assert.equal(buckets.size, variants.length, "customerBucket must not normalize — that is not its job");
});

test("blank, whitespace and null all land in the one no-customer bucket", () => {
  assert.equal(customerBucket(null), NO_CUSTOMER);
  assert.equal(customerBucket(""), NO_CUSTOMER);
  assert.equal(customerBucket("   "), NO_CUSTOMER);
});

test("a real customer never lands in the no-customer bucket", () => {
  assert.notEqual(customerBucket("SDC"), NO_CUSTOMER);
});

// ── The shared active-job definition ────────────────────────────────────────

test("ACTIVE_JOB_WHERE is Active plus the valid project types", () => {
  // Both the charts and the drill spell "active" with this object. If it ever
  // gains a condition, both move together — which is the reason it exists.
  assert.equal(ACTIVE_JOB_WHERE.status, "Active");
  assert.deepEqual([...ACTIVE_JOB_WHERE.type.in], [...VALID_JOB_TYPES]);
});

test("HeadStart is NOT active — it must never appear in a drill", () => {
  // A Head Start job has no PO. It is counted in its own KPI and shown as a
  // separate row under the type chart, so folding it in here would both
  // double-count it and break the foot to the Active Jobs total.
  assert.notEqual(ACTIVE_JOB_WHERE.status, "HeadStart");
});
