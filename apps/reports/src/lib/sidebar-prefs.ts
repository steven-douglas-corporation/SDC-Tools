// The sidebar's two display preferences — collapsed, and (when expanded) its
// drag-resized width — in COOKIES rather than localStorage (§46.14).
//
// ── Why cookies, when every other display preference here is localStorage ────
//
// Because this one changes the SERVER'S HTML, and localStorage is invisible to the
// server. Measured before changing anything: with the collapse flag set, a request
// for /etc came back with
//
//     <aside style="width:276px" class="… ">   ← expanded
//
// plus every nav label, the search field and the version string. So the first paint
// of every page load was the FULL sidebar, which then snapped to the 60px rail once
// React hydrated and the store read localStorage. §46.14 forbids exactly that ("do
// not briefly expand it during route transitions"), and no amount of care inside the
// component can fix it: the flash happens before any of it runs.
//
// §45's zoom preference stayed in localStorage on the reasoning that a cookie "costs
// a cookie on every request". That reasoning does not transfer, for two reasons.
// Zoom is applied by a pre-paint script writing one CSS custom property, so the
// server never needs to know it — the HTML is identical at every level. And the
// (app) layout already awaits auth(), which reads cookies and is what makes every
// route under it dynamic, so reading two more cookies there costs nothing that
// isn't already being paid.
//
// The trade is honest and worth stating: these two preferences are now per-BROWSER
// (as before) but travel on requests. They contain a boolean and a pixel count.

export const COLLAPSED_COOKIE = "sdc-sidebar-collapsed";
export const WIDTH_COOKIE = "sdc-sidebar-width";

/** The expanded default — the "Porcelain" design's sidebar width. */
export const DEFAULT_WIDTH = 276;
export const MIN_WIDTH = 180;
export const MAX_WIDTH = 420;

/**
 * The ONE collapsed width (§46.1: "use one consistent compact width"), in rem so it
 * scales with the type scale, and stated here rather than as a `w-16` class so the
 * server, the aside and the `--sidebar-w` variable cannot disagree about it.
 *
 * 4rem = 60px at the 15px root. That is what the rail already measured, so nothing
 * about the collapsed geometry moves — what changes is that a 15px nav icon in a
 * 60px rail is now CENTRED in it (see Sidebar), which it was not.
 */
export const COLLAPSED_WIDTH = "4rem";

export function clampWidth(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_WIDTH;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(n)));
}

export type SidebarPrefs = { collapsed: boolean; width: number };

export const DEFAULT_PREFS: SidebarPrefs = { collapsed: false, width: DEFAULT_WIDTH };

/**
 * Parse both preferences out of raw cookie values.
 *
 * Takes strings rather than a cookie store so the same rules run on the server (from
 * `cookies()`) and on the client (from `document.cookie`) — one parser, so a
 * hand-edited or stale cookie degrades to the default in both places identically.
 * That matters more than it sounds: if the two disagreed, the value React hydrated
 * with would differ from the value the server rendered, which is the flash this
 * module exists to remove.
 */
export function parseSidebarPrefs(collapsedRaw?: string | null, widthRaw?: string | null): SidebarPrefs {
  return {
    collapsed: collapsedRaw === "1",
    width: widthRaw == null || widthRaw === "" ? DEFAULT_WIDTH : clampWidth(Number(widthRaw)),
  };
}

/** The width the layout should reserve — the collapsed rail, or the chosen width. */
export function sidebarWidthCss(prefs: SidebarPrefs): string {
  return prefs.collapsed ? COLLAPSED_WIDTH : `${clampWidth(prefs.width)}px`;
}

// ── Client side ─────────────────────────────────────────────────────────────
//
// Same external-store shape as lib/nav-order.ts and lib/app-zoom.ts. The cookie is
// the single source of truth on both sides; there is no second copy in localStorage
// to drift out of step with it.

const EVENT = "sdc-sidebar-change";
// One year. A display preference should outlive a session but not a reinstall.
const MAX_AGE = 60 * 60 * 24 * 365;

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  for (const part of document.cookie.split("; ")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq) === name) return decodeURIComponent(part.slice(eq + 1));
  }
  return null;
}

function writeCookie(name: string, value: string): void {
  // `SameSite=Lax` so it is not sent on cross-site requests; no `Secure` because this
  // app is served over plain HTTP on the LAN (see the deployment note) and a Secure
  // cookie would simply never be stored.
  document.cookie = `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${MAX_AGE}; SameSite=Lax`;
}

/**
 * Read the collapse flag on the client.
 *
 * Returns a primitive, which useSyncExternalStore requires: it compares snapshots
 * with Object.is, so a fresh object each read would re-render forever.
 */
export function readCollapsed(): boolean {
  return readCookie(COLLAPSED_COOKIE) === "1";
}

export function readWidth(): number {
  const raw = readCookie(WIDTH_COOKIE);
  return raw == null || raw === "" ? DEFAULT_WIDTH : clampWidth(Number(raw));
}

export function writeCollapsed(next: boolean): void {
  writeCookie(COLLAPSED_COOKIE, next ? "1" : "0");
  window.dispatchEvent(new Event(EVENT));
}

export function writeWidth(next: number): void {
  writeCookie(WIDTH_COOKIE, String(clampWidth(next)));
  window.dispatchEvent(new Event(EVENT));
}

/**
 * `storage` is deliberately NOT listened for: cookies do not raise it. The explicit
 * event covers this tab, and another tab picks the new value up on its next
 * navigation — which is the same behaviour the localStorage version had in practice,
 * because nothing re-read it either.
 */
export function subscribeSidebar(onChange: () => void): () => void {
  window.addEventListener(EVENT, onChange);
  return () => window.removeEventListener(EVENT, onChange);
}
