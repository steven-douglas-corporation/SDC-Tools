// The tools this app holds, and which of them a person has.
//
// A tool is a set of pages with its own menu in the sidebar: Reports, and the Project
// Tracker (src/modules/tracker). The tools page at "/" shows a tile for each, and the
// launcher at the top of the sidebar switches between them.
//
// Nothing here decides a permission. A tool is shown when the person may open at least
// one of its pages, and that list (`permitted`) is the layout's `visibleHrefs`, worked
// out on the server from ROUTE_PERMISSIONS. So this file is pure and safe in a client
// component, and a tool can never be offered here and refused by the page.

export type ToolId = "reports" | "tracker";

/**
 * A tool, or Admin. Admin is not a tool and has no tile: it is the pages every tool shares
 * (users, permissions, the audit log, feedback). It is listed in the launcher beside the
 * tools, and has a menu of its own when it is open.
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

const isTrackerPath = (path: string): boolean => path === "/tracker" || path.startsWith("/tracker/");

/** Pages every tool shares. They are the Admin area, and never make a tool on their own. */
// Admin is the app's own area: accounts, permissions and feedback, shared by every tool. Two
// pages under /admin and beside it are about Reports' data only (Data Management, the Audit
// Log) and belong to Reports, whatever their addresses say.
const isReportsHousekeeping = (path: string): boolean =>
  path === "/audit-log" || path === "/admin/data-management" || path.startsWith("/admin/data-management/");

const isSharedPath = (path: string): boolean =>
  !isReportsHousekeeping(path) && (path === "/feedback" || path.startsWith("/admin/"));

/**
 * The tools a person has, in the order they are shown. `permitted` is every path their role
 * may open, in ROUTE_PERMISSIONS order.
 */
export function toolsFor(permitted: readonly string[]): Tool[] {
  const tools: Tool[] = [];
  // The housekeeping pages sit in Reports' menu but do not make Reports a tool on their own:
  // someone who may open only the Audit Log is not offered a Reports tile that leads nowhere else.
  const reportPages = permitted.filter((p) => !isTrackerPath(p) && !isSharedPath(p) && !isReportsHousekeeping(p));
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
  if (permitted.some(isTrackerPath)) {
    tools.push({
      id: "tracker",
      label: "Project Tracker",
      description: "Cards, forecast and timeline",
      href: "/tracker",
    });
  }
  return tools;
}

/** Which area a page belongs to. Null for the tools page itself, which belongs to none. */
export function toolForPath(path: string): AreaId | null {
  if (path === "/" || path === "") return null;
  if (isSharedPath(path)) return "admin";
  return isTrackerPath(path) ? "tracker" : "reports";
}
