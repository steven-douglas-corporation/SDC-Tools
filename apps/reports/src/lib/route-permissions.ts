import { hasPermission, type AppRole, type Permission } from "@/lib/permissions";

// ── The single map every nav/route surface reads from ───────────────────────
//
// proxy.ts uses this to redirect a direct URL hit it shouldn't allow; Sidebar
// uses it to decide which links to render at all. One list, so a route can
// never end up gated in one place and not the other.
export const ROUTE_PERMISSIONS: readonly { path: string; permission: Permission }[] = [
  { path: "/job-hours", permission: "job-hour-details:view" },
  { path: "/tm", permission: "tm:view" },
  { path: "/build-readiness", permission: "build-readiness:view" },
  { path: "/quoted", permission: "projects:view" },
  // Added 2026-09-14. /jobs (the job list) and /jobs/[id] (one job's quoted vs
  // actual cost, ETC entries, task assignments) show the same cost figures as
  // /quoted, so they take the same permission — and until this entry existed
  // permissionForPath returned null for them, meaning proxy.ts let ANY
  // signed-in role through, ALL included. Every role that holds dashboard:view
  // (whose cards link here) also holds projects:view, so no dashboard link
  // starts dead-ending because of this. There is no sidebar item for /jobs, so
  // the (app) layout's visibleHrefs picking it up changes nothing visible.
  { path: "/jobs", permission: "projects:view" },
  { path: "/etc", permission: "monthly-etc:view" },
  { path: "/hours", permission: "hours:view" },
  { path: "/employees", permission: "employees:view" },
  { path: "/audit-log", permission: "audit-log:view" },
  { path: "/job-cost-explorer", permission: "profitability:view" },
  // Added 2026-09-01 with the cash-flow:view permission. Until then this route
  // was absent from the map (permissionForPath returned null, so proxy.ts let
  // any signed-in user through) and the page's own requireEltOnly() was the
  // only thing stopping them. Listing it here means the direct-URL check and
  // the sidebar agree, like every other route.
  { path: "/cash-flow", permission: "cash-flow:view" },
  // ── Feedback sits LATE in this array on purpose (2026-09-17) ──────────────
  //
  // Read safeFallbackPath() below before moving it. That function returns the
  // FIRST entry in array order whose permission the role holds, so any entry
  // near the top becomes the destination for every permission-denied redirect
  // in the app for every role that holds it.
  //
  // feedback:view ships MANAGER-only, so the blast radius today is one role —
  // but it is exactly the kind of permission that gets widened later from
  // /admin/permissions without anyone re-reading this file. Were it on for
  // everyone and listed first, an ALL user typing /cash-flow would land on the
  // complaints queue instead of Job Details, and the fallback would stop
  // meaning "the page you can definitely see". Nothing throws; the app just
  // quietly grows a new front door.
  //
  // Placed here it is reachable, gated, and can never be chosen as a fallback,
  // because job-hour-details:view is matched first for every real role.
  // tests/permissions.test.ts pins this.
  { path: "/feedback", permission: "feedback:view" },
  { path: "/admin/users", permission: "users:manage" },
  // Roster maintenance moved off the Employees page (2026-08-24). Gated on the
  // permission its writing half needs, not the read-only half.
  { path: "/admin/data-management", permission: "employees:edit" },
  { path: "/admin/permissions", permission: "permissions:manage" },
];

/** Longest-prefix match; "/" is only ever an exact match (everything is a prefix of it). */
export function permissionForPath(pathname: string): Permission | null {
  if (pathname === "/") return "dashboard:view";
  const hit = ROUTE_PERMISSIONS.filter((r) => pathname.startsWith(r.path)).sort(
    (a, b) => b.path.length - a.path.length,
  )[0];
  return hit?.permission ?? null;
}

// Where a "permission denied" redirect should land. This must NEVER be a
// hardcoded "/" — dashboard:view is a MANAGER-and-up permission, so an ALL
// role (the base tier, and what a session with no role claim at all falls
// back to) would get redirected to "/" and then immediately refused "/"
// again: an infinite loop (found live 2026-08-18, ERR_TOO_MANY_REDIRECTS).
// job-hour-details:view is the one permission every real role has — it's
// ALL's own first grant — so this always resolves to a page the caller can
// actually see, however low their role.
export function safeFallbackPath(role: AppRole | null | undefined): string {
  for (const r of ROUTE_PERMISSIONS) {
    if (hasPermission(role, r.permission)) return r.path;
  }
  return "/login";
}
