"use client";

import { useState } from "react";

// ── "App Refresh" — reload the FRONTEND, stay exactly where you are ──────────
//
// The second of the two refreshes in the sidebar, and the distinction is the
// whole point of it existing separately:
//
//   Refresh Data  — runs the application-wide data pass (Paylocity, Total ETO,
//                   ETC, pools). Changes what the numbers ARE. Slow, server-side.
//   App Refresh   — reloads the page this tab is running. Changes nothing about
//                   the data; it replaces a tab that is holding stale JavaScript.
//
// They are deliberately not merged: one costs 20 seconds of upstream calls and
// moves figures for everybody, the other is a local, instant, read-only recovery.
//
// ── What this actually does, precisely ──────────────────────────────────────
//
// `window.location.reload()`. That is the entire mechanism, and it is the right
// one — it is already what all four of this app's error boundaries call when
// they detect a stale bundle (see lib/stale-bundle.ts, app/(app)/error.tsx,
// app/global-error.tsx, TmDrillErrorBoundary).
//
// It preserves the route, the query string and the hash by construction: reload
// re-requests the CURRENT location. Nothing here navigates, so there is no path
// by which this can land on the Dashboard.
//
// ── What it deliberately does NOT do ────────────────────────────────────────
//
// It does not clear localStorage, sessionStorage or cookies, and that is a
// decision rather than an omission:
//
//   • cookies carry the next-auth session (clearing them signs the user out) and
//     the remembered Job Hour Details selection (lib/job-hours-selection.ts) —
//     which is exactly what makes 1105 still be 1105 after this button, rendered
//     server-side on the first frame with no default-job flash.
//   • sessionStorage carries this TAB's realtime identity, documented in
//     RealtimeProvider as "survives a reload so a refresh reclaims its own
//     presence rather than orphaning it". Clearing it would leave a ghost editor
//     indicator on other people's screens.
//   • localStorage carries saved views, the app zoom and the sidebar state — user
//     preferences the request explicitly asks to keep.
//
// So this is not a "clear browser storage" button. Nothing a person saved is
// touched.
//
// ── On "hard" refresh ───────────────────────────────────────────────────────
//
// There is no JavaScript equivalent of Ctrl+Shift+R. `location.reload(true)` has
// been ignored by every current browser for years, and a page cannot instruct the
// browser to bypass its own HTTP cache. Pretending otherwise would be the
// theatre this was explicitly asked not to be.
//
// It does not need to be. The staleness this app actually suffers is a tab
// holding a build manifest that names chunks the server has replaced (§70) — and
// a plain reload re-fetches the document and that manifest, which is the fix.
// The chunks themselves are content-hashed, so a new build has new URLs and the
// browser cache cannot serve a stale one. There is no service worker and no
// Cache Storage entry in this app to invalidate; clearing them would be a no-op
// written to look thorough.

export function AppRefreshButton({ compact = false, className = "" }: { compact?: boolean; className?: string }) {
  // Local, and never reset: the reload is the unmount. It exists so the button
  // acknowledges the click during the moment before the document is replaced,
  // which on a slow first paint is long enough to be worth showing.
  const [reloading, setReloading] = useState(false);

  return (
    <button
      type="button"
      disabled={reloading}
      onClick={() => {
        setReloading(true);
        // Re-requests the CURRENT location — route, query and hash intact.
        window.location.reload();
      }}
      title={
        "App Refresh — reloads the Reports App while keeping your current page and selections. " +
        "Use it if the screen looks stale or a control has stopped responding. It does not change any data."
      }
      aria-label="App Refresh"
      className={className}
    >
      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
        {/* ── An app WINDOW being reloaded, not a bare circular arrow ──────────
            Refresh Data's glyph is already a circular arrow with an arrowhead
            (RefreshDataButton, same 16-box). Reusing that shape here made the two
            buttons indistinguishable in the collapsed rail, where the labels are
            gone and the icon is all there is — the "one button twice" the sidebar
            notes warn about. This is a window with a reload arrow inside it: the
            thing being refreshed is the APP, which is exactly the distinction. */}
        <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
          <rect x="1.6" y="2.4" width="12.8" height="11.2" rx="1.6" />
          <path d="M1.6 5.4 H14.4" />
          <path d="M11 9.9a3 3 0 1 1-.9-2.1" strokeLinecap="round" />
          <path d="M11.2 6.6v1.9H9.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      {!compact && <span className="whitespace-nowrap">{reloading ? "Refreshing…" : "App Refresh"}</span>}
    </button>
  );
}
