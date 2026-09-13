// ── Run an async map with a ceiling on how many run at once ─────────────────
//
// Written for getPartsCostFinancials (2026-08-24), which needs one live Total
// ETO call PER JOB. A plain Promise.all fires all of them simultaneously — fine
// for the handful of jobs that path was originally capped to, not fine when
// somebody selects the whole Active group and it becomes 59 concurrent upstream
// requests. That risk is precisely why the 12-job cap existed, and this is what
// makes lifting the cap defensible instead of reckless.
//
// Order-preserving: results come back positionally aligned with `items`,
// exactly like Promise.all, so callers that zip results against their input
// keep working unchanged.
//
// Deliberately NOT a dependency and deliberately tiny — pure, no timers, no
// AbortController, nothing to leak. Cancellation is a separate concern already
// handled one level up by withTimeoutOrNull, which bounds each individual call.
// Dependency-free so `tsx --test` can load it directly.

/**
 * Like `Promise.all(items.map(fn))`, but with at most `limit` calls in flight.
 *
 * A rejection propagates, same as Promise.all — callers wanting per-item
 * fail-soft should return a sentinel from `fn` rather than throwing (which is
 * what the parts path does: withTimeoutOrNull resolves to null on failure, so a
 * single unreachable job never sinks the whole aggregate).
 *
 * `limit` is clamped to at least 1, so a caller passing 0 or a negative gets
 * sequential execution rather than a promise that never settles.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const max = Math.max(1, Math.floor(limit) || 1);
  const results = new Array<R>(items.length);
  let next = 0;

  // One worker per slot, each pulling the next index until the list is done.
  // A shared cursor rather than pre-sliced chunks: with chunking, a batch
  // containing one slow job leaves the rest of that batch's slots idle until it
  // finishes. Workers keep every slot busy, which matters here because Total ETO
  // response times vary a lot job to job.
  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: Math.min(max, items.length) }, worker));
  return results;
}
