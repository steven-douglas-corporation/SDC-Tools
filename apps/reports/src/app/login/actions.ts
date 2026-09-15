"use server";

import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { logAuditFor } from "@/lib/audit";
import { isCompanyEmail } from "@/lib/company-email";
import { syncPasswordHashToScheduler } from "@/lib/scheduler-link";
import { invalidateTokenVersionCache } from "@/lib/token-revocation";
import { MIN_PASSWORD_LENGTH, passwordTooShortMessage } from "@/lib/password-policy";

// `pendingActivation` is set by registerUser: the account exists but cannot
// sign in until an administrator activates it (see below). LoginForm reads it
// to show the right message instead of attempting a sign-in that must fail.
export type RegisterResult = { ok: true; pendingActivation?: boolean } | { ok: false; error: string };

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
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: passwordTooShortMessage() };
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return { ok: false, error: "An account with this email already exists. Please sign in." };
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({
    // Least-privilege default — an ELT user promotes them from /admin/users
    // once they actually need Manager-tier access or above.
    //
    // `active: false` (2026-09-14): this form is reachable by anyone who can
    // see the login page, and the only thing it checks is that the address
    // ENDS in @sdcautomation.com — it never proves the person owns that
    // mailbox. Before this, typing a colleague's address and any password
    // created a working account in their name. Now the row exists but cannot
    // sign in (auth.ts's authorize() treats inactive as "no such user" via
    // currentTokenVersion) until an administrator activates it — see
    // setUserActive in lib/user-role-actions.ts. The Scheduler-SSO
    // auto-provision path in auth.ts is deliberately NOT changed: there the
    // identity is asserted by an app the person already signed in to, which
    // is the ownership proof this form lacks.
    data: { name, email, passwordHash, role: "ALL", active: false },
  });

  await logAuditFor(user.id, user.email, {
    action: "auth.register",
    entityType: "User",
    entityId: user.id,
    summary: `${user.email} created an account (pending activation)`,
  });

  // Best-effort, and almost always a no-op today: the Scheduler only applies this if
  // IT already has a row linked to a Reports account, which can't be true yet for an
  // account that didn't exist until this call — kept here anyway so every place a
  // password gets set pushes, rather than relying on someone to remember which ones
  // matter (shared-account project, see scheduler-link.ts's own header).
  await syncPasswordHashToScheduler(email, passwordHash);

  return { ok: true, pendingActivation: true };
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
  if (newPassword.length < MIN_PASSWORD_LENGTH) return { ok: false, error: passwordTooShortMessage() };

  const user = await prisma.user.findUnique({ where: { email } });
  // One generic error whether the account is missing or the current password is
  // wrong — so this can't be used to probe which emails exist.
  if (!user || !(await bcrypt.compare(currentPassword, user.passwordHash))) {
    return { ok: false, error: "Email or current password is incorrect." };
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  // tokenVersion bump (2026-09-14): a password change is the moment every
  // OTHER session for this account must stop working — the usual reason to
  // change a password is suspecting the old one leaked, and a session left
  // open elsewhere was outliving that. Same mechanism as sign-out/revoke
  // (lib/token-revocation.ts): the next request on any already-issued JWT
  // sees the version mismatch in auth.ts's jwt callback and lands on /login.
  // The person doing the changing is not stranded by this — they are on the
  // login form already, and LoginForm returns them to sign-in mode with a
  // "sign in with your new password" notice, which issues a fresh token at
  // the new version. (/login is outside proxy.ts's matcher, so a stale cookie
  // there is never redirected into a loop.)
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash, tokenVersion: { increment: 1 } } });
  invalidateTokenVersionCache(user.id);

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
