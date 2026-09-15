import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSchedulerToken, secretsMatch } from "../src/lib/scheduler-api-auth";

// The bearer guard on /api/integration/* compared the shared secret with `!==`
// until 2026-09-14; it now goes through a constant-time digest comparison, the
// same shape as button-password.ts.

test("secretsMatch is an exact match on equal strings only", () => {
  assert.equal(secretsMatch("abc", "abc"), true);
  assert.equal(secretsMatch("abc", "abd"), false);
  assert.equal(secretsMatch("abc", "abcd"), false, "different lengths must not throw, only fail");
  assert.equal(secretsMatch("", "abc"), false);
  assert.equal(secretsMatch("", ""), true);
});

function req(authorization?: string): Request {
  return new Request("http://internal/api/integration/jobs", { headers: authorization ? { authorization } : {} });
}

test("checkSchedulerToken: 503 when the secret is unset (fail closed)", () => {
  const saved = process.env.SCHEDULER_SHARED_TOKEN;
  delete process.env.SCHEDULER_SHARED_TOKEN;
  try {
    assert.equal(checkSchedulerToken(req("Bearer anything"))?.status, 503);
  } finally {
    if (saved !== undefined) process.env.SCHEDULER_SHARED_TOKEN = saved;
  }
});

test("checkSchedulerToken: exact bearer passes, everything else is 401", () => {
  const saved = process.env.SCHEDULER_SHARED_TOKEN;
  process.env.SCHEDULER_SHARED_TOKEN = "s3cret-value";
  try {
    assert.equal(checkSchedulerToken(req("Bearer s3cret-value")), null);
    assert.equal(checkSchedulerToken(req("Bearer s3cret-valuX"))?.status, 401);
    assert.equal(checkSchedulerToken(req("Bearer s3cret-valu"))?.status, 401);
    assert.equal(checkSchedulerToken(req("Bearer "))?.status, 401);
    assert.equal(checkSchedulerToken(req("s3cret-value"))?.status, 401, "no Bearer prefix");
    assert.equal(checkSchedulerToken(req())?.status, 401, "no header");
  } finally {
    if (saved === undefined) delete process.env.SCHEDULER_SHARED_TOKEN;
    else process.env.SCHEDULER_SHARED_TOKEN = saved;
  }
});
