"use client";

import { Component, type ReactNode } from "react";
import { isStaleBundleError, STALE_BUNDLE_TITLE, STALE_BUNDLE_BODY } from "@/lib/stale-bundle";

// ── The T&M drill-through must not be able to crash the whole page ─────────
//
// Reported: clicking "Detail" on any T&M KPI showed the group-level
// `(app)/error.tsx` card — the entire route replaced, filters and KPI values
// gone, sidebar the only thing left. Every DATA-FETCH failure in this flow was
// already contained (TmReportClient's `sequenced()` call catches a rejected
// server action and sets `drillError`, rendered inside the panel) — so a crash
// reaching the ROUTE boundary could only be a RENDER-time throw somewhere in
// the drawer's own content, which no try/catch around an async call can ever
// catch. An Error Boundary is the one React mechanism that does: this is the
// first one in the codebase (see src/lib/stale-bundle.ts's own header for the
// two existing boundaries this composes with).
//
// Scoped to just the drawer's CONTENT — BuildReadinessDrawer's own header
// (title, subtitle, Close button) renders OUTSIDE this boundary in
// TmReportClient.tsx, so even a caught crash still leaves Close reachable and
// the T&M page underneath completely unaffected.
//
// Remounted (via a `key` tied to the open drill) whenever the user switches
// which KPI they're viewing — an error caught for Engineering Hours must not
// still be showing when they open Shop Hours next.
export class TmDrillErrorBoundary extends Component<{ onRetry: () => void; children: ReactNode }, { error: unknown }> {
  state: { error: unknown } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  componentDidCatch(error: unknown, info: { componentStack?: string | null }) {
    // Client-side surfacing only, same as the two route-level error.tsx files'
    // own console.error — this is the one place a render-time drill crash is
    // still visible in devtools now that it no longer reaches them. The
    // request that PRODUCED the data (if any) already logs full context
    // server-side — see tm-drill-actions.ts.
    console.error("[T&M drill-through] render error:", error, info.componentStack ?? "");
  }

  render() {
    const { error } = this.state;
    if (error === null) return this.props.children;

    const stale = isStaleBundleError(error);
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-red-50 text-red-600">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="9" />
            <line x1="12" y1="8" x2="12" y2="13" strokeLinecap="round" />
            <line x1="12" y1="16.5" x2="12" y2="16.5" strokeLinecap="round" />
          </svg>
        </div>
        <p className="text-sm font-semibold text-sdc-navy">{stale ? STALE_BUNDLE_TITLE : "This detail couldn't load"}</p>
        <p className="max-w-xs text-note text-sdc-gray-600">
          {stale
            ? STALE_BUNDLE_BODY
            : "Something went wrong loading this detail. The rest of the T&M page — your filters and KPI values — is unaffected."}
        </p>
        {stale ? (
          // A document reload, not a retry: see stale-bundle.ts — the stale
          // reference itself is what's broken, so retrying calls the exact
          // same dead reference again.
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
            onClick={() => {
              this.setState({ error: null });
              this.props.onRetry();
            }}
            className="rounded-lg bg-sdc-blue px-4 py-2 text-sm font-semibold text-white hover:bg-sdc-blue-dark"
          >
            Try again
          </button>
        )}
      </div>
    );
  }
}
