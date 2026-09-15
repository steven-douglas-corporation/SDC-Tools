import { test } from "node:test";
import assert from "node:assert/strict";
import { runBounded, BOM_QUERY_CONCURRENCY, BOM_QUERY_COUNT } from "../src/lib/job-bom";

// ── The six BOM queries no longer all go out at once (2026-09-14) ───────────
//
// One Promise.all over six statements, six jobs at a time, against a pool of five
// was 36 acquires on 5 connections: tarn timed the queue out, classifyTotalEto
// called it pool_exhausted, the retry policy called that transient, and the walk
// finally swallowed it as an EMPTY bom — which Build Readiness stored as "No BOM"
// for jobs that have one. runBounded is the helper that caps the fan-out; these
// pin the three properties the walk depends on.

const tick = () => new Promise<void>((r) => setTimeout(r, 2));

test("never more than `limit` tasks are in flight, and results keep their order", async () => {
  let inFlight = 0;
  let peak = 0;
  const tasks = [5, 1, 4, 2, 3, 0].map((v, i) => async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await tick();
    await tick();
    inFlight--;
    return `${i}:${v}`;
  });
  const out = await runBounded(tasks, 2);
  assert.equal(peak, 2, "the cap is the whole point");
  assert.deepEqual(out, ["0:5", "1:1", "2:4", "3:2", "4:3", "5:0"], "results are by task index, not completion order");
});

test("the first failure rejects the whole walk and stops starting new tasks", async () => {
  // Five good result sets and one missing one is not a BOM — the caller must see
  // the failure, not a partial tree. And a pool-starved walk must not keep queuing
  // the statements it has not started yet.
  let started = 0;
  const tasks = [
    async () => {
      started++;
      await tick();
      throw Object.assign(new Error("Timeout: Request failed to complete in 120000ms"), { code: "ETIMEOUT" });
    },
    async () => {
      started++;
      await tick();
      await tick();
      await tick();
      return "b";
    },
    async () => {
      started++;
      return "c";
    },
    async () => {
      started++;
      return "d";
    },
  ];
  await assert.rejects(() => runBounded(tasks, 2), /Request failed to complete/);
  assert.ok(started <= 3, `tasks after the failure must not be started (started ${started})`);
});

test("a limit wider than the task list, or below 1, is harmless", async () => {
  assert.deepEqual(await runBounded([async () => 1, async () => 2], 10), [1, 2]);
  assert.deepEqual(await runBounded([async () => 1], 0), [1]);
  assert.deepEqual(await runBounded([], 3), []);
});

test("the walk's own fan-out is small and declared where the pass can read it", () => {
  assert.equal(BOM_QUERY_COUNT, 6, "SPECS, TOP, BOM, PO, PULLS, PROCESS");
  assert.ok(BOM_QUERY_CONCURRENCY >= 1 && BOM_QUERY_CONCURRENCY <= 3, "2-3 at a time; six at once is the starvation case");
});
