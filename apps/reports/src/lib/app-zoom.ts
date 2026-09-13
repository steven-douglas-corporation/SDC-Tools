// The application's ONE size control (§45).
//
// ── What it replaced ────────────────────────────────────────────────────────
//
// Six controls, in four places, each owning its own state, its own localStorage
// key and its own idea of what "bigger" meant:
//
//   • Sidebar   "Text size"    -> root font-size, 12–20px      (AppTextSize)
//   • ETC View  "Font size"    -> --etc-font-size, 4–24px      (EtcViewMenu)
//   • ETC View  "Row height"   -> --etc-row-py,    0–16px      (EtcViewMenu)
//   • ETC View  "Column width" -> --etc-col-px,    0–16px      (EtcViewMenu)
//   • Projects  "Row height"   -> --quoted-row-py, 0–16px      (GridZoomControls)
//   • Projects  "Column width" -> --quoted-col-px, 0–16px      (GridZoomControls)
//
// Six independent axes is 6 × 9 × 9 × 21 × 9 × 9 reachable combinations, of which
// exactly one is the design. They could also disagree ACROSS TABS — Monthly ETC at
// one density, Projects at another — which is the thing §45 names outright. And the
// root font-size only ever reached what was written in rem, so the sidebar, the
// toolbars and every fixed-px chrome element sat still while the grids grew: half a
// control, dressed as a whole one.
//
// ── Why CSS `zoom` and not the root font-size ───────────────────────────────
//
// `zoom` scales the used value of every length — padding, borders, icons, widths,
// gaps, images — not just the ones that happen to be expressed in rem. That is what
// makes this a single lever over "all visible application content" rather than a
// text-size control with a longer list of exceptions.
//
// It is also the only option that keeps the tables intact. `transform: scale()`
// scales pixels AFTER layout: sticky headers and frozen columns stop sticking to the
// right place, scroll containers keep their unscaled scrollHeight and hit-testing
// drifts from what you see. `zoom` participates in layout, so a frozen column and
// the cells beside it are laid out at the same scale and cannot misalign — verified
// live at every step (see the DEVLOG section for §45).
//
// ── The one thing `zoom` does NOT compensate: viewport units ────────────────
//
// Measured in Chrome before writing any of this: with `zoom: 1.25` on <html>, a
// `height: 100vh` element renders 900 physical px against a 720px viewport. `vh`
// resolves against the unzoomed viewport and is then scaled with everything else,
// so the sidebar would have hung a quarter of a screen below the fold.
//
// Hence --app-vh / --app-vw in globals.css, which divide the viewport unit back out
// by the zoom factor. Every viewport-relative length in the app reads those instead
// of `vh`/`vw`; tests/app-zoom.test.ts fails the build if a new one doesn't.
// (`position: fixed` needs no such help — that was measured too: a fixed inset-0
// overlay covers the viewport exactly at every zoom level.)

/**
 * The offered levels, smallest first: 50/60/70/80/90/100, an even 10% grid. The
 * first and last entries ARE the limits — `snapZoom` cannot return anything outside
 * the list, so there is no separate MIN/MAX to keep in step.
 *
 * ── Why the range moved down (2026-09-02) ─────────────────────────────────
 *
 * The original list was 75/80/90/100/110/125/150, built around 100% as the design
 * size with room to magnify. In practice this application is used the other way
 * round: the grids, the Job Hour Details chart and the ETC matrix are all wide, and
 * what people reach for is "fit more on the screen", not "make it bigger". Nothing
 * above 100% was earning its place, and the uneven 5/10/15/25% gaps meant the
 * stepper's travel per click changed depending where you were on the list.
 *
 * So: one even 10% step throughout, nothing above 100% (the browser's own Ctrl+
 * still magnifies, and composes with this), and a 50% floor — the smallest level
 * the sidebar control itself stays comfortably clickable at.
 */
// `readonly number[]`, not `as const`: every function below does arithmetic and
// index lookups on these, and a tuple of literal types turns each of those into a
// cast. The list being fixed is what the `readonly` says; the exact values are not
// something any caller should be typed against.
export const ZOOM_STEPS: readonly number[] = [0.5, 0.6, 0.7, 0.8, 0.9, 1];

/**
 * 80%, not 100% — the level this app is actually laid out to be read at, so a new
 * user lands on the fitted view rather than having to discover the control. It is a
 * member of ZOOM_STEPS, which matters: stepping away from a default that is not on
 * the list and back again would be impossible, since snapZoom would round it to a
 * neighbour first.
 */
export const DEFAULT_ZOOM = 0.8;
export const MIN_ZOOM = ZOOM_STEPS[0];
export const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1];

/** The custom property `html { zoom: … }` reads. Also written by the pre-paint script in layout.tsx. */
export const ZOOM_VAR = "--app-zoom";
/** localStorage key. Versioned so a future change of units can't be misread as a zoom factor. */
export const ZOOM_KEY = "sdc-app-zoom-v1";
const EVENT = "sdc-app-zoom-change";

/**
 * Nearest offered level. Anything unusable — NaN, a hand-edited localStorage value,
 * a level retired in a later release — lands on the default rather than throwing or
 * rendering the app at 4%.
 */
export function snapZoom(value: unknown): number {
  const n = typeof value === "number" ? value : parseFloat(String(value));
  if (!Number.isFinite(n)) return DEFAULT_ZOOM;
  // Compared in WHOLE PERCENT, not in the raw factors, because the distances that
  // decide a tie are not representable in binary floating point: for a saved 0.75,
  // `Math.abs(0.7 - 0.75)` is 0.049999999999999996 while `Math.abs(0.8 - 0.75)` is
  // 0.05000000000000004, so the exact midpoint between two 10% steps silently
  // resolves DOWNWARD and a retired 75% would land on 70%. In percent those are 5
  // and 5, a real tie — and `<=` then breaks it upward, since the list ascends. That
  // is the documented normalization: 75 -> 80, 85 -> 90, 110 -> 100, 40 -> 50.
  const pct = n * 100;
  let best = ZOOM_STEPS[0];
  for (const step of ZOOM_STEPS) {
    if (Math.abs(Math.round(step * 100) - pct) <= Math.abs(Math.round(best * 100) - pct)) best = step;
  }
  return best;
}

/**
 * One step out (`-1`) or in (`+1`), clamped at the ends of the list.
 *
 * Index-based rather than arithmetic. The list happens to be an even 10% grid now,
 * so `current ± 0.1` would give the same answers — but the list is the definition of
 * what is offered, and walking it by index keeps that true if it ever stops being
 * evenly spaced again.
 */
export function stepZoom(current: number, delta: -1 | 1): number {
  const from = ZOOM_STEPS.indexOf(snapZoom(current));
  const next = Math.min(ZOOM_STEPS.length - 1, Math.max(0, from + delta));
  return ZOOM_STEPS[next];
}

export function isMinZoom(z: number): boolean {
  return snapZoom(z) === MIN_ZOOM;
}
export function isMaxZoom(z: number): boolean {
  return snapZoom(z) === MAX_ZOOM;
}

/** "80%" — every step is a whole percentage, so no rounding decisions leak into the UI. */
export function zoomLabel(z: number): string {
  return `${Math.round(snapZoom(z) * 100)}%`;
}

// ── Reading and writing ─────────────────────────────────────────────────────
//
// Same external-store shape as lib/nav-order.ts, for the same reason: the value
// lives in localStorage, which the server cannot see, so a component reads it
// through useSyncExternalStore with a server snapshot of the default. Reading
// storage in render would hydrate differently from the server; a mount effect would
// paint one frame at the wrong size.

export function readZoom(): number {
  if (typeof window === "undefined") return DEFAULT_ZOOM;
  try {
    const raw = window.localStorage.getItem(ZOOM_KEY);
    return raw == null ? DEFAULT_ZOOM : snapZoom(raw);
  } catch {
    return DEFAULT_ZOOM; // storage blocked (private modes) — the app is not worth a blank page
  }
}

export function serverZoom(): number {
  return DEFAULT_ZOOM;
}

/**
 * The level that is ON SCREEN right now, read off the document rather than out of a
 * React closure.
 *
 * This is what the two stepper buttons step FROM, and the reason is a real bug class:
 * a handler closed over `useSyncExternalStore`'s value holds whatever the last render
 * saw, so two clicks landing before React re-renders would both compute
 * `stepZoom(sameValue, +1)` and the second would be swallowed — a `+` that ignores
 * every other press when clicked quickly. The applied custom property cannot go stale,
 * because setting it IS the operation.
 *
 * The same reasoning the retired grid-density steppers used, kept for the same reason:
 * "the CSS variable itself is the only source of truth, read straight off the DOM on
 * every click, so there's nothing to fall out of sync."
 */
export function currentZoom(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(ZOOM_VAR).trim();
  // Empty only if the stylesheet has not applied yet, in which case the stored value is
  // what the pre-paint script was about to write anyway.
  return raw ? snapZoom(raw) : readZoom();
}

/**
 * Put a zoom level on screen.
 *
 * This is the whole implementation of "apply it immediately": one custom property on
 * <html>, which `html { zoom: var(--app-zoom) }` and the two viewport vars all read.
 * No React state, no re-render, no request, no reload — the style recalculation is
 * the browser's, and every table cell, card and modal in the document participates
 * without being told.
 */
export function applyZoom(z: number): void {
  document.documentElement.style.setProperty(ZOOM_VAR, String(snapZoom(z)));
}

/** Apply, persist, and tell the control(s) on screen. */
export function writeZoom(z: number): void {
  const next = snapZoom(z);
  applyZoom(next);
  try {
    window.localStorage.setItem(ZOOM_KEY, String(next));
  } catch {
    /* not persisted; the zoom is still applied for this session */
  }
  // localStorage doesn't notify the tab that wrote it, hence the explicit event.
  window.dispatchEvent(new Event(EVENT));
}

/** `storage` covers the same app open in another tab, so both agree on one zoom. */
export function subscribeZoom(onChange: () => void): () => void {
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}
