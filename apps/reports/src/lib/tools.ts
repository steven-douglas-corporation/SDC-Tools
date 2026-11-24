// The tools this app holds, and which of them a person has.
//
// A tool is a set of pages with its own menu in the sidebar. For now there is one: Reports.
// The tools page at "/" shows a tile for each, and the launcher at the top of the sidebar
// switches between them.
//
// Internal Projects (src/modules/tracker, at /tracker) was a tool of its own; for now it is a
// page in Reports' Planning menu instead (2026-11-24), so it has no tile or launcher entry and
// its menu is Reports'. isTrackerPath still marks those pages so feedback can tag them as
// "Internal Projects"; the tracker can be split back into its own tool later (see MODULES/ADR).
//
// Nothing here decides a permission. A tool is shown when the person may open at least
// one of its pages, and that list (`permitted`) is the layout's `visibleHrefs`, worked
// out on the server from ROUTE_PERMISSIONS. So this file is pure and safe in a client
// component, and a tool can never be offered here and refused by the page.

export type ToolId = "reports";

/**
 * A tool, or Admin. Admin is not a tool — it is the pages every tool shares (users,
 * permissions, the audit log, feedback) — but it is reached two ways: a tile on the tools page
 * (adminFor), shown only to someone who holds a real admin page, and an entry in the launcher
 * beside the tools. It has a menu of its own when it is open.
 */
export type AreaId = ToolId | "admin";

export interface Tool {
  id: ToolId;
  label: string;
  /** One line under the name on a tile. */
  description: string;
  /** Where opening the tool lands. Always a page this person may open. */
  href: string;
}

/** An Internal Projects page. Exported for feedback tagging (feedback-status.ts); the nav no
 * longer branches on it, since these are Reports pages now. */
export const isTrackerPath = (path: string): boolean => path === "/tracker" || path.startsWith("/tracker/");

/** Pages every tool shares. They are the Admin area, and never make a tool on their own. */
// Admin is the app's own area: accounts, permissions, feedback and the audit log, shared by
// every tool. (The audit log records every tool's actions, not only Reports'.) Data Management
// has an /admin address but is about Reports' data only (rosters, finances, data quality), so it
// lives in Reports' menu, not Admin.
const isReportsHousekeeping = (path: string): boolean =>
  path === "/admin/data-management" || path.startsWith("/admin/data-management/");

const isSharedPath = (path: string): boolean =>
  !isReportsHousekeeping(path) && (path === "/feedback" || path === "/audit-log" || path.startsWith("/admin/"));

/**
 * The tools a person has, in the order they are shown. `permitted` is every path their role
 * may open, in ROUTE_PERMISSIONS order.
 */
export function toolsFor(permitted: readonly string[]): Tool[] {
  const tools: Tool[] = [];
  // The housekeeping pages sit in Reports' menu but do not make Reports a tool on their own:
  // someone who may open only the Audit Log is not offered a Reports tile that leads nowhere else.
  // Internal Projects (/tracker) IS a Reports page now, so it counts here and earns no tile of its
  // own — a tracker-only role lands on /tracker through the Reports tile.
  const reportPages = permitted.filter((p) => !isSharedPath(p) && !isReportsHousekeeping(p));
  if (reportPages.length > 0) {
    tools.push({
      id: "reports",
      label: "Reports",
      description: "Jobs, hours, ETC and profitability",
      // The Dashboard for those who have it; otherwise the first report they do have, which
      // is the same page a refused visit already falls back to (safeFallbackPath).
      href: reportPages.includes("/dashboard") ? "/dashboard" : reportPages[0]!,
    });
  }
  return tools;
}

/** Where an Admin tile lands, in order of preference — the first of these the person holds. */
const ADMIN_LANDING = ["/admin/users", "/admin/permissions", "/audit-log"] as const;

export interface AdminArea {
  label: string;
  description: string;
  href: string;
}

/**
 * The Admin tile for the tools page, or null when the person has no admin page to land on.
 * Admin is not a tool, but it earns a tile so the shared pages are reachable from home, not
 * only the launcher. Feedback alone does not earn the tile: every role may open Feedback, so a
 * tile shown for that would call an ordinary person an administrator. The tile appears only for
 * someone who holds a genuine admin page, and lands on the first they hold — always a page they
 * may open, so it never leads to a refusal.
 */
export function adminFor(permitted: readonly string[]): AdminArea | null {
  const href = ADMIN_LANDING.find((p) => permitted.includes(p));
  if (!href) return null;
  return { label: "Admin", description: "Accounts, permissions, feedback and the audit log", href };
}

/** Which area a page belongs to. Null for the tools page itself, which belongs to none. */
// Internal Projects pages (/tracker) are Reports pages now, so they show the Reports menu (where
// their link lives, in the Planning group). isTrackerPath still exists for feedback tagging.
export function toolForPath(path: string): AreaId | null {
  if (path === "/" || path === "") return null;
  if (isSharedPath(path)) return "admin";
  return "reports";
}
