// Building the next query string when a previous change may still be in flight.
//
// ── The bug this exists for ─────────────────────────────────────────────────
//
// Every toolbar control on these pages writes the URL the same way:
//
//     const qs = new URLSearchParams(searchParams.toString());
//     qs.set("statuses", …);
//     router.push(`${pathname}?${qs}`);
//
// and every one of them pushes inside a transition. That is the problem.
// `useSearchParams()` does not update until the navigation COMMITS — holding
// the old UI until the new one is ready is what a transition is for — so while
// a filter change is still rendering, every control on the page is still
// reading the query string from BEFORE it.
//
// Change one filter, then change another before the grid finishes: the second
// control rebuilds the URL from the pre-first-change params and the first
// change is silently gone. No error, nothing to see — the filter you set a
// moment ago has simply reverted. On /quoted, which takes a visible beat to
// render, that window is wide open, and it is the "filters don't stick"
// behaviour users report.
//
// ── The fix ─────────────────────────────────────────────────────────────────
//
// Remember the last query string we WROTE, together with the one we derived it
// from. If the router still reports that same base, our write hasn't landed
// yet, so build on the write instead.
//
// Self-clearing, which is the point — there is no effect to run and nothing to
// tear down. Once the navigation commits, the reported value IS our result and
// no longer matches `base`, so the overlay stops applying. Press Back and the
// reported value is some third thing, which also doesn't match, so the overlay
// is ignored there too. It can only ever apply in the exact window it is for.
//
// Module scope on purpose: the controls are separate components that know
// nothing about each other, and the thing being coordinated is one shared
// resource — the page's query string.

let pending: { base: string; result: string } | null = null;

// The query string to build the next change on top of. Pass
// `searchParams.toString()`.
export function nextParams(currentQs: string): URLSearchParams {
  if (pending && pending.base === currentQs) return new URLSearchParams(pending.result);
  return new URLSearchParams(currentQs);
}

// Call with the same `currentQs` that was passed to nextParams, and the query
// string actually being pushed. Must be called BEFORE router.push, so a control
// that fires immediately after sees it.
export function notePendingParams(currentQs: string, resultQs: string): void {
  pending = { base: currentQs, result: resultQs };
}

// Test seam. Nothing in the app calls this: the overlay expires on its own.
export function __resetPendingParams(): void {
  pending = null;
}
