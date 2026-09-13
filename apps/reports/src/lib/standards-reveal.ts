// The Standard Sheet's display-collapse toggle, as client state (§76).
//
// The password-box/double-click-gesture machinery this module used to hold
// (openStandardsPrompt, noteEtcClick, markStandardsUnlocked, …) is retired as
// of 2026-08-18: Standard Sheet visibility is now decided by ROLE
// (standards-sheet-gate.ts, checked server-side), so there is nothing left
// for a client-side "reveal" gesture to unlock. A Sales/ELT user's Standard
// Sheet columns and Standard Fees card render directly, the moment
// `showStandards` is true on the server — see etc/page.tsx.
//
// What's left is a genuinely separate feature: someone who IS authorized may
// still want to collapse the section to reduce clutter, without losing
// already-fetched figures or re-asking the server anything. That's `hidden`
// below, unchanged from before — see the note on hideStandardSheet.
//
// ── Why a module store rather than context ──────────────────────────────────
// Every Standard Sheet consumer (the grid's per-row cells, its grand-total
// row, the two header blocks, and the Fees card) needs the SAME answer to
// "has the user hidden this", and they don't share a common ancestor closer
// than the page itself. Same shape as lib/app-zoom.ts and lib/nav-order.ts: a
// module-level value, an event, and useSyncExternalStore.
type State = {
  /**
   * The Standard Sheet columns and the Standard Fees card are both collapsed
   * by choice, in a tab that is otherwise authorized. `hidden` starts `false`
   * on every fresh render (server and client snapshots agree), so there is no
   * seeding race and no flash-of-content to guard against.
   */
  hidden: boolean;
};

let state: State = { hidden: false };
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((cb) => cb());
}

export function readStandardsState(): State {
  return state;
}

export function serverStandardsState(): State {
  return CLOSED;
}
const CLOSED: State = Object.freeze({ hidden: false });

export function subscribeStandards(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

/** "Hide Standards" — collapses the columns and the card in this tab. Still authorized. */
export function hideStandardSheet(): void {
  if (state.hidden) return; // nothing changed — do not wake the subscribers
  state = { hidden: true };
  emit();
}

/** "Show Standards" when this tab is already authorized — the reverse, equally instant. */
export function revealStandardSheet(): void {
  if (!state.hidden) return;
  state = { hidden: false };
  emit();
}

/** Test seam — the state is module state, so a test needs a way back to the default. */
export function resetStandardsForTest(): void {
  state = { hidden: false };
  listeners.clear();
}
