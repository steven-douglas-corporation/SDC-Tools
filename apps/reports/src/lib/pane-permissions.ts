import { hasPermission, type AppRole } from "@/lib/permissions";
import { ROUTE_PERMISSIONS } from "@/lib/route-permissions";
import { normalizePath } from "@/lib/split-view";

// ── Which pane routes a role may open, and whether a given tab is one of them ─
//
// REPORTED 2026-09-14: the tab bar's "+" and "Split View → Open another page…"
// offered every SPLIT_ROUTE regardless of role, and a tab whose route the role
// cannot see rendered the page body — whose own requirePagePermission() calls
// redirect(). Inside a pane that redirect does not refuse ONE tab: it ejects the
// whole /w route, and every other open tab with it. The same thing happened on a
// `permissions` realtime event: router.refresh() re-ran every pane, and any tab
// the role had just lost threw the user out of their workspace.
//
// Two helpers, one rule:
//
//   permittedRoutePaths(role)   the paths this role may see — computed the same way
//                               app/(app)/layout.tsx computes the sidebar's
//                               `visibleHrefs`, so the strip, the picker and the
//                               sidebar cannot disagree about what is openable.
//   paneAllowed(route, paths)   pure: is `route` one of them. Used on the server
//                               (PaneView, to render an in-pane refusal instead of
//                               letting the page-level redirect fire) and on the
//                               client (the tab bar, to hide what cannot be opened).
//
// This is a UX pre-check, not the authorization. The page body's own
// requirePagePermission() still runs for every pane and is still the gate; what
// this changes is only that a refused tab shows a message in ITS pane rather than
// navigating the whole document away from the tabs the user may keep.

/** Every path this role's sidebar would show — identical to the layout's `visibleHrefs`. */
export function permittedRoutePaths(role: AppRole | null | undefined): string[] {
  const out = ROUTE_PERMISSIONS.filter((r) => hasPermission(role, r.permission)).map((r) => r.path);
  if (hasPermission(role, "dashboard:view")) out.push("/");
  return out;
}

/**
 * May a tab on `route` be shown to a user who can see exactly `permitted`?
 *
 * Exact match after normalization — a pane route is always one of the twelve
 * top-level paths, so the longest-prefix rule permissionForPath uses for arbitrary
 * URLs is not needed here, and "/" must never match as a prefix of everything.
 */
export function paneAllowed(route: string, permitted: Iterable<string>): boolean {
  const p = normalizePath(route);
  for (const allowed of permitted) if (normalizePath(allowed) === p) return true;
  return false;
}
