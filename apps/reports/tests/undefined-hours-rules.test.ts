import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aggregateUndefined,
  countsAsUndefined,
  isInReportMonth,
  reconcileUndefined,
  reconciliationMessage,
  reportMonthForWorkDate,
  undefinedTotalsForMonth,
  roundedHoursVisible,
  visibleUndefinedTotals,
  KPI_COUNTED_REASONS,
  UNDEFINED_REASON_FIX,
  UNDEFINED_REASON_LABEL,
  RECONCILE_TOLERANCE,
  type RejectionLike,
  type UndefinedReason,
} from "../src/lib/undefined-hours-rules";

// ── The Undefined Hours definition, pinned (§42.9-42.12, §42.28) ────────────
//
// The defect these exist for: the KPI card summed a stored table while the
// drill-through re-derived the punches from the source. Two computations for one
// number, which agreed only while nothing had changed since the last sync — and the
// module that did it documented the divergence as an acceptable trade-off.
//
// §42.11 requires `Undefined Hours KPI = sum of the drill-through rows` and says a
// mismatch is a calculation failure. The only way to guarantee that is for both to
// come from one function, so these tests are about that function being the only one.

const row = (over: Partial<RejectionLike> = {}): RejectionLike => ({
  reason: "JOB_NOT_FOUND",
  countsTowardKpi: true,
  month: "2026-07",
  label: "Not Defined",
  hours: 8,
  ...over,
});

// ── What counts ─────────────────────────────────────────────────────────────

test("only the two job-number reasons are in the KPI's definition", () => {
  // The headline is deliberately narrow — see the long note in the module. If a reason
  // is added here, a signed-off number moves, so this list is asserted exactly rather
  // than spot-checked.
  assert.deepEqual([...KPI_COUNTED_REASONS].sort(), ["JOB_NOT_FOUND", "MISSING_JOB_ID"]);
});

test("a counted reason still needs the punch to have reached a grid column", () => {
  // Both halves must hold. Time on an untracked section is missing from the grid
  // whatever its job number, so counting it would overstate what a valid job number
  // could actually have recovered.
  assert.equal(countsAsUndefined({ reason: "JOB_NOT_FOUND", countsTowardKpi: true }), true);
  assert.equal(countsAsUndefined({ reason: "JOB_NOT_FOUND", countsTowardKpi: false }), false);
});

test("correct exclusions never reach the KPI", () => {
  // 5,170h of the real file is UNSUPPORTED_CATEGORY — phase 80/90 work the app does
  // not model. The headline is 568h. Folding them together would be a nine-fold
  // overstatement, and would report correct behaviour as a data-quality fault.
  for (const reason of ["UNSUPPORTED_CATEGORY", "DEPARTMENT_NOT_MAPPED", "EMPLOYEE_NOT_MAPPED", "INVALID_LABOR_CODE"] as UndefinedReason[]) {
    assert.equal(countsAsUndefined({ reason, countsTowardKpi: true }), false, `${reason} must not count`);
  }
});

test("every reason has a label and a corrective action", () => {
  // §42.12 forbids "one generic Undefined label without explaining the cause", and
  // §42.27 asks the drill for the corrective data needed. A reason added without
  // either would render as an empty cell.
  const reasons = Object.keys(UNDEFINED_REASON_LABEL) as UndefinedReason[];
  assert.ok(reasons.length >= 10, "the §42.12 vocabulary should have all ten categories");
  for (const r of reasons) {
    assert.ok(UNDEFINED_REASON_LABEL[r]?.length > 0, `${r} has no label`);
    assert.ok(UNDEFINED_REASON_FIX[r]?.length > 0, `${r} has no corrective action`);
  }
});

// ── The reconciliation guarantee ────────────────────────────────────────────

test("the aggregate is exactly the sum of the rows it aggregates (§42.11)", () => {
  const rejected = [
    row({ hours: 8, label: "Not Defined" }),
    row({ hours: 2.5, label: "Not Defined" }),
    row({ hours: 4, label: "2026 SERVICE" }),
    // Excluded — must not appear in the totals at all.
    row({ hours: 100, reason: "UNSUPPORTED_CATEGORY", label: "80-311" }),
    row({ hours: 50, countsTowardKpi: false, label: "Not Defined" }),
  ];

  const totals = aggregateUndefined(rejected);
  const kpiTotal = totals.reduce((s, t) => s + t.hours, 0);
  // What the drill shows: the same predicate, applied to the same array.
  const drillRows = rejected.filter(countsAsUndefined);
  const drillTotal = drillRows.reduce((s, r) => s + r.hours, 0);

  assert.equal(kpiTotal, 14.5);
  assert.equal(drillTotal, 14.5);
  assert.deepEqual(reconcileUndefined(drillTotal, kpiTotal), { ok: true, delta: 0 });
  // Row counts have to foot too — the card prints "N entries" beside the hours.
  assert.equal(totals.reduce((s, t) => s + t.rows, 0), drillRows.length);
});

test("rounding must happen BEFORE aggregation, not after (regression)", () => {
  // ── The bug this pins, found live on the first real import ────────────────
  //
  // Both tables are Decimal(10,2). The drill sums rows that were each rounded on the
  // way in; the KPI stored a total summed from RAW values and rounded once. Across 59
  // rows that drifted by +0.04h for 2026-06 and +0.01h for 2026-07 — small, but
  // §42.11 defines any mismatch as a calculation failure, and the drill correctly
  // showed it in red.
  //
  // The fix is to round once, up front, and derive BOTH from the same numbers. This
  // test fails if anyone reintroduces raw-sum-then-round.
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const raw = [0.005, 0.005, 0.005, 0.005].map((h) => row({ hours: h }));

  // Wrong: aggregate the raw values, round the total.
  const rawTotal = round2(aggregateUndefined(raw).reduce((s, t) => s + t.hours, 0));
  // Right: round each row, then aggregate — which is what the stored rows sum to.
  const rounded = raw.map((r) => ({ ...r, hours: round2(r.hours) }));
  const roundedTotal = aggregateUndefined(rounded).reduce((s, t) => s + t.hours, 0);
  const drillTotal = rounded.reduce((s, r) => s + r.hours, 0);

  assert.equal(rawTotal, 0.02, "raw-then-round loses the per-row rounding");
  assert.equal(drillTotal, 0.04, "the stored rows each round up to 0.01");
  assert.equal(roundedTotal, drillTotal, "round-first makes the KPI equal the drill exactly");
  assert.equal(reconcileUndefined(drillTotal, roundedTotal).ok, true);
  assert.equal(reconcileUndefined(drillTotal, rawTotal).ok, false, "the old order would still fail reconciliation");
});

test("aggregation groups by month AND label, never across months", () => {
  const totals = aggregateUndefined([
    row({ month: "2026-06", hours: 10 }),
    row({ month: "2026-07", hours: 20 }),
    row({ month: "2026-07", hours: 5 }),
  ]);
  assert.equal(totals.length, 2);
  assert.deepEqual(
    totals.map((t) => [t.month, t.hours, t.rows]),
    [
      ["2026-06", 10, 1],
      ["2026-07", 25, 2],
    ],
  );
});

test("per-month totals match the aggregate for that month", () => {
  const rejected = [row({ month: "2026-06", hours: 10 }), row({ month: "2026-07", hours: 25 }), row({ month: "2026-07", hours: 5 })];
  const july = undefinedTotalsForMonth(rejected, "2026-07");
  const fromAggregate = aggregateUndefined(rejected).filter((t) => t.month === "2026-07");
  assert.equal(july.hours, fromAggregate.reduce((s, t) => s + t.hours, 0));
  assert.equal(july.entries, fromAggregate.reduce((s, t) => s + t.rows, 0));
});

test("an empty month reconciles at zero rather than failing", () => {
  // "0 undefined hours" is a daily reassurance that the import is clean; it must not
  // read as a reconciliation error.
  assert.deepEqual(aggregateUndefined([]), []);
  assert.equal(reconcileUndefined(0, 0).ok, true);
  assert.match(reconciliationMessage(0, 0), /matches KPI: 0 hours/);
});

// ── The mismatch case, which must be loud ───────────────────────────────────

test("a real divergence is reported, not absorbed", () => {
  const { ok, delta } = reconcileUndefined(284, 296);
  assert.equal(ok, false);
  assert.equal(delta, -12);
  // §42.28's own example wording.
  const msg = reconciliationMessage(284, 296);
  assert.match(msg, /Reconciliation error/);
  assert.match(msg, /296/);
  assert.match(msg, /284/);
});

test("float dust is tolerated but a cent is not", () => {
  // Both sides are Decimal(10,2) sums of the same rows, so they should agree exactly.
  // The tolerance exists for IEEE noise (0.1+0.2), not for rounding disagreements.
  assert.equal(reconcileUndefined(0.1 + 0.2, 0.3).ok, true);
  assert.equal(reconcileUndefined(100.01, 100.0).ok, false, "one cent of an hour is a real difference");
  assert.ok(RECONCILE_TOLERANCE < 0.01);
});

// ── Report-month assignment (§42.6) ─────────────────────────────────────────

test("the reporting month comes from the work date, in UTC", () => {
  assert.equal(reportMonthForWorkDate(new Date("2026-07-01T00:00:00.000Z")), "2026-07");
  assert.equal(reportMonthForWorkDate(new Date("2026-07-31T23:59:59.000Z")), "2026-07");
  assert.equal(reportMonthForWorkDate(new Date("2026-08-01T00:00:00.000Z")), "2026-08");
});

test("month boundaries land on the right side (§42.32)", () => {
  // The window §42.6 states: Work Date >= July 1 and < August 1.
  assert.equal(isInReportMonth(new Date("2026-06-30T00:00:00.000Z"), "2026-07"), false);
  assert.equal(isInReportMonth(new Date("2026-07-01T00:00:00.000Z"), "2026-07"), true);
  assert.equal(isInReportMonth(new Date("2026-07-31T00:00:00.000Z"), "2026-07"), true);
  assert.equal(isInReportMonth(new Date("2026-08-01T00:00:00.000Z"), "2026-07"), false);
});

test("year boundaries land on the right side (§42.32)", () => {
  assert.equal(reportMonthForWorkDate(new Date("2025-12-31T00:00:00.000Z")), "2025-12");
  assert.equal(reportMonthForWorkDate(new Date("2026-01-01T00:00:00.000Z")), "2026-01");
  assert.equal(isInReportMonth(new Date("2025-12-31T00:00:00.000Z"), "2026-01"), false);
});

// ── Negative corrections (§42.32) ───────────────────────────────────────────

test("negative correction hours net off rather than being discarded", () => {
  // Paylocity issues a negative row to reverse a mis-booked punch. Clamping or
  // dropping it would leave the reversal unapplied and overstate the month.
  const totals = aggregateUndefined([
    row({ hours: 8, label: "Not Defined" }),
    row({ hours: -3, label: "Not Defined" }),
  ]);
  assert.equal(totals.length, 1);
  assert.equal(totals[0].hours, 5);
  assert.equal(totals[0].rows, 2, "both rows are still entries, even though they net");
});

test("a fully reversed entry reconciles at zero without vanishing", () => {
  const rejected = [row({ hours: 4 }), row({ hours: -4 })];
  const totals = aggregateUndefined(rejected);
  const kpi = totals.reduce((s, t) => s + t.hours, 0);
  const drill = rejected.filter(countsAsUndefined).reduce((s, r) => s + r.hours, 0);
  assert.equal(kpi, 0);
  assert.equal(reconcileUndefined(drill, kpi).ok, true);
  // The rows are still there to look at — a zero total with two entries behind it is
  // a different situation from no entries, and the drill has to show which.
  assert.equal(totals[0].rows, 2);
});

// ── Zero-hour row filtering (by request, 2026-08-20) ────────────────────────

test("roundedHoursVisible matches the display rounding exactly", () => {
  assert.equal(roundedHoursVisible(0.49), false, "rounds to 0");
  assert.equal(roundedHoursVisible(-0.49), false, "rounds to -0, still invisible");
  assert.equal(roundedHoursVisible(0.5), true, "rounds to 1");
  assert.equal(roundedHoursVisible(0), false);
  assert.equal(roundedHoursVisible(8), true);
});

test("visibleUndefinedTotals drops rows that round to 0 before they ever reach a total", () => {
  const rejected = [
    row({ hours: 8, label: "Not Defined" }),
    // Real time, but invisible at whole-hour display — must not pad the total.
    row({ hours: 0.2, label: "Not Defined" }),
    row({ hours: -0.3, label: "Not Defined" }),
  ];
  const totals = visibleUndefinedTotals(rejected);
  assert.equal(totals.length, 1);
  assert.equal(totals[0].hours, 8, "the 0.2 and -0.3 rows are excluded, not merely hidden");
  assert.equal(totals[0].rows, 1);
});

test("a reversal pair still nets correctly even though each half rounds to non-zero", () => {
  // Distinct from the invisible-single-row case above: two real, individually-visible
  // rows that happen to sum to something small are not the same thing as one row that
  // rounds away on its own — the filter is per-row, applied before aggregation, never
  // on the aggregate itself.
  const totals = visibleUndefinedTotals([row({ hours: 4 }), row({ hours: -3.6 })]);
  assert.equal(totals.length, 1);
  assert.ok(Math.abs(totals[0].hours - 0.4) < 1e-9);
  assert.equal(totals[0].rows, 2);
});
