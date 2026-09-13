// ── The ONE walk over a job's BOM tree, and the ONE key it assigns per unit ──
//
// Extracted out of build-readiness-sync.ts (2026-08-17) so a LIVE re-fetch
// (Build Readiness's assembly-detail drill, which needs to locate the exact
// same node a stored snapshot's `AssemblyDetail.key` refers to) can never
// silently drift from the key algorithm the snapshot itself was built with —
// there is now exactly one implementation of "every buildable/requirement
// unit in a job's BOM, and the path-based key each one gets," used by both
// the sync job and the live lookup.
//
// A "unit" is every nested assembly PLUS each section's own "Loose parts"
// synthetic bucket (its direct parts with no parent sub-assembly) — the same
// definition JobProcurement.tsx's own LoosePartsRow uses for the Parts List.
// Section container nodes themselves are never units (not a buildable/buy
// concept on their own); everything under them is walked.

import type { JobBom } from "@/lib/job-bom";
import { isUncoveredPart, type BomNode, type BomPart } from "@/lib/job-bom-rules";

export type BomUnit = {
  key: string;
  node: BomNode;
  // The node's own direct requirements — its buy/build line (`node.self`,
  // only set for a real unit) plus its direct parts. Does NOT include a
  // child sub-assembly's own parts; each child is its own separate unit.
  ownParts: BomPart[];
};

export function walkJobBomUnits(bom: JobBom): BomUnit[] {
  const units: BomUnit[] = [];

  const visit = (node: BomNode, keyPrefix: string) => {
    const key = `${keyPrefix}${node.key}`;
    const ownParts: BomPart[] = node.self ? [node.self, ...node.parts] : node.parts;
    units.push({ key, node, ownParts });
    for (const child of node.children) visit(child, `${keyPrefix}${node.key}/`);
  };

  for (const section of bom.roots) {
    for (const child of section.children) visit(child, "");
    if (section.parts.length > 0) {
      // Synthetic "Loose parts" bucket for a section's direct parts — no
      // `self` line, same treatment JobProcurement.tsx's LoosePartsRow gives
      // these: a group with no single "unit" concept, just individual buy
      // items.
      const looseReceived = section.parts.filter((p) => p.status === "received").length;
      const looseTotal = section.parts.length;
      const looseNode: BomNode = {
        key: `${section.key}-loose`,
        id: `${section.key}-loose`,
        depth: section.depth + 1,
        label: "Loose parts",
        pn: "",
        desc: "",
        isAssembly: false,
        release: "contentsOnly",
        self: null,
        // Synthetic bucket, not an eps edge - the parts inside carry their own
        // packet tags, the bucket itself has none.
        packetId: null,
        packetLabel: null,
        children: [],
        parts: section.parts,
        stats: {
          total: looseTotal,
          received: looseReceived,
          // isUncoveredPart, NOT a raw `status === "noPO"` — a part paused on
          // hold still carries that status, and counting it here made this the
          // one surface that disagreed with the Procurement card, the Parts
          // List filter and build-readiness-sync's own `no_po` key. Measured
          // before the fix: job 1122 reported 15 uncovered against everyone
          // else's 7, the difference being exactly its 8 held parts.
          noPO: section.parts.filter(isUncoveredPart).length,
          ordered: section.parts.filter((p) => p.status === "ordered").length,
          stock: section.parts.filter((p) => p.source === "stock" || p.source === "process").length,
          pct: looseTotal ? Math.round((looseReceived / looseTotal) * 100) : 0,
        },
        totalCost: 0,
        totalPartQty: 0,
        nestedAssemblies: 0,
      };
      visit(looseNode, `${section.key}/`);
    }
  }

  return units;
}

// Locates the same unit a stored `AssemblyDetail.key` refers to, in a FRESH
// (live) BomBom tree. Returns null when the BOM has changed shape since the
// snapshot was built (a real, expected possibility — callers treat this the
// same way `loadPoDetailForJob` treats a PO whose parts have moved: "not
// found," not an error).
export function findJobBomUnit(bom: JobBom, assemblyKey: string): BomUnit | null {
  return walkJobBomUnits(bom).find((u) => u.key === assemblyKey) ?? null;
}
