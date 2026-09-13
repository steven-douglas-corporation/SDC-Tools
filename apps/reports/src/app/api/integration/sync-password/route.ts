import { checkSchedulerToken } from "@/lib/scheduler-api-auth";
import { prisma } from "@/lib/prisma";

// Server-to-server: the Scheduler calls this whenever a LINKED account's password
// changes over there (its own change-password action, or an admin's reset), so the two
// apps' login forms keep working from the same credential without either one ever
// seeing the other's plaintext (shared-account project, 2026-08-13 — see
// scheduler-sso.ts's own header for the auto-provisioning half of this).
//
// Only a bcrypt HASH ever crosses this boundary, never the password itself — sharing a
// one-way, salted digest isn't "copying a password" any more than each app already
// storing its own hash is; possessing it lets you VERIFY a guess, not recover anything.
// The mirror image lives on the Scheduler (POST /api/auth/sync-password), called from
// this app's own changePassword()/registerUser() (see login/actions.ts).
//
// Bearer-guarded exactly like every other /api/integration/* route; proxy.ts already
// exempts this prefix from the browser NextAuth session gate.
export async function POST(req: Request) {
  const denied = checkSchedulerToken(req);
  if (denied) return denied;

  const body = (await req.json().catch(() => null)) as { email?: string; passwordHash?: string } | null;
  const email = body?.email?.trim().toLowerCase();
  const passwordHash = body?.passwordHash;
  if (!email || !passwordHash) return Response.json({ error: "email_and_passwordHash_required" }, { status: 400 });
  // A loose sanity check, not full validation — this is a trusted server-to-server call,
  // but a malformed value here would otherwise silently brick someone's login.
  if (!/^\$2[aby]\$\d{2}\$.{53}$/.test(passwordHash)) {
    return Response.json({ error: "passwordHash_does_not_look_like_bcrypt" }, { status: 400 });
  }

  const user = await prisma.user.update({ where: { email }, data: { passwordHash } }).catch(() => null);
  // Not found is a normal, expected case (this email has no Reports account, or isn't
  // actually linked) — nothing to sync, not a failure.
  if (!user) return Response.json({ error: "user_not_found" }, { status: 404 });

  return Response.json({ ok: true });
}
