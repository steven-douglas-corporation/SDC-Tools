import { test } from "node:test";
import assert from "node:assert/strict";

import { createHmac } from "crypto";
import {
  mintSchedulerSsoToken,
  decodeSchedulerSsoToken,
  verifySchedulerSsoToken,
  withSchedulerSso,
  consumeSchedulerSsoNonce,
  isSelfMintedSsoNonce,
} from "../src/lib/scheduler-sso";

// Set before any test runs. Safe as a plain assignment rather than a dynamic
// import because the module reads process.env per call, not once at import — which
// is also what lets the wrong-secret test below swap it mid-file.
process.env.SCHEDULER_SHARED_TOKEN = "test-shared-secret-value";

// A token in the Scheduler's OWN wire format (lib/etcSso.js): {e,x,n}, no
// audience claim, signed with the shared secret. This is what the inbound
// verifier must accept.
function schedulerMinted(fields: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify({ e: "a@b.com", x: Math.floor(Date.now() / 1000) + 60, n: "sched-nonce", ...fields })).toString("base64url");
  const sig = createHmac("sha256", "test-shared-secret-value").update(`sso:v1:${payload}`).digest("base64url");
  return `${payload}.${sig}`;
}

// This token is the whole authority for "let this person into the Scheduler", so
// the cases that matter are the ones where it must REFUSE.

test("a freshly minted token decodes to the same email, lowercased, addressed to the Scheduler", () => {
  const t = mintSchedulerSsoToken("  AKamuju@SDCautomation.com ")!;
  const d = decodeSchedulerSsoToken(t)!;
  assert.equal(d.email, "akamuju@sdcautomation.com");
  assert.equal(d.aud, "scheduler");
});

test("every token carries a distinct nonce, so single-use can be enforced", () => {
  const a = decodeSchedulerSsoToken(mintSchedulerSsoToken("a@b.com")!)!;
  const b = decodeSchedulerSsoToken(mintSchedulerSsoToken("a@b.com")!)!;
  assert.notEqual(a.nonce, b.nonce);
});

test("a tampered email is rejected", () => {
  // Re-encode the payload with a different email, keeping the original signature.
  const t = mintSchedulerSsoToken("viewer@sdcautomation.com")!;
  const [, sig] = t.split(".");
  const forged = Buffer.from(JSON.stringify({ e: "admin@sdcautomation.com", x: 9999999999, n: "x" })).toString("base64url");
  assert.equal(decodeSchedulerSsoToken(`${forged}.${sig}`), null);
  assert.equal(verifySchedulerSsoToken(`${forged}.${sig}`), null);
});

test("a token signed with the wrong secret is rejected", () => {
  const t = mintSchedulerSsoToken("a@b.com")!;
  process.env.SCHEDULER_SHARED_TOKEN = "a-different-secret";
  assert.equal(decodeSchedulerSsoToken(t), null);
  process.env.SCHEDULER_SHARED_TOKEN = "test-shared-secret-value";
});

test("an expired token is rejected", () => {
  // Hand-built with an expiry in the past, signed correctly — proves the expiry
  // check runs rather than being implied by the signature.
  const t = schedulerMinted({ x: Math.floor(Date.now() / 1000) - 1 });
  assert.equal(decodeSchedulerSsoToken(t), null);
  assert.equal(verifySchedulerSsoToken(t), null);
});

test("garbage in any shape is rejected, never thrown", () => {
  for (const bad of ["", ".", "a.b", "onlyonepart", "eyJ9.###"]) {
    assert.equal(decodeSchedulerSsoToken(bad), null);
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

// ── Direction (2026-09-14) ──────────────────────────────────────────────────
//
// Same secret, same "sso:v1" prefix on both sides meant a token THIS app minted
// for a Reports→Scheduler link was also accepted by this app's own inbound
// /api/auth/sso — a sign-in as whoever's sidebar link you could read. Two
// independent refusals now stand in the way; each is tested on its own.

test("the INBOUND verifier accepts a Scheduler-minted token (no audience claim)", () => {
  const v = verifySchedulerSsoToken(schedulerMinted({ n: "from-scheduler-1" }));
  assert.deepEqual(v, { email: "a@b.com", nonce: "from-scheduler-1" });
});

test("the INBOUND verifier refuses a token this app minted — it is outbound, not an assertion about us", () => {
  const t = mintSchedulerSsoToken("victim@sdcautomation.com")!;
  assert.ok(decodeSchedulerSsoToken(t), "validly signed, so only the direction rule can refuse it");
  assert.equal(verifySchedulerSsoToken(t), null);
});

test("refusal 1: an audience of \"scheduler\" is refused on its own, even for a nonce we never minted", () => {
  // Someone reconstructing our outbound format with the real secret still gets
  // nowhere — the claim itself marks the token as not-for-us.
  const t = schedulerMinted({ n: "never-minted-here", a: "scheduler" });
  assert.ok(decodeSchedulerSsoToken(t));
  assert.equal(verifySchedulerSsoToken(t), null);
});

test("refusal 2: a nonce this process minted is refused on its own, even with the audience claim stripped", () => {
  // Covers a token minted by a build that predates the audience claim: the
  // payload is re-encoded WITHOUT `a` but reusing our nonce and re-signed.
  const ours = decodeSchedulerSsoToken(mintSchedulerSsoToken("victim@sdcautomation.com")!)!;
  assert.equal(isSelfMintedSsoNonce(ours.nonce), true);
  const stripped = schedulerMinted({ e: "victim@sdcautomation.com", n: ours.nonce });
  assert.equal(decodeSchedulerSsoToken(stripped)?.aud, null, "no audience claim on the rebuilt token");
  assert.equal(verifySchedulerSsoToken(stripped), null);
  // …while an unknown nonce with the same shape is fine.
  assert.equal(isSelfMintedSsoNonce("not-ours"), false);
  assert.ok(verifySchedulerSsoToken(schedulerMinted({ n: "not-ours" })));
});

test("the Scheduler's verifier reads only e/x/n, so the extra claim costs nothing there", () => {
  // Mirrors routes/auth.js's parse exactly: unknown keys are ignored.
  const t = mintSchedulerSsoToken("a@b.com")!;
  const [payload] = t.split(".");
  const body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  assert.equal(typeof body.e, "string");
  assert.equal(typeof body.x, "number");
  assert.equal(typeof body.n, "string");
  assert.equal(body.a, "scheduler");
});

test("consumeSchedulerSsoNonce is single-use", () => {
  assert.equal(consumeSchedulerSsoNonce("once"), true);
  assert.equal(consumeSchedulerSsoNonce("once"), false);
  assert.equal(consumeSchedulerSsoNonce("twice"), true);
});
