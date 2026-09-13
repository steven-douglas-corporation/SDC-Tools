import { NextRequest, NextResponse } from "next/server";
import { AuthError } from "next-auth";
import { signIn } from "@/lib/auth";

// Inbound half of the Scheduler ↔ Reports SSO hand-off — the mirror of
// scheduler-sso.ts's outbound mint, which every existing Reports→Scheduler
// link already uses. A Scheduler-authored link lands HERE, never on the
// final destination directly: proxy.ts's session gate runs before any other
// route's own code does, so a token bolted onto e.g.
// "/job-hours?...&sso=..." would be silently dropped at the login redirect
// before anything could read it. This route is exempt from that gate for
// free — proxy.ts's matcher already excludes the whole `api/auth` prefix.
//
// Calls the SERVER-exported `signIn` from lib/auth (not next-auth/react's
// client one) with a synthetic in-process request, so verifying the
// assertion and establishing the real session cookie happens in one hop —
// no rendered landing page, no client-side round trip.
// `req.url` inside a route handler is the server's own internal URL
// (localhost:4006), NOT the origin the browser asked for — so
// `NextResponse.redirect(new URL("/login", req.url))` sent SDC Tools shell
// users to localhost, which on their machine is nothing at all: a blank white
// window. Build the origin from the Host header instead. (A relative Location
// header would also be correct HTTP, but see proxy.ts — Next 16 rejects those,
// so keep both files on the same absolute-from-Host approach.)
function redirectTo(req: NextRequest, pathAndQuery: string) {
  const host  = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const proto = req.headers.get("x-forwarded-proto") ?? "http";
  const base  = host ? `${proto}://${host}` : req.nextUrl.origin;
  return NextResponse.redirect(new URL(pathAndQuery, base));
}

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  const next = req.nextUrl.searchParams.get("next") || "/";
  if (!token) return redirectTo(req, "/login");

  try {
    // `next` reaches NextAuth's own `redirectTo`, which its default redirect
    // callback already collapses any off-origin value back to this app's own
    // origin — an open redirect via `next=` isn't possible without this
    // route adding anything itself.
    const url = await signIn("scheduler-sso" as Parameters<typeof signIn>[0], {
      token,
      redirectTo: next,
      redirect: false,
    });
    // NextAuth returns either a path or an absolute URL at its own configured
    // origin; keep only the path+query so the browser resolves it against the
    // origin it is really on.
    const dest = new URL(url as string, "http://internal.invalid");
    return redirectTo(req, dest.pathname + dest.search);
  } catch (e) {
    // Bad signature, expired, already-used, or no Reports account for that
    // email — every one of those collapses to authorize() returning null,
    // which NextAuth reports uniformly as an AuthError. Whatever the exact
    // cause, this must degrade to the normal login form, never a broken or
    // blank page.
    if (e instanceof AuthError) {
      return redirectTo(req, "/login");
    }
    throw e;
  }
}
