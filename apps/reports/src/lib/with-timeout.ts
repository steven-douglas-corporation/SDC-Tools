// ── A time budget for an external system (§69) ───────────────────────────────
//
// The Job Hour Details page hangs when TotalETO is slow, and "slow" is not
// hypothetical: measured 2026-08-06, `getJobPartsCost` took 110.5s and `getJobBom`
// 101.7s for one job, against ~30ms for every app-database read on the same page. The
// page returned 200 in 2.0–3.9 minutes and showed its loading skeleton throughout.
//
// The page already knows how to survive those two calls FAILING — a null `parts`
// renders "Parts Cost is unavailable", a thrown BOM renders the procurement
// EmptyState. What it had no answer for was them being slow rather than broken:
// mssql's own `requestTimeout` is 120s, so a blocked query holds the render for two
// minutes before that fallback is ever reached.
//
// So the budget is stated here, in app terms, rather than left to the driver's.
//
// ── Why this does not cancel the underlying work ─────────────────────────────
//
// It cannot: a promise is not cancellable, and the mssql request keeps running until
// the driver's own timeout. That is deliberate rather than a limitation being ignored
// — the point is to stop the USER waiting, not to stop the query. The abandoned
// request finishes into nothing and the pool closes it as it always would.
//
// The consequence worth knowing: this bounds the RENDER, not the load on TotalETO. If
// that server is the bottleneck, a page reload starts another query. Fixing the
// upstream is a separate job; this only stops one slow system taking a whole page down
// with it.

/** What a timed-out call reports, so a caller can tell it apart from a real failure. */
export class TimeoutError extends Error {
  readonly label: string;
  readonly ms: number;
  constructor(label: string, ms: number) {
    super(`${label} did not respond within ${ms}ms`);
    this.name = "TimeoutError";
    this.label = label;
    this.ms = ms;
  }
}

/**
 * Resolve `work`, or reject with a TimeoutError once `ms` has passed.
 *
 * `label` names the system rather than the function, because it ends up in a server log
 * that somebody reads while wondering which upstream is down.
 *
 * The timer is always cleared — including on the success path — so a short call does not
 * hold the event loop open for the rest of the budget. That matters here: this runs
 * during a server render, and a leaked 12s timer per request is a leak per request.
 */
export function withTimeout<T>(label: string, ms: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
  });
  return Promise.race([work, limit]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

/**
 * The same budget, but reporting `null` instead of throwing — for the callers whose
 * whole contract is already "null means this section could not be loaded".
 *
 * Swallows a genuine rejection too, on purpose: to the page, "TotalETO refused" and
 * "TotalETO never answered" lead to the identical fallback, and forcing every caller to
 * write the same two-branch catch is how one of them ends up missing a branch. `onFail`
 * is where the distinction is kept — it receives the real error for the log.
 */
export async function withTimeoutOrNull<T>(
  label: string,
  ms: number,
  work: () => Promise<T>,
  onFail?: (error: unknown) => void,
): Promise<T | null> {
  try {
    return await withTimeout(label, ms, work());
  } catch (error) {
    onFail?.(error);
    return null;
  }
}

// ── The budget itself ────────────────────────────────────────────────────────
//
// 12 seconds, and the number is chosen from measurement rather than taste. A healthy
// TotalETO answers these in ~1–3s (the page rendered in 3.1s end to end earlier the same
// day), so 12s is ~4× the healthy case: long enough that a merely busy server still
// returns real data, short enough that a blocked one costs a reader seconds instead of
// minutes. Anything under ~5s would start showing "unavailable" on a slow-but-working
// day, which is worse than waiting — a wrong figure's absence reads as a bug.
export const UPSTREAM_BUDGET_MS = 12_000;
