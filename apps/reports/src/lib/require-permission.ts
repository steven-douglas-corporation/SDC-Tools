import { redirect } from "next/navigation";
import { NextResponse } from "next/server";
import type { Session } from "next-auth";
import { auth } from "@/lib/auth";
import { hasPermission, type Permission } from "@/lib/permissions";
import { safeFallbackPath } from "@/lib/route-permissions";

// Three call shapes for the same check, one per place authorization actually
// has to be re-verified — proxy.ts is a fourth (it can't import "use server"
// action helpers, and works from the request's own token instead, see
// proxy.ts). None of these are "use server" themselves: they're plain helpers
// called FROM server components and server actions, never bound directly to a
// client form/event.

/**
 * For a Server Component page. Redirects to a page the caller's OWN role can
 * actually see (safeFallbackPath) rather than rendering anything for a role
 * that lacks the permission — there is no dedicated "forbidden" page, so an
 * unauthorized hit looks identical to typing a route that doesn't exist.
 * Never redirects to a hardcoded "/" — see safeFallbackPath's own comment for
 * the redirect-loop that produced from doing that. Returns the session so the
 * page doesn't pay for a second `auth()` call.
 */
export async function requirePagePermission(permission: Permission): Promise<Session> {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (!hasPermission(session.user.role, permission)) redirect(safeFallbackPath(session.user.role));
  return session;
}

/**
 * For a Server Action. Throws rather than returning a flag, matching the
 * existing assertProjectsEditable()/assertStandardSheetUnlocked() convention
 * — a missed call site fails loudly instead of silently falling through to
 * the write, and callers already catch these to surface a toast.
 */
export async function assertActionPermission(permission: Permission): Promise<Session> {
  const session = await auth();
  if (!session?.user) throw new Error("You need to be signed in to do that.");
  if (!hasPermission(session.user.role, permission)) {
    throw new Error("You don't have permission to do that.");
  }
  return session;
}

/** For a Route Handler, given a session it already fetched. */
export function requireApiPermission(session: Session | null, permission: Permission): NextResponse | null {
  if (!session?.user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (!hasPermission(session.user.role, permission)) {
    return NextResponse.json({ error: "Not authorized." }, { status: 403 });
  }
  return null;
}
