// ── The toast half of the ONE notification stack, pure and tested ──────────
//
// Reported: side notifications spread across the screen instead of reading as one
// clean list — because there were, in effect, up to four independent notification
// surfaces at once: Toast.tsx (bottom-right, no cap, no dedup), ChangeNotifications.tsx
// (top-right, already capped+deduped), and two hand-rolled one-offs elsewhere
// (AddProjectButton's error span, SaveQuotedHoursButton's top banner — left alone; see
// the note in Toast.tsx). Toast.tsx and ChangeNotifications.tsx now render into ONE
// fixed container, but their item logic stays two separate, independently testable
// halves — merging the STATE (a realtime change-event queue and an arbitrary-message
// toast queue are shaped nothing alike) would have been a much larger, riskier change
// than merging the two already-correct renderers into one visual column.
//
// This file is the toast half — the rules ChangeNotifications.tsx already had
// (dedupe by identity, cap with the oldest trimmed first) applied to the DIFFERENT
// identity a toast has (message + type, not a grid cell), plus a `critical` flag
// ChangeNotifications never needed. Kept dependency-free, like lib/motion.ts, so
// `tsx --test` can load it and a render-time bug can never hide a logic bug.

// `warning` added 2026-09-02: the durations below are graded by severity, and
// without it every non-error had to be either a 2.5s confirmation or a 6s
// failure — so anything in between ("saved, but two rows were skipped") had to
// pick a lie.
export type ToastKind = "success" | "error" | "info" | "warning";

export type ToastItem = {
  id: number;
  message: string;
  type: ToastKind;
  // Survives a cap sweep even when every other toast on screen is trimmed — see
  // capToasts. Set by the five call sites the task names as "keep notifications
  // for": save/autosave failure, refresh failure/completion, permission/auth
  // errors. Everything else defaults to false.
  critical: boolean;
  // How many times this exact (message, type) has fired while already on screen.
  // ">1" is what the card renders as a "×N" badge instead of a second card.
  count: number;
};

// How many cards this half of the stack may show at once. ChangeNotifications
// caps its own half at 3 (VISIBLE, unchanged); toasts get one more because they
// are individually shorter-lived (4-6s vs. ChangeNotifications' 7s, or no
// auto-dismiss at all for a refused change) and less likely to pile up — but the
// two caps are independent, deliberately: capping the COMBINED stack at one shared
// number would let a burst of routine toasts push a colleague's change card off
// screen, or the reverse, and there is no principled way to rank "your export
// finished" against "Abhi edited cell X" that both halves should have to agree on.
// 3, matching ChangeNotifications' own VISIBLE. It was 4, on the reasoning that
// toasts are shorter-lived than change cards and so less likely to pile up —
// true, but it meant the two halves of one stack had different ideas of "too
// many", and seven cards can be on screen at once. Three each is the ceiling
// the notification rules ask for and reads as one list rather than a column of
// them.
export const MAX_VISIBLE_TOASTS = 3;

// ── Graded by severity, not one number for everything ─────────────────────
//
// A confirmation is GLANCED at — you already know what you did, the toast only
// says it worked — so it should be gone before it becomes furniture. A failure
// is READ, and often re-read, so it gets more than twice as long.
//
// Retuned 2026-09-02 (was 4s for everything except errors, which is a long time
// for "Copied 1101" to sit over the page): success and info now clear in 2.5s,
// which is enough to register and short enough that a burst of them never
// accumulates into a wall.
//
// Nothing here returns Infinity. A toast that never leaves is a toast the reader
// must clean up by hand, and the one message in this app that genuinely needs
// standing attention — a refused edit, which is asking somebody to re-enter a
// value — is a ChangeNotifications card, which has its own no-expiry rule for
// exactly that case.
export function autoDismissMs(type: ToastKind): number {
  switch (type) {
    case "error":
      return 6000;
    case "warning":
      return 4000;
    default:
      return 2500;
  }
}

/**
 * Fold an incoming toast into the current list.
 *
 * An identical (message, type) toast already on screen is BUMPED — its count
 * increments and it moves to the end (so it reads as the most recent, and so its
 * auto-dismiss timer restarts, which the caller does by re-scheduling whichever id
 * this returns as `bumpedId`) — rather than stacked as a second, visually identical
 * card. This is the "similar repeated notifications should be grouped or
 * deduplicated" requirement, applied at TOAST granularity: a message that repeats
 * character-for-character is what "similar" means to be safe about — two
 * DIFFERENT messages of the same shape ("Copied 1101", then "Copied 1104") are two
 * different facts and must not be merged into one that hides the second.
 *
 * `critical` is taken from the LATEST call, not the first — a message that fires
 * once as routine and again as critical (unlikely in practice, since a call site's
 * criticality does not change between calls, but not to leave a stale flag if it
 * ever did) should not have its critical status frozen at whichever call happened
 * to arrive first.
 */
export function foldToast(
  items: readonly ToastItem[],
  incoming: Omit<ToastItem, "count">,
): { items: ToastItem[]; bumpedId: number | null } {
  const idx = items.findIndex((t) => t.message === incoming.message && t.type === incoming.type);
  if (idx === -1) {
    return { items: [...items, { ...incoming, count: 1 }], bumpedId: null };
  }
  const existing = items[idx];
  const bumped: ToastItem = { ...existing, critical: incoming.critical, count: existing.count + 1 };
  return {
    items: [...items.slice(0, idx), ...items.slice(idx + 1), bumped],
    bumpedId: existing.id,
  };
}

/**
 * Trim to at most `max` visible cards, never dropping a critical one.
 *
 * A burst of routine confirmations (several "Copied X" in a row, say) must not be
 * able to push a save failure, a refresh failure, or a permission error off
 * screen — that is the one property `critical` exists to guarantee, and it is
 * enforced HERE rather than trusted to "critical toasts just happen to fire less
 * often". Trims the OLDEST non-critical items first, so what survives a trim is
 * always the most recent routine confirmations plus every critical one, in their
 * original relative order (a render-order flip on every keystroke would itself be
 * the "layout shift" the task asks to avoid).
 *
 * If `critical` items alone exceed `max` (every one of the app's 5 known critical
 * sites firing inside one debounce window — not reachable today, but not assumed
 * away either), every critical item is still kept: the cap is a ceiling on
 * ROUTINE noise, not a hard ceiling on the stack, because a dropped critical
 * message is a worse outcome than a taller stack for one render.
 */
export function capToasts(items: readonly ToastItem[], max: number): ToastItem[] {
  if (items.length <= max) return [...items];
  const critical = items.filter((t) => t.critical);
  const normal = items.filter((t) => !t.critical);
  const keepNormal = Math.max(0, max - critical.length);
  const trimmedNormal = normal.slice(Math.max(0, normal.length - keepNormal));
  const kept = new Set<number>([...critical, ...trimmedNormal].map((t) => t.id));
  return items.filter((t) => kept.has(t.id));
}

/**
 * Whether a `useToast()` call made from inside a suppressed subtree (Job Cost
 * Explorer, the Standard Sheet grid columns, the Standard Card / Standard Fees
 * panel — see SuppressToasts in ui/Toast.tsx) should actually be silenced.
 *
 * A one-line predicate, pulled out on its own for the reason every other rule in
 * this file is: so the actual decision — "critical always wins" — is pinned by a
 * test instead of living only inside a React hook nothing here can render.
 */
export function shouldSuppress(suppressed: boolean, critical: boolean | undefined): boolean {
  return suppressed && !critical;
}
