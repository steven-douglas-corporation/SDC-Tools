"use client";

import { useLayoutEffect, useRef } from "react";
import {
  ROOT_KEY,
  applyScrollState,
  driftedKeys,
  elementForKey,
  parseScrollState,
  pruneScrollState,
  roomOf,
  scrollKeyOf,
  shouldRecordScroll,
  tabScrollStorageKey,
  type TabScrollState,
} from "@/lib/tab-scroll-state";
import { tabDebug, tabDebugEnabled, tabDebugScroller } from "@/lib/tab-debug";

// ── The pane's scroll container, and every scroller inside it ────────────────
//
// lib/tab-scroll-state.ts carries the reasoning for all of it: why <Activity> alone does
// not keep a nested scroller's offset, why a scroll to zero with no gesture behind it is
// refused rather than recorded, and why the store is keyed by TAB INSTANCE.
//
// ── Why this is not just save-on-hide / restore-on-show ────────────────────
//
// Because that is what shipped first, and it did not work. Two reasons, and the second
// is the one that makes the shape of this file:
//
//   The recorder was corrupting its own memory. Anything that reset the grid to 0 fired
//   a scroll event at 0 and overwrote the remembered offset.
//
//   The restore was one-shot. `apply({navigate:true})` — opening, duplicating or
//   re-routing a tab — goes through the router, so the server re-delivers every pane's
//   content and the grid DOM is REPLACED after the restore has already run.
//
// So the restore cannot be an event, it has to be a standing intent: this component
// watches its own subtree and puts the position back whenever the DOM drifts away from
// it, until the user themselves scrolls somewhere else. That covers a re-render, a
// remount, a late-arriving column measurement and a virtualized body initialising —
// none of which are things a page has to tell us about.

/** Frames to keep retrying one restore. ~20 at 60fps is a third of a second. */
const MAX_RESTORE_FRAMES = 20;

export function TabScrollMemory({ tabId, children }: { tabId: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  // The live record. A ref, not state: nothing renders from it, and a setState per
  // scroll frame on a 450-cell grid would be its own performance bug.
  const state = useRef<TabScrollState>({});
  const loaded = useRef(false);
  /** When a real gesture last happened in this pane — the thing that makes a scroll a decision. */
  const lastInput = useRef<number | null>(null);
  const shows = useRef(0);

  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const storageKey = tabScrollStorageKey(tabId);
    shows.current += 1;
    // ACTIVATE, in the report's own terms. Under <Activity> a layout effect runs when
    // the pane becomes visible and its cleanup runs when it is hidden, so this pair IS
    // the activate/deactivate boundary — and the show count proves the component is not
    // being remounted, because a remount would reset it to 1 every time.
    tabDebug("ACTIVATE", { tabId, shows: shows.current, remembered: { ...state.current } });

    // ── Seed from the last session, once ──────────────────────────────────
    //
    // Only on first mount for this tab. On a re-show the in-memory record is the
    // authority — it is newer than anything on disk, and re-reading storage here would
    // undo a position the user changed since the last frame that got persisted.
    if (!loaded.current) {
      loaded.current = true;
      try {
        state.current = parseScrollState(sessionStorage.getItem(storageKey));
      } catch {
        // Private mode, or storage disabled. Starting at the top is a fine outcome.
      }
    }

    // ── Restore, retrying until it takes ──────────────────────────────────
    //
    // A layout effect is the earliest the pane is laid out again, but "laid out" is not
    // "the table inside has its final width": a grid whose columns are unmeasured clamps
    // scrollLeft to 0 and reports 0 back. So each frame reapplies only what has not
    // stuck, and stops as soon as nothing is left.
    let raf = 0;
    const runRestore = (why: string) => {
      if (raf) cancelAnimationFrame(raf);
      let frame = 0;
      const step = () => {
        raf = 0;
        const pending = applyScrollState(root, state.current);
        if (pending.length === 0) {
          tabDebug("RESTORED", { tabId, why, state: { ...state.current } });
          return;
        }
        if (frame >= MAX_RESTORE_FRAMES) {
          tabDebug("RESTORE-GAVE-UP", { tabId, why, pending });
          return;
        }
        frame++;
        raf = requestAnimationFrame(step);
      };
      step();
    };
    runRestore("activate");

    // ── A standing intent, not a one-shot ─────────────────────────────────
    //
    // Whatever replaces or resizes the content — an RSC re-delivery, a remount, columns
    // measuring late, a virtualized body initialising — the position goes back, unless
    // the user has since scrolled somewhere themselves (which updates the record, so
    // there is nothing to drift from).
    let reRaf = 0;
    const reRestoreSoon = (why: string) => {
      if (reRaf) return;
      reRaf = requestAnimationFrame(() => {
        reRaf = 0;
        const drifted = driftedKeys(root, state.current);
        if (drifted.length === 0) return;
        tabDebug("DRIFT", { tabId, why, drifted });
        runRestore(why);
      });
    };

    // childList + subtree: this fires when the grid's DOM is replaced, which is the case
    // the one-shot restore missed entirely.
    const mo = new MutationObserver(() => reRestoreSoon("mutation"));
    mo.observe(root, { childList: true, subtree: true });

    // And when a scroller's own dimensions arrive late, which is the other way an
    // applied offset silently becomes 0.
    const ro = new ResizeObserver(() => reRestoreSoon("resize"));
    ro.observe(root);
    for (const el of root.querySelectorAll<HTMLElement>("[data-scroll-key]")) ro.observe(el);

    // ── Gestures ──────────────────────────────────────────────────────────
    //
    // What makes a scroll-to-zero believable. Capture phase and passive: these must never
    // interfere with the interaction they are observing.
    const onInput = () => {
      lastInput.current = Date.now();
    };
    for (const type of ["pointerdown", "wheel", "keydown", "touchstart"] as const) {
      root.addEventListener(type, onInput, { capture: true, passive: true });
    }

    // ── Record ────────────────────────────────────────────────────────────
    //
    // Capture phase: a scroll event does not bubble, but it does reach a capture listener
    // on an ancestor — so this one listener sees the pane itself AND every scroller
    // nested anywhere inside it. That is what makes this general across all twelve pages
    // rather than a Monthly ETC special case.
    let writeRaf = 0;
    const onScroll = (e: Event) => {
      const el = e.target;
      if (!(el instanceof HTMLElement) || !root.contains(el)) return;
      const key = el === root ? ROOT_KEY : scrollKeyOf(el, root);
      const next = { left: el.scrollLeft, top: el.scrollTop };
      const sinceUserInputMs = lastInput.current === null ? null : Date.now() - lastInput.current;

      // The fix for the first bug: a collapse to zero that no gesture preceded is a
      // layout reset, and recording it would destroy the very value we are protecting.
      if (!shouldRecordScroll({ next, remembered: state.current[key], sinceUserInputMs, room: roomOf(el) })) {
        tabDebug("IGNORED-RESET", { tabId, key, next, remembered: state.current[key], sinceUserInputMs });
        reRestoreSoon("reset");
        return;
      }

      // Step 3 of the report: name the element that ACTUALLY scrolls, once per key, so a
      // parent wrapper reporting 0/0 can be told apart from the real scroller.
      if (tabDebugEnabled() && state.current[key] === undefined) tabDebugScroller(key, el);
      state.current[key] = next;
      // One write per frame at most: a trackpad fling on a long grid fires these in the
      // hundreds, and sessionStorage is synchronous.
      if (writeRaf) return;
      writeRaf = requestAnimationFrame(() => {
        writeRaf = 0;
        try {
          sessionStorage.setItem(storageKey, JSON.stringify(pruneScrollState(state.current)));
        } catch {
          /* see above */
        }
      });
    };
    root.addEventListener("scroll", onScroll, { capture: true, passive: true });

    return () => {
      tabDebug("DEACTIVATE", { tabId, state: { ...state.current } });
      root.removeEventListener("scroll", onScroll, { capture: true });
      for (const type of ["pointerdown", "wheel", "keydown", "touchstart"] as const) {
        root.removeEventListener(type, onInput, { capture: true });
      }
      mo.disconnect();
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
      if (reRaf) cancelAnimationFrame(reRaf);
      if (writeRaf) cancelAnimationFrame(writeRaf);

      // A last read on the way out. `root`, captured when the effect ran — not
      // ref.current, which React may already have detached.
      //
      // This cannot be RELIED on: if React has applied display:none by now then every
      // offset reads 0. Which is exactly why it only ever ADDS non-zero values and can
      // never overwrite a remembered one with a zero.
      if (root.isConnected) {
        for (const key of Object.keys(state.current)) {
          const node = elementForKey(root, key);
          if (!node) continue;
          if (node.scrollLeft !== 0 || node.scrollTop !== 0) {
            state.current[key] = { left: node.scrollLeft, top: node.scrollTop };
          }
        }
        try {
          sessionStorage.setItem(storageKey, JSON.stringify(pruneScrollState(state.current)));
        } catch {
          /* see above */
        }
      }
    };
  }, [tabId]);

  // overflow-auto both ways: dense pages scroll horizontally in here too, and
  // ScrollHandoff (mounted once in AppShell, above this) keeps nested table scrolling
  // working because it listens at the document level.
  return (
    <div ref={ref} data-tab-pane={tabId} className="min-h-0 flex-1 overflow-auto bg-background">
      {children}
    </div>
  );
}
