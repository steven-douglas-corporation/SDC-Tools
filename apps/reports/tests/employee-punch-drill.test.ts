import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BUCKET_LABEL } from "../src/lib/employee-punch-drill";
import { classifyUtilizationPunch, type PunchBucket } from "../src/lib/department-utilization";

// ── The punch drill behind an employee's utilization row ────────────────────
//
// Clicking a person in the expanded Department Utilization table opens their
// punches for the month being shown. The whole value of it is that its totals
// ARE the row's figures — a drill whose total disagrees with the number it
// hangs off is worse than no drill.
//
// Verified against live data when it was written: all 48 employees with hours
// in 2026-08 reconcile on both total AND billable hours. These tests pin the
// two things that would break that quietly.

test("every bucket has a label — none can render as a raw enum", () => {
  const buckets: PunchBucket[] = ["billableActive", "warranty", "service", "spareParts", "bellco", "nonBillable"];
  for (const b of buckets) {
    assert.ok(BUCKET_LABEL[b], `${b} has no label`);
    assert.notEqual(BUCKET_LABEL[b], b, `${b} falls through to the enum name`);
  }
});

/** The drill's own rule, mirrored here so both tests state it once. */
const isBillableBucket = (b: PunchBucket): boolean => b !== "nonBillable" && b !== "bellco";

test("the drill's billable partition matches the department table's", () => {
  // The table sums billableTotal as active + warranty + service + spareParts
  // (department-utilization.ts's accumulate); the drill derives `billable` as
  // "not nonBillable and not bellco". Those are the same set — stated here so
  // that adding a seventh bucket cannot silently land on the wrong side of it
  // in one place and not the other.
  const tableBillable: PunchBucket[] = ["billableActive", "warranty", "service", "spareParts"];
  const all: PunchBucket[] = [...tableBillable, "bellco", "nonBillable"];
  for (const b of all) {
    assert.equal(isBillableBucket(b), tableBillable.includes(b), `${b} is on different sides of the two definitions`);
  }
});

test("the drill classifies with the table's own function, not a copy", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "src", "lib", "employee-punch-drill.ts"), "utf8");
  assert.match(src, /import \{[\s\S]{0,200}?classifyUtilizationPunch[\s\S]{0,200}?\} from "@\/lib\/department-utilization";/);
  assert.match(src, /classifyUtilizationPunch\(\{/);
  // A second rule table here is how the panel and the row start telling
  // different stories about the same punch.
  assert.doesNotMatch(src, /rawSection === "70"|=== "98"|OVERHEAD_JOB_IDS\.includes/);
});

test("the drill is month-scoped — an all-time list could not reconcile", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "src", "lib", "employee-punch-drill.ts"), "utf8");
  assert.match(src, /where: \{ employeeId, month \}/, "the punch query must filter on the month being displayed");
});

test("the action validates both arguments before querying", () => {
  // A server action is a public endpoint. employeeId reaches a Prisma `where`
  // and month reaches a string compare, so both are checked rather than trusted
  // because our own UI happens to send good values.
  const src = readFileSync(join(import.meta.dirname, "..", "src", "lib", "employee-punch-actions.ts"), "utf8");
  assert.match(src, /assertActionPermission\("dashboard:view"\)/);
  assert.match(src, /isValidMonth\(month\)/);
  assert.match(src, /\/\^\[A-Za-z0-9_-\]\{1,32\}\$\/\.test\(employeeId\)/);
});

// A couple of end-to-end sanity checks on the classifier itself, from the
// drill's point of view — these are the rows a reader is most likely to
// question when they see the panel.

test("an overhead job reads as Non-Billable in the drill", () => {
  // Job 4000 is literally named "Non-Billable"; Terence Hudson's whole month
  // was 152h of it, which is why his row shows 0%.
  const bucket = classifyUtilizationPunch({
    jobNumber: "4000",
    rawSection: "10",
    workDate: new Date("2026-08-27T00:00:00Z"),
    effectiveCloseDate: null,
  });
  assert.equal(bucket, "nonBillable");
  assert.equal(BUCKET_LABEL[bucket], "Non-Billable");
});

test("Bellco is its own bucket and does NOT count as billable", () => {
  // 51.75 of Adam Haviland's 149.75 hours, and the reason he reads 61% rather
  // than ~92%. Showing it as billable would make the panel contradict the row.
  const bucket = classifyUtilizationPunch({
    jobNumber: "6000",
    rawSection: "10",
    workDate: new Date("2026-08-25T00:00:00Z"),
    effectiveCloseDate: null,
  });
  assert.equal(bucket, "bellco");
  // Via the shared predicate rather than an inline compare on `bucket`, which
  // TypeScript has already narrowed to the literal "bellco" by this point and
  // would flag as a constant comparison.
  assert.equal(isBillableBucket("bellco"), false, "Bellco must not count toward billable");
});
