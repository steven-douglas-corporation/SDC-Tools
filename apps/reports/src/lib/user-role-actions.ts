"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { assertActionPermission } from "@/lib/require-permission";
import { ROLES, type AppRole } from "@/lib/permissions";
import { invalidateTokenVersionCache } from "@/lib/token-revocation";
import { invalidateUserRoleCache } from "@/lib/session-role";

export type ManagedUser = {
  id: number;
  email: string;
  name: string;
  role: AppRole;
  active: boolean;
};

// The only screen that can change a User's role — before this, it took a raw
// DB write. ELT-only (users:manage), same as every other mutation here.
export async function listUsersForAdmin(): Promise<ManagedUser[]> {
  await assertActionPermission("users:manage");
  // Raw for the same reason as the write below: the generated client's Role
  // enum predates PM, so a findMany would type u.role as the old union and a
  // PM row would not narrow to AppRole.
  const users = await prisma.$queryRaw<{ id: number; email: string; name: string; role: string; active: boolean | number }[]>`
    SELECT id, email, name, role, active FROM User ORDER BY email ASC
  `;
  return users.map((u) => ({ id: u.id, email: u.email, name: u.name, role: u.role as AppRole, active: Boolean(u.active) }));
}

export async function setUserRole(userId: number, role: AppRole): Promise<void> {
  await assertActionPermission("users:manage");
  if (!ROLES.includes(role)) throw new Error(`"${role}" is not a valid role.`);

  const before = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, role: true } });
  if (!before) throw new Error("That user no longer exists.");
  if (before.role === role) return; // nothing to change, nothing to sign out

  // $executeRaw, not prisma.user.update({ data: { role } }) — the generated
  // Prisma Client's `Role` enum does not yet include PM, because `prisma
  // generate` cannot run on this box while a server process holds
  // node_modules/.prisma open (the same standing constraint that makes
  // RolePermission raw-only; see role-permissions-store.ts). The typed call
  // rejects "PM" at compile time even though the column accepts it.
  //
  // Safe as a raw write: `role` has already been checked against ROLES above,
  // so the parameter can only ever be one of the five known values, and it is
  // bound rather than interpolated.
  //
  // tokenVersion is bumped in the SAME statement (2026-09-14). A role is baked
  // into the session JWT at sign-in, and until this the change reached nobody
  // who was already signed in — a demotion did not take until the person chose
  // to sign out. Bumping the version ends every session that user holds on
  // their very next request (auth.ts's jwt callback, via
  // lib/token-revocation.ts); their next sign-in picks up the new role. The
  // two cache invalidations below make that immediate in this process rather
  // than at the caches' 60s ceiling. The same audit row records both facts.
  //
  // Once a deploy regenerates the client, this can go back to the typed update.
  await prisma.$executeRaw`UPDATE User SET role = ${role}, tokenVersion = tokenVersion + 1 WHERE id = ${userId}`;
  invalidateTokenVersionCache(userId);
  invalidateUserRoleCache(userId);
  await logAudit({
    action: "user.roleChange",
    entityType: "User",
    entityId: userId,
    summary: `${before.email} role changed ${before.role} → ${role} (existing sessions signed out)`,
    metadata: { before: before.role, after: role, sessionsRevoked: true },
  });
  revalidatePath("/admin/users");
}

// Activate or deactivate an account (2026-09-14). Self-registered accounts
// now start with active=false (login/actions.ts) and this is how an
// administrator turns one on; it is also the deliberate "disable this person"
// control that until now took a raw DB write. Deactivating also bumps
// tokenVersion so any open session ends on its next request rather than
// running out its natural life — activating does not need to (there is no
// session to end), and leaving the version alone keeps a re-enabled person's
// still-valid cookie, if any, working.
export async function setUserActive(userId: number, active: boolean): Promise<void> {
  const session = await assertActionPermission("users:manage");
  const before = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, active: true } });
  if (!before) throw new Error("That user no longer exists.");
  if (!active && session.user.email?.toLowerCase() === before.email.toLowerCase()) {
    throw new Error("You can't deactivate your own account.");
  }
  if (before.active === active) return;

  if (active) {
    await prisma.$executeRaw`UPDATE User SET active = 1 WHERE id = ${userId}`;
  } else {
    await prisma.$executeRaw`UPDATE User SET active = 0, tokenVersion = tokenVersion + 1 WHERE id = ${userId}`;
  }
  invalidateTokenVersionCache(userId);
  invalidateUserRoleCache(userId);
  await logAudit({
    action: active ? "user.activate" : "user.deactivate",
    entityType: "User",
    entityId: userId,
    summary: active ? `${before.email} account activated` : `${before.email} account deactivated (sessions signed out)`,
    metadata: { before: before.active, after: active },
  });
  revalidatePath("/admin/users");
}
