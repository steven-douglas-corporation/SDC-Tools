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

// ── Direction matters (2026-09-14) ──────────────────────────────────────────
//
// Both apps sign with the SAME secret and the SAME "sso:v1" prefix, and until
// this change the payload said nothing about which way it was travelling. So a
// token this app minted for a Reports→Scheduler link was also a perfectly valid
// Scheduler→Reports assertion: anyone who could read one out of a rendered
// sidebar (it sits in every Project Scheduler link's href) could hand it to
// /api/auth/sso here and sign in as that person without ever touching the
// Scheduler. Two independent fixes, either of which is sufficient:
//
//   1. Outbound tokens carry `a: "scheduler"` (audience). The Scheduler's own
//      verifier (routes/auth.js) reads only e/x/n and ignores unknown keys, so
//      this costs nothing there; the inbound verifier below refuses any token
//      addressed to the Scheduler.
//   2. Every nonce this process mints is remembered for the token's lifetime,
//      and the inbound verifier refuses a nonce it minted itself — which also
//      covers a token a stale build minted without the audience claim.
//
// The minted set lives on globalThis, not in a module-level const: the sidebar
// mints from the (app) layout's Server Component bundle and the inbound check
// runs in the api/auth/sso Route Handler bundle, and Next bundles those
// separately (the same trap lib/permissions.ts and lib/prisma.ts document). A
// plain `const` would be two Maps, and the check would silently never fire.
const OUTBOUND_AUDIENCE = "scheduler";
const MINTED_RETENTION_MS = (TTL_SECONDS + 30) * 1000;

type NonceStore = {
  minted: Map<string, number>; // nonce → expires-at (ms)
  spent: Map<string, number>; // nonce → forget-after (ms)
};
const g = globalThis as unknown as { __schedulerSsoNonces?: NonceStore };
if (!g.__schedulerSsoNonces) g.__schedulerSsoNonces = { minted: new Map(), spent: new Map() };
const nonces: NonceStore = g.__schedulerSsoNonces;

function sweep(map: Map<string, number>, now: number): void {
  if (map.size <= 500) return;
  for (const [k, until] of map) if (until < now) map.delete(k);
}

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
  const now = Date.now();
  const nonce = randomBytes(9).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      e: email.trim().toLowerCase(),
      x: Math.floor(now / 1000) + TTL_SECONDS,
      n: nonce,
      a: OUTBOUND_AUDIENCE,
    }),
  ).toString("base64url");
  nonces.minted.set(nonce, now + MINTED_RETENTION_MS);
  sweep(nonces.minted, now);
  return `${payload}.${sign(payload, key)}`;
}

/** True when this process minted `nonce` recently — i.e. the token is one of OURS, outbound. */
export function isSelfMintedSsoNonce(nonce: string): boolean {
  const until = nonces.minted.get(nonce);
  if (until === undefined) return false;
  if (until < Date.now()) {
    nonces.minted.delete(nonce);
    return false;
  }
  return true;
}

// Appends the assertion to a Scheduler URL that may already carry query params
// (the per-job deep link does: ?job=1101&view=schedule).
export function withSchedulerSso(url: string, email: string | null | undefined): string {
  const token = mintSchedulerSsoToken(email);
  if (!token) return url;
  return `${url}${url.includes("?") ? "&" : "?"}sso=${encodeURIComponent(token)}`;
}

export type DecodedSsoToken = {
  email: string;
  nonce: string;
  /** `a` claim: "scheduler" on tokens THIS app minted for outbound links; absent on the Scheduler's own. */
  aud: string | null;
};

// Signature + shape + expiry ONLY — no opinion about direction. This is the
// part that must match the Scheduler's own copy in JavaScript (routes/auth.js)
// byte for byte, and the part the mint-then-decode tests exercise. It is not
// what auth.ts calls; see verifySchedulerSsoToken below for the inbound rule.
export function decodeSchedulerSsoToken(token: string): DecodedSsoToken | null {
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
    const body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      e?: string;
      x?: number;
      n?: string;
      a?: unknown;
    };
    if (!body.e || !body.x || !body.n) return null;
    if (body.x < Math.floor(Date.now() / 1000)) return null; // expired
    return { email: body.e, nonce: body.n, aud: typeof body.a === "string" ? body.a : null };
  } catch {
    return null;
  }
}

// The INBOUND check — what auth.ts's "scheduler-sso" provider calls. Accepts a
// token only if it is validly signed AND was minted by the other side: a token
// addressed to the Scheduler (`a: "scheduler"`), or one whose nonce this very
// process handed out, is one of our own outbound assertions being replayed
// back at us, and is refused (see the note above OUTBOUND_AUDIENCE).
export function verifySchedulerSsoToken(token: string): { email: string; nonce: string } | null {
  const decoded = decodeSchedulerSsoToken(token);
  if (!decoded) return null;
  if (decoded.aud === OUTBOUND_AUDIENCE) return null;
  if (isSelfMintedSsoNonce(decoded.nonce)) return null;
  return { email: decoded.email, nonce: decoded.nonce };
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
// token that's almost certainly already expired anyway. (Stored on the same
// globalThis slot as the minted set, for the bundle-per-layer reason given
// there.)
const NONCE_RETENTION_MS = 5 * 60 * 1000;

// Returns true the first time a nonce is seen (i.e. "ok, proceed"), false on
// a repeat. Callers must check the token's own expiry themselves — this
// function only tracks which have already been spent.
export function consumeSchedulerSsoNonce(nonce: string): boolean {
  const now = Date.now();
  if (nonces.spent.has(nonce)) return false;
  nonces.spent.set(nonce, now + NONCE_RETENTION_MS);
  sweep(nonces.spent, now);
  return true;
}
