"use server";

import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { logAuditFor } from "@/lib/audit";
import { isCompanyEmail } from "@/lib/company-email";
import { syncPasswordHashToScheduler } from "@/lib/scheduler-link";

export type RegisterResult = { ok: true } | { ok: false; error: string };

// Self-service account creation: name + email + password. Called from the
// sign-up form; on success the client signs in with the same credentials.
export async function registerUser(input: {
  name: string;
  email: string;
  password: string;
}): Promise<RegisterResult> {
  const name = input.name?.trim();
  const email = input.email?.trim().toLowerCase();
  const password = input.password ?? "";

  if (!name) return { ok: false, error: "Please enter your name." };
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, error: "Please enter a valid email address." };
  }
  // Shared-account project (§Aug 2026): self-registration is company-only on
  // both this app and the Scheduler, so the two apps' account bases can only
  // ever grow in step — see company-email.ts, also used by the Scheduler-SSO
  // auto-provisioning path in auth.ts.
  if (!isCompanyEmail(email)) {
    return { ok: false, error: "Sign-up is limited to @sdcautomation.com email addresses." };
  }
  if (password.length < 1) {
    return { ok: false, error: "Please enter a password." };
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return { ok: false, error: "An account with this email already exists. Please sign in." };
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({
    // Least-privilege default — an ELT user promotes them from /admin/users
    // once they actually need Manager-tier access or above.
    data: { name, email, passwordHash, role: "ALL" },
  });

  await logAuditFor(user.id, user.email, {
    action: "auth.register",
    entityType: "User",
    entityId: user.id,
    summary: `${user.email} created an account`,
  });

  // Best-effort, and almost always a no-op today: the Scheduler only applies this if
  // IT already has a row linked to a Reports account, which can't be true yet for an
  // account that didn't exist until this call — kept here anyway so every place a
  // password gets set pushes, rather than relying on someone to remember which ones
  // matter (shared-account project, see scheduler-link.ts's own header).
  await syncPasswordHashToScheduler(email, passwordHash);

  return { ok: true };
}

// Self-service password change for an existing account: proves ownership by
// requiring the current password, then re-hashes the new one. Works from the
// login screen (no active session needed), so any user can change theirs.
export async function changePassword(input: {
  email: string;
  currentPassword: string;
  newPassword: string;
}): Promise<RegisterResult> {
  const email = input.email?.trim().toLowerCase();
  const currentPassword = input.currentPassword ?? "";
  const newPassword = input.newPassword ?? "";

  if (!email) return { ok: false, error: "Please enter your email." };
  if (newPassword.length < 1) return { ok: false, error: "Please enter a new password." };

  const user = await prisma.user.findUnique({ where: { email } });
  // One generic error whether the account is missing or the current password is
  // wrong — so this can't be used to probe which emails exist.
  if (!user || !(await bcrypt.compare(currentPassword, user.passwordHash))) {
    return { ok: false, error: "Email or current password is incorrect." };
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });

  await logAuditFor(user.id, user.email, {
    action: "auth.changePassword",
    entityType: "User",
    entityId: user.id,
    summary: `${user.email} changed their password`,
  });

  // Keeps a linked Scheduler account working from the SAME password — see
  // scheduler-link.ts's own header for why only the hash travels, never the password.
  await syncPasswordHashToScheduler(email, passwordHash);

  return { ok: true };
}
