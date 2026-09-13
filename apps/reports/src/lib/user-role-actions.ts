"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { assertActionPermission } from "@/lib/require-permission";
import { ROLES, type AppRole } from "@/lib/permissions";

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
  // Once a deploy regenerates the client, this can go back to the typed update.
  await prisma.$executeRaw`UPDATE User SET role = ${role} WHERE id = ${userId}`;
  await logAudit({
    action: "user.roleChange",
    entityType: "User",
    entityId: userId,
    summary: `${before.email} role changed ${before.role} → ${role}`,
    metadata: { before: before.role, after: role },
  });
  revalidatePath("/admin/users");
}
