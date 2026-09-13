import "server-only";
import { prisma } from "@/lib/prisma";

// Lets "sign out" actually stop a session from working — on a plain
// password-based one AND one established via the Scheduler SSO hand-off.
// NextAuth's JWT strategy is stateless by default, so without this, sign-out
// only ever meant "the browser forgot its own cookie"; a captured/replayed
// token, or a session left open on another device, would keep working for
// the rest of its natural life regardless.
//
// A per-user counter, embedded in the JWT at sign-in and re-checked against
// the current DB value on every request (auth.ts's `jwt` callback) —
// bumping it makes every previously-issued token for that user stop being
// honoured, without touching how sign-IN itself works for anyone else or
// for that user's next sign-in.
//
// Cached briefly so the re-check doesn't cost a query on every single page
// load — same rationale, and the same ~60s ceiling, as the Scheduler's own
// `_activeCache` for its account-disabled check (server.js). Bumping a
// user's version also clears their cache entry immediately, so within THIS
// process a revoke takes effect right away rather than waiting out the
// window; the 60s figure is only the worst case (e.g. across a restart, or
// if a future deploy ever runs more than one instance).
const _cache = new Map<number, { version: number; active: boolean; fetchedAt: number }>();
const CACHE_MS = 60_000;

// ── Why a DB failure here must not propagate (2026-08-24) ───────────────────
//
// This function is awaited from auth.ts's `jwt` callback, which runs on EVERY
// session read — including the `await auth()` at the top of (app)/layout.tsx.
// A throw from the query below therefore threw INSIDE that layout, and a
// layout's error is not caught by its own segment's error.tsx: it propagated to
// the root layout, which had no boundary, and React unmounted the tree. That is
// the intermittent blank white screen reported 2026-08-24, and it explains why
// closing and reopening the window "fixed" it — a new request re-ran the layout
// after the transient failure had passed.
//
// app/global-error.tsx now catches that case so it can never be a BLANK screen
// again. This is the other half: a brief DB hiccup should not be a visible
// failure at all.
//
// The rule below is deliberately not "on error, carry on". This is a security
// control — it is what makes sign-out and admin deactivation actually stop a
// session — so it must never fail OPEN, or making the database unreachable
// would become a way to keep using a revoked token. Instead:
//
//   * A value the database really did give us recently is reused (stale-on-
//     error). It is not a guess, and a revoke clears the entry outright via
//     invalidateTokenVersionCache, so a revoked user is never served from here.
//   * Past that window we fail CLOSED, which sends the user to /login — a
//     legible page that explains itself, not a blank one.
//
// 15 minutes covers a pool hiccup, a MySQL restart, or a brief network drop
// without ever becoming an indefinite bypass.
const STALE_ON_ERROR_MS = 15 * 60_000;

// `active` exists in the database (see prisma/migrations/20260813010000_add_user_active)
// but isn't in the generated Prisma Client's types yet — `prisma generate` is blocked on
// this box by a locked query-engine DLL, the same constraint documented in
// employee-team-field.ts. Raw SQL is the established fallback; tokenVersion is read the
// same way here (rather than split across a typed query and a raw one) so this stays one
// round trip. Once `generate` succeeds again this can go back to `prisma.user.findUnique`.
async function fetchVersionAndActive(userId: number): Promise<{ version: number; active: boolean } | null> {
  const rows = await prisma.$queryRaw<{ tokenVersion: number; active: number | boolean }[]>`
    SELECT tokenVersion, active FROM User WHERE id = ${userId}
  `;
  const row = rows[0];
  return row ? { version: row.tokenVersion, active: Boolean(row.active) } : null;
}

// Null means "no such user" OR "deactivated" — callers (both auth.ts authorize()
// functions, and its jwt callback's re-check) treat either the same as an invalidated
// session, not as "version 0, carry on". A deactivated user is never handed a version
// number at all; there is nothing for a later reactivation to accidentally match against.
export async function currentTokenVersion(userId: number): Promise<number | null> {
  const now = Date.now();
  const cached = _cache.get(userId);
  if (cached && now - cached.fetchedAt < CACHE_MS) return cached.active ? cached.version : null;

  let row: { version: number; active: boolean } | null;
  try {
    row = await fetchVersionAndActive(userId);
  } catch (err) {
    // Reaching here means the QUERY failed — not that the user is unknown.
    // fetchVersionAndActive returns null for "no such user"; only an
    // unreachable/erroring database throws.
    if (cached && now - cached.fetchedAt < STALE_ON_ERROR_MS) {
      console.error(
        `[token-revocation] DB unreachable for user ${userId}; reusing value cached ` +
          `${Math.round((now - cached.fetchedAt) / 1000)}s ago rather than failing the request:`,
        err,
      );
      return cached.active ? cached.version : null;
    }
    // No recent verified value to stand on. Fail closed — the session is
    // treated as invalid and the user lands on /login.
    console.error(`[token-revocation] DB unreachable for user ${userId} and no recent cached value; failing closed:`, err);
    return null;
  }

  if (!row) {
    // Genuinely no such user (or deleted). Drop any stale entry so a later
    // error cannot resurrect it.
    _cache.delete(userId);
    return null;
  }
  _cache.set(userId, { version: row.version, active: row.active, fetchedAt: now });
  return row.active ? row.version : null;
}

export function invalidateTokenVersionCache(userId: number): void {
  _cache.delete(userId);
}
