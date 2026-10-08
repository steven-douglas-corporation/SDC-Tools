"use client";

import { useSyncExternalStore } from "react";

// ── What the user is dragging, for the split view's drop targets (2026-10-08) ─
//
// Two things can be dropped on a split group or on the edge of the screen: a PAGE
// dragged out of the sidebar, and a TAB dragged out of a strip. Both start in places
// that know nothing about the drop targets, and the targets (a pane, the screen-edge
// overlay) are mounted somewhere else entirely. A one-slot store is the smallest thing
// that connects them.
//
// Why not dataTransfer: a browser hides a drag's payload from `dragover` and only hands
// it over on `drop` — but a drop target has to decide on `dragover` whether to accept
// the drag at all, and to show that it will. Everything dragged here comes from this
// same document, so the payload can simply live here.
//
// The store is cleared by whoever sees the drag end. `dragend` fires on the SOURCE
// element, and a dragged tab is re-parented by the very drop that finishes the drag —
// browsers do not reliably fire `dragend` on an element that has left the document —
// so `watchDragEnd` also listens on the window.

export type DragPayload =
  | { kind: "page"; path: string }
  | { kind: "tab"; id: string };

let current: DragPayload | null = null;
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

export function beginDrag(payload: DragPayload): void {
  current = payload;
  emit();
}

export function endDrag(): void {
  if (current === null) return;
  current = null;
  emit();
}

export const currentDrag = (): DragPayload | null => current;

/**
 * Clear the drag when it ends anywhere. Mount once for the app; returns the unsubscribe.
 * `drop` and `dragend` are both listened for in the CAPTURE phase of the window, so a
 * target that stops propagation cannot leave the overlay stuck on screen.
 *
 * Capture runs BEFORE the target's own `drop` handler, and that handler reads the
 * payload — so the clear is deferred a tick. The whole dispatch finishes first.
 */
export function watchDragEnd(win: Window = window): () => void {
  const end = () => {
    setTimeout(endDrag, 0);
  };
  // The object form, not a bare `true`: removeEventListener must be given the same capture
  // flag it was added with, and not every EventTarget implementation reads a boolean there.
  const capture = { capture: true };
  win.addEventListener("drop", end, capture);
  win.addEventListener("dragend", end, capture);
  return () => {
    win.removeEventListener("drop", end, capture);
    win.removeEventListener("dragend", end, capture);
  };
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

/** The drag in progress, or null. */
export function useDragPayload(): DragPayload | null {
  return useSyncExternalStore(subscribe, currentDrag, () => null);
}
