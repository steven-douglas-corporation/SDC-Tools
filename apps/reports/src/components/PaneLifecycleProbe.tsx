"use client";

import { useEffect, useRef } from "react";
import { tabDebug, tabDebugEnabled } from "@/lib/tab-debug";

// ── Is the pane's CONTENT being remounted, or only hidden? ───────────────────
//
// Step 1 of the 2026-09-04 report, and the question two failed fixes turned on. The two
// hypotheses look identical from the outside:
//
//   1. Monthly ETC is remounted on tab activation.
//   2. Monthly ETC stays mounted, and something re-renders the grid after the scroll
//      position has been restored.
//
// This tells them apart, and it has to live INSIDE the pane's content to do it.
// TabScrollMemory wraps the content and is not remounted with it, so its own
// ACTIVATE/DEACTIVATE pair cannot see a child subtree being replaced underneath.
//
// Reading it:
//
//   MOUNT with mounts:1, then only ACTIVATE/DEACTIVATE pairs
//       → the pane is being hidden and shown, never destroyed. Hypothesis 2.
//
//   MOUNT ... UNMOUNT ... MOUNT on every switch
//       → the pane's content is being destroyed. Hypothesis 1, and the tab
//         architecture is what needs fixing rather than the scroll restore.
//
// `mounts` is module-scope and keyed by tab id ON PURPOSE: a remount resets any
// component-local counter to 1, which is exactly the signal being measured, so the
// count has to survive the thing it is counting.
const mounts = new Map<string, number>();

export function PaneLifecycleProbe({ tabId, page }: { tabId: string; page: string }) {
  const seq = useRef(0);

  useEffect(() => {
    if (!tabDebugEnabled()) return;
    const n = (mounts.get(tabId) ?? 0) + 1;
    mounts.set(tabId, n);
    seq.current = n;
    tabDebug("MOUNT", { page, tabId, mounts: n });
    return () => {
      tabDebug("UNMOUNT", { page, tabId, mounts: seq.current });
    };
    // tabId only: a re-render must not be reported as a remount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);

  return null;
}
