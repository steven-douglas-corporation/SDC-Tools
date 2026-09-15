import { test } from "node:test";
import assert from "node:assert/strict";
import { probeWithRetry, healthResponse, PROBE_TIMEOUT_MS, PROBE_ATTEMPTS } from "../src/lib/health-probe";

// ── /api/health and /health say something true (2026-09-14) ─────────────────
//
// Both returned 200 `{ status: "ok" }` unconditionally, so a process that had lost
// MySQL looked healthy to the launcher. They now run one SELECT 1 with a 2s budget
// and ONE retry — enough that a single blip does not flap the tile, and a real
// outage still reads as 503 degraded.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a database that answers is ok on the first attempt", async () => {
  let calls = 0;
  const p = await probeWithRetry(async () => {
    calls++;
    return [{ 1: 1 }];
  });
  assert.equal(p.ok, true);
  assert.equal(calls, 1);
});

test("one blip is absorbed by the single retry — the tile must not flap", async () => {
  let calls = 0;
  const p = await probeWithRetry(async () => {
    calls++;
    if (calls === 1) throw new Error("Can't reach database server");
    return 1;
  });
  assert.equal(p.ok, true);
  assert.equal(calls, 2);
});

test("a database that never answers is degraded, quickly, and names the reason", async () => {
  let calls = 0;
  const p = await probeWithRetry(
    async () => {
      calls++;
      await sleep(200); // longer than the probe's own budget
    },
    { timeoutMs: 15, attempts: 2 },
  );
  assert.equal(p.ok, false);
  assert.equal(calls, 2, "exactly one retry — not a loop that hides the outage");
  if (!p.ok) assert.match(p.error, /did not answer within 15ms/);
  assert.ok(p.ms < 150, "the probe must stay fast whatever the database is doing");
});

test("two consecutive failures are reported as unreachable", async () => {
  const p = await probeWithRetry(async () => {
    throw new Error("ECONNREFUSED");
  });
  assert.equal(p.ok, false);
  if (!p.ok) assert.match(p.error, /ECONNREFUSED/);
});

test("the response is 200 db:ok when healthy and 503 degraded/unreachable when not, and never cached", async () => {
  const ok = healthResponse({ ok: true, ms: 3 });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { status: "ok", app: "sdc-projects-reports", db: "ok", dbMs: 3 });
  assert.equal(ok.headers.get("cache-control"), "no-store");

  const bad = healthResponse({ ok: false, ms: 4005, error: "database did not answer within 2000ms" });
  assert.equal(bad.status, 503);
  const body = (await bad.json()) as Record<string, unknown>;
  assert.equal(body.status, "degraded");
  assert.equal(body.db, "unreachable");
  assert.equal(body.app, "sdc-projects-reports");
});

test("the defaults are a 2s budget and one retry", () => {
  assert.equal(PROBE_TIMEOUT_MS, 2_000);
  assert.equal(PROBE_ATTEMPTS, 2);
});
