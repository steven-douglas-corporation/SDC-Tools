import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calcHoursLeft,
  suggestNewEtc,
  round2,
  isMonthLocked,
  currentMonth,
  prevMonth,
  nextMonth,
  isValidMonth,
  workingDaysInMonth,
  hasPublishedHistory,
  groupStandardFeesRows,
  isSafeForLiveEtcSync,
  isNewEtcDecided,
  effectiveNewEtc,
  newEtcDiff,
  latestPriorEtcByKey,
  priorEtcForMonth,
  monthOfDate,
  startsInMonth,
  redrivenDraft,
} from "../src/lib/etc";

test("calcHoursLeft: prior minus worked, may go negative", () => {
  assert.equal(calcHoursLeft(100, 40), 60);
  assert.equal(calcHoursLeft(10, 25), -15);
  assert.equal(calcHoursLeft(0, 0), 0);
});

test("suggestNewEtc: carry-forward rule when no hours worked", () => {
  // Dan's rule: no hours worked ⇒ no progress ⇒ New ETC = Prior ETC.
  assert.equal(suggestNewEtc(80, 0), 80);
  assert.equal(suggestNewEtc(0, 0), 0);
});

test("suggestNewEtc: subtracts worked hours, clamped at zero", () => {
  assert.equal(suggestNewEtc(100, 30), 70);
  assert.equal(suggestNewEtc(20, 50), 0); // overrun never suggests negative
});

test("round2: rounds to cents/hundredths", () => {
  assert.equal(round2(1.005 * 100), 100.5);
  assert.equal(round2(3.14159), 3.14);
  assert.equal(round2(2.675), 2.68); // 2.675 * 100 = 267.50000000000003 → 268
});

test("prevMonth/nextMonth: adjacent months incl. year rollover", () => {
  assert.equal(prevMonth("2026-06"), "2026-05");
  assert.equal(prevMonth("2026-01"), "2025-12");
  assert.equal(nextMonth("2026-06"), "2026-07");
  assert.equal(nextMonth("2026-12"), "2027-01");
  assert.equal(nextMonth(prevMonth("2026-01")), "2026-01"); // round-trip
});

// currentMonth() is the app's one "what month is it right now" definition —
// three page-level call sites and cash-flow-view.ts's currentMonthKey all
// used to compute this independently, one of them (currentMonthKey) via UTC
// instead of local time, which could name a different month than the other
// three for the same instant near a month boundary. Pinned here so a future
// caller can't reintroduce a second, timezone-inconsistent copy.
test("currentMonth: local server time, not UTC", () => {
  assert.equal(currentMonth(new Date(2026, 7, 19, 23, 30)), "2026-08"); // Aug 19, 11:30pm local
  assert.equal(currentMonth(new Date(2026, 0, 1, 0, 0)), "2026-01"); // Jan 1, midnight local
  assert.equal(currentMonth(new Date(2025, 11, 31, 23, 59)), "2025-12"); // Dec 31, 11:59pm local
});

test("isValidMonth: accepts YYYY-MM, rejects garbage", () => {
  assert.equal(isValidMonth("2026-06"), true);
  assert.equal(isValidMonth("2026-12"), true);
  assert.equal(isValidMonth("2026-13"), false);
  assert.equal(isValidMonth("2026-00"), false);
  assert.equal(isValidMonth("2026-6"), false);
  assert.equal(isValidMonth("banana"), false);
  assert.equal(isValidMonth(""), false);
});

test("workingDaysInMonth: weekday count, matches the report's Working Days card", () => {
  assert.equal(workingDaysInMonth("2026-05"), 21); // the report's card shows 21 for the May 2026 period
  assert.equal(workingDaysInMonth("2026-06"), 22); // June 2026 starts on a Monday, 30 days
  assert.equal(workingDaysInMonth("2026-07"), 23);
  assert.equal(workingDaysInMonth("2026-02"), 20); // non-leap February
});

test("isMonthLocked: locked only when non-empty and fully confirmed", () => {
  assert.equal(isMonthLocked([]), false); // never-started month is NOT locked
  assert.equal(isMonthLocked([{ needsReview: true }]), false);
  assert.equal(isMonthLocked([{ needsReview: false }, { needsReview: true }]), false);
  assert.equal(isMonthLocked([{ needsReview: false }, { needsReview: false }]), true);
});

// Regression coverage for the 2026-07-14 fix: a month locked in the app via a
// premature/live submission must not silently stay wrong forever once Power
// BI's real historical archive shows up for it (see sync-etc-history.ts).
test("hasPublishedHistory: true only when at least one row has a real (non-null) value", () => {
  assert.equal(hasPublishedHistory([]), false); // no period rows at all yet
  assert.equal(hasPublishedHistory([{ NewEtc: null }, { NewEtc: null }]), false); // period exists, still unarchived
  assert.equal(hasPublishedHistory([{ NewEtc: null }, { NewEtc: 100 }]), true); // archive has landed
  assert.equal(hasPublishedHistory([{ NewEtc: 0 }]), true); // a real zero still counts as published
});

test("groupStandardFeesRows: routes owned-month rows to ownedWithHistoryNow instead of rowsByMonth", () => {
  type Row = { key: number; month: string };
  const rows: Row[] = [
    { key: 1, month: "2026-04" }, // owned, archive present -> flagged
    { key: 2, month: "2026-04" },
    { key: 3, month: "2026-05" }, // not owned -> grouped normally
    { key: 4, month: "2026-06" }, // owned, archive present -> flagged (dedup across rows)
    { key: 5, month: "2026-06" },
  ];
  const { rowsByMonth, ownedWithHistoryNow, ownedRowsByMonth } = groupStandardFeesRows(rows, (r) => r.month, new Set(["2026-04", "2026-06"]));

  assert.deepEqual(ownedWithHistoryNow, ["2026-04", "2026-06"]); // deduped, one entry per owned month
  assert.deepEqual([...rowsByMonth.keys()], ["2026-05"]); // owned months never make it into rowsByMonth
  assert.equal(rowsByMonth.get("2026-05")?.length, 1);
  // owned rows aren't just flagged and discarded — they're preserved so the
  // caller can reconcile their non-decision fact fields against Power BI.
  assert.deepEqual([...ownedRowsByMonth.keys()].sort(), ["2026-04", "2026-06"]);
  assert.equal(ownedRowsByMonth.get("2026-04")?.length, 2);
  assert.equal(ownedRowsByMonth.get("2026-06")?.length, 2);
});

test("groupStandardFeesRows: an owned month with no Power BI rows at all is never flagged", () => {
  // Mirrors the real June 2026 case: the period doesn't exist in Power BI's
  // archive yet, so it must never falsely trigger the stale-data warning.
  type Row = { month: string };
  const rows: Row[] = [{ month: "2026-04" }];
  const { ownedWithHistoryNow } = groupStandardFeesRows(rows, (r) => r.month, new Set(["2026-04", "2026-06"]));
  assert.deepEqual(ownedWithHistoryNow, ["2026-04"]);
});

test("groupStandardFeesRows: rows with no resolvable month are dropped, not grouped under undefined", () => {
  type Row = { periodKey: number };
  const rows: Row[] = [{ periodKey: 999 }]; // unmapped period key
  const { rowsByMonth, ownedWithHistoryNow } = groupStandardFeesRows(rows, () => undefined, new Set());
  assert.equal(rowsByMonth.size, 0);
  assert.deepEqual(ownedWithHistoryNow, []);
});

// Regression coverage for the 2026-07-14 Run Report corruption bug: proven
// live by reopening a corrected historical month and running the real sync —
// 42 real entries were deleted, 62 wrong ones were injected. This is the
// pure decision logic behind the fix in etc-actions.ts's assertCurrentEtcMonth.
test("isSafeForLiveEtcSync: no month started yet — anything goes", () => {
  assert.equal(isSafeForLiveEtcSync("2026-07", null), true);
});

test("isSafeForLiveEtcSync: refreshing the existing latest month is safe", () => {
  assert.equal(isSafeForLiveEtcSync("2026-06", "2026-06"), true);
});

test("isSafeForLiveEtcSync: starting the very next month is safe (it has no entries yet, so was never 'latest')", () => {
  assert.equal(isSafeForLiveEtcSync("2026-07", "2026-06"), true);
});

test("isSafeForLiveEtcSync: any older month is unsafe, even the one right before latest", () => {
  assert.equal(isSafeForLiveEtcSync("2026-05", "2026-06"), false);
  assert.equal(isSafeForLiveEtcSync("2026-04", "2026-06"), false);
});

test("isSafeForLiveEtcSync: a month further in the future than 'next' is unsafe too", () => {
  assert.equal(isSafeForLiveEtcSync("2026-08", "2026-06"), false);
});

// ── Diff is LIVE on every cell (2026-08-02) ─────────────────────────────────
//
// This reverses the 2026-07-31 rule, which returned null for any cell a manager
// hadn't typed into. That rule was added because the totals showed a large
// overrun off almost no decided cells, and it was read as phantom. Requested
// back by the user: the Diff column was blank across most of the grid for most
// of the month, which hid the one thing it exists to show.
//
// The mechanism is unchanged and worth restating, because it is what makes the
// live number safe to read. An untouched cell compares against the SUGGESTION:
//   • worked 0                  -> suggestion is Prior, Hours Left is Prior  -> 0
//   • worked, hours still left  -> suggestion IS Hours Left                  -> 0
//   • worked PAST Prior ETC     -> suggestion clamps at 0, Hours Left is
//                                  negative                                  -> the overrun
// So an untouched cell is silent unless the section is genuinely overspent.
// Those hours are booked whether or not anyone has typed a New ETC.

// ── The rule, as of 2026-08-03 ──────────────────────────────────────────────
// An UNDECIDED cell has no Diff. Until a manager enters a New ETC there is
// nothing to compare against, so the cell prints EMPTY and contributes 0 to every
// total that sums it. Diff reports decisions.
//
// This column went through three rules in two days, so the discarded ones are
// worth naming: it returned null (the column read "—" everywhere, hiding real
// overruns), then compared an untouched cell against the SUGGESTION (correct but
// unreadable on screen — "77 − blank = 0" beside "−7 − blank = −7"), and now
// reports nothing at all until somebody decides.
test("newEtcDiff: an untouched cell has no variance, whatever is left", () => {
  // Prior 100, worked 40 -> 60 left, but nobody has planned it. 0 means
  // "contributes nothing"; the CELL renders empty — see EtcSectionCells.
  assert.equal(newEtcDiff({ needsReview: true, newEtcDraft: null, newEtc: 0, priorEtc: 100, hoursWorked: 40 }), 0);
});

test("newEtcDiff: an untouched cell with NO hours worked has no variance either", () => {
  assert.equal(newEtcDiff({ needsReview: true, newEtcDraft: null, newEtc: 0, priorEtc: 100, hoursWorked: 0 }), 0);
});

test("newEtcDiff: a DECIDED cell reports its real overrun", () => {
  // Prior 20, worked 50 -> 30 past the estimate; the manager plans 10 more.
  // -30 − 10 = -40.
  assert.equal(newEtcDiff({ needsReview: true, newEtcDraft: 10, newEtc: 0, priorEtc: 20, hoursWorked: 50 }), -40);
});

test("newEtcDiff: a typed New ETC is clamped at 0, never negative", () => {
  // "max(entered, 0)" — a negative plan is not a plan, and letting one through
  // would make Diff read HIGHER than Hours Left.
  assert.equal(newEtcDiff({ needsReview: true, newEtcDraft: -5, newEtc: 0, priorEtc: 100, hoursWorked: 40 }), 60);
});

test("newEtcDiff: typing the suggestion is what makes a cell read on-plan", () => {
  // The same cell as the first test, once a manager accepts the 60. This is the
  // pair that shows the column is now reporting DECISIONS: 60 unaccounted before,
  // 0 after.
  assert.equal(newEtcDiff({ needsReview: true, newEtcDraft: 60, newEtc: 0, priorEtc: 100, hoursWorked: 40 }), 0);
});

test("newEtcDiff: an untouched OVERSPENT cell still reports nothing", () => {
  // Prior 20, worked 50 -> 30 hours past the estimate, and Diff is deliberately
  // silent about it. The overrun is already visible in Hours Left (-30); Diff is
  // about decisions. This is the exact case the 2026-08-02 rule existed to
  // surface here, given up knowingly when the column became decisions-only.
  assert.equal(newEtcDiff({ needsReview: true, newEtcDraft: null, newEtc: 0, priorEtc: 20, hoursWorked: 50 }), 0);
});

test("newEtcDiff: never returns null", () => {
  // The column and every total now render it unconditionally, so a null here
  // would print as NaN rather than as a dash.
  const cases = [
    { needsReview: true, newEtcDraft: null, newEtc: 0, priorEtc: 0, hoursWorked: 0 },
    { needsReview: true, newEtcDraft: null, newEtc: 0, priorEtc: 20, hoursWorked: 50 },
    { needsReview: false, newEtcDraft: null, newEtc: 5, priorEtc: 20, hoursWorked: 5 },
  ];
  for (const c of cases) assert.equal(typeof newEtcDiff(c), "number");
});

test("newEtcDiff: a saved draft is a decision, and is compared", () => {
  // Prior 100, worked 40 -> 60 left; the manager says 80, so 20 over.
  assert.equal(newEtcDiff({ needsReview: true, newEtcDraft: 80, newEtc: 0, priorEtc: 100, hoursWorked: 40 }), -20);
});

test("newEtcDiff: a submitted cell is compared against its confirmed value", () => {
  assert.equal(newEtcDiff({ needsReview: false, newEtcDraft: null, newEtc: 50, priorEtc: 100, hoursWorked: 40 }), 10);
});

test("newEtcDiff: a decided cell that matches what's left is on plan", () => {
  assert.equal(newEtcDiff({ needsReview: true, newEtcDraft: 60, newEtc: 0, priorEtc: 100, hoursWorked: 40 }), 0);
});

test("effectiveNewEtc: forecast still uses the suggestion when undecided", () => {
  // The Total New ETC column is a forecast of what submitting now would write,
  // so it DOES include the suggestion — only the variance excludes it.
  assert.equal(effectiveNewEtc({ needsReview: true, newEtcDraft: null, newEtc: 0, priorEtc: 100, hoursWorked: 40 }), 60);
  assert.equal(effectiveNewEtc({ needsReview: true, newEtcDraft: null, newEtc: 0, priorEtc: 20, hoursWorked: 50 }), 0);
  assert.equal(effectiveNewEtc({ needsReview: true, newEtcDraft: 15, newEtc: 0, priorEtc: 20, hoursWorked: 5 }), 15);
  assert.equal(effectiveNewEtc({ needsReview: false, newEtcDraft: 15, newEtc: 7, priorEtc: 20, hoursWorked: 5 }), 7);
});

// ── The zero-hours carry-forward, pinned at every level it is consumed ──────
//
// "If no hours were worked this month, New ETC carries the prior forward" is the
// oldest rule in this app (ported from the Managers Fill Out sheet, confirmed by Dan)
// and it was re-confirmed as a standing requirement on 2026-08-03.
//
// suggestNewEtc is already covered above, but the rule is READ at three levels and
// only the bottom one was tested. effectiveNewEtc — what the Total New ETC column
// sums and what submitMonth falls back to — had no zero-hours case at all, so the
// composition could have regressed while suggestNewEtc stayed green.
test("carry-forward: a zero-hours cell forecasts its prior, not zero", () => {
  // What the grid totals sum and what Submit would write.
  assert.equal(effectiveNewEtc({ needsReview: true, newEtcDraft: null, newEtc: 0, priorEtc: 80, hoursWorked: 0 }), 80);
  assert.equal(effectiveNewEtc({ needsReview: true, newEtcDraft: null, newEtc: 0, priorEtc: 12, hoursWorked: 0 }), 12);
  // A prior of 0 carries 0 forward — the rule, not an absence of one.
  assert.equal(effectiveNewEtc({ needsReview: true, newEtcDraft: null, newEtc: 0, priorEtc: 0, hoursWorked: 0 }), 0);
});

test("carry-forward: the exact prior survives, unrounded", () => {
  // The BOX displays a whole number, but the forecast and the submitted value must
  // keep the stored figure — rounding here would shave hours off a month's balance
  // every time it carried forward.
  assert.equal(effectiveNewEtc({ needsReview: true, newEtcDraft: null, newEtc: 0, priorEtc: 40.5, hoursWorked: 0 }), 40.5);
  assert.equal(suggestNewEtc(40.5, 0), 40.5);
});

test("carry-forward: an explicit draft still wins — the one designed exception", () => {
  // The rule is the DEFAULT, not a lock: a manager can zero a cancelled scope, and
  // that has to survive. Worth pinning, because 11 of July's zero-hours cells carried
  // an explicit 0 draft written in a single batch on 2026-08-03 — the mechanism is
  // legitimate even when a particular write was not.
  assert.equal(effectiveNewEtc({ needsReview: true, newEtcDraft: 0, newEtc: 0, priorEtc: 80, hoursWorked: 0 }), 0);
  assert.equal(effectiveNewEtc({ needsReview: true, newEtcDraft: 55, newEtc: 0, priorEtc: 0, hoursWorked: 0 }), 55);
  // And an explicit 0 counts as a decision, so nothing re-suggests over it.
  assert.equal(isNewEtcDecided({ needsReview: true, newEtcDraft: 0 }), true);
});

test("carry-forward: no hours worked means no variance to report", () => {
  // Diff must stay silent on a carried-forward cell: nothing was spent, so there is
  // nothing to be over or under by.
  assert.equal(newEtcDiff({ needsReview: true, newEtcDraft: null, newEtc: 0, priorEtc: 80, hoursWorked: 0 }), 0);
});

test("isNewEtcDecided: draft or submitted, nothing else", () => {
  assert.equal(isNewEtcDecided({ needsReview: true, newEtcDraft: null }), false);
  assert.equal(isNewEtcDecided({ needsReview: true, newEtcDraft: 0 }), true); // an explicit zero IS a decision
  assert.equal(isNewEtcDecided({ needsReview: false, newEtcDraft: null }), true);
});

// ── Prior ETC carry-forward source ──────────────────────────────────────────
//
// Found 2026-08-02 on job 1104: seeding read only prevMonth(month) and fell
// back to QUOTED hours when it found nothing, so a job that skipped a single
// period came back at its full original quote instead of the balance it had
// been worked down to — 1420h where it should have been 0. 49 entries across
// 21 jobs were wrong. These pin the rule so it cannot regress quietly, which
// is the only way it would come back: nothing errors, the numbers just inflate.
test("carry-forward uses the latest prior month, not the month before", () => {
  const rows = [
    { jobId: 5, section: "10-211", month: "2026-04", newEtc: 8 },
    { jobId: 5, section: "10-211", month: "2026-05", newEtc: 0 },
    // no 2026-06 row at all — the job dropped out of the active filter
  ];
  const m = latestPriorEtcByKey(rows);
  assert.equal(m.get("5-10-211"), 0, "must resume from May's 0, not fall through to quoted");
});

test("carry-forward is per job AND section, not per job", () => {
  const rows = [
    { jobId: 5, section: "10-211", month: "2026-05", newEtc: 0 },
    { jobId: 5, section: "10-312", month: "2026-03", newEtc: 235 },
    { jobId: 9, section: "10-211", month: "2026-05", newEtc: 77 },
  ];
  const m = latestPriorEtcByKey(rows);
  assert.equal(m.get("5-10-211"), 0);
  assert.equal(m.get("5-10-312"), 235); // its own latest month, not the job's
  assert.equal(m.get("9-10-211"), 77);
});

test("carry-forward month order does not depend on the query's row order", () => {
  // The rule picks the highest month string; it must not depend on the DB
  // handing rows back sorted, which nothing guarantees.
  const ascending = [
    { jobId: 5, section: "10-211", month: "2026-01", newEtc: 40 },
    { jobId: 5, section: "10-211", month: "2026-05", newEtc: 0 },
  ];
  const descending = [...ascending].reverse();
  assert.equal(latestPriorEtcByKey(ascending).get("5-10-211"), 0);
  assert.equal(latestPriorEtcByKey(descending).get("5-10-211"), 0);
});

test("carry-forward compares months correctly across a year boundary", () => {
  const rows = [
    { jobId: 5, section: "10-211", month: "2025-09", newEtc: 12 },
    { jobId: 5, section: "10-211", month: "2026-01", newEtc: 3 },
  ];
  assert.equal(latestPriorEtcByKey(rows).get("5-10-211"), 3);
});

test("no ETC history at all yields nothing, so the caller falls back to quoted", () => {
  // The one case where quoted hours ARE right: a genuinely new job.
  assert.equal(latestPriorEtcByKey([]).get("5-10-211"), undefined);
});

test("a carried balance of 0 is a real value, not 'missing'", () => {
  // The whole bug in one assertion: 0 must survive as 0. A truthiness check
  // anywhere in this path sends it back to quoted hours.
  const m = latestPriorEtcByKey([{ jobId: 5, section: "10-211", month: "2026-05", newEtc: 0 }]);
  assert.ok(m.has("5-10-211"));
  assert.equal(m.get("5-10-211"), 0);
});

// ── priorEtcForMonth / redrivenDraft ──────────────────────────────────────────
// The two rules extracted on 2026-08-04 so that seedMonth, the cascade,
// reopenMonth and syncPartsCost cannot answer "what does this month open at"
// differently. See the June-2026/July-2026 carry-forward incident.

test("priorEtcForMonth: a carried balance wins over the quote", () => {
  assert.equal(priorEtcForMonth({ startsThisMonth: false, carried: 40, quoted: 1420 }), 40);
});

test("priorEtcForMonth: a carried ZERO still wins — the job finished, it did not restart", () => {
  // The parts-cost bug in one assertion (jobs 979 / 1105): falling back to the
  // quote here reopened a spent-down balance at its full original figure.
  assert.equal(priorEtcForMonth({ startsThisMonth: false, carried: 0, quoted: 636234 }), 0);
});

test("priorEtcForMonth: no history at all falls back to the quote", () => {
  assert.equal(priorEtcForMonth({ startsThisMonth: false, carried: undefined, quoted: 700 }), 700);
});

test("priorEtcForMonth: a job STARTING this month opens at its quote regardless", () => {
  // Jobs 1159/1160: rows existed from before anyone typed their quote, carrying 0.
  assert.equal(priorEtcForMonth({ startsThisMonth: true, carried: 0, quoted: 260 }), 260);
  assert.equal(priorEtcForMonth({ startsThisMonth: true, carried: 999, quoted: 260 }), 260);
});

// ── startsInMonth / monthOfDate ───────────────────────────────────────────────
//
// The date half of the opening-balance rule. It decides whether a job is in its
// FIRST ETC month (open at the quote) or a later one (carry forward), so an
// off-by-one-month here is a whole project's Prior ETC reading zero — the
// August 2026 regression. Every edge of the month, and the year, is pinned.

test("startsInMonth: the first and last day of the month both count", () => {
  // A date-only ISO string is UTC midnight per spec, which is how parseDate
  // (quoted-actions.ts) writes every Start Date.
  assert.equal(startsInMonth(new Date("2026-08-01"), "2026-08"), true);
  assert.equal(startsInMonth(new Date("2026-08-31"), "2026-08"), true);
  assert.equal(startsInMonth(new Date("2026-08-15"), "2026-08"), true);
});

test("startsInMonth: the days either side of the month do NOT", () => {
  assert.equal(startsInMonth(new Date("2026-07-31"), "2026-08"), false);
  assert.equal(startsInMonth(new Date("2026-09-01"), "2026-08"), false);
});

test("startsInMonth: a job starting NEXT month is not starting in this one", () => {
  // Job 1170 starting September, viewed while running August: carries forward
  // (or has no row at all), never opens at its quote in August.
  assert.equal(startsInMonth(new Date("2026-09-10"), "2026-08"), false);
});

test("startsInMonth: no Start Date is never 'starts this month'", () => {
  // Otherwise a dateless job would reset to its quote every month forever.
  assert.equal(startsInMonth(null, "2026-08"), false);
  assert.equal(startsInMonth(undefined, "2026-08"), false);
});

test("startsInMonth: the YEAR is compared, not just the month number", () => {
  // January 2027 must not match 2026-01 — the year-boundary case.
  assert.equal(startsInMonth(new Date("2027-01-15"), "2026-01"), false);
  assert.equal(startsInMonth(new Date("2027-01-15"), "2027-01"), true);
  assert.equal(startsInMonth(new Date("2026-12-31"), "2027-01"), false);
  assert.equal(startsInMonth(new Date("2027-01-01"), "2027-01"), true);
});

test("startsInMonth: reads UTC, so a negative-offset zone cannot shift the month", () => {
  // SDC is UTC-4/-5. Local getMonth() on 2026-08-01T00:00:00Z reads July 31st
  // there and would drop the job's first ETC month by one.
  assert.equal(startsInMonth(new Date("2026-08-01T00:00:00.000Z"), "2026-08"), true);
  // And the far edge: late on the 31st UTC is still August, not September.
  assert.equal(startsInMonth(new Date("2026-08-31T23:59:59.000Z"), "2026-08"), true);
});

test("monthOfDate: zero-pads the month so it compares against a YYYY-MM string", () => {
  assert.equal(monthOfDate(new Date("2026-01-05")), "2026-01");
  assert.equal(monthOfDate(new Date("2026-09-05")), "2026-09");
  assert.equal(monthOfDate(new Date("2026-10-05")), "2026-10");
  assert.equal(monthOfDate(new Date("2026-12-05")), "2026-12");
});

// The two halves composed — this is the whole rule as the grid experiences it.
test("opening balance: first ETC month opens at the quote, later months carry forward", () => {
  const open = (startDate: Date | null, month: string, carried: number | undefined, quoted: number) =>
    priorEtcForMonth({ startsThisMonth: startsInMonth(startDate, month), carried, quoted });

  // Job 1163: starts 2026-08-13, quoted 1770 on 10-211, no August history.
  assert.equal(open(new Date("2026-08-13"), "2026-08", undefined, 1770), 1770);
  // Same job the month AFTER it submitted 1500: carries, does NOT revert to 1770.
  assert.equal(open(new Date("2026-08-13"), "2026-09", 1500, 1770), 1500);
  // And a submitted zero in September stays zero in October.
  assert.equal(open(new Date("2026-08-13"), "2026-10", 0, 1770), 0);
  // A July-start job running August with a July submission of 120.
  assert.equal(open(new Date("2026-07-20"), "2026-08", 120, 300), 120);
  // A July-start job whose July submission was legitimately zero.
  assert.equal(open(new Date("2026-07-20"), "2026-08", 0, 300), 0);
  // Quoted zero on a department in its first month is zero, not a fallback.
  assert.equal(open(new Date("2026-08-13"), "2026-08", undefined, 0), 0);
  // No Start Date, no history: nothing to carry, so the quote.
  assert.equal(open(null, "2026-08", undefined, 80), 80);
});

test("redrivenDraft: leaves a manager's own figure alone", () => {
  // 12 is not suggestNewEtc(100, 40) = 60, so somebody typed it. Never touched.
  assert.equal(redrivenDraft({ draft: 12, oldPriorEtc: 100, newPriorEtc: 150, hoursWorked: 40 }), 12);
});

test("redrivenDraft: moves a draft that merely echoed the old suggestion", () => {
  // Prior 100 − worked 40 = 60 was in the box; the Prior then became 150.
  assert.equal(redrivenDraft({ draft: 60, oldPriorEtc: 100, newPriorEtc: 150, hoursWorked: 40 }), 110);
});

test("redrivenDraft: the zero-spend carry-forward moves too", () => {
  // Job 979's parts cell exactly: draft 0 saved while the Prior was still 0,
  // then the Prior became 8600. A stale 0 there would zero a live balance.
  assert.equal(redrivenDraft({ draft: 0, oldPriorEtc: 0, newPriorEtc: 8600, hoursWorked: 0 }), 8600);
});

test("redrivenDraft: an unchanged Prior never rewrites the draft", () => {
  assert.equal(redrivenDraft({ draft: 60, oldPriorEtc: 100, newPriorEtc: 100, hoursWorked: 40 }), 60);
});

test("redrivenDraft: no draft stays no draft", () => {
  assert.equal(redrivenDraft({ draft: null, oldPriorEtc: 0, newPriorEtc: 8600, hoursWorked: 0 }), null);
});

test("redrivenDraft: an overspent cell's clamped zero follows the new Prior", () => {
  // suggestNewEtc clamps at 0, so a draft of 0 on an overspent cell is the
  // suggestion. Prior 800 − spent 7481 → 0; a corrected Prior of 9000 → 1519.
  assert.equal(redrivenDraft({ draft: 0, oldPriorEtc: 800, newPriorEtc: 9000, hoursWorked: 7481 }), 1519);
});
