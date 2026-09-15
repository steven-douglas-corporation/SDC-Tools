import "server-only";
import { prisma } from "@/lib/prisma";
import { createRoleCache, type RoleCache } from "@/lib/session-role-cache";

// The Prisma-bound instance of session-role-cache.ts — see that file for why
// this exists. Raw SQL for the same reason user-role-actions.ts uses it: the
// generated client's `Role` enum predates PM (prisma generate is blocked on
// this box), so a typed `select: { role: true }` would narrow to the old union.
//
// Pinned on globalThis, like lib/permissions.ts and lib/prisma.ts: auth.ts's
// jwt callback reads this from whichever bundle called auth() (layout, route
// handler, server action) and user-role-actions.ts's setUserRole invalidates
// it from the Server Action bundle. Next bundles those separately; a
// module-level const would be one cache per bundle and the invalidate would
// miss the copy the next page load reads from.
const g = globalThis as unknown as { __sessionRoleCache?: RoleCache };
if (!g.__sessionRoleCache) {
  g.__sessionRoleCache = createRoleCache(async (userId) => {
    const rows = await prisma.$queryRaw<{ role: string; active: number | boolean }[]>`
      SELECT role, active FROM User WHERE id = ${userId}
    `;
    const row = rows[0];
    return row ? { role: row.role, active: Boolean(row.active) } : null;
  });
}
const roleCache: RoleCache = g.__sessionRoleCache;

export const currentUserRole = (userId: number) => roleCache.currentRole(userId);
export const invalidateUserRoleCache = (userId: number) => roleCache.invalidate(userId);
