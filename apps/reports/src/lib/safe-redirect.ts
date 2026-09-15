// ── The one place a caller-supplied "where to go next" is made safe ──────────
//
// Dependency-free and browser-safe (no node:, no "@/" imports), because it has to
// run in three places at once: api/auth/sso/route.ts (a Node route handler taking
// `?next=`), login/LoginForm.tsx (a client component taking `?callbackUrl=`, set
// by proxy.ts), and the unit test.
//
// Why `startsWith("/")` is not enough (2026-09-14): next-auth's default redirect
// callback accepts any value beginning with "/", but a scheme-relative URL
// begins with "/" too — `new URL("//evil.example/x", "http://reports")` resolves
// to http://evil.example/x, so `next=//evil.example` was an open redirect through
// a trusted-looking login link. Browsers also treat a backslash as a slash in
// this position ("/\evil.example"), and the WHATWG URL parser normalises it to
// "//evil.example", so a check on the RAW string alone still leaks.
//
// The rule: the value must be a same-origin path. It is parsed against a
// throwaway base, the result must still be on that base, and the NORMALISED
// path (what the browser would actually use) is re-checked the same way before
// being returned. Anything else becomes `fallback`, never an error — a bad
// `next` is a nuisance to route around, not a reason to break sign-in.

const PROBE_BASE = "http://internal.invalid";

/** True when `path` is a plain same-origin path: "/x", "/x?y=1", "/x#z". */
export function isSafeRelativePath(path: unknown): path is string {
  if (typeof path !== "string" || path.length === 0) return false;
  if (!path.startsWith("/")) return false;
  if (path.startsWith("//") || path.startsWith("/\\")) return false;
  let url: URL;
  try {
    url = new URL(path, PROBE_BASE);
  } catch {
    return false;
  }
  if (url.origin !== PROBE_BASE) return false;
  // The normalised form is what a later `new URL(dest, realOrigin)` will see.
  const normalised = url.pathname + url.search + url.hash;
  if (!normalised.startsWith("/") || normalised.startsWith("//") || normalised.startsWith("/\\")) return false;
  try {
    return new URL(normalised, PROBE_BASE).origin === PROBE_BASE;
  } catch {
    return false;
  }
}

/**
 * The normalised same-origin path for `input`, or `fallback` (default "/")
 * when it is missing, malformed, off-origin, or would land back on the login
 * page itself (a callbackUrl of "/login" after a successful login is a loop of
 * one step — pointless, so it is treated like no callbackUrl at all).
 */
export function safeRelativePath(input: unknown, fallback = "/"): string {
  if (!isSafeRelativePath(input)) return fallback;
  const url = new URL(input, PROBE_BASE);
  if (url.pathname === "/login" || url.pathname.startsWith("/login/")) return fallback;
  return url.pathname + url.search + url.hash;
}

/**
 * For callers that redirect against a REAL origin: resolves `path` against
 * `origin` and confirms the result stayed there. Returns the absolute URL, or
 * `${origin}${fallback}`. Unlike safeRelativePath this does NOT reject
 * "/login" — the SSO route legitimately sends a failed hand-off there.
 */
export function resolveSameOrigin(path: string, origin: string, fallback = "/"): URL {
  const base = new URL(origin);
  if (isSafeRelativePath(path)) {
    try {
      const url = new URL(path, base);
      if (url.origin === base.origin) return url;
    } catch {
      // fall through to the fallback
    }
  }
  return new URL(fallback, base);
}
