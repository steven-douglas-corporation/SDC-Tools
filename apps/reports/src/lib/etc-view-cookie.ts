// The Monthly ETC grid's remembered view — which blocks and columns this browser last
// had hidden — kept in a cookie so the SERVER can render it.
//
// ── Why a cookie and not localStorage ───────────────────────────────────────
//
// The same reason the sidebar's collapsed state is one (lib/sidebar-prefs.ts): the grid
// is server-rendered with its hidden columns already applied, and localStorage is
// invisible to the server. A PM who keeps Parts Cost only would otherwise get the full
// 13-section grid on first paint and watch it collapse once React hydrated — the flash
// the instant-view mechanism (lib/grid-view.ts) exists to avoid.
//
// ── What is stored, and what wins ───────────────────────────────────────────
//
// The value is the view's own query string (`dept=none&jobname=0`), so the page parses it
// with the same function as a URL (hiddenFromEtcParams) and there is one format to keep
// right instead of two. Nothing hidden = no cookie at all.
//
// An EXPLICIT view in the URL always wins: a shared link or a bookmark opens what it says,
// and only a visit with none of the three view params falls back to this cookie. Merely
// opening a shared link does not overwrite the cookie — it is written when the hidden set
// changes, not when the page loads.
//
// Per browser by design: a PM who also opens the app in another browser starts from the
// full grid there. Not httpOnly, like the other display cookies — it holds three view
// toggles and nothing a forged value could exploit (a bad value parses to the full grid).
//
// No `server-only` marker: the page (server) reads it and GridViewProvider's owner
// (client) writes it, so this module has to load on both sides.

import { etcViewWriteParams, type EtcViewParams } from "@/lib/etc-view";
import type { ViewKey } from "@/lib/grid-view";

export const ETC_VIEW_COOKIE = "sdc-etc-view";

// One year, like the sidebar prefs: a display preference should outlive a session.
const MAX_AGE = 60 * 60 * 24 * 365;

/** The cookie value for a hidden set: its query string, "" when nothing is hidden. */
export function etcViewCookieValue(hidden: ReadonlySet<ViewKey>): string {
  const qs = new URLSearchParams();
  etcViewWriteParams(hidden, qs);
  return qs.toString();
}

/**
 * The view params a cookie value describes. Takes the raw string so the server (from
 * `cookies()`) and the tests share it; anything unreadable degrades to no params, which
 * the page reads as the full grid.
 */
export function parseEtcViewCookie(raw: string | null | undefined): EtcViewParams {
  if (!raw) return {};
  let text = raw;
  if (text.includes("%")) {
    try {
      text = decodeURIComponent(text);
    } catch {
      return {};
    }
  }
  const qs = new URLSearchParams(text);
  return {
    dept: qs.get("dept") ?? undefined,
    jobname: qs.get("jobname") ?? undefined,
    parts: qs.get("parts") ?? undefined,
  };
}

/** True when the URL carries any of the view params, i.e. it is an explicit view. */
export function hasExplicitEtcView(p: EtcViewParams): boolean {
  return p.dept !== undefined || p.jobname !== undefined || p.parts !== undefined;
}

/** Browser side: remember this hidden set, or forget it when nothing is hidden. */
export function writeEtcViewCookie(hidden: ReadonlySet<ViewKey>): void {
  if (typeof document === "undefined") return;
  const value = etcViewCookieValue(hidden);
  // `SameSite=Lax`, no `Secure`: the app is served over plain HTTP on the LAN, where a
  // Secure cookie would simply never be stored (same note as lib/sidebar-prefs.ts).
  document.cookie = value
    ? `${ETC_VIEW_COOKIE}=${encodeURIComponent(value)}; Path=/; Max-Age=${MAX_AGE}; SameSite=Lax`
    : `${ETC_VIEW_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
}
