import { ROLES, type AppRole } from "@/lib/permissions";

// ── Why a session's role has to be re-read at all (2026-09-14) ──────────────
//
// auth.ts pins `token.role` into the JWT at sign-in and, until this, never
// looked at it again: the per-request re-check in its jwt callback compared
// only tokenVersion. So an admin changing someone's role on /admin/users
// changed nothing for that person until they happened to sign out — a
// demotion in particular did not take. setUserRole now also bumps tokenVersion
// (which ends the old session outright), but the role claim itself should
// never be able to go stale either: a role written by a migration, a script,
// or a raw SQL fix has no bump attached, and the answer to "what may this
// session do" must come from the database, not from a cookie.
//
// This is the caching half, kept pure (no Prisma, no Next) so it can be unit
// tested with a fake fetcher. session-role.ts binds it to the real query.
//
// Cost: the jwt callback runs on EVERY session read, and it already pays one
// (cached, 60s) query for tokenVersion via lib/token-revocation.ts. That module
// is not editable from here, so the role read is a second cached lookup with
// the same TTL rather than an extension of the same row fetch — one extra query
// per user per minute, not per request, and the same stale-on-error rule so a
// DB hiccup degrades identically (reuse a recently verified value, then fail
// CLOSED) instead of one check passing while the other fails.

export type RoleRow = { role: string; active: boolean };
export type RoleFetcher = (userId: number) => Promise<RoleRow | null>;

export type RoleCache = {
  /** The user's CURRENT role, or null for "no such user", "deactivated", or "unknown role value". */
  currentRole(userId: number): Promise<AppRole | null>;
  /** Drop the cached value so the next read hits the database (called after a role/active write). */
  invalidate(userId: number): void;
};

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_STALE_ON_ERROR_MS = 15 * 60_000;

function asRole(value: string): AppRole | null {
  return (ROLES as readonly string[]).includes(value) ? (value as AppRole) : null;
}

export function createRoleCache(
  fetchRole: RoleFetcher,
  opts: { ttlMs?: number; staleOnErrorMs?: number; now?: () => number } = {},
): RoleCache {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const staleOnErrorMs = opts.staleOnErrorMs ?? DEFAULT_STALE_ON_ERROR_MS;
  const now = opts.now ?? Date.now;
  const cache = new Map<number, { role: AppRole | null; fetchedAt: number }>();

  return {
    async currentRole(userId) {
      const t = now();
      const cached = cache.get(userId);
      if (cached && t - cached.fetchedAt < ttlMs) return cached.role;

      let row: RoleRow | null;
      try {
        row = await fetchRole(userId);
      } catch (err) {
        if (cached && t - cached.fetchedAt < staleOnErrorMs) {
          console.error(`[session-role] DB unreachable for user ${userId}; reusing cached role:`, err);
          return cached.role;
        }
        console.error(`[session-role] DB unreachable for user ${userId} and no recent cached value; failing closed:`, err);
        return null;
      }

      if (!row) {
        cache.delete(userId);
        return null;
      }
      const role = row.active ? asRole(row.role) : null;
      cache.set(userId, { role, fetchedAt: t });
      return role;
    },
    invalidate(userId) {
      cache.delete(userId);
    },
  };
}
