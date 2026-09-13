// A pending state that cannot last forever.
//
// ── The bug class this exists for (§35.1, §35.7, §35.14) ────────────────────
//
// Reported as two things that look unrelated and are the same defect: the Projects
// "Show all" button stuck on "Showing all…", and clicking a tab leaving the next one
// loading indefinitely. Both are an unbounded pending flag.
//
// Every navigating control in this app follows the same shape:
//
//     const [pending, startTransition] = useTransition();
//     startTransition(() => router.push(...));
//     <button disabled={pending}>{pending ? "Showing all…" : "Show all"}</button>
//
// `pending` is true for the whole server round-trip, which is correct and is what makes
// a slow render feel acknowledged rather than broken. What is NOT correct is that there
// is no other way out. If the transition never settles — the navigation is superseded by
// another one, the RSC request is queued behind a long-running server action (Next
// serializes server actions from one client; a Refresh Data pass holds one open for
// ~19s), the connection stalls — then `pending` stays true, the button stays disabled,
// and the only fix available to the user is a full browser reload. On a control that is
// `disabled={pending}`, a stuck flag is indistinguishable from a broken app.
//
// So a pending state gets a deadline. It is deliberately NOT a cancellation — nothing here
// can abort a server render, and pretending otherwise would be worse. What it does is
// stop LYING: after `slowAfterMs` it says the operation is taking longer than expected,
// and after `timeoutAfterMs` it stops claiming to be in progress at all and re-enables
// the control so the user can retry or navigate away (§35.15: keep the last valid data,
// offer a retry, never require a browser refresh).
//
// Pure and separate from React so the state machine is testable without a DOM, a fake
// clock, or a renderer — see phaseForLevel.

export type PendingPhase =
  // Nothing in flight.
  | "idle"
  // In flight, within the expected window. Show the normal busy label.
  | "pending"
  // Still in flight, but longer than this operation should take. Same busy state, plus
  // an honest "this is taking longer than usual" — the difference between slow and
  // broken, which is the whole complaint.
  | "slow"
  // Long enough that we will no longer claim it is working. The control is re-enabled
  // and a retry is offered. The underlying request may still land; if it does, the
  // navigation simply completes and `pending` goes false on its own.
  | "timedout";

// Defaults chosen against the measured shape of this app rather than picked round:
// the heaviest thing any of these controls triggers is the Projects grid at "Show all"
// (233 rows x every column, with actuals) or the Monthly ETC grid (4,150 cells). Those
// are hundreds of milliseconds of server render, not seconds — so 3s is comfortably
// "slower than it has any right to be" and 15s is "this is not coming back".
export const SLOW_AFTER_MS = 3_000;
export const TIMEOUT_AFTER_MS = 15_000;

// ── Level, not a clock ──────────────────────────────────────────────────────
//
// The phase advances on TIMERS rather than by comparing timestamps. That is not a
// stylistic choice: the React hook derives the phase during render, and both
// `Date.now()` and reading a ref are forbidden there (impure / refs-in-render). A level
// that timers push forward is pure to read, so the rule below stays a plain function of
// its inputs and the hook stays lint-clean without suppressions.
export type PendingLevel = 0 | 1 | 2; // 0 fresh, 1 slow, 2 gave up

/**
 * The phase to show, given whether an operation is in flight and how far its timers have
 * advanced.
 *
 * `pending === false` always wins: an operation that completes is idle no matter how
 * long it took, so the watchdog can never latch a stale busy state.
 */
export function phaseForLevel(pending: boolean, level: PendingLevel): PendingPhase {
  if (!pending) return "idle";
  if (level >= 2) return "timedout";
  if (level >= 1) return "slow";
  return "pending";
}

/**
 * Whether the control should be disabled.
 *
 * The load-bearing case is `timedout` → FALSE. A control that stays disabled after its
 * operation has visibly failed is the reported bug: there is no way to retry and no way
 * to tell it apart from a dead application.
 */
export function shouldDisableForPhase(phase: PendingPhase): boolean {
  return phase === "pending" || phase === "slow";
}

/** Whether a busy affordance (spinner, "…" label) should show. */
export function shouldShowBusyForPhase(phase: PendingPhase): boolean {
  return phase === "pending" || phase === "slow";
}
