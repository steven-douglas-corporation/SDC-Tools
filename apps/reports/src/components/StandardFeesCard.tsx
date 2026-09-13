"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { StandardPoolPanel } from "@/components/StandardPoolPanel";
import { getStandardFeesCard, type StandardFeesCardData } from "@/lib/standard-fees-card";
import { readStandardsState, serverStandardsState, subscribeStandards } from "@/lib/standards-reveal";

// The Standard Fees card (§48, §76).
//
// ── The shape of the fix ────────────────────────────────────────────────────
//
// Visibility is a role check now (standard-sheet-gate.ts, decided server-side and handed
// down as `initialData`) rather than a client-side password unlock — a role doesn't change
// mid-session, so unlike the old password gate there is no event that could reveal this
// card without a page load. The only thing left as client state is `hidden` (§76): an
// authorized user collapsing the section to reduce clutter, with no re-fetch either way.
//
// Nothing here asks the page to re-render. The grid, the KPI card, the filters, the
// focused cell and any unsaved edit are untouched because they are never involved.
export function StandardFeesCard({
  month,
  /**
   * The card, already computed, when the signed-in user's role grants standards:view.
   * Null otherwise — never fetched client-side, so nobody without the permission can
   * reach the confidential figures by any client-side event.
   */
  initialData,
  savePoolsAction,
}: {
  month: string;
  initialData: StandardFeesCardData | null;
  savePoolsAction: (formData: FormData) => Promise<void>;
}) {
  const { hidden } = useSyncExternalStore(subscribeStandards, readStandardsState, serverStandardsState);
  const [data, setData] = useState<StandardFeesCardData | null>(initialData);
  const [error, setError] = useState<string | null>(null);

  // ── One request, and stale answers cannot land (§48) ───────────────────────
  //
  // `loadingFor` is the month a request is currently out for. A second reveal of the same
  // month while the first is in flight is dropped (the dedupe), and an answer whose month
  // no longer matches what is being asked for is discarded rather than rendered (the
  // stale-response guard). Both live in a ref so they are read synchronously — state
  // would be one render behind and would let a duplicate through.
  const loadingFor = useRef<string | null>(null);
  const [loading, setLoading] = useState(false);

  // ── Hidden is a separate, later veto (§76) ──────────────────────────────────
  //
  // `initialData != null` answers "is this tab authorized"; `hidden` answers "has the
  // user collapsed it anyway", and it must be checked LAST — an authorized-but-hidden
  // card must not show, and toggling `hidden` back off must not have to re-answer the
  // authorization question (it doesn't: `data` below is never cleared by hiding, so
  // showing again is instant and re-uses whatever this card already fetched).
  const show = initialData != null && !hidden;

  useEffect(() => {
    // Nothing to do unless the card is on screen and its figures are missing.
    if (!show || data != null) return;
    if (loadingFor.current === month) return; // already asking for exactly this
    loadingFor.current = month;
    setLoading(true);
    setError(null);
    let alive = true;
    getStandardFeesCard(month)
      .then((next) => {
        // Discard an answer for a month we are no longer showing.
        if (!alive || loadingFor.current !== month) return;
        setData(next);
      })
      .catch(() => {
        if (!alive || loadingFor.current !== month) return;
        // §48: never leave the panel stuck loading. A failure clears the indicator and
        // says so, with a way to try again.
        setError("Couldn't load the Standard Fees figures.");
      })
      .finally(() => {
        if (!alive) return;
        loadingFor.current = null;
        setLoading(false);
      });
    return () => {
      alive = false;
    };
    // `data` deliberately absent: including it would re-run this the moment the answer
    // arrives. The guard above is what decides whether a load is needed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show, month]);

  // A month switch is a different card. Drop what we have so the effect above fetches
  // again rather than showing last month's figures under this month's heading.
  //
  // Set-state-during-render, not a ref and not an effect: this is the same resync
  // GridViewProvider and useDraftParamMenu use, and it is React's sanctioned way to
  // adjust state when a prop changes. A ref would be read during render (which React's
  // rules forbid, since it does not schedule the re-render); an effect would paint one
  // frame showing last month's figures under this month's heading.
  const [seenMonth, setSeenMonth] = useState(month);
  if (seenMonth !== month) {
    setSeenMonth(month);
    if (data != null && data.month !== month) setData(null);
  }

  if (!show) return null;

  if (data == null) {
    // The shell, immediately. Same frame as the password being accepted.
    return (
      <section
        aria-label="Standard Fees"
        aria-busy={loading}
        className="rounded-lg border border-sdc-border bg-white p-4"
      >
        <h3 className="text-base font-semibold text-sdc-navy">Standard Fees</h3>
        {error ? (
          <div className="mt-2 flex items-center gap-3">
            <p className="text-note text-sdc-red-text">{error}</p>
            <button
              type="button"
              onClick={() => {
                // Clearing the marker is what re-arms the effect above.
                loadingFor.current = null;
                setError(null);
                setData(null);
                setLoading(true);
                getStandardFeesCard(month)
                  .then(setData)
                  .catch(() => setError("Couldn't load the Standard Fees figures."))
                  .finally(() => setLoading(false));
              }}
              className="text-note text-sdc-blue-dark underline-offset-2 hover:underline"
            >
              Try again
            </button>
          </div>
        ) : (
          <p className="mt-2 flex items-center gap-2 text-note text-sdc-muted">
            <span
              aria-hidden
              className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-sdc-border border-t-sdc-blue"
            />
            Loading this month&apos;s figures…
          </p>
        )}
      </section>
    );
  }

  return (
    <StandardPoolPanel
      month={data.month}
      carriedFrom={data.carriedFrom}
      upstreamNote={data.upstreamNote}
      rows={data.rows}
      newProjects={data.newProjects}
      isSubmitted={data.isSubmitted}
      poolsEditable={data.poolsEditable}
      savePoolsAction={savePoolsAction}
      monthName={data.monthName}
      initialStatus={data.initialStatus}
    />
  );
}
