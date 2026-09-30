import { test } from "node:test";
import assert from "node:assert/strict";
import { combineHourSources, olderSourcesUnavailable, snapshotBeforeRange } from "../src/lib/hours-by-source";
import { SNAPSHOT_THROUGH_MONTH, supersededBySnapshot } from "../src/lib/actual-hours";

// The Hours page's "Hours by source" band (2026-09-30). The rule under test: January
// 2025 punches on a job with a migration snapshot are already inside it, so they are
// listed but not added again — nothing is ever subtracted from the snapshot.

test("the overlap is left out of the total, never subtracted from the snapshot", () => {
  const s = combineHourSources({ punches: 1000, overlap: 120, snapshot: 5000, frozen: 300 });
  assert.equal(s.punchesCounted, 880);
  assert.equal(s.snapshot, 5000, "the snapshot is shown whole");
  assert.equal(s.total, 880 + 5000 + 300);
});

test("no overlap: the total is simply the three sources", () => {
  assert.equal(combineHourSources({ punches: 40, overlap: 0, snapshot: 10, frozen: 5 }).total, 55);
});

test("an overlap can never exceed the punches it is part of", () => {
  const s = combineHourSources({ punches: 10, overlap: 12, snapshot: 0, frozen: 0 });
  assert.equal(s.overlap, 10);
  assert.equal(s.punchesCounted, 0);
});

test("no combined total when an older source can't honour the filters", () => {
  const s = combineHourSources({ punches: 100, overlap: 5, snapshot: null, frozen: null });
  assert.equal(s.total, null);
  assert.equal(s.punches, 100, "the punches are still shown");
  assert.ok(olderSourcesUnavailable({ employeeIds: ["100001"] }));
  assert.ok(olderSourcesUnavailable({ departments: ["Engineering"] }));
  assert.equal(olderSourcesUnavailable({}), null);
});

test("a range starting after the snapshot's last month leaves the snapshot out", () => {
  assert.equal(snapshotBeforeRange("2025-02", SNAPSHOT_THROUGH_MONTH), true);
  assert.equal(snapshotBeforeRange(SNAPSHOT_THROUGH_MONTH, SNAPSHOT_THROUGH_MONTH), false, "January 2025 is still inside it");
  assert.equal(snapshotBeforeRange(undefined, SNAPSHOT_THROUGH_MONTH), false);
});

test("the band's overlap is exactly the months the reports' own rule supersedes", () => {
  // loadHoursBySource counts punches with month <= SNAPSHOT_THROUGH_MONTH on a job
  // with a snapshot; supersededBySnapshot is the rule loadActualHoursBySection uses.
  for (const month of ["2024-12", "2025-01", "2025-02", "2026-09"]) {
    assert.equal(supersededBySnapshot(month, true), month <= SNAPSHOT_THROUGH_MONTH);
    assert.equal(supersededBySnapshot(month, false), false, "a job without a snapshot keeps every punch");
  }
});
