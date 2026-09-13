// Which milestone chips are on, and the month range — per person, in the browser.
//
// Same shape as lib/app-zoom.ts and lib/kpi-strip-pref.ts: a tiny external store
// read through useSyncExternalStore rather than restored with a setState in an
// effect. The reason is the one AppZoom's own header gives — localStorage is
// invisible to the server, so reading it in render hydrates differently from the
// HTML, and restoring it in an effect shows the default for a frame on every
// page load (and trips react-hooks/set-state-in-effect).
//
// Kept out of the URL deliberately: the Dashboard's query string is shareable,
// and one person's chip selection has no business travelling into a colleague's
// link.

export const KEY_DATES_ANCHOR_KEY = "sdcKeyDatesAnchors";
export const KEY_DATES_FROM_KEY = "sdcKeyDatesFrom";
export const KEY_DATES_TO_KEY = "sdcKeyDatesTo";
const EVENT = "sdc-key-dates-change";

export type KeyDatesPrefs = { anchors: string[]; from: string; to: string };

/**
 * Server snapshot. Referentially stable — a fresh object here makes
 * useSyncExternalStore re-render forever.
 *
 * The range is "" rather than a real month on purpose: the opening window is
 * whatever the server rendered with, and the component fills it in. Baking a
 * default date in here would mean two places deciding what "this month" is.
 */
const serverSnapshot: KeyDatesPrefs = { anchors: ["mech_release_1"], from: "", to: "" };
let clientSnapshot: KeyDatesPrefs = serverSnapshot;

export function subscribeKeyDates(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(EVENT, onChange);
  // Another tab changing the same preference should move this one too.
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

function readRaw(): KeyDatesPrefs {
  const fallback = serverSnapshot;
  try {
    const rawAnchors = window.localStorage.getItem(KEY_DATES_ANCHOR_KEY);
    const parsed: unknown = rawAnchors ? JSON.parse(rawAnchors) : null;
    const anchors =
      Array.isArray(parsed) && parsed.every((x) => typeof x === "string") && parsed.length > 0
        ? (parsed as string[])
        : fallback.anchors;
    const from = window.localStorage.getItem(KEY_DATES_FROM_KEY);
    const to = window.localStorage.getItem(KEY_DATES_TO_KEY);
    return {
      anchors,
      from: from && /^\d{4}-\d{2}$/.test(from) ? from : fallback.from,
      to: to && /^\d{4}-\d{2}$/.test(to) ? to : fallback.to,
    };
  } catch {
    // A browser refusing storage (private window, blocked site data) must not
    // stop the timeline rendering — it just does not remember the selection.
    return fallback;
  }
}

/** Cached so repeated reads return the SAME object; a fresh one each call makes React loop. */
export function readKeyDates(): KeyDatesPrefs {
  if (typeof window === "undefined") return serverSnapshot;
  const next = readRaw();
  const same =
    next.from === clientSnapshot.from &&
    next.to === clientSnapshot.to &&
    next.anchors.length === clientSnapshot.anchors.length &&
    next.anchors.every((a, i) => a === clientSnapshot.anchors[i]);
  if (!same) clientSnapshot = next;
  return clientSnapshot;
}

export function serverKeyDates(): KeyDatesPrefs {
  return serverSnapshot;
}

export function writeKeyDates(next: KeyDatesPrefs): void {
  try {
    window.localStorage.setItem(KEY_DATES_ANCHOR_KEY, JSON.stringify(next.anchors));
    window.localStorage.setItem(KEY_DATES_FROM_KEY, next.from);
    window.localStorage.setItem(KEY_DATES_TO_KEY, next.to);
  } catch {
    /* not remembering the choice is survivable; not applying it is not */
  }
  clientSnapshot = next;
  window.dispatchEvent(new Event(EVENT));
}
