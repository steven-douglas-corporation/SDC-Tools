// ── Data Management's tabs ───────────────────────────────────────────────────
//
// The page used to be three bands stacked one above the other: how each source
// last refreshed, the data-quality checks, and the manual roster tools. They are
// tabs now, one per band, so a half-width split pane shows one thing at a time
// rather than a long scroll, and so the server only runs the queries for the tab
// that is open (the Job punches tab alone reads every punch for the explorer).
//
// The open tab is the `tab` URL param — not local state — for the reasons the
// Dashboard's Finances tab is: the server decides what to build from it, and in a
// split view or a workspace tab each pane keeps its own (the pane URL namespaces
// it). The first tab is the default and writes no param, so the plain URL stays
// the plain URL. Job punches is first, the check people open the page for.
//
// One tab per data-quality section (2026-10-22). They were five sections stacked inside
// one "Data quality" tab, which was still a very long scroll. The `quality` id is gone, so
// an old `?tab=quality` bookmark opens the default tab rather than a blank panel.
//
// No React and no server imports, so the client tab strip and the server page can
// both read it, and tests/data-management-tabs.test.ts can pin it.

export const DATA_MANAGEMENT_TABS = [
  { id: "punches", label: "Job punches" },
  { id: "temp", label: "Temp punches" },
  { id: "roster-sync", label: "Roster sync" },
  { id: "families", label: "Position families" },
  { id: "customers", label: "Customers" },
  { id: "sources", label: "Data sources" },
  { id: "roster", label: "Employee roster" },
] as const;

export type DataManagementTabId = (typeof DATA_MANAGEMENT_TABS)[number]["id"];

export const DEFAULT_DATA_MANAGEMENT_TAB: DataManagementTabId = DATA_MANAGEMENT_TABS[0].id;

/**
 * The tab a `?tab=` value names. Anything unrecognised — absent, empty, a stale
 * bookmark, a typo — is the default tab rather than an error or a blank page.
 */
export function dataManagementTab(raw: string | null | undefined): DataManagementTabId {
  return DATA_MANAGEMENT_TABS.find((t) => t.id === raw)?.id ?? DEFAULT_DATA_MANAGEMENT_TAB;
}
