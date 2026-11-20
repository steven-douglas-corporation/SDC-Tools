import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { logAuditFor } from "@/lib/audit";
import { verifySchedulerSsoToken, consumeSchedulerSsoNonce } from "@/lib/scheduler-sso";
import { currentTokenVersion } from "@/lib/token-revocation";
import { currentUserRole } from "@/lib/session-role";
import { isCompanyEmail } from "@/lib/company-email";
import { nameFromEmail } from "@/lib/name-from-email";
import { fetchSchedulerPasswordHash } from "@/lib/scheduler-link";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import {
  ENTRA_PROVIDER_ID,
  entraDisplayName,
  entraEmail,
  entraSettings,
  entraSettingsProblem,
  entraSignInRefusal,
} from "@/lib/entra-sign-in";

// "Sign in with Microsoft", for people who open this app in a browser instead
// of through the SDC Tools launcher. Null (and the provider below absent) until
// all three AUTH_MICROSOFT_ENTRA_ID_* settings exist — see entra-sign-in.ts.
const entra = entraSettings(process.env);
const entraProblem = entraSettingsProblem(process.env);
if (entraProblem) console.warn(`[auth] ${entraProblem}`);

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
    // Microsoft Entra ID, single tenant. Registered only when configured, so an
    // unconfigured server exposes no extra sign-in route at all.
    //
    // The scope is cut down to sign-in only and `profile` is replaced: the
    // library's default also asks for User.Read and downloads the person's
    // photo from Microsoft Graph on every sign-in, which this app has no use
    // for. `role` here is a placeholder the type requires — the real role is
    // read from the User row in the jwt callback, never taken from the token.
    ...(entra
      ? [
          MicrosoftEntraID({
            clientId: entra.clientId,
            clientSecret: entra.clientSecret,
            issuer: entra.issuer,
            authorization: { params: { scope: "openid profile email" } },
            profile: (profile) => ({
              id: profile.sub,
              name: entraDisplayName(profile),
              email: entraEmail(profile),
              image: null,
              role: "ALL" as const,
            }),
          }),
        ]
      : []),
  ],
  callbacks: {
    // Runs for every provider; only the Microsoft one has anything to decide
    // here (both Credentials providers already decided in authorize()).
    //
    // A refusal returns the login page with ?error=microsoft rather than
    // `false`, which would land on next-auth's own unstyled error page. The
    // reason is deliberately not passed along: the page shows one message for
    // every refusal, so it cannot be used to learn which addresses have
    // accounts or which are deactivated.
    signIn: async ({ account, profile }) => {
      if (account?.provider !== ENTRA_PROVIDER_ID) return true;
      const refused = "/login?error=microsoft";
      if (!entra || !profile) return refused;
      if (entraSignInRefusal(profile, entra)) return refused;
      const email = entraEmail(profile);
      if (!email) return refused;

      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing) {
        // Deactivated accounts stay out, exactly as on the password form.
        return (await currentTokenVersion(existing.id)) === null ? refused : true;
      }

      // First time this person has reached Reports. Same reasoning as the
      // Scheduler hand-off above: Microsoft has proved who they are and that
      // they are in our directory, which is the ownership proof the
      // self-registration form lacks — so the account is usable at once, at
      // the least-privilege role. The password hash is random and unusable:
      // an account made this way can only ever sign in through Microsoft (or
      // the Scheduler hand-off) until a password is set some other way.
      try {
        const created = await prisma.user.create({
          data: {
            email,
            name: entraDisplayName(profile) ?? nameFromEmail(email),
            passwordHash: await bcrypt.hash(randomBytes(32).toString("hex"), 10),
          },
        });
        await logAuditFor(created.id, created.email, {
          action: "user.autoProvisioned",
          entityType: "User",
          entityId: created.id,
          summary: `${created.email} auto-provisioned via Microsoft sign-in`,
        });
      } catch (e) {
        // Two first sign-ins for the same person at once: the loser hits the
        // unique email. Fine as long as the row now exists.
        if (!(await prisma.user.findUnique({ where: { email } }))) throw e;
      }
      return true;
    },
    jwt: async ({ token, user, account }) => {
      if (user && account?.provider === ENTRA_PROVIDER_ID) {
        // A Microsoft sign-in. `user.id` here is MICROSOFT's id for the person,
        // not this app's — every other part of the app reads token.sub as a
        // User.id, so it is replaced with the real one, looked up by the
        // address the signIn callback above just accepted. Role and token
        // version come from the same row, never from the Microsoft token.
        const email = user.email?.trim().toLowerCase();
        const row = email ? await prisma.user.findUnique({ where: { email } }) : null;
        if (!row) return null;
        const version = await currentTokenVersion(row.id);
        if (version === null) return null;
        token.sub = String(row.id);
        token.email = row.email;
        token.name = row.name;
        token.picture = null;
        token.role = row.role;
        token.tokenVersion = version;
        await logAuditFor(row.id, row.email, {
          action: "auth.signIn",
          entityType: "User",
          entityId: row.id,
          summary: `${row.email} signed in (via Microsoft)`,
        });
      } else if (user) {
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
        const userId = Number(token.sub);
        const current = await currentTokenVersion(userId);
        const tokenVersion = typeof token.tokenVersion === "number" ? token.tokenVersion : 0;
        if (current === null || current !== tokenVersion) return null;

        // Role refresh (2026-09-14). `token.role` used to be written once, at
        // sign-in, and never again — so an admin changing someone's role on
        // /admin/users did nothing to that person's open session, demotion
        // included, until they happened to sign out. The role now comes from
        // the database on every request (cached 60s, same as the version
        // check above — see session-role-cache.ts for the cost argument), so
        // the session claim can never disagree with the User row for longer
        // than that. `null` here means the row is gone, deactivated, or holds
        // a role this build does not know — every one of those ends the
        // session rather than continuing on a stale claim. (setUserRole also
        // bumps tokenVersion, so the usual admin path ends the old session
        // immediately via the check above; this is the backstop for every
        // other way a role can change.)
        const role = await currentUserRole(userId);
        if (role === null) return null;
        token.role = role;
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
