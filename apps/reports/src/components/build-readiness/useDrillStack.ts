"use client";

import { useCallback, useMemo, useState } from "react";
import type { BlockerReason } from "@/lib/build-readiness-types";

// ── One drill stack for the whole Build Readiness page ──────────────────────
//
// The table and all 5 insight cards render together on one page (no tabs —
// confirmed by reading page.tsx/BuildReadinessDashboard.tsx), so there must be
// exactly one open drawer regardless of which section triggered it. This is
// genuinely new: every existing "drill deeper" elsewhere in the app either
// expands an accordion row in place or closes the current panel and jumps
// elsewhere (see PoPanel's own onPartClick) — nothing before this stacked one
// drawer on top of another. `push` adds a level; `popTo` truncates back to a
// clicked breadcrumb segment; `close` clears the whole stack.
export type DrillFrame =
  | { kind: "assemblies"; jobId: string; filter: "all" | "ready" | "partial" | "blocked" }
  | { kind: "parts"; jobId: string; filter: "missing" | "pastDue" | "dueSoon" | "onOrder" }
  | { kind: "material"; jobId: string }
  | { kind: "nextUnlock"; jobId: string }
  // `assemblyKeys` (plural, always ≥1) — the same physical assembly part
  // number can legitimately occur at more than one BOM tree position in one
  // job (a reused sub-assembly design, or the same assembly-detail-fix's own
  // job-bom.ts dedup notwithstanding, still a valid shape). "What Can We
  // Build Now" merges those into ONE displayed row per (jobId, part number),
  // so its drill target has to carry every underlying position's key —
  // otherwise the drawer would only ever show one instance's parts/blockers,
  // silently dropping the others. Every OTHER caller (a single BOM position)
  // just wraps its one key in a 1-element array.
  | { kind: "assemblyDetail"; jobId: string; assemblyKeys: string[]; highlightPn?: string }
  | {
      kind: "buildableCalc";
      jobId: string;
      assemblyKey: string;
      poNumber: string | null;
      supplier: string | null;
      expectedDate: string;
      incomingPn: string;
      incomingQty: number;
      buildableBefore: number | null;
      buildableAfter: number | null;
    }
  | { kind: "blockerReason"; reason: BlockerReason }
  | { kind: "supplier"; supplier: string }
  | { kind: "forecastWeek"; week: number }
  | { kind: "po"; jobId: string; supplier: string | null; poNumber: string };

// The jobId a frame is scoped to, when it has one — used to keep a table
// row's "this drawer is open for me" highlight lit through the WHOLE chain
// (Project → Blocked Assemblies → PO), not just while the top frame matches.
export function frameJobId(frame: DrillFrame): string | null {
  switch (frame.kind) {
    case "assemblies":
    case "parts":
    case "material":
    case "nextUnlock":
    case "assemblyDetail":
    case "buildableCalc":
    case "po":
      return frame.jobId;
    case "blockerReason":
    case "supplier":
    case "forecastWeek":
      return null;
  }
}

export function useDrillStack() {
  const [stack, setStack] = useState<DrillFrame[]>([]);

  const push = useCallback((frame: DrillFrame) => setStack((s) => [...s, frame]), []);
  // Truncates to the clicked breadcrumb segment (index i keeps frames 0..i).
  const popTo = useCallback((index: number) => setStack((s) => s.slice(0, index + 1)), []);
  const close = useCallback(() => setStack([]), []);

  const isOpenForJob = useCallback((jobId: string) => stack.some((f) => frameJobId(f) === jobId), [stack]);

  return useMemo(
    () => ({ stack, top: stack[stack.length - 1] ?? null, push, popTo, close, isOpenForJob }),
    [stack, push, popTo, close, isOpenForJob],
  );
}

export type DrillStack = ReturnType<typeof useDrillStack>;
