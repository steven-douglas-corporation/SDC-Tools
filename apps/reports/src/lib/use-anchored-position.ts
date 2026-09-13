"use client";

import { useLayoutEffect, useState, type RefObject } from "react";
import { computeAnchoredPosition, type AnchoredPosition, type AnchoredPositionOptions } from "@/lib/anchored-position";

// ── The DOM half of anchored-position.ts ────────────────────────────────────
//
// Measures the trigger and the panel AFTER the panel has rendered (off-screen,
// `visibility: hidden` — the caller's job, not this hook's) so real width/height are
// available before the first paint, then hands both rects to the pure function above.
// Same hidden-until-measured trick JobCellMenuHost.tsx uses for its own portal, just
// anchored to an ELEMENT instead of a cursor position.
//
// Recomputes only when `open` flips true — not on every render — because the trigger
// and panel don't move on their own while open; a scroll or resize closes the menu
// entirely (the caller's listeners, same as ExportMenu.tsx already had), so there is
// nothing to re-measure until the next open.
export function useAnchoredPosition(
  triggerRef: RefObject<HTMLElement | null>,
  panelRef: RefObject<HTMLElement | null>,
  open: boolean,
  opts: AnchoredPositionOptions = {},
): AnchoredPosition | null {
  const { side, align, sideOffset, pad } = opts;
  const [pos, setPos] = useState<AnchoredPosition | null>(null);

  useLayoutEffect(() => {
    // Nothing to (re)measure while closed — the stale `pos` from the last
    // time this was open is left in state rather than reset here (no
    // setState needed to "clear" it), because the return statement below
    // masks it with null whenever `open` is false regardless.
    if (!open) return;
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    if (!trigger || !panel) return;
    setPos(
      computeAnchoredPosition(trigger.getBoundingClientRect(), panel.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight }, {
        side,
        align,
        sideOffset,
        pad,
      }),
    );
    // triggerRef/panelRef are stable ref objects; side/align/sideOffset/pad are the
    // actual options, unpacked so a fresh `opts` literal each render doesn't reset this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, side, align, sideOffset, pad]);

  return open ? pos : null;
}
