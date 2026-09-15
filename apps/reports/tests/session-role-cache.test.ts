import { test } from "node:test";
import assert from "node:assert/strict";
import { createRoleCache, type RoleRow } from "../src/lib/session-role-cache";

// auth.ts's jwt callback re-reads the role through this on every request
// (2026-09-14) — before that, `token.role` was written once at sign-in and a
// role change on /admin/users never reached an open session.

function harness(rows: Record<number, RoleRow | null | Error>, opts: { ttlMs?: number; staleOnErrorMs?: number } = {}) {
  let now = 1_000_000;
  let calls = 0;
  const cache = createRoleCache(
    async (id) => {
      calls++;
      const r = rows[id];
      if (r instanceof Error) throw r;
      return r ?? null;
    },
    { ...opts, now: () => now },
  );
  return { cache, advance: (ms: number) => (now += ms), calls: () => calls, rows };
}

test("returns the CURRENT role from the database, not what the token said", async () => {
  const h = harness({ 1: { role: "MANAGER", active: true } });
  assert.equal(await h.cache.currentRole(1), "MANAGER");
  h.rows[1] = { role: "ALL", active: true }; // admin demoted them
  h.cache.invalidate(1); // what setUserRole calls
  assert.equal(await h.cache.currentRole(1), "ALL");
});

test("a deactivated user, a missing user, and an unknown role value all read as null", async () => {
  const h = harness({ 1: { role: "ELT", active: false }, 2: { role: "SUPERADMIN", active: true } });
  assert.equal(await h.cache.currentRole(1), null, "inactive");
  assert.equal(await h.cache.currentRole(2), null, "unknown role fails closed");
  assert.equal(await h.cache.currentRole(3), null, "no such user");
});

test("cached for the TTL, so the per-request cost is one query per user per minute", async () => {
  const h = harness({ 1: { role: "PM", active: true } }, { ttlMs: 60_000 });
  for (let i = 0; i < 50; i++) await h.cache.currentRole(1);
  assert.equal(h.calls(), 1);
  h.advance(60_000);
  await h.cache.currentRole(1);
  assert.equal(h.calls(), 2);
});

test("invalidate makes the next read hit the database even inside the TTL", async () => {
  const h = harness({ 1: { role: "PM", active: true } });
  await h.cache.currentRole(1);
  h.rows[1] = { role: "SALES", active: true };
  assert.equal(await h.cache.currentRole(1), "PM", "still cached");
  h.cache.invalidate(1);
  assert.equal(await h.cache.currentRole(1), "SALES");
});

test("a DB error reuses a recently verified value, then fails CLOSED", async () => {
  const h = harness({ 1: { role: "MANAGER", active: true } }, { ttlMs: 60_000, staleOnErrorMs: 15 * 60_000 });
  const quiet = console.error;
  console.error = () => {};
  try {
    assert.equal(await h.cache.currentRole(1), "MANAGER");
    h.rows[1] = new Error("pool timeout");
    h.advance(61_000); // past TTL, inside stale window
    assert.equal(await h.cache.currentRole(1), "MANAGER", "stale-on-error");
    h.advance(15 * 60_000); // past the stale window
    assert.equal(await h.cache.currentRole(1), null, "fails closed");
    // With no cached value at all, an error is also closed, never a throw.
    assert.equal(await h.cache.currentRole(99), null);
  } finally {
    console.error = quiet;
  }
});

test("a deactivation is never masked by an older cached active value once invalidated", async () => {
  const h = harness({ 1: { role: "SALES", active: true } });
  assert.equal(await h.cache.currentRole(1), "SALES");
  h.rows[1] = { role: "SALES", active: false };
  h.cache.invalidate(1);
  assert.equal(await h.cache.currentRole(1), null);
});
