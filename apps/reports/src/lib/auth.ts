import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { logAuditFor } from "@/lib/audit";
import { verifySchedulerSsoToken, consumeSchedulerSsoNonce } from "@/lib/scheduler-sso";
import { currentTokenVersion } from "@/lib/token-revocation";
import { isCompanyEmail } from "@/lib/company-email";
import { nameFromEmail } from "@/lib/name-from-email";
import { fetchSchedulerPasswordHash } from "@/lib/scheduler-link";

// Email/password authentication. Accounts are created via the sign-up form
// (see src/app/login/actions.ts) or the seed script; passwords are stored as
// bcrypt hashes and never in plaintext.
export const { handlers, signIn, signOut, auth } = NextAuth({
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  // Required when self-hosting behind a hostname like server-app1 (NextAuth
  // otherwise only trusts hosts it can infer on known platforms).
  trustHost: true,
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      authorize: async (credentials) => {
        const email = (credentials?.email as string | undefined)?.trim().toLowerCase();
        const password = credentials?.password as string | undefined;
        if (!email || !password) return null;

        const user = await prisma.user.findUnique({ where: { email } });
        if (!user) return null;

        const valid = await bcrypt.compare(password, user.passwordHash);
        if (!valid) return null;

        // Deactivated accounts fail sign-in here, not just the ongoing-session
        // recheck in the jwt callback below — currentTokenVersion returns null
        // for either "no such user" or "inactive" (see token-revocation.ts).
        if ((await currentTokenVersion(user.id)) === null) return null;

        return { id: String(user.id), email: user.email, name: user.name, role: user.role };
      },
    }),
    // SSO hand-off FROM the Scheduler — the mirror image of the assertion
    // this app already mints for links going the other way (see
    // scheduler-sso.ts). An explicit `id` is required: Credentials()
    // defaults every instance to id:"credentials", so without this override
    // the second provider silently collides with the first and is never
    // reachable. Consumed by src/app/api/auth/sso/route.ts, never by the
    // login form — there is no UI for this provider.
    //
    // An assertion says who someone is, not automatically that they may use
    // this app — EXCEPT for a company email, where the whole point of the
    // shared-account project is that having an account on one side is
    // enough to get a working (if low-privilege) account on the other,
    // without a second sign-up. A non-company email with no existing
    // Reports user still falls through to `null` — auto-provisioning stays
    // scoped to people this app would let self-register anyway.
    Credentials({
      id: "scheduler-sso",
      credentials: {
        token: { label: "Token", type: "text" },
      },
      authorize: async (credentials) => {
        const token = credentials?.token as string | undefined;
        if (!token) return null;

        const verified = verifySchedulerSsoToken(token);
        if (!verified) return null;
        // Single-use, checked AFTER signature/expiry so a malformed or
        // already-expired token can't burn a legitimate nonce slot.
        if (!consumeSchedulerSsoNonce(verified.nonce)) return null;

        const existing = await prisma.user.findUnique({ where: { email: verified.email } });
        if (existing) {
          if ((await currentTokenVersion(existing.id)) === null) return null; // deactivated
          return { id: String(existing.id), email: existing.email, name: existing.name, role: existing.role };
        }

        if (!isCompanyEmail(verified.email)) return null;

        // First time this person has ever reached Reports via the Scheduler
        // hand-off — create their account, seeded with their CURRENT Scheduler
        // password hash so the same password works directly on this app's own
        // login form immediately (shared-account project — see
        // scheduler-link.ts's fetchSchedulerPasswordHash for why sharing a
        // one-way hash isn't "copying a password"). Falls back to a random,
        // unusable hash only if that fetch fails (Scheduler unreachable, or
        // somehow no local account despite the token) — sign-in for this row
        // then only ever arrives through this same SSO path until a password
        // is set some other way.
        const passwordHash = (await fetchSchedulerPasswordHash(verified.email)) ?? (await bcrypt.hash(randomBytes(32).toString("hex"), 10));
        const created = await prisma.user.create({
          data: { email: verified.email, name: nameFromEmail(verified.email), passwordHash },
        });
        await logAuditFor(created.id, created.email, {
          action: "user.autoProvisioned",
          entityType: "User",
          entityId: created.id,
          summary: `${created.email} auto-provisioned via Scheduler SSO`,
        });
        return { id: String(created.id), email: created.email, name: created.name, role: created.role };
      },
    }),
  ],
  callbacks: {
    jwt: async ({ token, user, account }) => {
      if (user) {
        // Fresh sign-in — pin the CURRENT version into the token. Read
        // fresh rather than trusting a value off `user` (neither provider's
        // `authorize()` returns one), which also means a version bumped
        // between "authorize() approved this sign-in" and "the jwt callback
        // ran" is still honoured correctly rather than baked in stale.
        token.role = user.role;
        token.tokenVersion = (await currentTokenVersion(Number(user.id))) ?? 0;
        const viaSso = account?.provider === "scheduler-sso";
        await logAuditFor(Number(user.id), user.email ?? null, {
          action: "auth.signIn",
          entityType: "User",
          entityId: user.id,
          summary: viaSso ? `${user.email} signed in (via Scheduler SSO)` : `${user.email} signed in`,
        });
      } else if (token.sub) {
        // Existing session, re-checked on every request (this callback runs
        // whenever the session is read, not only at sign-in — see
        // token-revocation.ts). If a logout (here or on the Scheduler) or an
        // admin action bumped the version since this JWT was issued, the
        // value pinned above is stale — returning `null` is how a NextAuth
        // JWT session is invalidated server-side; the next page load bounces
        // to /login exactly as if there were no session at all.
        //
        // A token signed BEFORE this feature existed carries no
        // `tokenVersion` claim at all (`undefined`, not `0`) — treated as 0
        // here, the same tolerant reading the Scheduler's own check already
        // uses (`req.authUser.token_version || 0`), so deploying this does
        // NOT force-log-out every already-signed-in person for free; only an
        // ACTUAL revoke (which starts everyone else, and itself, at 0) does.
        const current = await currentTokenVersion(Number(token.sub));
        const tokenVersion = typeof token.tokenVersion === "number" ? token.tokenVersion : 0;
        if (current === null || current !== tokenVersion) return null;
      }
      return token;
    },
    session: async ({ session, token }) => {
      if (session.user) {
        session.user.role = token.role ?? "ALL";
        if (token.sub) session.user.id = token.sub;
      }
      return session;
    },
    // No `authorized` callback here any more — proxy.ts now passes auth() a
    // custom handler function instead of relying on this callback, and
    // next-auth's own middleware wrapper (lib/index.js's handleAuth) skips
    // `authorized` entirely whenever a custom handler is present. Both the
    // "must be signed in" check and the new permission check live in
    // proxy.ts, in one place, together.
  },
});
