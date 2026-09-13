import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { permissionForPath, safeFallbackPath } from "@/lib/route-permissions";

// Passing auth() a handler function (rather than re-exporting it bare, as
// this used to) makes next-auth skip its own `authorized` callback entirely
// — see the comment on auth.ts's callbacks object. That means the "must be
// signed in" check that callback used to provide is now THIS function's job
// too, not just the new permission check below; both live here so there is
// one place, not two, deciding what a given request may reach.

// The origin the BROWSER actually asked for, taken from the request headers.
//
// Two traps make this necessary, and neither is obvious:
//   1. next-auth v5's `auth()` wrapper rewrites `req.url` (and `req.nextUrl`)
//      to AUTH_URL's origin. When AUTH_URL drifted from the app's real port
//      (stale ":3010" after the 2026-08-23 renumber to 4006), every
//      unauthenticated request 307'd to a dead origin — which in the SDC Tools
//      Electron shell is a permanently blank white window, no error anywhere.
//   2. A RELATIVE Location header looks like the clean fix and is legal HTTP,
//      but Next 16's middleware layer parses the value with `new URL(value)`
//      and throws ERR_INVALID_URL — a 500 on every gated route. Measured live
//      2026-08-24; do not "simplify" this back to a bare path.
// So: absolute, but built from Host rather than from anything AUTH_URL touches.
function requestOrigin(req: { headers: Headers; nextUrl: URL }) {
  const host  = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (!host) return req.nextUrl.origin;  // no Host header at all — nothing better to use
  const proto = req.headers.get("x-forwarded-proto") ?? "http";
  return `${proto}://${host}`;
}

export const proxy = auth((req) => {
  if (!req.auth?.user) {
    // callbackUrl is relative — an absolute one built from the rewritten
    // req.nextUrl.href would carry the wrong origin forward and strand the
    // user there after a successful login.
    const signInUrl = new URL("/login", requestOrigin(req));
    signInUrl.searchParams.set("callbackUrl", req.nextUrl.pathname + req.nextUrl.search);
    return NextResponse.redirect(signInUrl);
  }

  // /cash-flow used to be checked HERE, separately, as `role !== "ELT"` —
  // it was deliberately not a togglable Permission. It is one now
  // (cash-flow:view, 2026-09-01) and it is listed in ROUTE_PERMISSIONS like
  // every other route, so the generic check below covers it and this special
  // case is gone. Access is unchanged: the migration seeds that permission OFF
  // for every role but ELT, which passes via hasPermission()'s wildcard.

  // Defense-in-depth against a typed-in URL — NOT the only enforcement point.
  // A Server Action's route can fall outside this matcher entirely, so every
  // mutating action re-checks with assertActionPermission() regardless of
  // what happens here (see require-permission.ts).
  //
  // The redirect target is NEVER a hardcoded "/" — dashboard:view is
  // MANAGER-and-up, so an ALL role denied anywhere would get sent to "/" and
  // immediately refused "/" too: an infinite loop (found live 2026-08-18,
  // ERR_TOO_MANY_REDIRECTS from outside the office LAN). safeFallbackPath
  // always lands on a route the caller's own role can actually see.
  const permission = permissionForPath(req.nextUrl.pathname);
  if (permission && !hasPermission(req.auth.user.role, permission)) {
    return NextResponse.redirect(new URL(safeFallbackPath(req.auth.user.role), requestOrigin(req)));
  }
});

export const config = {
  // api/integration is exempt from the browser NextAuth session: those routes
  // are server-to-server (called by SDC_Scheduler) and enforce their own
  // SCHEDULER_SHARED_TOKEN bearer guard, which fails closed when unset.
  //
  // BOTH `api/health` and `health` are exempt — the suite's other apps answer
  // the bare `/health`, and whatever polls them uniformly was hammering this
  // app's login redirect once a second until src/app/health/route.ts existed.
  matcher: ["/((?!login|api/auth|api/integration|api/health|health|_next/static|_next/image|favicon.ico|brand/).*)"],
};
