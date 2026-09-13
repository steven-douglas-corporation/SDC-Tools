// ── The app's one motion vocabulary (§36.17) ────────────────────────────────
//
// Before this file, every component that animated anything picked its own value:
// `transition-all` with no duration (Tailwind's 150ms default) on the buttons,
// `duration-150` on the sidebar width, `duration-150` on two chevrons, and nothing
// at all on the toasts, the change banner, the confirmation modal, the KPI cards or
// any grid cell. Nine components, four different answers, and most of the app
// unanimated — which is the "different arbitrary animation values in each
// component" §36.17 forbids.
//
// The durations live here AND as CSS custom properties in globals.css (--motion-*),
// which are the same numbers written twice — deliberately, and checked by a test
// (tests/motion.test.ts reads the stylesheet). CSS needs them as properties so a
// class can use them without JavaScript; TypeScript needs them as numbers so a
// setTimeout that has to outlast an exit animation is derived from the animation
// rather than guessed alongside it.
//
// ── Why these numbers ──────────────────────────────────────────────────────
//
// Straight from §36.2, one token per band rather than a range, because a range is
// how the drift started. Everything an interaction triggers is ≤ 300ms
// (INTERACTION_BUDGET_MS) and that is enforced below, not just documented: §36.2's
// "avoid long transitions above approximately 300ms" is the rule most easily broken
// by someone reaching for a nicer-feeling 400ms on one control.

/** Button press feedback (§36.2: 50–100ms). */
export const PRESS_MS = 80;
/** Hover and focus transitions (§36.2: 100–150ms). */
export const HOVER_MS = 120;
/** Dropdown / filter-menu open and close (§36.2: 120–180ms). */
export const MENU_MS = 150;
/**
 * Tabs, panels, cards, modals, notification banners and skeletons — every one of
 * which §36.2 puts in the same 150–250ms band, so they share one token. A modal
 * that opened at 200ms beside a banner that entered at 180ms is the kind of
 * difference nobody can name and everybody feels as untidiness.
 */
export const PANEL_MS = 200;

/**
 * The "this value just changed" highlight on a cell, a total or a KPI card
 * (§36.6, §36.8). NOT an interaction transition and deliberately outside the
 * budget below: it is feedback that has to survive being read, where 200ms is
 * a flicker. §36.6 still bounds it — "avoid persistent animations on edited
 * cells" — hence FLASH_MAX_MS.
 */
export const FLASH_MS = 600;

/**
 * How long a loading indicator waits before it is allowed to appear (§36.9:
 * "prevent loading-state flicker for very fast requests").
 *
 * Applied as a CSS `animation-delay` on an element that starts at opacity 0, so a
 * navigation that resolves in 60ms never paints a skeleton at all and no timer,
 * state or re-render is involved. 120ms is under the ~200ms at which a delay
 * starts being felt as lag, and over the time a warm prefetched route takes.
 */
export const LOADING_REVEAL_DELAY_MS = 120;

/**
 * Anything an interaction triggers must land within this (§36.2, §36.19). The
 * ceiling is on the token, not on a single use: a 400ms fade is not "slower
 * animation", it is a control that has stopped feeling connected to the click.
 */
export const INTERACTION_BUDGET_MS = 300;
/** Floor, from §36.2's shortest band. Below this a transition reads as a glitch. */
export const INTERACTION_FLOOR_MS = 50;
/** Ceiling for a feedback highlight (§36.6: brief, never persistent). */
export const FLASH_MAX_MS = 800;

/** Every token an interaction can trigger, keyed by the §36.2 band it comes from. */
export const MOTION = {
  press: PRESS_MS,
  hover: HOVER_MS,
  menu: MENU_MS,
  panel: PANEL_MS,
} as const;

export type MotionToken = keyof typeof MOTION;

/**
 * Is `ms` a legitimate duration for something a user's action triggers?
 *
 * Exported so the budget is a test rather than a comment — see tests/motion.test.ts,
 * which asserts it over every token in MOTION. A new token added outside the band
 * fails the suite instead of shipping.
 */
export function isInteractionDuration(ms: number): boolean {
  return Number.isFinite(ms) && ms >= INTERACTION_FLOOR_MS && ms <= INTERACTION_BUDGET_MS;
}

/** Same question for the value-changed highlight, which has its own, looser ceiling. */
export function isFlashDuration(ms: number): boolean {
  return Number.isFinite(ms) && ms > 0 && ms <= FLASH_MAX_MS;
}

/**
 * The duration to actually use, given the viewer's motion preference (§36.16).
 *
 * Zero when reduced motion is on — the state change still happens, it just happens
 * at once. This is the JS-side counterpart of the `prefers-reduced-motion` block in
 * globals.css, and it exists for the same reason FLASH_MS does: a timer that waits
 * for an animation must wait for the animation that is actually running. Under
 * reduced motion an exit animation does not run, so an element held on screen for
 * 200ms "while it fades" would just be an element that lingers.
 */
export function resolveMotionMs(ms: number, reducedMotion: boolean): number {
  return reducedMotion ? 0 : ms;
}

/**
 * Whether the current browser is asking for reduced motion.
 *
 * Returns false anywhere `matchMedia` is unavailable (server render, jsdom-less
 * test): the honest default for "we cannot ask" is the standard experience, and a
 * server render that assumed reduced motion would hydrate into a mismatch on every
 * ordinary browser.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// ── Which cells may flash (§36.6) ───────────────────────────────────────────
//
// "Update only affected cells" and "do not animate every cell during large
// refreshes" are two halves of one rule, and they pull in opposite directions on
// this app's grids: a keystroke in one New ETC cell moves two totals (flash them),
// while a Refresh Data pass or a "Show all" can move a hundred at once (flashing
// them all is the strobing §36.6 forbids, and a hundred simultaneous background
// animations is the main-thread cost §36.15 forbids).
//
// So the painter asks this function, which answers with the keys that changed and
// says outright when it has stopped counting.

/** Above this many changed cells in one paint, nothing flashes — see FLASH_CAP. */
export const FLASH_CAP = 12;

export type FlashDecision = {
  /** The keys to highlight. Empty when a bulk update suppressed the highlight. */
  keys: string[];
  /**
   * True when more than FLASH_CAP cells moved at once, so this was a bulk update
   * (a refresh, a filter change, a month switch) rather than somebody editing.
   * The caller shows nothing: a bulk update is not "your value was saved".
   */
  bulk: boolean;
};

/**
 * Which of `next` differ from `previous`, and whether that is too many to animate.
 *
 * Keys absent from `previous` are NOT flashes: a cell appearing for the first time
 * (first paint, a column unhidden, a row scrolled into a re-render) has not
 * changed, and highlighting it would mean the whole grid lights up on arrival.
 */
export function changedForFlash(
  previous: ReadonlyMap<string, string>,
  next: ReadonlyMap<string, string>,
  cap: number = FLASH_CAP,
): FlashDecision {
  const keys: string[] = [];
  for (const [key, value] of next) {
    const before = previous.get(key);
    if (before === undefined) continue; // first sighting, not a change
    if (before === value) continue;
    keys.push(key);
    // Keep counting past the cap so `bulk` is right, but stop collecting: the
    // caller cannot use more than cap+1 keys and a 4,150-entry array on every
    // keystroke is exactly the kind of work §36.15 asks to keep off the main thread.
    if (keys.length > cap) return { keys: [], bulk: true };
  }
  return { keys, bulk: false };
}

// ── Keeping a removed item on screen long enough to leave (§36.13) ──────────
//
// Toasts and the change-notification banner both come off a list. React unmounts a
// removed item immediately, so an exit animation on it never runs — which is why
// both of them appeared with a jump and vanished with one.
//
// The fix is the same in both places and is written once, here: merge the incoming
// list with what was rendered last time, marking the departed as `leaving` and
// LEAVING THEM IN PLACE. The caller animates them out and drops them after
// PANEL_MS. Pure, so the ordering rules — a departure holds its position, a
// re-arrival cancels its own exit — are pinned by tests rather than by reading a
// hook.

export type ExitEntry<T> = {
  key: string;
  item: T;
  /** On its way out: still rendered, no longer in the source list. */
  leaving: boolean;
};

/**
 * Merge `next` over `previous`, preserving entries that have gone away.
 *
 * Order is the incoming list's order, with each departed entry held at the index it
 * previously occupied — so a toast in the middle of a stack fades where it stands
 * instead of jumping to the end while it does (§36.13: "stack or queue cleanly",
 * §36.14: no unexpected movement).
 *
 * A key that comes BACK while it is still leaving is restored, not duplicated: the
 * same change can be re-announced, and a card that was mid-fade must simply stop
 * fading rather than appearing twice.
 */
export function mergeExiting<T>(
  next: readonly T[],
  keyOf: (item: T) => string,
  previous: readonly ExitEntry<T>[],
): ExitEntry<T>[] {
  const incoming = new Map<string, T>();
  for (const item of next) incoming.set(keyOf(item), item);

  const arriving: ExitEntry<T>[] = next.map((item) => ({ key: keyOf(item), item, leaving: false }));

  // Nothing has gone away: the common case (a toast added to an empty stack, a
  // steady list re-rendering) allocates one array and returns.
  const departed = previous.filter((e) => !incoming.has(e.key));
  if (departed.length === 0) return arriving;

  // Rebuild in the PREVIOUS order for the entries that survive from it, so a
  // departure keeps its neighbours, then append anything genuinely new.
  const out: ExitEntry<T>[] = [];
  const placed = new Set<string>();
  for (const before of previous) {
    const still = incoming.get(before.key);
    if (still !== undefined) {
      out.push({ key: before.key, item: still, leaving: false });
    } else {
      out.push({ key: before.key, item: before.item, leaving: true });
    }
    placed.add(before.key);
  }
  for (const entry of arriving) {
    if (!placed.has(entry.key)) out.push(entry);
  }
  return out;
}

/** Are any entries mid-exit? The hook uses this to decide whether to arm a timer. */
export function hasLeaving<T>(entries: readonly ExitEntry<T>[]): boolean {
  return entries.some((e) => e.leaving);
}

/** Drop every entry that is on its way out — what the exit timer applies. */
export function withoutLeaving<T>(entries: readonly ExitEntry<T>[]): ExitEntry<T>[] {
  return entries.filter((e) => !e.leaving);
}
