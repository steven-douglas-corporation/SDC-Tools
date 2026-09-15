// ── The cells this tab was editing when it was hidden ────────────────────────
//
// REPORTED 2026-09-14: hide the browser tab while a Monthly ETC cell is focused,
// come back, and the "you are editing this" indicator is gone for everyone else —
// permanently, until the cell is blurred and refocused.
//
// RealtimeProvider releases every held cell on `visibilitychange → hidden`, which
// is right (an inactive user must not claim a cell — spec 3). But nothing
// re-claimed them on `→ visible`: the cell was still focused, the user was still
// typing, and the server had been told they left. This file is the pure part of
// the fix: remember what was held when hiding, and decide what to re-announce on
// showing.

export type HeldCell = { tab: string; rowRef: string; columnName: string; cellKey: string };

/** Snapshot the held set on the way out — a copy, so releasing the live set cannot empty it. */
export function suspendHeld(held: ReadonlyMap<string, HeldCell>): Map<string, HeldCell> {
  return new Map(held);
}

/**
 * Which suspended cells to re-announce when the tab is visible again.
 *
 *   focused cell is one of them   just that one — the user is still in it, and
 *                                  the others were left while hidden (a blur that
 *                                  fired with no server to tell)
 *   nothing focused, or focus on   all of them — we cannot tell which one the
 *   something with no name         user is in, and a missing indicator is the bug
 *                                  being fixed; an extra one expires with the TTL
 *   focus moved to a DIFFERENT     none — the user has moved on, and that cell's
 *   named cell                     own focus handler is what announces it
 */
export function heldToReannounce(
  suspended: ReadonlyMap<string, HeldCell>,
  focusedCellKey: string | null,
): HeldCell[] {
  if (suspended.size === 0) return [];
  if (focusedCellKey) {
    const hit = suspended.get(focusedCellKey);
    return hit ? [hit] : [];
  }
  return [...suspended.values()];
}
