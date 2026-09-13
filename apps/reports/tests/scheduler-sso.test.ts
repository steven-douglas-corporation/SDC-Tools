import { test } from "node:test";
import assert from "node:assert/strict";

import { createHmac } from "crypto";
import { mintSchedulerSsoToken, verifySchedulerSsoToken, withSchedulerSso } from "../src/lib/scheduler-sso";

// Set before any test runs. Safe as a plain assignment rather than a dynamic
// import because the module reads process.env per call, not once at import — which
// is also what lets the wrong-secret test below swap it mid-file.
process.env.SCHEDULER_SHARED_TOKEN = "test-shared-secret-value";

// This token is the whole authority for "let this person into the Scheduler", so
// the cases that matter are the ones where it must REFUSE.

test("a freshly minted token verifies to the same email, lowercased", () => {
  const t = mintSchedulerSsoToken("  AKamuju@SDCautomation.com ")!;
  assert.equal(verifySchedulerSsoToken(t)?.email, "akamuju@sdcautomation.com");
});

test("every token carries a distinct nonce, so single-use can be enforced", () => {
  const a = verifySchedulerSsoToken(mintSchedulerSsoToken("a@b.com")!)!;
  const b = verifySchedulerSsoToken(mintSchedulerSsoToken("a@b.com")!)!;
  assert.notEqual(a.nonce, b.nonce);
});

test("a tampered email is rejected", () => {
  // Re-encode the payload with a different email, keeping the original signature.
  const t = mintSchedulerSsoToken("viewer@sdcautomation.com")!;
  const [, sig] = t.split(".");
  const forged = Buffer.from(JSON.stringify({ e: "admin@sdcautomation.com", x: 9999999999, n: "x" })).toString("base64url");
  assert.equal(verifySchedulerSsoToken(`${forged}.${sig}`), null);
});

test("a token signed with the wrong secret is rejected", () => {
  const t = mintSchedulerSsoToken("a@b.com")!;
  process.env.SCHEDULER_SHARED_TOKEN = "a-different-secret";
  assert.equal(verifySchedulerSsoToken(t), null);
  process.env.SCHEDULER_SHARED_TOKEN = "test-shared-secret-value";
});

test("an expired token is rejected", () => {
  // Hand-built with an expiry in the past, signed correctly — proves the expiry
  // check runs rather than being implied by the signature.
  const past = Math.floor(Date.now() / 1000) - 1;
  const payload = Buffer.from(JSON.stringify({ e: "a@b.com", x: past, n: "n" })).toString("base64url");
  const sig = createHmac("sha256", "test-shared-secret-value").update(`sso:v1:${payload}`).digest("base64url");
  assert.equal(verifySchedulerSsoToken(`${payload}.${sig}`), null);
});

test("garbage in any shape is rejected, never thrown", () => {
  for (const bad of ["", ".", "a.b", "onlyonepart", "eyJ9.###"]) {
    assert.equal(verifySchedulerSsoToken(bad), null);
  }
});

test("withSchedulerSso respects a URL that already has query params", () => {
  const url = withSchedulerSso("http://host:4003/?job=1101&view=schedule", "a@b.com");
  assert.ok(url.includes("?job=1101&view=schedule&sso="));
});

test("no email means the link is left exactly as it was", () => {
  // Not signed in — the Scheduler should ask, rather than be handed an assertion
  // about nobody.
  assert.equal(withSchedulerSso("http://host:4003/?view=projects", null), "http://host:4003/?view=projects");
  assert.equal(mintSchedulerSsoToken(null), null);
});

test("no shared secret means no token at all", () => {
  const saved = process.env.SCHEDULER_SHARED_TOKEN;
  delete process.env.SCHEDULER_SHARED_TOKEN;
  assert.equal(mintSchedulerSsoToken("a@b.com"), null);
  assert.equal(withSchedulerSso("http://host/x", "a@b.com"), "http://host/x");
  process.env.SCHEDULER_SHARED_TOKEN = saved;
});
