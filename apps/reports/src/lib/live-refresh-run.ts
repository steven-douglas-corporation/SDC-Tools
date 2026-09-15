import type { ChangeVersion } from "@/lib/change-version";

// ── When a focus refresh is allowed to move the "I am current as of" marker ──
//
// REPORTED 2026-09-14: LiveRefresh recorded `syncedAtVersion = latest` BEFORE
// calling run(), and run() then bailed out because a save was in flight
// (isSavingSomewhere()). The marker had moved, the refresh had not happened, and
// the next focus compared against the new marker, saw nothing newer, and skipped
// again. A colleague's change stayed invisible until the five-minute backstop.
//
// The rule, pure so tests/live-refresh-gate.test.ts can pin it: the marker moves
// only when a refresh actually runs. A pass skipped because a save is landing
// leaves the marker where it was, so the next focus retries with the same
// evidence and refreshes once the save has settled.

export type RefreshRunOutcome = {
  /** Whether router.refresh() should be called. */
  ran: boolean;
  /** The marker to keep after this pass. */
  syncedAtVersion: ChangeVersion;
};

export function settleRefreshRun(a: {
  /** isSavingSomewhere() at the moment the coalesced run fires. */
  saving: boolean;
  /** The marker as it stands. */
  syncedAt: ChangeVersion;
  /**
   * The server version the gate observed when it asked for this run, or
   * `undefined` for a run that did not come through the gate (requestLiveRefresh,
   * the interval), which learns nothing about the version and leaves it alone.
   */
  latest: ChangeVersion | undefined;
}): RefreshRunOutcome {
  if (a.saving) return { ran: false, syncedAtVersion: a.syncedAt };
  return { ran: true, syncedAtVersion: a.latest === undefined ? a.syncedAt : a.latest };
}
