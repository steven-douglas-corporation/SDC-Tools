// Node-only by construction: `node:crypto` cannot resolve in a browser bundle, so
// importing this from a client component fails the build. That is the same
// protection `import "server-only"` gives, minus the side effect of making the
// module unloadable in a plain test runner — and a token that decides who gets
// into another app is exactly the code that should be unit-tested.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Single sign-on hand-off to the SDC Scheduler.
//
// The two apps have separate account tables and separate session mechanisms
// (NextAuth here, its own JWT there), so "already signed in" did not carry
// across: clicking Project Scheduler dropped you at its login modal even though
// ETC knew perfectly well who you were.
//
// This mints a short-lived assertion — "the bearer of this is <email>, signed by
// something only the two apps know" — which the Scheduler exchanges for its own
// session. It reuses SCHEDULER_SHARED_TOKEN, the secret the two apps already use
// to trust each other's API calls, rather than introducing another one to keep in
// sync; the message is domain-prefixed so a token minted here can never be
// replayed against the roster endpoints, which authenticate with the raw secret.
//
// ── What this deliberately does NOT do ──────────────────────────────────────
// It does not create Scheduler accounts. An assertion only says who someone is;
// whether that person may use the Scheduler, and with what role, is the
// Scheduler's decision and its admins'. An email with no Scheduler user gets the
// normal login modal, exactly as today.
//
// ── The URL trade ───────────────────────────────────────────────────────────
// The token travels as a query parameter, which means it lands in browser
// history and the Scheduler's access log. Mitigated rather than ignored: it
// lives 60 seconds, carries a nonce so the Scheduler can refuse a second use,
// and the Scheduler strips it from the address bar after exchanging it. A stolen
// token is worth one Scheduler session for the person it already named, within a
// minute, on a LAN-only host — accepted knowingly, and the reason the TTL is not
// generous.

const TTL_SECONDS = 60;
const DOMAIN = "sso:v1"; // separates these tokens from any other use of the secret

function secret(): string | null {
  const s = process.env.SCHEDULER_SHARED_TOKEN;
  return s && s.length > 0 ? s : null;
}

function sign(payload: string, key: string): string {
  return createHmac("sha256", key).update(`${DOMAIN}:${payload}`).digest("base64url");
}

// Returns null when SSO isn't configured — callers then link to the Scheduler
// exactly as before, so a missing secret degrades to "sign in again", never to a
// broken link.
export function mintSchedulerSsoToken(email: string | null | undefined): string | null {
  const key = secret();
  if (!key || !email) return null;
  const payload = Buffer.from(
    JSON.stringify({
      e: email.trim().toLowerCase(),
      x: Math.floor(Date.now() / 1000) + TTL_SECONDS,
      n: randomBytes(9).toString("base64url"),
    }),
  ).toString("base64url");
  return `${payload}.${sign(payload, key)}`;
}

// Appends the assertion to a Scheduler URL that may already carry query params
// (the per-job deep link does: ?job=1101&view=schedule).
export function withSchedulerSso(url: string, email: string | null | undefined): string {
  const token = mintSchedulerSsoToken(email);
  if (!token) return url;
  return `${url}${url.includes("?") ? "&" : "?"}sso=${encodeURIComponent(token)}`;
}

// The verification half, kept here beside the minting so the two can't drift.
// The Scheduler has its own copy in JavaScript (routes/auth.js) — this one exists
// for tests and for any future in-app verification.
export function verifySchedulerSsoToken(token: string): { email: string; nonce: string } | null {
  const key = secret();
  if (!key) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = sign(payload, key);
  // Constant-time, and length-checked first because timingSafeEqual throws on a
  // length mismatch rather than returning false.
  if (sig.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { e?: string; x?: number; n?: string };
    if (!body.e || !body.x || !body.n) return null;
    if (body.x < Math.floor(Date.now() / 1000)) return null; // expired
    return { email: body.e, nonce: body.n };
  } catch {
    return null;
  }
}

// ── The other direction: Scheduler → here ───────────────────────────────────
//
// The Scheduler mints the identical wire format (its own copy of `sign()`,
// same SCHEDULER_SHARED_TOKEN, same "sso:v1" domain prefix) for ITS
// currently-logged-in user, so `verifySchedulerSsoToken` above already knows
// how to check one without any changes. What it doesn't do is enforce
// single-use — that's this, kept separate so the pure verify function stays
// side-effect-free and testable without a shared mutable Map between test
// cases.
//
// Mirrors the Scheduler's own `_ssoSpent` (routes/auth.js) exactly: in-memory
// is the right scope on both sides, since these tokens live 60 seconds — a
// restart losing the set costs nothing worse than allowing a replay of a
// token that's almost certainly already expired anyway.
const _spentNonces = new Map<string, number>();
const NONCE_RETENTION_MS = 5 * 60 * 1000;

// Returns true the first time a nonce is seen (i.e. "ok, proceed"), false on
// a repeat. Callers must check the token's own expiry themselves — this
// function only tracks which have already been spent.
export function consumeSchedulerSsoNonce(nonce: string): boolean {
  const now = Date.now();
  if (_spentNonces.has(nonce)) return false;
  _spentNonces.set(nonce, now + NONCE_RETENTION_MS);
  if (_spentNonces.size > 500) {
    for (const [k, until] of _spentNonces) if (until < now) _spentNonces.delete(k);
  }
  return true;
}
