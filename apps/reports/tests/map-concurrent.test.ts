import { test } from "node:test";
import assert from "node:assert/strict";
import { mapWithConcurrency } from "../src/lib/map-concurrent";

// The ceiling is the whole point: getPartsCostFinancials makes one live Total ETO
// call per job, and lifting the 12-job cap is only safe if 59 jobs does NOT mean
// 59 simultaneous upstream requests.

// A deferred promise, so a test can hold calls open and observe how many are in
// flight rather than relying on timers.
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

test("results come back in input order, not completion order", () => {
  // Positionally aligned like Promise.all, so callers zipping results against
  // their input keep working. Resolved out of order on purpose.
  const gates = [deferred<string>(), deferred<string>(), deferred<string>()];
  const run = mapWithConcurrency([0, 1, 2], 3, (i) => gates[i].promise);
  gates[2].resolve("c");
  gates[0].resolve("a");
  gates[1].resolve("b");
  return run.then((out) => assert.deepEqual(out, ["a", "b", "c"]));
});

test("never exceeds the limit, and keeps every slot busy", async () => {
  let inFlight = 0;
  let peak = 0;
  const order: number[] = [];
  await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 4, async (i) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    // Yield a few times so the scheduler can interleave workers.
    await Promise.resolve();
    await Promise.resolve();
    order.push(i);
    inFlight--;
    return i;
  });
  assert.equal(peak, 4, "four in flight at the peak, never five");
  assert.equal(order.length, 20, "every item ran exactly once");
  assert.deepEqual([...order].sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i));
});

test("one slow item does not idle the other slots", async () => {
  // The reason this uses a shared cursor rather than pre-sliced chunks: with
  // chunking, a batch containing one slow call leaves its siblings' slots empty
  // until that call finishes. Total ETO response times vary a lot job to job.
  const slow = deferred<string>();
  const finished: number[] = [];
  const run = mapWithConcurrency([0, 1, 2, 3, 4], 2, async (i) => {
    if (i === 0) return slow.promise.then(() => { finished.push(0); return "slow"; });
    finished.push(i);
    return `fast-${i}`;
  });
  // Let the fast ones drain while item 0 is still pending.
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(finished, [1, 2, 3, 4], "the free slot worked through the rest");
  slow.resolve("go");
  const out = await run;
  assert.deepEqual(out, ["slow", "fast-1", "fast-2", "fast-3", "fast-4"]);
});

test("an empty list resolves immediately to an empty array", async () => {
  assert.deepEqual(await mapWithConcurrency([], 8, async () => "never"), []);
});

test("a limit larger than the list is harmless", async () => {
  assert.deepEqual(await mapWithConcurrency([1, 2], 100, async (n) => n * 2), [2, 4]);
});

test("a nonsense limit degrades to sequential rather than hanging", async () => {
  // A caller passing 0 must not produce a promise that never settles — with
  // zero workers, nothing would ever pull from the queue.
  assert.deepEqual(await mapWithConcurrency([1, 2, 3], 0, async (n) => n), [1, 2, 3]);
  assert.deepEqual(await mapWithConcurrency([1, 2, 3], -5, async (n) => n), [1, 2, 3]);
  assert.deepEqual(await mapWithConcurrency([1, 2, 3], 1.7, async (n) => n), [1, 2, 3]);
});

test("the index is passed through", async () => {
  assert.deepEqual(await mapWithConcurrency(["a", "b", "c"], 2, async (v, i) => `${i}:${v}`), ["0:a", "1:b", "2:c"]);
});

test("a rejection propagates, like Promise.all", async () => {
  await assert.rejects(
    () => mapWithConcurrency([1, 2, 3], 2, async (n) => { if (n === 2) throw new Error("boom"); return n; }),
    /boom/,
  );
});
