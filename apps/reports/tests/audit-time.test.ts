import { test } from "node:test";
import assert from "node:assert/strict";
import { formatAuditWhen } from "../src/lib/audit-time";

test("shows Eastern Standard Time in winter (UTC-5)", () => {
  assert.equal(formatAuditWhen(new Date("2026-11-06T19:00:00Z")), "2026-11-06 14:00");
});

test("shows Eastern Daylight Time in summer (UTC-4)", () => {
  assert.equal(formatAuditWhen(new Date("2026-07-15T18:30:00Z")), "2026-07-15 14:30");
});

test("an evening change keeps its own date, not the next day's", () => {
  assert.equal(formatAuditWhen(new Date("2026-11-07T02:15:00Z")), "2026-11-06 21:15");
});

test("midnight is 00, not 24", () => {
  assert.equal(formatAuditWhen(new Date("2026-11-06T05:00:00Z")), "2026-11-06 00:00");
});
