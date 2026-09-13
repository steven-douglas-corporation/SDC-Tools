"use client";

// ── Instrumentation for the tab lifecycle ────────────────────────────────────
//
// Asked for 2026-09-04, step 1 of the report: "determine whether Monthly ETC is
// remounting" — MOUNT / UNMOUNT / ACTIVATE / DEACTIVATE, plus the scroll container's
// real numbers while scrolling by hand.
//
// It exists because two fixes have now been shipped against a bug I cannot reproduce
// myself: this app requires a sign-in, so the only way to distinguish "the pane is
// remounting" from "the pane is fine and something re-renders the grid underneath it"
// is for the person who CAN reproduce it to read it off their own console.
//
// ── Off unless asked for ────────────────────────────────────────────────────
//
// A grid scroll fires hundreds of events; logging them unconditionally would be its own
// performance bug and would bury anything else in the console. Two ways to turn it on:
//
//     ?tabdebug=1                 for one page load
//     localStorage.sdcTabDebug=1  until it is turned off again
//
// The flag is read ONCE per module load, so toggling it needs a reload — deliberate: a
// per-call read would put a localStorage hit on the scroll path, which is the one place
// this must not cost anything.

const enabled = (() => {
  if (typeof window === "undefined") return false;
  try {
    if (new URLSearchParams(window.location.search).get("tabdebug") === "1") return true;
    return window.localStorage.getItem("sdcTabDebug") === "1";
  } catch {
    // Private mode, or storage disabled. Off is the right answer.
    return false;
  }
})();

/** True when the log is on, so a caller can skip building an expensive payload. */
export const tabDebugEnabled = (): boolean => enabled;

/**
 * One lifecycle line.
 *
 * `event` is the vocabulary the report asked for; `detail` is whatever makes that event
 * answerable. Prefixed so it can be filtered to in the console.
 */
export function tabDebug(event: string, detail?: Record<string, unknown>): void {
  if (!enabled) return;
  console.log(`[tab] ${event}`, detail ?? "");
}

/**
 * A scroll container's real numbers.
 *
 * Step 3 of the report: "do not assume the browser/page scroll is the ETC grid scroll —
 * find the exact element whose values change." This prints the element, its key, and the
 * four figures that say whether it is the one that actually scrolls: a parent wrapper
 * reports 0/0 with no room, the real scroller does not.
 */
export function tabDebugScroller(key: string, el: HTMLElement): void {
  if (!enabled) return;
  console.log(`[tab] SCROLLER ${key || "(pane)"}`, {
    el,
    scrollLeft: el.scrollLeft,
    scrollTop: el.scrollTop,
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    canScrollX: el.scrollWidth > el.clientWidth,
    canScrollY: el.scrollHeight > el.clientHeight,
  });
}
