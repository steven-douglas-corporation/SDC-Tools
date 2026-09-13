"use client";

import { useEffect, useState } from "react";
import {
  phaseForLevel,
  shouldDisableForPhase,
  shouldShowBusyForPhase,
  SLOW_AFTER_MS,
  TIMEOUT_AFTER_MS,
  type PendingLevel,
  type PendingPhase,
} from "@/lib/pending-watchdog";

// React wrapper for lib/pending-watchdog.ts — turns a `useTransition` pending flag into
// a bounded one.
//
// Drop-in for the pattern every navigating control here already uses:
//
//     const [pending, startTransition] = useTransition();
//     const { busy, disabled, timedOut } = usePendingWatchdog(pending);
//
// `busy`/`disabled` replace the raw `pending` in the markup. The difference is that they
// come back false once the operation has been in flight long enough to be considered
// gone, so the control re-enables and the user can retry instead of reloading the
// browser. See the note in lib/pending-watchdog.ts for why that matters.
//
// Deliberately does NOT try to cancel anything: nothing in the browser can abort a
// server render that Next has already started, and a control that claimed to cancel
// would be lying. It bounds the CLAIM, not the request.
export function usePendingWatchdog(
  pending: boolean,
  opts: { slowAfterMs?: number; timeoutAfterMs?: number } = {},
): { phase: PendingPhase; busy: boolean; disabled: boolean; timedOut: boolean } {
  const slowAfterMs = opts.slowAfterMs ?? SLOW_AFTER_MS;
  const timeoutAfterMs = opts.timeoutAfterMs ?? TIMEOUT_AFTER_MS;

  // How far the current operation's timers have advanced. A LEVEL rather than a start
  // timestamp: the phase is derived during render, and `Date.now()` there is an impure
  // call (as is reading a ref), both of which react-hooks rejects — correctly, since a
  // render that reads the clock produces a different answer every time it happens to
  // re-run. Timers push this forward instead, so reading it is pure.
  const [level, setLevel] = useState<PendingLevel>(0);

  // Reset the level whenever an operation starts or finishes. Set-state-during-render is
  // the supported way to derive state from a prop, and it is what useDraftParamMenu
  // already does for its `seenCommitted` resync — an effect would leave one frame
  // showing the previous operation's level.
  const [seenPending, setSeenPending] = useState(pending);
  if (seenPending !== pending) {
    setSeenPending(pending);
    setLevel(0);
  }

  // Two timers, armed once per operation. Nothing polls, and the cleanup cancels them
  // when the operation finishes — so a fast navigation never reaches "slow" at all.
  useEffect(() => {
    if (!pending) return;
    const toSlow = window.setTimeout(() => setLevel(1), slowAfterMs);
    const toTimeout = window.setTimeout(() => setLevel(2), timeoutAfterMs);
    return () => {
      window.clearTimeout(toSlow);
      window.clearTimeout(toTimeout);
    };
  }, [pending, slowAfterMs, timeoutAfterMs]);

  const phase = phaseForLevel(pending, level);
  return {
    phase,
    busy: shouldShowBusyForPhase(phase),
    disabled: shouldDisableForPhase(phase),
    timedOut: phase === "timedout",
  };
}
