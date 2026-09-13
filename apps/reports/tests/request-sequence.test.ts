import { test } from "node:test";
import assert from "node:assert/strict";
import { sequenced, abandonLane, laneIsBusy, __resetLanes } from "../src/lib/request-sequence";

// Ordering guarantees for client-side async reads (§32.2). The failure being
// pinned here is silent — an older filter response overwrites a newer one and the
// table quietly disagrees with the control above it — so the exact interleavings
// are spelled out rather than described.

// A promise whose resolution this test controls, so "B finishes before A" is a
// fact of the test rather than a race against a timer.
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("the spec's scenario: the LATER-issued request wins even though it finished first", async () => {
  __resetLanes();
  const a = deferred<string>();
  const b = deferred<string>();

  // 1. user selects Active
  const runA = sequenced("table", "Active", () => a.promise);
  // 2. user immediately selects HeadStart
  const runB = sequenced("table", "HeadStart", () => b.promise);

  // 3. the HeadStart request finishes first
  b.resolve("HeadStart rows");
  const outB = await runB;
  assert.deepEqual(outB, { ok: true, value: "HeadStart rows", deduped: false });

  // 4. the older Active response finishes later — and must NOT be applied.
  a.resolve("Active rows");
  const outA = await runA;
  assert.equal(outA.ok, false);
  assert.equal(outA.ok === false && outA.reason, "stale");
});

test("an older response is refused even when it resolves in the same tick as the newer one", async () => {
  __resetLanes();
  const a = deferred<number>();
  const b = deferred<number>();
  const runA = sequenced("table", "a", () => a.promise);
  const runB = sequenced("table", "b", () => b.promise);

  // Both settle before either handler runs — the case a plain "am I the newest
  // issued?" check gets right only by accident, which is why `applied` exists too.
  a.resolve(1);
  b.resolve(2);
  const [outA, outB] = await Promise.all([runA, runB]);

  assert.equal(outB.ok, true, "the newest issued request is the one that applies");
  assert.equal(outA.ok, false);
});

test("ordering is per lane — unrelated reads finishing out of order are both applied", async () => {
  __resetLanes();
  const kpi = deferred<string>();
  const drill = deferred<string>();
  const runKpi = sequenced("kpi", "july", () => kpi.promise);
  const runDrill = sequenced("drill", "july", () => drill.promise);

  drill.resolve("punch rows");
  kpi.resolve("cards");

  // Neither supersedes the other: they keep different things current, so calling
  // one stale would drop a result nothing else is going to supply.
  assert.equal((await runKpi).ok, true);
  assert.equal((await runDrill).ok, true);
});

test("an identical repeat joins the in-flight request instead of issuing a second one", async () => {
  __resetLanes();
  let calls = 0;
  const d = deferred<string>();
  const work = () => {
    calls += 1;
    return d.promise;
  };

  // A double-click, or two components asking for the same panel at once.
  const first = sequenced("drill", "job-42", work);
  const second = sequenced("drill", "job-42", work);
  d.resolve("rows");

  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls, 1, "one action, one request (§32.3)");
  assert.equal(a.ok, true);
  assert.equal(b.ok, true, "the joiner still gets the answer");
  assert.equal(b.ok === true && b.deduped, true, "and is told it shared a request");
});

test("a DIFFERENT key in the same lane does issue its own request", async () => {
  __resetLanes();
  let calls = 0;
  const d1 = deferred<string>();
  const d2 = deferred<string>();
  const queue = [d1.promise, d2.promise];
  const work = () => {
    calls += 1;
    return queue[calls - 1];
  };

  const first = sequenced("drill", "job-42", work);
  const second = sequenced("drill", "job-99", work);
  assert.equal(calls, 2, "different question, different request");

  d1.resolve("42 rows");
  d2.resolve("99 rows");
  assert.equal((await second).ok, true);
  assert.equal((await first).ok, false, "and the first is superseded");
});

test("a failure is reported to the caller that is still current", async () => {
  __resetLanes();
  const d = deferred<string>();
  const run = sequenced("table", "x", () => d.promise);
  d.reject(new Error("network down"));

  const out = await run;
  assert.equal(out.ok, false);
  assert.equal(out.ok === false && out.reason, "error");
  assert.match(out.ok === false ? String((out.error as Error).message) : "", /network down/);
});

test("a failure from a SUPERSEDED request is reported as stale, not as an error", async () => {
  __resetLanes();
  const a = deferred<string>();
  const b = deferred<string>();
  const runA = sequenced("table", "a", () => a.promise);
  const runB = sequenced("table", "b", () => b.promise);

  b.resolve("newer rows");
  await runB;
  a.reject(new Error("the abandoned one blew up"));

  // Surfacing this as an error would put a failure message on screen for a
  // request whose answer is no longer wanted, and invite the user to retry
  // something that has already been replaced (§32.11).
  const outA = await runA;
  assert.equal(outA.ok === false && outA.reason, "stale");
});

test("abandonLane stops an in-flight result from ever being applied", async () => {
  __resetLanes();
  const d = deferred<string>();
  const run = sequenced("drill", "job-42", () => d.promise);

  abandonLane("drill"); // panel closed / tab left
  d.resolve("rows nobody is looking at any more");

  assert.equal((await run).ok, false);
});

test("a lane reports busy only while something is actually running", async () => {
  __resetLanes();
  assert.equal(laneIsBusy("drill"), false);
  const d = deferred<string>();
  const run = sequenced("drill", "k", () => d.promise);
  assert.equal(laneIsBusy("drill"), true, "a section-level indicator has something to show");
  d.resolve("done");
  await run;
  assert.equal(laneIsBusy("drill"), false, "and stops as soon as it lands");
});

test("a slow loser does not clear the winner's in-flight slot", async () => {
  __resetLanes();
  const a = deferred<string>();
  const b = deferred<string>();
  const runA = sequenced("table", "a", () => a.promise);
  const runB = sequenced("table", "b", () => b.promise);

  // A resolves last. Its `finally` must not wipe B's in-flight record, or an
  // identical repeat of B would start a second request behind B's back.
  a.resolve("a");
  await runA;
  assert.equal(laneIsBusy("table"), true, "B is still in flight");

  b.resolve("b");
  await runB;
  assert.equal(laneIsBusy("table"), false);
});
