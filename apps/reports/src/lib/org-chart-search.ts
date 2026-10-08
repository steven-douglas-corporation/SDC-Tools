import type { OrgNode } from "@/lib/org-chart";

// The Org chart's search (2026-10-08). The same words the Cards view searches
// (lib/employee-row.ts's rowMatchesSearch), applied to the reporting tree: a person
// stays if they match OR someone under them does, so a match is never shown without
// the managers above it, and the tree stays readable. Pure and client-safe — the
// builder in lib/org-chart.ts is server-only, so only its types are imported here.

/** The nodes that match or have a matching descendant, each keeping only such reports. */
export function filterOrgNodes(nodes: OrgNode[], matches: (id: number) => boolean): OrgNode[] {
  return nodes.flatMap((n) => {
    const reports = filterOrgNodes(n.reports, matches);
    return matches(n.id) || reports.length > 0 ? [{ ...n, reports }] : [];
  });
}

/** Everyone in the trees, managers and all. */
export function countOrgNodes(nodes: OrgNode[]): number {
  return nodes.reduce((n, node) => n + 1 + countOrgNodes(node.reports), 0);
}
