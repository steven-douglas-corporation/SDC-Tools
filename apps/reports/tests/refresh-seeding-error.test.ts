import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isNotSeedableError } from "../src/lib/refresh-service";

// ── Only "not seedable" may be swallowed (2026-09-14) ───────────────────────
//
// refresh-service.ts wrapped startMonth in `catch {}` and treated EVERY error as
// "nothing to seed". A MySQL failure, a permission refusal or a bug in seeding
// therefore looked exactly like the expected silent case, and a month that failed
// to start was indistinguishable from one that had no reason to.

test("the two guard sentences from assertMonthSeedable are the expected, silent case", () => {
  assert.ok(isNotSeedableError(new Error("2026-08 is still in progress — submit and lock it before starting a new month.")));
  assert.ok(isNotSeedableError(new Error("The next ETC month after 2026-08 is 2026-09 — months must be started in order.")));
});

test("anything else is a real failure and must be surfaced", () => {
  assert.equal(isNotSeedableError(new Error("Can't reach database server at localhost:3306")), false);
  assert.equal(isNotSeedableError(new Error("Forbidden: elt role required")), false);
  assert.equal(isNotSeedableError(new TypeError("Cannot read properties of undefined (reading 'jobId')")), false);
  assert.equal(isNotSeedableError("some string"), false);
});

test("the guard's sentences have not drifted away from what refresh-service matches on", () => {
  // Both fragments must still appear in etc-actions.ts's assertMonthSeedable; if
  // someone rewords the guard, this is the test that says the refresh will start
  // reporting the normal case as an error.
  const src = readFileSync(join(process.cwd(), "src", "lib", "etc-actions.ts"), "utf8");
  assert.match(src, /is still in progress/);
  assert.match(src, /must be started in order/);
});

test("refresh-service no longer has a bare catch around startMonth, and surfaces the error in its result", () => {
  const src = readFileSync(join(process.cwd(), "src", "lib", "refresh-service.ts"), "utf8");
  assert.match(src, /if \(!isNotSeedableError\(err\)\)/, "the catch must branch on the specific error");
  assert.match(src, /seedingError/, "a real seeding failure must reach the outcome");
});
