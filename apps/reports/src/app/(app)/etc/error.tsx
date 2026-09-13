"use client";

// ── The Monthly ETC route's error boundary (§70) ─────────────────────────────
//
// This used to be titled "Submission rejected" for EVERY error it caught, and to advise
// "fix the value above and submit again". That was wrong for every error it has ever
// shown, and wrong in a way that sent people looking for a problem they did not have:
//
//   • A real submission failure never reaches this boundary. submitMonthlyReport returns
//     a typed failure kind and SubmitReportAction renders it INLINE in the Standard Fees
//     card (see failureExplanation) — precisely so the grid, the filters and the unsaved
//     edits survive a refusal. Nothing about submission throws up here.
//   • So what this boundary actually catches is render and data faults on /etc — a brief
//     TotalETO or Power BI hiccup, a database blip, or a stale chunk. It had already
//     misled once on exactly that: docs/GRAPH-APP-ONLY-SETUP.md records a user-triggered
//     Refresh surfacing as "Submission rejected".
//   • And there is frequently no "value above" at all: when the page fails before the
//     grid renders, the advice names a control that is not on screen.
//
// Two states now, because they need opposite actions — see lib/stale-bundle.ts for why
// `reset()` cannot fix a missing chunk and only a document reload can.
import { useEffect } from "react";
import Link from "next/link";
import { isStaleBundleError, STALE_BUNDLE_TITLE, STALE_BUNDLE_BODY } from "@/lib/stale-bundle";

export default function MonthlyEtcError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const stale = isStaleBundleError(error);

  useEffect(() => {
    // `digest` ties this to the server log line Next emits, same as the group boundary.
    console.error("Monthly ETC page error:", error);
  }, [error]);

  return (
    <div className="flex min-h-[calc(var(--app-vh)_*_0.6)] w-full items-center justify-center p-8">
      <div className="max-w-md rounded-xl border border-sdc-border bg-white p-6 text-center shadow-sm">
        <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-red-50 text-red-600">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="9" />
            <line x1="12" y1="8" x2="12" y2="13" strokeLinecap="round" />
            <line x1="12" y1="16.5" x2="12" y2="16.5" strokeLinecap="round" />
          </svg>
        </div>

        <h2 className="mb-1 text-base font-semibold text-sdc-navy">
          {stale ? STALE_BUNDLE_TITLE : "Something went wrong on Monthly ETC"}
        </h2>
        <p className="mb-4 text-sm text-sdc-gray-600">
          {stale ? (
            STALE_BUNDLE_BODY
          ) : (
            <>
              The page failed to load — often a brief hiccup talking to Power BI, TotalETO, or the database. No ETC
              values were saved or changed; any figures you had already typed are still stored as drafts.
            </>
          )}
        </p>

        <div className="flex items-center justify-center gap-2">
          {stale ? (
            // A document reload, NOT reset(): the missing chunk is missing because this
            // tab's build manifest is out of date, so re-rendering the same segment asks
            // for the same 404 again. Only a reload re-fetches the manifest.
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-lg bg-sdc-blue px-4 py-2 text-sm font-semibold text-white hover:bg-sdc-blue-dark"
            >
              Reload the page
            </button>
          ) : (
            <button
              type="button"
              onClick={reset}
              className="rounded-lg bg-sdc-blue px-4 py-2 text-sm font-semibold text-white hover:bg-sdc-blue-dark"
            >
              Try again
            </button>
          )}
          {/* Link, not <a>: a bare anchor does a full document reload, throwing away the
              router and every client-held preference on the way out of an error the user
              may well recover from. (The stale-bundle branch above WANTS that reload, so
              it uses location.reload() explicitly rather than relying on an anchor.) */}
          <Link
            href="/"
            className="rounded-lg border border-sdc-border px-4 py-2 text-sm font-semibold text-sdc-navy hover:bg-sdc-blue-light"
          >
            Go to Dashboard
          </Link>
        </div>

        {/* The raw message stays reachable — it is what makes a bug report useful — but it
            is no longer the headline, which is what made an infrastructure error read as a
            rejected submission. */}
        <p className="mt-3 break-words text-note text-sdc-gray-400">{error.message}</p>
        {error.digest && <p className="mt-1 text-note text-sdc-gray-400">Reference: {error.digest}</p>}
      </div>
    </div>
  );
}
