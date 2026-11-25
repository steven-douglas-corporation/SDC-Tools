import { isCompanyEmail } from "./company-email";

// ── "Sign in with Microsoft" (Entra ID), for people who open this app directly ──
//
// Opening the app from the SDC Tools launcher already signs people in through the
// Scheduler hand-off (see scheduler-sso.ts). This is for a plain browser, where
// until now the only way in was the email and password form.
//
// Dependency-free on purpose (no Prisma, no next-auth, no `@/` imports), the
// same as permissions.ts: `tsx --test` loads it directly, and both auth.ts and
// the login page can use it.
//
// ── OFF until three settings exist ──────────────────────────────────────────
//
//   AUTH_MICROSOFT_ENTRA_ID_ID         Application (client) ID
//   AUTH_MICROSOFT_ENTRA_ID_SECRET     client secret value
//   AUTH_MICROSOFT_ENTRA_ID_TENANT_ID  Directory (tenant) ID
//
// With any of them missing the provider is not registered and the login page
// shows no Microsoft button: the app behaves exactly as it did before.
//
// ── It cannot be switched on for a plain-HTTP address ───────────────────────
//
// Entra only accepts return addresses that start with https, with one exception
// for http://localhost. So this works on a developer PC today, and on the
// server only once the app is reachable over HTTPS. See docs/ENTRA-SSO-SETUP.md.

/** The id next-auth gives the built-in Entra provider. Part of the callback URL. */
export const ENTRA_PROVIDER_ID = "microsoft-entra-id";

const ENV_ID = "AUTH_MICROSOFT_ENTRA_ID_ID";
const ENV_SECRET = "AUTH_MICROSOFT_ENTRA_ID_SECRET";
const ENV_TENANT = "AUTH_MICROSOFT_ENTRA_ID_TENANT_ID";

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type EntraSettings = {
  clientId: string;
  clientSecret: string;
  tenantId: string;
  /** Single-tenant issuer: only accounts in this directory can sign in. */
  issuer: string;
};

type Env = Record<string, string | undefined>;

function read(env: Env) {
  return {
    clientId: env[ENV_ID]?.trim() ?? "",
    clientSecret: env[ENV_SECRET]?.trim() ?? "",
    tenantId: env[ENV_TENANT]?.trim() ?? "",
  };
}

/**
 * Why Microsoft sign-in is off although someone started configuring it, or null
 * when it is either fully configured or not configured at all. For a startup
 * warning: a half-set configuration otherwise looks exactly like "off".
 */
export function entraSettingsProblem(env: Env): string | null {
  const { clientId, clientSecret, tenantId } = read(env);
  const set = [clientId, clientSecret, tenantId].filter(Boolean).length;
  if (set === 0) return null;
  if (set < 3) {
    const missing = [!clientId && ENV_ID, !clientSecret && ENV_SECRET, !tenantId && ENV_TENANT].filter(Boolean);
    return `Microsoft sign-in is off: ${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} not set.`;
  }
  // The tenant id becomes part of the issuer URL. Anything but a directory id
  // here (in particular "common" or "organizations") would let accounts from
  // other organisations through, so it is refused rather than passed along.
  if (!GUID.test(tenantId)) {
    return `Microsoft sign-in is off: ${ENV_TENANT} must be the Directory (tenant) ID, not "${tenantId}".`;
  }
  return null;
}

/** The settings when Microsoft sign-in is fully configured, otherwise null. */
export function entraSettings(env: Env): EntraSettings | null {
  const { clientId, clientSecret, tenantId } = read(env);
  if (!clientId || !clientSecret || !GUID.test(tenantId)) return null;
  return {
    clientId,
    clientSecret,
    tenantId: tenantId.toLowerCase(),
    issuer: `https://login.microsoftonline.com/${tenantId.toLowerCase()}/v2.0`,
  };
}

/** The claims this app reads from a Microsoft ID token. Everything is untrusted input. */
export type EntraClaims = {
  email?: unknown;
  preferred_username?: unknown;
  tid?: unknown;
  name?: unknown;
};

/**
 * The address this app knows the person by. `email` first, then
 * `preferred_username` (the sign-in name), which is the same order the
 * Scheduler's own Microsoft exchange uses, so one person resolves to one
 * address in both apps. Lowercased, because User.email is stored lowercased.
 */
export function entraEmail(claims: EntraClaims): string | null {
  for (const candidate of [claims.email, claims.preferred_username]) {
    if (typeof candidate !== "string") continue;
    const value = candidate.trim().toLowerCase();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return value;
  }
  return null;
}

/**
 * Why a Microsoft sign-in must be turned away, or null when it may proceed to
 * the account lookup. Three checks, none of which trusts the others:
 *
 *  - the token came from OUR directory. The issuer already restricts this; the
 *    `tid` claim is checked as well so that a mistake in the issuer setting
 *    cannot quietly open the door to other organisations.
 *  - it names an address this app can use.
 *  - that address is a company one, the same rule self-registration and the
 *    Scheduler hand-off apply (company-email.ts).
 */
export function entraSignInRefusal(claims: EntraClaims, settings: EntraSettings): string | null {
  if (typeof claims.tid !== "string" || claims.tid.toLowerCase() !== settings.tenantId) {
    return "The Microsoft account is not in this organisation's directory.";
  }
  const email = entraEmail(claims);
  if (!email) return "The Microsoft account has no email address this app can use.";
  if (!isCompanyEmail(email)) return "Only company email addresses can sign in.";
  return null;
}

/** The display name from the token, if it carries a usable one. */
export function entraDisplayName(claims: EntraClaims): string | null {
  return typeof claims.name === "string" && claims.name.trim() ? claims.name.trim() : null;
}
