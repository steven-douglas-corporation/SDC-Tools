"use client";

import { useSyncExternalStore } from "react";

// ── Where each CELL's save got to ───────────────────────────────────────────
//
// §17 asks for five states per edited field — editing, saving, saved, failed,
// conflict — and the page had one status chip for the whole grid. That is fine for
// "is anything outstanding" and useless for the question a manager actually asks,
// which is "did MY cell save". With 1,180 inputs on screen, a single chip reading
// "1 cell could not be saved" leaves them hunting.
//
// So the state is per field name, in a module store, for the same reason as the other
// three stores in this app (etc-dirty-tracker, etc-live-totals, etc-remote-values):
// the writers are one autosave component and the readers are ~1,180 independent cells
// with no ancestor in common short of the page. Each cell reads its OWN key through
// useSyncExternalStore, so a batch of 20 saves re-renders those 20 cells and leaves
// the rest alone.
//
// Deliberately NOT the source of truth for anything: it drives a border colour and a
// tooltip. What is actually saved is decided by the server and reflected in the dirty
// tracker's baselines; if these two ever disagreed, the tracker would be right. That
// is why "saved" here expires — a stale green ring on a cell somebody has since edited
// would be a lie, and this store must never be the thing a manager trusts over the
// value in the box.

export type CellSaveState =
  // The user is typing / the value differs from what was saved. Not shown as an error.
  | "editing"
  // A request carrying this cell is in flight.
  | "saving"
  // The server confirmed this exact value. Fades — see SAVED_TTL_MS.
  | "saved"
  // The write failed (network, server error). The typed value is still in the box.
  | "failed"
  // Refused because somebody else changed the cell first. The manager has to look at
  // what is there now, which is why this one does not expire.
  | "conflict"
  // The value in the box is not one this column accepts (§27.9). Distinct from
  // "failed", which is about the SAVE: nothing was even attempted here, because there
  // is nothing valid to send. Carries a message — see setCellInvalid — and, like
  // "conflict", never expires: the cell is wrong until somebody fixes it.
  | "invalid";

const state = new Map<string, CellSaveState>();
// The rule an invalid cell broke, in the words lib/cell-rules.ts produced. Kept beside
// the state rather than inside it so CellSaveState stays a plain string union that the
// existing switch statements handle exhaustively.
const invalidMessages = new Map<string, string>();
const listeners = new Set<() => void>();

// A green ring that never goes away is noise, and worse, it goes stale the moment the
// cell is edited again. Long enough to notice, short enough not to accumulate.
const SAVED_TTL_MS = 4_000;
let sweepTimer: ReturnType<typeof setTimeout> | null = null;
const savedAt = new Map<string, number>();

function emit() {
  for (const l of listeners) l();
}

function scheduleSweep() {
  if (sweepTimer) return;
  sweepTimer = setTimeout(() => {
    sweepTimer = null;
    const now = Date.now();
    let changed = false;
    for (const [name, at] of savedAt) {
      if (now - at < SAVED_TTL_MS) continue;
      savedAt.delete(name);
      if (state.get(name) === "saved") {
        state.delete(name);
        changed = true;
      }
    }
    if (savedAt.size > 0) scheduleSweep();
    if (changed) emit();
  }, SAVED_TTL_MS);
}

// Set the state of one or many fields. Batched on purpose: a save carries every cell
// it posted, and twenty cells going "saving" together must be one notification.
export function setCellSaveState(names: Iterable<string>, next: CellSaveState): void {
  let changed = false;
  for (const name of names) {
    if (state.get(name) !== next) {
      state.set(name, next);
      changed = true;
    }
    if (next === "saved") {
      savedAt.set(name, Date.now());
    } else {
      savedAt.delete(name);
    }
  }
  if (next === "saved") scheduleSweep();
  if (changed) emit();
}

export function clearCellSaveState(name: string): void {
  const had = state.delete(name);
  savedAt.delete(name);
  const hadMessage = invalidMessages.delete(name);
  if (had || hadMessage) emit();
}

// ── An invalid cell (§27.9) ─────────────────────────────────────────────────
//
// Called by the cell itself, from the parse it already has to do, with the message
// lib/cell-rules.ts produced ("New ETC must be a whole number greater than or equal
// to 0."). What §27.9 asks for, and what this makes possible:
//
//   * the typed value STAYS on screen — this store never touches the input;
//   * the cell is highlighted and says what was expected;
//   * nothing is saved, and nothing enters a total, because the cell simply does not
//     publish to lib/etc-live-totals.ts while it is in this state;
//   * and the save-status chip cannot say "All changes saved", because an invalid
//     cell is not clean.
export function setCellInvalid(name: string, message: string): void {
  const same = state.get(name) === "invalid" && invalidMessages.get(name) === message;
  if (same) return;
  state.set(name, "invalid");
  invalidMessages.set(name, message);
  savedAt.delete(name);
  emit();
}

export function readCellInvalidMessage(name: string): string | null {
  return invalidMessages.get(name) ?? null;
}

// Is anything on screen currently holding a value the column will not accept? Gates
// the save-status chip and, through it, the "All changes saved" claim.
export function hasInvalidCells(): boolean {
  return invalidMessages.size > 0;
}

export function invalidCellNames(): string[] {
  return [...invalidMessages.keys()];
}

// The same question hasInvalidCells() answers, for the OTHER state that means "your
// value was not written": a cell somebody else changed first.
//
// Added 2026-08-31 after a two-tab test: the stale write was correctly refused by
// saveAllNewEtcDrafts, the cell correctly took its conflict ring — and the status chip
// still said "All changes saved", because it only ever escalated on `invalid`. The
// requirement §27.9 wrote for invalid cells ("do not display 'All changes saved'")
// applies here for exactly the same reason, and applies harder: an invalid value is
// this user's own typo, visible to them, whereas a conflict is somebody else's write
// that they never saw. Reading the state map rather than a second side-table because,
// unlike `invalid`, `conflict` carries no message of its own.
export function conflictCellNames(): string[] {
  return [...state.entries()].filter(([, s]) => s === "conflict").map(([name]) => name);
}

export function readCellSaveState(name: string): CellSaveState | null {
  return state.get(name) ?? null;
}

// Test seam / month switch: every key belongs to one month's fields.
export function resetCellSaveStates(): void {
  if (state.size === 0 && savedAt.size === 0 && invalidMessages.size === 0) return;
  state.clear();
  savedAt.clear();
  invalidMessages.clear();
  emit();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// Exported for the toolbar chip, which is not a cell and so has no field name to
// watch — it needs "did anything anywhere change".
export const subscribeCellSaveStates = subscribe;

export function useCellSaveState(name: string): CellSaveState | null {
  return useSyncExternalStore(
    subscribe,
    () => readCellSaveState(name),
    () => null, // server render: nothing has been saved yet by definition
  );
}

export function useCellInvalidMessage(name: string): string | null {
  return useSyncExternalStore(
    subscribe,
    () => readCellInvalidMessage(name),
    () => null, // server render: nothing has been typed yet, so nothing can be invalid
  );
}

// The ring a cell wears, and what it means when hovered. One place, so the hours cells
// and Parts Cost cannot end up speaking different visual languages.
export function cellSaveStateStyle(s: CellSaveState | null): { ring: string; title: string } | null {
  switch (s) {
    case "saving":
      return { ring: "ring-1 ring-inset ring-sdc-blue/60", title: "Saving…" };
    case "saved":
      return { ring: "ring-1 ring-inset ring-sdc-green-text/60", title: "Saved" };
    case "failed":
      // ── Distinct from "invalid", which it used to be identical to (§42.25) ──
      //
      // Both were `ring-2 ring-inset ring-sdc-red`, so two states demanding opposite
      // responses looked the same: "invalid" means the value is wrong and the user has
      // to change it; "failed" means the value is FINE and the save did not land, so
      // the right response is to wait or press Retry. Rendering them identically told
      // people to edit a cell that had nothing wrong with it.
      //
      // §42.25 requires error and conflict states to be visually distinct; this is the
      // same requirement one level down, between two kinds of error. The softer border
      // red keeps it unmistakably an error while separating it from the solid ring that
      // means "act on this now", and the tooltips say which is which.
      return {
        ring: "ring-2 ring-inset ring-sdc-red-border",
        title: "This value could not be saved. It is still here — it will be retried, and Retry in the toolbar forces it.",
      };
    case "conflict":
      return {
        ring: "ring-2 ring-inset ring-sdc-yellow-text",
        title: "Another user changed this cell first, so your value was not saved. Check the figure that is stored now before re-entering.",
      };
    case "invalid":
      // The strongest ring in the set, because it is the only state the USER has to
      // act on before anything else can happen. The real message comes from
      // readCellInvalidMessage and is rendered by the cell; this is the fallback for
      // any caller that only has the state.
      return {
        ring: "ring-2 ring-inset ring-sdc-red",
        title: "This value is not one this column accepts. It has not been saved and is not counted in any total.",
      };
    // "editing" gets no ring: the value being different from the saved one is the
    // normal state of a cell somebody is working in, not something to decorate.
    default:
      return null;
  }
}
