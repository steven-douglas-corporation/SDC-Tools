import { test } from "node:test";
import assert from "node:assert/strict";
import { withTimeout, withTimeoutOrNull, TimeoutError, UPSTREAM_BUDGET_MS } from "../src/lib/with-timeout";

// ── A time budget for an external system (§69) ───────────────────────────────
//
// The Job Hour Details page returned 200 in 2.0–3.9 MINUTES because two TotalETO
// queries took 110.5s and 101.7s (measured 2026-08-06) and nothing bounded them —
// mssql's own requestTimeout is 120s. The page already knew how to render without
// those figures; it just never got the chance to.
//
// These pin the three properties the page depends on: a fast call is unaffected, a
// slow one gives up on time, and giving up is reported in a way the caller can tell
// apart from a crash.

const slower = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a call inside the budget returns its value untouched", () => {
  return withTimeout("fast thing", 1000, Promise.resolve({ rows: 3 })).then((v) =>
    assert.deepEqual(v, { rows: 3 }),
  );
});

test("a call over the budget rejects with a TimeoutError that names the system", async () => {
  await assert.rejects(
    () => withTimeout("TotalETO parts", 20, slower(500)),
    (e: unknown) => {
      assert.ok(e instanceof TimeoutError, "callers branch on this type, so it must survive");
      assert.equal(e.label, "TotalETO parts", "the log has to say WHICH upstream");
      assert.equal(e.ms, 20);
      assert.match(e.message, /did not respond within 20ms/);
      return true;
    },
  );
});

test("a real rejection is passed through, not relabelled as a timeout", async () => {
  // "TotalETO refused the connection" and "TotalETO never answered" are different
  // operational problems; only one of them means look at the network.
  const boom = new Error("Login failed for user");
  await assert.rejects(
    () => withTimeout("TotalETO parts", 1000, Promise.reject(boom)),
    (e: unknown) => e === boom,
  );
});

test("withTimeoutOrNull reports null for BOTH a timeout and a failure", async () => {
  // The page's fallback is the same either way ("Parts Cost is unavailable"), and making
  // every caller write that two-branch catch is how one of them ends up missing a branch.
  assert.equal(await withTimeoutOrNull("slow", 20, () => slower(500)), null);
  assert.equal(await withTimeoutOrNull("broken", 1000, () => Promise.reject(new Error("nope"))), null);
  // …and a value still comes back as a value.
  assert.deepEqual(await withTimeoutOrNull("fine", 1000, () => Promise.resolve([1, 2])), [1, 2]);
});

test("withTimeoutOrNull hands the real error to the logger", async () => {
  const seen: unknown[] = [];
  await withTimeoutOrNull("TotalETO BOM", 20, () => slower(500), (e) => seen.push(e));
  assert.equal(seen.length, 1);
  assert.ok(seen[0] instanceof TimeoutError, "the log must be able to say it timed out");

  const failure = new Error("connection reset");
  const seen2: unknown[] = [];
  await withTimeoutOrNull("TotalETO BOM", 1000, () => Promise.reject(failure), (e) => seen2.push(e));
  assert.equal(seen2[0], failure, "…and must get the original error otherwise");
});

test("a synchronous throw inside the work function is caught too", async () => {
  // `() => { throw }` never produces a promise, so a naive Promise.race would let it
  // escape past the budget and crash the render instead of degrading.
  assert.equal(
    await withTimeoutOrNull("bad caller", 1000, () => {
      throw new Error("thrown before any await");
    }),
    null,
  );
});

test("the timer does not outlive a fast call", async () => {
  // This runs during a server render, so a leaked 12s timer is a leak PER REQUEST. If the
  // timer were left pending, node would stay alive for the rest of the budget — asserting
  // it resolves far sooner than the budget is the observable form of that.
  const t0 = Date.now();
  await withTimeout("fast", 5000, Promise.resolve(1));
  assert.ok(Date.now() - t0 < 500, `resolved in ${Date.now() - t0}ms, so it did not wait out the budget`);
});

test("the budget is generous against the measured healthy case, and finite", () => {
  // A healthy TotalETO answers in ~1–3s (this page rendered end to end in 3.1s the same
  // day it was measured at 110s). Too tight and a slow-but-working day starts reporting
  // "unavailable", which reads as a bug; unbounded is the defect being fixed.
  assert.ok(UPSTREAM_BUDGET_MS >= 8_000, `${UPSTREAM_BUDGET_MS}ms would fail on a merely busy upstream`);
  assert.ok(UPSTREAM_BUDGET_MS <= 30_000, `${UPSTREAM_BUDGET_MS}ms is long enough that the page still reads as hung`);
});
