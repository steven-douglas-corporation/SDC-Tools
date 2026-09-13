"use client";

// React side of the motion system (§36.17). The tokens and every rule worth
// pinning live in lib/motion.ts, which is pure and tested; this file is the three
// hooks that need React and nothing else.
//
// Kept out of lib/ deliberately, matching the split the rest of this app uses:
// lib/ is importable by a node:test file, components/ is not guaranteed to be.

import { useEffect, useState, useSyncExternalStore } from "react";
import {
  FLASH_MS,
  PANEL_MS,
  mergeExiting,
  withoutLeaving,
  prefersReducedMotion,
  resolveMotionMs,
  type ExitEntry,
} from "@/lib/motion";

// ── The viewer's motion preference, as React state (§36.16) ─────────────────
//
// A module-level store rather than a hook-local listener, for the same reason the
// other browser-preference reads in this app use one (Sidebar's collapse, the KPI
// strip): reading matchMedia during render hydrates differently from the server, and
// setState-in-effect flickers for a frame and is a lint error here. One listener
// serves every subscriber, which matters because the ETC grid can mount ~1,180 of
// them.
let reducedMotionValue: boolean | null = null;
const reducedMotionListeners = new Set<() => void>();
let mediaQuery: MediaQueryList | null = null;

function reducedMotionSnapshot(): boolean {
  if (reducedMotionValue === null) reducedMotionValue = prefersReducedMotion();
  return reducedMotionValue;
}

function subscribeReducedMotion(cb: () => void): () => void {
  reducedMotionListeners.add(cb);
  if (!mediaQuery && typeof window !== "undefined" && typeof window.matchMedia === "function") {
    mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    // Live, not read-once: the preference can be changed in the OS while the app is
    // open, and this app is left open all day.
    mediaQuery.addEventListener("change", (e) => {
      reducedMotionValue = e.matches;
      for (const l of reducedMotionListeners) l();
    });
  }
  return () => reducedMotionListeners.delete(cb);
}

/**
 * True when the viewer has asked for reduced motion.
 *
 * Only needed where JavaScript has to KNOW — a timer that outlasts an exit
 * animation, say. Anything purely visual should express itself as CSS and let the
 * `prefers-reduced-motion` block in globals.css handle it, which costs no
 * JavaScript at all and cannot get out of step with the stylesheet.
 */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReducedMotion, reducedMotionSnapshot, () => false);
}

// ── "This number just changed" (§36.6, §36.8) ───────────────────────────────

/**
 * Returns true for FLASH_MS after `value` changes — the subtle highlight §36.6 asks
 * for on an updated cell and §36.8 asks for on a KPI card whose figure moved.
 *
 * Never true on first render: arriving is not changing, and a strip of six cards all
 * flashing on page load is the opposite of "draws attention to what moved".
 *
 * The caller adds a class; the animation is CSS. Under reduced motion the window
 * collapses to zero so nothing is held on, rather than the class being applied to an
 * element whose animation the stylesheet has just disabled.
 */
export function useValueFlash(value: string | number): boolean {
  const reduced = useReducedMotion();
  // Two counters rather than a boolean and a ref. The change is detected DURING
  // RENDER — set-state-during-render is the supported way to derive state from a prop,
  // and the same pattern useDraftParamMenu and usePendingWatchdog already use here —
  // because detecting it in an effect would mean a synchronous setState in an effect
  // body, which this repo's lint rules reject (correctly: it cascades a render).
  //
  // A counter pair also fixes something a boolean could not. When the value moves
  // AGAIN inside the flash window, `version` increments, so the effect below sees a new
  // dependency, cancels the in-flight timer and arms a fresh one — the highlight
  // restarts rather than ending early on the first change's clock.
  const [seen, setSeen] = useState(value);
  const [version, setVersion] = useState(0);
  const [cleared, setCleared] = useState(0);

  if (seen !== value) {
    setSeen(value);
    // Reduced motion never starts one, rather than starting one whose animation the
    // stylesheet has disabled — see resolveMotionMs.
    if (resolveMotionMs(FLASH_MS, reduced) > 0) setVersion((n) => n + 1);
  }

  useEffect(() => {
    if (version === cleared) return;
    // setState inside the timer callback, not in the effect body: this is the
    // "subscribe and call setState when something outside React changes" shape the
    // rule exists to allow.
    const t = window.setTimeout(() => setCleared(version), FLASH_MS);
    return () => window.clearTimeout(t);
  }, [version, cleared]);

  return version !== cleared;
}

// ── Lists whose removals get to animate out (§36.13) ────────────────────────

/**
 * The list to render, with departed items still in it and marked `leaving`.
 *
 * Used by the toast stack and the change-notification banner, which are the two
 * places in this app where something appears and disappears on its own schedule.
 * The merge rules (a departure holds its position; a re-arrival cancels its exit)
 * are in lib/motion.ts and tested there.
 *
 * `exitMs` defaults to PANEL_MS because that is the band §36.2 puts notification
 * banners in — the timer and the CSS animation are then the same number by
 * construction, so an item can never be dropped mid-fade or linger after it.
 */
export function useExitList<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  exitMs: number = PANEL_MS,
): ExitEntry<T>[] {
  const reduced = useReducedMotion();
  const [entries, setEntries] = useState<ExitEntry<T>[]>(() =>
    items.map((item) => ({ key: keyOf(item), item, leaving: false })),
  );

  // Derived from props during render — the supported way, and deliberately not an
  // effect: an effect would render one frame with the OLD list, which for a toast
  // that has just been dismissed means a visible frame of it still sitting there
  // un-faded. `mergeExiting` is pure, so calling it here is safe on a render React
  // discards.
  const merged = reduced
    ? items.map((item) => ({ key: keyOf(item), item, leaving: false }))
    : mergeExiting(items, keyOf, entries);
  const mergedKey = merged.map((e) => `${e.key}:${e.leaving ? "1" : "0"}`).join("|");
  const seenKey = entries.map((e) => `${e.key}:${e.leaving ? "1" : "0"}`).join("|");
  if (mergedKey !== seenKey) setEntries(merged);

  // Keyed on WHICH items are leaving, not on the array's identity. A new toast
  // arriving while another fades produces a fresh `entries` array, and depending on
  // that would restart this timer — so the fading one would sit there for as long as
  // people kept adding toasts (§36.13: "avoid excessive animations when many users
  // edit simultaneously" cuts both ways — an item must also finish leaving).
  const leavingKey = merged
    .filter((e) => e.leaving)
    .map((e) => e.key)
    .join("|");
  useEffect(() => {
    if (leavingKey === "") return;
    const t = window.setTimeout(() => setEntries((cur) => withoutLeaving(cur)), exitMs);
    return () => window.clearTimeout(t);
  }, [leavingKey, exitMs]);

  return merged;
}
