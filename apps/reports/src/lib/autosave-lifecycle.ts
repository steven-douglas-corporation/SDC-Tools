// ── What autosave does when its pane is hidden, and when it comes back ───────
//
// REPORTED 2026-09-14: type in a Monthly ETC cell, switch tabs within 800ms, and
// the edit is never saved.
//
// WorkspaceShell keeps every tab mounted behind <Activity>, and a hidden Activity
// DESTROYS effects (React 19.2: cleanup runs on hide, effects re-run on show — the
// same lifecycle a remount would have, without losing state). useAutosave's cleanup
// cleared the pending debounce timer, and its visibilitychange flush listener was
// removed with it. The tab was hidden, not the document, so `visibilitychange` never
// fired either. Nothing was left to save the edit, and nothing rescheduled it.
//
// The rules below are pure so that both halves are pinned by tests/autosave.test.ts:
//
//   on deactivate   a save that is pending on the timer is flushed NOW, not dropped
//   on reactivate   a grid that is still dirty gets its debounce re-armed — unless
//                   the last save FAILED, because retrying automatically against a
//                   server that just refused the write is how one bad value becomes
//                   a request loop (the chip offers Retry for that; see
//                   needsFollowUpSave in lib/autosave.ts)

export type DeactivateState = {
  /** The debounce timer is armed — an edit is waiting on it. */
  timerPending: boolean;
  /** A save is already running; it will see `changedDuringSave` itself. */
  inFlight: boolean;
};

/** Fire the pending save synchronously on the way out, rather than clearing it? */
export function shouldFlushOnDeactivate(s: DeactivateState): boolean {
  // In flight: the running save's follow-up logic owns the outcome; a second run()
  // would be refused by shouldAutosave anyway. Not pending: nothing to flush.
  return s.timerPending && !s.inFlight;
}

export type ReactivateState = {
  enabled: boolean;
  dirty: boolean;
  inFlight: boolean;
  /** Whether the most recent save succeeded. `null` when none has run yet. */
  lastSaveOk: boolean | null;
};

/** Re-arm the debounce when a pane comes back with unsaved edits still in it? */
export function shouldRearmOnReactivate(s: ReactivateState): boolean {
  if (!s.enabled) return false;
  if (!s.dirty) return false;
  if (s.inFlight) return false;
  // A refused write stays dirty by design and must not be auto-retried.
  if (s.lastSaveOk === false) return false;
  return true;
}
