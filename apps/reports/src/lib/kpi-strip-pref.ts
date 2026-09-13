"use client";

// Whether the Monthly ETC summary strip is showing. Per browser, like the grid's
// other display preferences — six cards is a real amount of vertical space on a
// laptop, and someone who never reads them should be able to put them away for
// good rather than scrolling past them every day.
const KEY = "etc-kpi-strip-open";
const EVENT = "etc-kpi-strip-change";

export function readKpiStripOpen(): boolean {
  try {
    // Default OPEN: the cards are useful, and a summary that hides itself on first
    // visit is a summary nobody discovers.
    return window.localStorage.getItem(KEY) !== "0";
  } catch {
    return true;
  }
}

export function writeKpiStripOpen(open: boolean): void {
  try {
    window.localStorage.setItem(KEY, open ? "1" : "0");
  } catch {
    return;
  }
  window.dispatchEvent(new Event(EVENT));
}

export function subscribeKpiStrip(onChange: () => void): () => void {
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}
