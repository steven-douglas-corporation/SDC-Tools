// The rules behind ScrollHandoff.tsx, with the decision itself kept as a PURE
// function over plain descriptors — the same shape DragScroll's `pressKindFor` uses,
// and for the same reason: getting a scroll rule wrong in either direction is a
// reported bug, and a rule that can only be verified by clicking is a rule nobody
// re-verifies. tests/scroll-handoff.test.ts drives `chooseHandoff` directly; the DOM
// walk below is the thin part that reads real elements into those descriptors.
//
// See ScrollHandoff.tsx for WHY any of this exists (short version: this app has no
// scroll traps — what makes a table feel stuck is the browser latching a gesture to
// it, which no CSS can undo).

/** One link in the ancestor chain, reduced to only what the decision depends on. */
export type ScrollNode = {
  /** `position: fixed` — a modal, drawer or popover boundary. */
  fixed: boolean;
  /** Computed `overflow-y`. */
  overflowY: string;
  /** Computed `overscroll-behavior-y`. */
  overscrollY: string;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};

/**
 * A scroll container is only interesting if it can actually overflow vertically.
 *
 * The one-pixel slack is not cosmetic: sub-pixel layout routinely leaves scrollHeight
 * a hair above clientHeight on a container that is not really scrollable, and
 * treating those as scrollers would put a handoff decision in front of ordinary page
 * scrolling on half the app.
 */
export function scrollsVertically(n: ScrollNode): boolean {
  if (n.overflowY !== "auto" && n.overflowY !== "scroll" && n.overflowY !== "overlay") return false;
  return n.scrollHeight - n.clientHeight > 1;
}

/**
 * Room left to move in the wheel's direction, in the element's own pixels.
 * Positive means the element can still absorb the gesture itself.
 */
export function roomToScroll(n: ScrollNode, deltaY: number): number {
  if (deltaY < 0) return n.scrollTop;
  return n.scrollHeight - n.clientHeight - n.scrollTop;
}

/**
 * The same 1px tolerance, applied to the boundary test — and here it earns its keep
 * at fractional zoom (§45 runs the whole app at 0.8 by default). A container scrolled
 * fully to its end can sit at scrollTop 412.5 against a max of 413; without the
 * tolerance it would never read as "at the bottom" and would never hand off, which is
 * precisely the stuck feeling this is meant to remove.
 */
export function canAbsorb(n: ScrollNode, deltaY: number): boolean {
  return roomToScroll(n, deltaY) > 1;
}

/**
 * Whether this container has asked, in CSS, to keep overscroll to itself.
 *
 * Nothing in this app does today (audited: zero `contain`/`none` on the Y axis), but
 * respecting it is the difference between a helper and an override — a future modal
 * body or infinite-scroll pane that sets `overscroll-behavior-y: contain` means it,
 * and this must not chain out of it.
 */
export function containsOverscroll(n: ScrollNode): boolean {
  return n.overscrollY === "contain" || n.overscrollY === "none";
}

/**
 * Which element in the chain should take this wheel event.
 *
 * `chain` runs innermost-first, from the event target up to (not including) the root
 * scroller; `root` is the page itself. Returns an index into `chain`, the string
 * "root" for the page, or null to leave the browser alone — which is the answer for
 * the overwhelming majority of events.
 *
 * Null means one of:
 *   • the pointer is not inside any scroll container (the page already scrolls);
 *   • the innermost container can still move, so native scrolling is correct;
 *   • that container asked to contain its overscroll;
 *   • the chain runs into a `position: fixed` ancestor before reaching anything
 *     scrollable — a modal, drawer or dropdown. Handing off there would scroll the
 *     page behind an open dialog, which is the one thing every scroll-lock exists to
 *     prevent. Detected structurally rather than by looking for `role="dialog"`, so
 *     the unlabelled modals in this codebase are covered too;
 *   • nothing outward can move either, so there is nowhere to hand off TO.
 */
export function chooseHandoff(
  chain: readonly ScrollNode[],
  root: ScrollNode,
  deltaY: number,
): number | "root" | null {
  // 1. The innermost scroll container the pointer is actually inside.
  let innerAt = -1;
  for (let i = 0; i < chain.length; i++) {
    if (scrollsVertically(chain[i])) {
      innerAt = i;
      break;
    }
    // A fixed ancestor reached before any scroller: the pointer is over the static
    // part of a dialog or popover. Nothing to hand off, and nothing to chain into.
    if (chain[i].fixed) return null;
  }
  if (innerAt === -1) return null; // not in a nested scroller — the page needs no help
  if (canAbsorb(chain[innerAt], deltaY)) return null; // room left: the normal case
  if (containsOverscroll(chain[innerAt])) return null;

  // 2. The next thing outward that can take the gesture.
  for (let i = innerAt + 1; i < chain.length; i++) {
    const node = chain[i];
    if (node.fixed) return null;
    if (!scrollsVertically(node)) continue;
    if (canAbsorb(node, deltaY)) return i;
    // An intermediate scroller that is ALSO at its end is not a dead end — keep
    // walking outward past it — unless it means to contain its own overscroll.
    if (containsOverscroll(node)) return null;
  }

  // 3. The page itself.
  return canAbsorb(root, deltaY) ? "root" : null;
}

/**
 * Wheel deltas arrive in three units; only pixels can be applied to scrollTop.
 * `deltaMode` 1 is lines and 2 is pages — rare (some mice, some Firefox
 * configurations) but not hypothetical, and a line treated as a pixel is a wheel that
 * appears not to work at all once handoff engages.
 */
export function wheelPixels(deltaY: number, deltaMode: number, clientHeight: number): number {
  if (deltaMode === 1) return deltaY * 16; // lines
  if (deltaMode === 2) return deltaY * clientHeight; // pages
  return deltaY;
}

/**
 * `zoom` (§45) scales an element's rendered size but NOT the wheel's deltaY, which
 * arrives in the viewport's own unscaled pixels. Moving a zoomed container by a raw
 * deltaY therefore travels 1/zoom too far — at the 50% floor, twice the distance the
 * gesture asked for. Dividing it out makes a handoff scroll exactly as far as the
 * same gesture scrolls natively at that zoom level.
 *
 * The root scroller takes no correction: the zoom lives ON <html>, so the viewport it
 * scrolls is already the unscaled space the delta is measured in. Both halves of this
 * were measured in the running app at 50/80/100%, not reasoned about alone.
 */
export function zoomScale(zoom: number, isRoot: boolean): number {
  if (isRoot) return 1;
  return Number.isFinite(zoom) && zoom > 0 ? 1 / zoom : 1;
}

// ── The DOM half ────────────────────────────────────────────────────────────

function describe(el: Element): ScrollNode {
  const style = getComputedStyle(el);
  return {
    fixed: style.position === "fixed",
    overflowY: style.overflowY,
    overscrollY: style.overscrollBehaviorY,
    scrollTop: el.scrollTop,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  };
}

/** The element this wheel event should be handed to, or null to leave the browser alone. */
export function findHandoffTarget(from: Element, deltaY: number): { el: Element; scale: number } | null {
  const doc = from.ownerDocument;
  const root = doc.scrollingElement ?? doc.documentElement;

  const elements: Element[] = [];
  for (let el: Element | null = from; el && el !== root; el = el.parentElement) elements.push(el);

  const choice = chooseHandoff(elements.map(describe), describe(root), deltaY);
  if (choice === null) return null;

  const el = choice === "root" ? root : elements[choice];
  const zoom = parseFloat(getComputedStyle(doc.documentElement).getPropertyValue("--app-zoom"));
  return { el, scale: zoomScale(zoom, el === root) };
}
