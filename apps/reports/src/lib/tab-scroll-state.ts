// ── Every scroll position in a tab, per tab instance ─────────────────────────
//
// REPORTED 2026-09-04: scroll the Monthly ETC grid far to the right, switch tabs, come
// back — the grid is at the left again.
//
// ── Why <Activity> was not enough on its own ────────────────────────────────
//
// The panes already stay mounted (WorkspaceShell), and Next's own guide says Activity
// preserves "form drafts, scroll positions, expanded <details> elements". React state
// genuinely does survive, and so does the pane's own scrollTop — which is why this was
// reported as a HORIZONTAL problem on an inner grid rather than as "everything resets".
//
// The gap is that Activity hides a pane with `display: none`, and an element with no
// layout box has no scroll box either: the browser cannot keep an offset for something
// it is not laying out. The page-level scroller survives because Next restores that one
// itself; a nested `overflow-x: auto` div three levels inside a table wrapper does not.
// The Monthly ETC grid is exactly that, so it lost its horizontal position on every
// switch while everything around it looked fine.
//
// ── Capture continuously, not on the way out ────────────────────────────────
//
// The obvious fix is to read the offsets in a layout-effect cleanup, which is the hook
// Activity gives you for "about to be hidden". It is the wrong one here: it depends on
// reading scrollLeft BEFORE React applies display:none, and if that order is ever not
// what we assumed, every read is 0 and the bug becomes "positions reset to the start",
// which is indistinguishable from having no fix at all.
//
// So positions are recorded as they change, from a capture-phase scroll listener, and
// the recording is what gets restored. Nothing depends on when the pane is hidden.
// Scroll events do not bubble, but they DO reach a capture listener on an ancestor, so
// one listener per pane sees every scroller inside it — which is also what makes this
// general: no page needs to know it is inside a tab, and a scroller added to any of the
// twelve pages later is covered the day it is added.
//
// ── Keyed by TAB INSTANCE ───────────────────────────────────────────────────
//
// "Monthly ETC tab A → own state, Monthly ETC tab B → own state." The store is keyed by
// the tab's id (`t1`, `t2`, …), which is what the URL already carries, so two Monthly
// ETC tabs on the same month with the same filters still cannot share a position. Keying
// by route+params — which the earlier version did — would have collided on exactly that
// case.

/** One scroller's remembered offsets. */
export type ScrollEntry = { key: string; left: number; top: number };

/** Everything scrollable inside one tab, keyed as below. */
export type TabScrollState = Record<string, { left: number; top: number }>;

/** The pane container itself, as opposed to a scroller inside it. */
export const ROOT_KEY = "";

export const tabScrollStorageKey = (tabId: string): string => `sdc.ws.scroll.v2:${tabId}`;

/**
 * A stable name for one scroller within its pane.
 *
 * `data-scroll-key` wins when a component has declared one — that is the durable
 * option, and worth adding to anything whose position genuinely matters (the Monthly
 * ETC grid has one). Everything else gets a structural path: the chain of child indices
 * from the pane root.
 *
 * The path is stable for as long as the pane stays mounted, which is the whole window
 * this needs to cover — a hide and a show, with no re-render in between. It is
 * deliberately NOT trusted further than that: after a reload the DOM is rebuilt and a
 * path that no longer resolves is simply skipped, so a layout change can lose a
 * position but can never apply one to the wrong element.
 */
export function scrollKeyOf(el: Element, root: Element): string {
  const declared = el.getAttribute("data-scroll-key");
  if (declared) return `@${declared}`;
  const path: number[] = [];
  let node: Element | null = el;
  while (node && node !== root) {
    const parent: Element | null = node.parentElement;
    if (!parent) return ""; // detached mid-walk; treat as the root rather than guess
    path.push([...parent.children].indexOf(node));
    node = parent;
  }
  return path.reverse().join("/");
}

/** Resolve a structural path (or a declared key) back to an element. */
export function elementForKey(root: HTMLElement, key: string): HTMLElement | null {
  if (key === ROOT_KEY) return root;
  if (key.startsWith("@")) return root.querySelector<HTMLElement>(`[data-scroll-key="${CSS.escape(key.slice(1))}"]`);
  let node: HTMLElement = root;
  for (const part of key.split("/")) {
    const i = Number(part);
    // Duck-typed rather than `instanceof HTMLElement`: `children` is an element
    // collection by definition, and an SVG or MathML scroll container is a legitimate
    // element that the instanceof check would have refused.
    const next = node.children[i] as HTMLElement | undefined;
    if (!next) return null;
    node = next;
  }
  return node;
}

/** Does this element actually have somewhere to scroll? */
export function hasScrollRoom(el: HTMLElement): boolean {
  return el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
}

/**
 * Write one entry back, and say whether it stuck.
 *
 * The reason this returns a boolean rather than just assigning: a scroller whose
 * content has not been laid out yet clamps the assignment to 0 and reports 0 back,
 * silently. That is the failure the report warned about — "setting scrollLeft too early
 * may silently reset to 0" — and the only way to know it happened is to read the value
 * back and compare.
 *
 * "Stuck" allows for legitimate clamping: a saved offset of 900 against a scroller that
 * genuinely only reaches 850 is applied correctly at 850, and must not be retried
 * forever. So a value is accepted once it matches OR the element is already at its
 * maximum in that axis.
 */
export function applyEntry(el: HTMLElement, want: { left: number; top: number }): boolean {
  if (want.left !== el.scrollLeft) el.scrollLeft = want.left;
  if (want.top !== el.scrollTop) el.scrollTop = want.top;
  const maxLeft = Math.max(0, el.scrollWidth - el.clientWidth);
  const maxTop = Math.max(0, el.scrollHeight - el.clientHeight);
  // ── Why `max > 0` is part of the test ──────────────────────────────────────
  //
  // A grid whose columns have not been measured yet has scrollWidth === clientWidth, so
  // its maximum is 0 — which is indistinguishable, at this instant, from a scroller that
  // genuinely has nowhere to go. Accepting the clamp in that case was the first version
  // of this function, and it reported success on exactly the case the retry loop exists
  // for: the offset silently became 0 and never came back.
  //
  // So a clamp only counts as applied when there was some room to clamp INTO. No room at
  // all, against a non-zero target, reads as "not laid out yet" and is retried — and the
  // caller's frame cap is what stops a scroller that really has no room from retrying
  // forever.
  const clamped = (want: number, at: number, max: number) => want > max && max > 0 && at >= max - 1;
  const leftOk = Math.abs(el.scrollLeft - want.left) <= 1 || clamped(want.left, el.scrollLeft, maxLeft);
  const topOk = Math.abs(el.scrollTop - want.top) <= 1 || clamped(want.top, el.scrollTop, maxTop);
  return leftOk && topOk;
}

/**
 * Apply a whole tab's state, returning the keys that did NOT stick.
 *
 * The caller retries those on later frames rather than looping here: the reason a value
 * does not stick is that the browser has not finished laying the content out, and no
 * amount of synchronous retrying inside one frame can change that.
 */
export function applyScrollState(root: HTMLElement, state: TabScrollState): string[] {
  const pending: string[] = [];
  for (const [key, want] of Object.entries(state)) {
    if (want.left === 0 && want.top === 0) continue; // nothing to restore
    const el = elementForKey(root, key);
    if (!el) continue; // the DOM changed shape; skip rather than guess
    if (!applyEntry(el, want)) pending.push(key);
  }
  return pending;
}

/** Drop zero offsets so a fresh tab stores nothing and `{}` means "never scrolled". */
export function pruneScrollState(state: TabScrollState): TabScrollState {
  const out: TabScrollState = {};
  for (const [key, v] of Object.entries(state)) {
    if (v.left !== 0 || v.top !== 0) out[key] = v;
  }
  return out;
}

/** Parse what came out of sessionStorage. Total: any malformed value reads as "nothing saved". */
export function parseScrollState(raw: string | null): TabScrollState {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: TabScrollState = {};
    for (const [key, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!v || typeof v !== "object") continue;
      const { left, top } = v as { left?: unknown; top?: unknown };
      const l = Number(left);
      const t = Number(top);
      // Negative and non-finite are refused rather than clamped: they cannot have come
      // from a real scroller, so the entry is corrupt and guessing at it is worse than
      // starting that scroller at the top.
      if (!Number.isFinite(l) || !Number.isFinite(t) || l < 0 || t < 0) continue;
      out[key] = { left: l, top: t };
    }
    return out;
  } catch {
    return {};
  }
}

// ── Telling a user's scroll apart from a layout reset ────────────────────────
//
// REPORTED AGAIN 2026-09-04, after the first fix: "the Monthly ETC tab is still losing
// its internal grid viewport state." Two bugs, both provable by reading the code rather
// than by clicking, and the first one is why saving values was never going to be enough.
//
//   1. The recorder trusted every scroll event. Anything that reset the grid to 0 fired
//      a scroll event at 0, which OVERWROTE the remembered offset — so the memory was
//      destroyed before the restore ever got a chance to use it. A save-and-restore
//      pair cannot work if the save is the thing corrupting the value.
//
//   2. The restore was one-shot, on show. But `apply({navigate:true})` — opening a tab,
//      duplicating one, re-routing one — goes through the router, so the server
//      re-delivers EVERY pane's content and the grid DOM is replaced AFTER the restore
//      has already run. Nothing re-applied it. That is the report's own second
//      hypothesis, and it is correct.
//
// The rule below fixes the first. A scroll to zero that no user gesture preceded is not
// a decision, it is a layout reset — so it is refused, and the caller re-restores
// instead. The window is deliberate rather than a debounce: it asks "did a person do
// this?", and a person scrolling genuinely back to the far left within the window is
// still recorded, because the gesture is what admits it.

/** How recently a real gesture must have happened for a scroll-to-zero to be believed. */
export const USER_INTENT_MS = 700;

/**
 * Is this scroll event a decision to record, or a reset to refuse?
 *
 * Refused only in the one shape that a reset takes and a person almost never does: an
 * axis snapping to exactly 0 from a remembered non-zero offset, in a container that
 * still has room to scroll, with no gesture behind it.
 */
export function shouldRecordScroll(a: {
  next: { left: number; top: number };
  remembered: { left: number; top: number } | undefined;
  /** Milliseconds since the last gesture in this pane, or null if there has never been one. */
  sinceUserInputMs: number | null;
  /** How far each axis can scroll right now. */
  room: { left: number; top: number };
}): boolean {
  const byUser = a.sinceUserInputMs !== null && a.sinceUserInputMs <= USER_INTENT_MS;
  if (byUser) return true;
  const was = a.remembered;
  if (!was) return true; // nothing to protect
  const collapsedLeft = a.next.left === 0 && was.left > 0 && a.room.left > 0;
  const collapsedTop = a.next.top === 0 && was.top > 0 && a.room.top > 0;
  // Both axes intact, or a move that is not a collapse to zero: a real change.
  return !(collapsedLeft || collapsedTop);
}

/**
 * The keys whose DOM position no longer matches what we remember.
 *
 * Drives the re-restore: an observer notices the subtree changed, and this says whether
 * anything actually needs putting back. Returning the keys rather than a boolean is what
 * lets the caller reapply only those, so a pane the user has since scrolled by hand is
 * left alone.
 */
export function driftedKeys(root: HTMLElement, state: TabScrollState): string[] {
  const out: string[] = [];
  for (const [key, want] of Object.entries(state)) {
    if (want.left === 0 && want.top === 0) continue;
    const el = elementForKey(root, key);
    if (!el) continue;
    if (Math.abs(el.scrollLeft - want.left) > 1 || Math.abs(el.scrollTop - want.top) > 1) out.push(key);
  }
  return out;
}

/** How far each axis of this element can scroll. */
export function roomOf(el: HTMLElement): { left: number; top: number } {
  return {
    left: Math.max(0, el.scrollWidth - el.clientWidth),
    top: Math.max(0, el.scrollHeight - el.clientHeight),
  };
}
