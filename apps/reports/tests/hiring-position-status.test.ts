import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isOpenHiringStatus,
  isManualJobStatus,
  MANUAL_JOB_STATUSES,
  DEFAULT_MANUAL_JOB_STATUS,
  manualJobStatusOf,
  hiringStatusStyle,
} from "../src/lib/hiring-position-status";

test("isOpenHiringStatus: an ordinary open-sounding status is open", () => {
  assert.equal(isOpenHiringStatus("Published", null, false), true);
  assert.equal(isOpenHiringStatus("Open", null, false), true);
});

test("isOpenHiringStatus: archived always closes it regardless of status text", () => {
  assert.equal(isOpenHiringStatus("Open", null, true), false);
});

test("isOpenHiringStatus: a closed-keyword status closes it even if not archived", () => {
  for (const status of ["Filled", "Closed", "Cancelled", "Canceled", "Withdrawn", "Expired", "On Hold"]) {
    assert.equal(isOpenHiringStatus(status, null, false), false, `expected "${status}" to be closed`);
  }
});

test("isOpenHiringStatus: a closed-keyword sub-status closes it even when the main status looks open", () => {
  assert.equal(isOpenHiringStatus("Published", "Cancelled", false), false);
});

// The whole point of the four-status vocabulary (2026-08-21): the visual
// treatment is new, the open-ness rule is NOT. Open and Published count as
// hiring capacity, On Hold and Filled do not -- exactly as isOpenHiringStatus
// already behaved for the workbook's own values.
test("MANUAL_JOB_STATUSES open-ness is unchanged by the status vocabulary: Open/Published open, On Hold/Filled closed", () => {
  const expected: Record<string, boolean> = { Open: true, Published: true, "On Hold": false, Filled: false };
  for (const status of MANUAL_JOB_STATUSES) {
    assert.equal(isOpenHiringStatus(status, null, false), expected[status], `"${status}" open-ness mismatch`);
  }
});

test("the four statuses are exactly Open/Published/On Hold/Filled, with Cancelled gone and Open the default", () => {
  assert.deepEqual([...MANUAL_JOB_STATUSES], ["Open", "Published", "On Hold", "Filled"]);
  assert.equal(isManualJobStatus("Cancelled"), false);
  assert.equal(DEFAULT_MANUAL_JOB_STATUS, "Open");
});

test("isManualJobStatus rejects free text outside the fixed vocabulary", () => {
  assert.equal(isManualJobStatus("Open"), true);
  assert.equal(isManualJobStatus("Published"), true);
  assert.equal(isManualJobStatus("Cancelled"), false);
  assert.equal(isManualJobStatus(""), false);
});

test("manualJobStatusOf normalizes case and whitespace so a workbook spelling still matches", () => {
  assert.equal(manualJobStatusOf("published"), "Published");
  assert.equal(manualJobStatusOf("  On Hold "), "On Hold");
  assert.equal(manualJobStatusOf("ON HOLD"), "On Hold");
});

test("manualJobStatusOf does NOT coerce an off-vocabulary status into one of the four", () => {
  // A workbook row still worded "Cancelled"/"Withdrawn" must keep its own
  // text rather than being relabelled Filled -- it is still CLOSED for
  // counting purposes (isOpenHiringStatus, above), just not renamed.
  for (const raw of ["Cancelled", "Withdrawn", "Expired", "Closed"]) {
    assert.equal(manualJobStatusOf(raw), null, `"${raw}" should not map to one of the four`);
    assert.equal(isOpenHiringStatus(raw, null, false), false, `"${raw}" should still count as closed`);
  }
});

test("hiringStatusStyle gives each of the four a distinct accent/tint/pill, and never an empty class", () => {
  const seen = new Set<string>();
  for (const status of MANUAL_JOB_STATUSES) {
    const style = hiringStatusStyle(status);
    assert.equal(style.label, status);
    for (const cls of [style.accent, style.tint, style.pill, style.dot]) {
      assert.ok(cls.trim().length > 0, `"${status}" has an empty class`);
    }
    seen.add(style.accent);
  }
  assert.equal(seen.size, MANUAL_JOB_STATUSES.length, "two statuses share a left accent");
});

test("hiringStatusStyle falls back to the neutral treatment and keeps the raw text for an unknown status", () => {
  assert.equal(hiringStatusStyle("Cancelled").label, "Cancelled");
  assert.equal(hiringStatusStyle("  ").label, "Unknown");
  assert.equal(hiringStatusStyle("Cancelled").pill, hiringStatusStyle("Filled").pill);
});
