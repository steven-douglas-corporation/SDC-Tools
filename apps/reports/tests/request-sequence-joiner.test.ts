import { test } from "node:test";
import assert from "node:assert/strict";
import { sequenced, abandonLane, __resetLanes } from "../src/lib/request-sequence";

// ── A joiner is judged by the owner's rule (2026-09-14) ─────────────────────
//
// abandonLane sets applied = issued on purpose, and the joiner's check used to read
// `issued !== applied && inFlightKey !== key` — false after an abandon — so a request
// that joined an in-flight one returned ok:true for a lane that had just been told to
// forget everything in flight. Contrary to the abandonLane contract, and silent.
//
// Extends tests/request-sequence.test.ts.

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const never = () => Promise.reject(new Error("a joiner must not start its own request"));

test("a joiner of an ABANDONED request is stale, like the owner", async () => {
  __resetLanes();
  const a = deferred<string>();
  const owner = sequenced("panel", "k", () => a.promise);
  const joiner = sequenced("panel", "k", never);
  abandonLane("panel"); // the panel closed
  a.resolve("late answer");
  const [o, j] = await Promise.all([owner, joiner]);
  assert.deepEqual(o, { ok: false, reason: "stale" });
  assert.deepEqual(j, { ok: false, reason: "stale" }, "the joiner must not apply what the lane abandoned");
});

test("a joiner superseded by a DIFFERENT request that already finished is stale", async () => {
  __resetLanes();
  const a = deferred<string>();
  const b = deferred<string>();
  const owner = sequenced("table", "Active", () => a.promise);
  const joiner = sequenced("table", "Active", never);
  const newer = sequenced("table", "HeadStart", () => b.promise);
  b.resolve("HeadStart rows"); // newer finishes FIRST, so issued === applied again
  assert.deepEqual(await newer, { ok: true, value: "HeadStart rows", deduped: false });
  a.resolve("Active rows");
  const [o, j] = await Promise.all([owner, joiner]);
  assert.deepEqual(o, { ok: false, reason: "stale" });
  assert.deepEqual(j, { ok: false, reason: "stale" }, "issued === applied is not evidence the joined request is current");
});

test("a joiner of a request that is still the newest gets the shared answer", async () => {
  __resetLanes();
  const a = deferred<string>();
  const owner = sequenced("table", "k", () => a.promise);
  const joiner = sequenced("table", "k", never);
  a.resolve("v");
  assert.deepEqual(await owner, { ok: true, value: "v", deduped: false });
  assert.deepEqual(await joiner, { ok: true, value: "v", deduped: true });
});

test("a joiner of a request that FAILS after an abandon is stale, not an error", async () => {
  __resetLanes();
  const a = deferred<string>();
  const owner = sequenced("lane", "k", () => a.promise);
  const joiner = sequenced("lane", "k", never);
  abandonLane("lane");
  a.reject(new Error("boom"));
  const [o, j] = await Promise.all([owner, joiner]);
  assert.equal(o.ok, false);
  assert.equal(o.reason, "stale");
  assert.equal(j.ok, false);
  assert.equal(j.reason, "stale", "nobody is waiting for this answer, so no error surfaces");
});

test("a joiner of a request that FAILS while still current reports the error", async () => {
  __resetLanes();
  const a = deferred<string>();
  const owner = sequenced("lane2", "k", () => a.promise);
  const joiner = sequenced("lane2", "k", never);
  a.reject(new Error("boom"));
  const [o, j] = await Promise.all([owner, joiner]);
  assert.equal(o.ok, false);
  assert.equal(o.reason, "error");
  assert.equal(j.ok, false);
  assert.equal(j.reason, "error");
});
