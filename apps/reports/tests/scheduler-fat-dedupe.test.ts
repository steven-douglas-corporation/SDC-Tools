import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupeFats, type SchedulerFatEvent } from "../src/lib/scheduler-db";

// ── One FAT per (job, date, kind) ───────────────────────────────────────────
//
// dedupeFats now has TWO consumers: the Dashboard's FAT KPI cards and its
// Execution Calendar. They must count a month identically, and they only do
// that for as long as they run this same function — which is why it moved out
// of dashboard-overview.ts and into scheduler-db.ts, beside the reader whose
// rows it collapses.
//
// The bug that put it here (2026-08-28): the calendar built its events straight
// off fetchSchedulerFatEvents without de-duplicating, and showed 8 FATs in
// August 2026 against the KPI's 7 — job 1138 carries both "FAT" and
// "1138 - Shade-O-Matic FAT" on the 19th. Two chips for one real event, and a
// count that disagreed with the card beside it.

const base: SchedulerFatEvent = {
  taskId: 1,
  name: "FAT",
  project: "1138_Shade O Matic",
  jobNumber: "1138",
  date: "2026-08-19",
  assignee: null,
  machine: null,
  kind: "fat",
  progress: 0,
};
const ev = (over: Partial<SchedulerFatEvent>): SchedulerFatEvent => ({ ...base, ...over });

test("two task names for the same job, date and kind collapse to one", () => {
  const out = dedupeFats([
    ev({ taskId: 6274, name: "1138 - Shade-O-Matic FAT" }),
    ev({ taskId: 6278, name: "FAT" }),
  ]);
  assert.equal(out.length, 1);
});

test("the row that names a person wins", () => {
  // An assigned row is the one worth showing — it is the only one that can
  // answer "who is running this".
  const out = dedupeFats([ev({ taskId: 1, assignee: null }), ev({ taskId: 2, assignee: "Justin Stanko" })]);
  assert.equal(out.length, 1);
  assert.equal(out[0].assignee, "Justin Stanko");

  // …and order must not decide it.
  const reversed = dedupeFats([ev({ taskId: 2, assignee: "Justin Stanko" }), ev({ taskId: 1, assignee: null })]);
  assert.equal(reversed[0].assignee, "Justin Stanko");
});

test("a Pre-FAT and a FAT on the same job and day are DIFFERENT events", () => {
  // kind is part of the key. Collapsing these would lose the readiness run and
  // silently drop one from the Pre-FAT count.
  const out = dedupeFats([ev({ taskId: 1, kind: "fat" }), ev({ taskId: 2, kind: "pre", name: "Pre FAT" })]);
  assert.equal(out.length, 2);
});

test("the same job on two different dates stays two events", () => {
  // Job 1137 really does have a FAT on 2026-08-14 and another on 2026-08-19.
  const out = dedupeFats([
    ev({ taskId: 6220, jobNumber: "1137", date: "2026-08-14" }),
    ev({ taskId: 6225, jobNumber: "1137", date: "2026-08-19" }),
  ]);
  assert.equal(out.length, 2);
});

test("different jobs on one date stay separate", () => {
  const out = dedupeFats([ev({ taskId: 1, jobNumber: "1136" }), ev({ taskId: 2, jobNumber: "1138" })]);
  assert.equal(out.length, 2);
});

test("two schedules for one job on one date collapse — machine is NOT part of the key", () => {
  // Deliberate: the key is (job, date, kind), matching what the FAT KPI counts.
  // If per-machine FATs on the same day should ever count separately, that is a
  // change to the KPI definition too, not something the calendar decides alone.
  const out = dedupeFats([
    ev({ taskId: 1, project: "1101- Steris Coil Staker QTY (8)", jobNumber: "1101", machine: "M2" }),
    ev({ taskId: 2, project: "1101_Steris_Test", jobNumber: "1101", machine: "M3" }),
  ]);
  assert.equal(out.length, 1);
});

test("an empty feed yields an empty list rather than throwing", () => {
  assert.deepEqual(dedupeFats([]), []);
});
