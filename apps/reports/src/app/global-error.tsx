"use client";

// ── The last-resort boundary. This is what makes a blank white screen impossible ──
//
// Reported 2026-08-24: "users are intermittently getting a completely blank/white
// screen; the only workaround is closing the window and reopening it."
//
// (app)/error.tsx already existed and is good — but a segment's error.tsx wraps that
// segment's CHILDREN, never its own layout. So an error thrown in (app)/layout.tsx
// (which is where `await auth()` runs) propagates PAST it to the parent segment, i.e.
// the root app/layout.tsx — and there was no boundary there at all. Next.js's
// documented answer for "the root layout threw" is this file; without it, React
// unmounts the whole tree and the browser is left showing nothing. That is the blank
// screen, and it is why reopening the window "fixed" it: a fresh request re-ran the
// layout, and whatever transient DB/auth failure caused the throw had passed.
//
// Two rules this file has to obey, both easy to get wrong:
//
//   1. It REPLACES the root layout when it renders, so it must supply its own
//      <html> and <body>. Nothing from app/layout.tsx (fonts, SessionProvider) is
//      present here.
//   2. Styling is INLINE, not Tailwind. A stale/failed CSS chunk is one of the
//      things that lands a user here (see lib/stale-bundle.ts), and a boundary that
//      needs a stylesheet to be legible would render as unstyled text — or as
//      nothing — in exactly the case it exists for. Inline styles cannot fail that
//      way. This is the one file in the app where that trade is correct.
//
// Recovery, not just an apology: a stale bundle needs a document reload (reset()
// re-requests the same missing chunk — see lib/stale-bundle.ts), while a transient
// server-side failure is usually gone by the next attempt. So this offers the right
// action for the case, and both are in-page. Nobody has to close the app.

import { useEffect } from "react";
import { isStaleBundleError, STALE_BUNDLE_TITLE, STALE_BUNDLE_BODY } from "@/lib/stale-bundle";

const NAVY = "#061d39";
const BLUE = "#1574c4";
const BLUE_DARK = "#0f5a95";
const BORDER = "#d9d9d9";
const GRAY = "#2b2b2b";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const stale = isStaleBundleError(error);

  useEffect(() => {
    // The only record that this happened on the client. `digest` ties it to the
    // server-side log line Next emits for the same failure.
    console.error("Fatal application error (global-error boundary):", error);
  }, [error]);

  return (
    <html lang="en">
      {/* `position: fixed; inset: 0` rather than a height in viewport units.
          globals.css applies `zoom: var(--app-zoom)` to <html> and exposes
          --app-vh to divide the zoom back out, because `zoom` scales `vh` while
          the viewport itself does not — but neither the zoom nor that variable
          exists in this file, which renders its own <html> without the theme.
          Raw `100vh` would happen to be right here and wrong everywhere else,
          so this sidesteps the unit altogether and stays inside the rule
          tests/app-zoom.test.ts enforces. */}
      <body
        style={{
          margin: 0,
          position: "fixed",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "auto",
          background: "#f5f6f8",
          padding: "2rem",
          // The SYSTEM stack, deliberately — not the brand family. This file
          // renders its own <html>, so next/font's generated --font-montserrat
          // variable (set by app/layout.tsx's className) does not exist here,
          // and naming "Montserrat" literally would resolve to whatever happens
          // to be installed on the machine or silently fall back — the exact
          // drift tests/typography.test.ts exists to prevent. A last-resort
          // error card is the one place where the system font is the right
          // answer: it always renders, which is the whole point of this file.
          fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
          color: GRAY,
        }}
      >
        <div
          style={{
            maxWidth: "30rem",
            width: "100%",
            background: "#fff",
            border: `1px solid ${BORDER}`,
            borderRadius: "0.75rem",
            padding: "1.75rem",
            textAlign: "center",
            boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
          }}
        >
          <h1 style={{ margin: "0 0 0.5rem", fontSize: "1.0625rem", fontWeight: 600, color: NAVY }}>
            {stale ? STALE_BUNDLE_TITLE : "SDC Projects Reports could not start"}
          </h1>
          <p style={{ margin: "0 0 1.25rem", fontSize: "0.875rem", lineHeight: 1.55 }}>
            {stale
              ? STALE_BUNDLE_BODY
              : "The application hit an unexpected error while loading. Nothing was saved or changed. " +
                "This is usually temporary — try again, and if it keeps happening send the reference below to IT."}
          </p>
          <div style={{ display: "flex", gap: "0.5rem", justifyContent: "center", flexWrap: "wrap" }}>
            {/* A stale bundle needs a real document reload; reset() would re-request
                the same missing chunk and land straight back here. */}
            <button
              type="button"
              onClick={stale ? () => window.location.reload() : reset}
              style={{
                background: BLUE,
                color: "#fff",
                border: "none",
                borderRadius: "0.5rem",
                padding: "0.5rem 1rem",
                fontSize: "0.875rem",
                fontWeight: 600,
                cursor: "pointer",
              }}
              onMouseOver={(e) => (e.currentTarget.style.background = BLUE_DARK)}
              onMouseOut={(e) => (e.currentTarget.style.background = BLUE)}
            >
              {stale ? "Reload the page" : "Try again"}
            </button>
            {/* Deliberately a full document load, unlike (app)/error.tsx's <Link>:
                by the time this boundary renders the root layout has been torn
                down and the router may itself be part of what failed, so this
                must not depend on it. A <Link> here could render nothing at all
                — which is the blank screen this file exists to prevent. This is
                the one place the no-html-link-for-pages rule is wrong, and it is
                what Next's own global-error documentation does. */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a
              href="/"
              style={{
                display: "inline-block",
                border: `1px solid ${BORDER}`,
                borderRadius: "0.5rem",
                padding: "0.5rem 1rem",
                fontSize: "0.875rem",
                fontWeight: 600,
                color: NAVY,
                textDecoration: "none",
              }}
            >
              Start over
            </a>
          </div>
          {error.digest && (
            <p style={{ margin: "0.875rem 0 0", fontSize: "0.75rem", color: "#8a8a8a" }}>
              Reference: {error.digest}
            </p>
          )}
        </div>
      </body>
    </html>
  );
}
