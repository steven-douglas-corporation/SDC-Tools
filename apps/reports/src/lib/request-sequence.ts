// Newest-wins sequencing for client-side async work, and de-duplication of the
// request that is already in flight.
//
// ── The failure this exists for (§32.2) ─────────────────────────────────────
//
// Every asynchronous read the browser starts for a filter, a drill or a status
// poll can finish out of order. The reported case:
//
//   1. user picks "Active"          -> request A starts
//   2. user immediately picks "HeadStart" -> request B starts
//   3. B finishes first, table shows HeadStart   (correct)
//   4. A finishes later, table shows Active      (WRONG — and silent)
//
// Nothing about `await` prevents step 4: both promises resolve, both handlers
// run, and the LAST one to resolve wins regardless of which the user asked for
// last. The result is a table that disagrees with the filter control above it,
// which reads as "the filter didn't work" and is corrected only by touching the
// filter again.
//
// Route navigations are already safe — Next's router discards a superseded
// navigation itself, which is what `useTransition` reports on. This is for
// everything that is NOT a navigation: server actions called from a click, the
// punch drill's on-demand fetch, `/api/...` polls. Those go straight to a
// setState with nothing arbitrating between them.
//
// ── Why a lane, not a per-call token ────────────────────────────────────────
//
// Ordering only means anything BETWEEN requests that write the same thing. Two
// unrelated fetches finishing out of order is not a bug. So the unit is a named
// lane — "the thing being kept current" — and each lane keeps its own counter.
// A caller asks for the latest result for its lane and gets `null` if a newer
// request has already been issued, which is the whole contract.
//
// Deliberately not a React hook: the callers are a mix of components, module
// stores and plain event handlers, and a lane frequently has to be shared
// between them (the drill's fetch is issued from a click handler and applied in
// a component). Module scope is the same choice lib/url-params.ts made, for the
// same reason.

type Lane = {
  // Monotonic id of the most recently ISSUED request in this lane.
  issued: number;
  // Highest id whose result has already been applied. A result older than this
  // is stale even if its own id was the newest when it was issued — which
  // happens when two results arrive in the same tick.
  applied: number;
  // In-flight de-duplication: the key of the request currently running, and the
  // promise it is running on, so an identical repeat can join it instead of
  // starting a second one (§32.3 "no duplicate network request for one action").
  inFlightKey: string | null;
  inFlightPromise: Promise<unknown> | null;
};

const lanes = new Map<string, Lane>();

function lane(name: string): Lane {
  let l = lanes.get(name);
  if (!l) {
    l = { issued: 0, applied: 0, inFlightKey: null, inFlightPromise: null };
    lanes.set(name, l);
  }
  return l;
}

export type SequencedOutcome<T> =
  // The result is the newest answer for this lane — apply it.
  | { ok: true; value: T; deduped: boolean }
  // A newer request superseded this one, or it failed. Do NOT touch the UI's
  // data with it: `stale` in particular means the screen is already showing
  // something newer, so replacing it would be the exact bug this prevents.
  | { ok: false; reason: "stale"; error?: undefined }
  | { ok: false; reason: "error"; error: unknown };

/**
 * Run `work` as the newest request in `laneName`, and report whether its result
 * is still the one that should be applied when it resolves.
 *
 * `key` identifies the REQUEST — same key means same question. When a request
 * with the identical key is already in flight, this joins it rather than
 * issuing a second one, so a double-click cannot produce two round-trips.
 *
 * The caller applies the result only on `ok: true`. That is the entire
 * discipline: there is no way to accidentally apply a superseded response,
 * because a superseded response never comes back as `ok`.
 */
export async function sequenced<T>(
  laneName: string,
  key: string,
  work: () => Promise<T>,
): Promise<SequencedOutcome<T>> {
  const l = lane(laneName);

  // ── Join an identical in-flight request ───────────────────────────────────
  // Same lane, same key: the answer being computed is the answer we want. Note
  // this does NOT bump `issued` — joining is not a new request, so it cannot
  // invalidate the one it is joining.
  if (l.inFlightKey === key && l.inFlightPromise) {
    try {
      const value = (await l.inFlightPromise) as T;
      // Still checked against `applied`: the shared request may have been
      // superseded by a THIRD, different request while we were waiting on it.
      if (l.issued !== l.applied && l.inFlightKey !== key) return { ok: false, reason: "stale" };
      return { ok: true, value, deduped: true };
    } catch (error) {
      return { ok: false, reason: "error", error };
    }
  }

  const id = ++l.issued;
  const promise = work();
  l.inFlightKey = key;
  l.inFlightPromise = promise;

  try {
    const value = await promise;
    // Superseded while we were waiting: a newer request was issued after us, so
    // the screen is either already newer or about to be. Drop this one.
    if (id !== l.issued) return { ok: false, reason: "stale" };
    if (id <= l.applied) return { ok: false, reason: "stale" };
    l.applied = id;
    return { ok: true, value, deduped: false };
  } catch (error) {
    // A failure from a superseded request is not worth reporting — the newer one
    // owns the outcome now, and surfacing this would put an error on screen for a
    // request whose answer nobody is waiting for (§32.11 "do not reset valid
    // current data because one request fails").
    if (id !== l.issued) return { ok: false, reason: "stale" };
    return { ok: false, reason: "error", error };
  } finally {
    // Only the request that OWNS the slot may clear it, or a slow loser would
    // wipe the winner's in-flight record and let a duplicate through.
    if (l.inFlightKey === key && l.inFlightPromise === promise) {
      l.inFlightKey = null;
      l.inFlightPromise = null;
    }
  }
}

/**
 * Abandon whatever is in flight for a lane without issuing a request — for
 * leaving a tab or closing a panel, where the pending answer must not land on a
 * screen that has moved on (§32.10 "cancel requests for tabs the user has
 * already left").
 *
 * The underlying fetch is not aborted (server actions expose no signal); what is
 * guaranteed is that its result can no longer be applied.
 */
export function abandonLane(laneName: string): void {
  const l = lane(laneName);
  l.issued += 1;
  l.applied = l.issued;
  l.inFlightKey = null;
  l.inFlightPromise = null;
}

/** Whether a lane currently has a request running — for a section-level spinner. */
export function laneIsBusy(laneName: string): boolean {
  return lane(laneName).inFlightPromise !== null;
}

/** Test seam. Lanes are module state, so tests must be able to start clean. */
export function __resetLanes(): void {
  lanes.clear();
}
