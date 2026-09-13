import { checkSchedulerToken } from "@/lib/scheduler-api-auth";
import { prisma } from "@/lib/prisma";
import { invalidateTokenVersionCache } from "@/lib/token-revocation";

// Server-to-server: the Scheduler calls this from ITS OWN logout action, so
// signing out there also invalidates any Reports session that was
// established via the SSO hand-off — the mirror of what Reports' own logout
// does to the Scheduler (POST /api/auth/revoke-session over there, added in
// the same change). Bearer-guarded exactly like every other
// /api/integration/* route; proxy.ts already exempts this whole prefix from
// the browser NextAuth session gate, and checkSchedulerToken fails closed
// (503) if SCHEDULER_SHARED_TOKEN is unset, same as those.
//
// Bumps tokenVersion rather than deleting the user or anything account-
// level — this only ever affects which already-issued JWTs are still
// honoured (see lib/token-revocation.ts), never login itself.
export async function POST(req: Request) {
  const denied = checkSchedulerToken(req);
  if (denied) return denied;

  const body = (await req.json().catch(() => null)) as { email?: string } | null;
  const email = body?.email?.trim().toLowerCase();
  if (!email) return Response.json({ error: "email_required" }, { status: 400 });

  const user = await prisma.user
    .update({ where: { email }, data: { tokenVersion: { increment: 1 } } })
    .catch(() => null);
  // Not found is a normal, expected case (the person has no Reports
  // account), not a failure — nothing to revoke, so say so plainly rather
  // than a 500.
  if (!user) return Response.json({ error: "user_not_found" }, { status: 404 });

  invalidateTokenVersionCache(user.id);
  return Response.json({ ok: true });
}
