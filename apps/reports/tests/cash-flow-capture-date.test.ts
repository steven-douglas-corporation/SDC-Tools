import { test } from "node:test";
import assert from "node:assert/strict";
import { snapshotDateFor } from "../src/lib/cash-flow-capture";
import { currentMonth } from "../src/lib/etc";

// ── A snapshot is filed under the LOCAL calendar day (2026-09-14) ───────────
//
// `new Date(ts.toISOString().slice(0, 10))` took the UTC day. The server runs
// UTC-4, so any capture at 20:00 local or later was filed under tomorrow, and the
// "prior month-end" lookup on CashFlowSnapshot.snapshotDate missed the evening
// capture that closed the month. The day now follows the app's own convention —
// local server time, as lib/etc.ts's currentMonth() does — stored as midnight UTC
// of that date (what a Prisma @db.Date column keeps).

const dateKey = (d: Date) => d.toISOString().slice(0, 10);
const localKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

test("a 21:00 local capture is filed under the local date, not the UTC one", () => {
  const ts = new Date(2026, 8, 14, 21, 0, 0); // 2026-09-14 21:00 local, whatever the zone
  const snapshotDate = snapshotDateFor(ts);
  assert.equal(dateKey(snapshotDate), "2026-09-14");
  assert.equal(dateKey(snapshotDate), localKey(ts));
  // Stored as midnight UTC of that day — the DATE column's own representation.
  assert.equal(snapshotDate.getUTCHours(), 0);
  assert.equal(snapshotDate.getUTCMinutes(), 0);
});

test("the last capture of a month, late in the evening, stays in that month", () => {
  // 2026-08-31 23:30 local. Under the old UTC-day rule, on a UTC-4 server this was
  // 2026-09-01 — and the August month-end lookup found nothing.
  const ts = new Date(2026, 7, 31, 23, 30, 0);
  assert.equal(dateKey(snapshotDateFor(ts)), "2026-08-31");
  // Same month the rest of the app would say it is "now" for that instant.
  assert.equal(dateKey(snapshotDateFor(ts)).slice(0, 7), currentMonth(ts));
});

test("an early-morning capture is unaffected, and the function is stable across the day", () => {
  const morning = new Date(2026, 8, 14, 6, 15, 0);
  const evening = new Date(2026, 8, 14, 22, 45, 0);
  assert.equal(dateKey(snapshotDateFor(morning)), "2026-09-14");
  assert.equal(snapshotDateFor(morning).getTime(), snapshotDateFor(evening).getTime(), "one calendar day, one snapshotDate");
});
