// Whether this tab's realtime stream is actually connected.
//
// ── Why this is its own module ───────────────────────────────────────────────
//
// The store used to live inside components/RealtimeProvider.tsx, which was fine
// while only the change banner read it. LiveRefresh needs it too now — it decides
// whether a full route re-render is necessary, and the answer depends on whether
// the stream has been delivering events (see components/LiveRefresh.tsx) — and
// RealtimeProvider already imports requestLiveRefresh FROM LiveRefresh. Reading it
// the other way round would be a straight import cycle.
//
// So the smallest shared thing moves out and both import it. RealtimeProvider is
// still the only WRITER; everyone else reads.

export type RealtimeStatus = "connecting" | "live" | "offline";

let status: RealtimeStatus = "connecting";

// How many times this tab has LOST a live stream. Increments on the transition out
// of "live", not on entering "offline" from "connecting" — a stream that has never
// connected has missed nothing yet, because the page it is attached to was
// server-rendered after the events it would have carried.
//
// This is what lets a reader ask the only question that matters: "could I have
// missed a change since the last time I was sure?" A plain status read cannot
// answer that — a connection that dropped and recovered while the tab was hidden
// reads "live" again by the time anyone looks.
let gaps = 0;

const listeners = new Set<() => void>();

export function setRealtimeStatus(next: RealtimeStatus): void {
  if (status === next) return;
  if (status === "live") gaps += 1;
  status = next;
  for (const l of listeners) l();
}

export function subscribeRealtimeStatus(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function readRealtimeStatus(): RealtimeStatus {
  return status;
}

/** Monotonic count of lost connections — compare two readings, don't read once. */
export function readRealtimeGaps(): number {
  return gaps;
}

/** Test seam: these are module singletons, so a test must be able to start clean. */
export function __resetRealtimeStatus(): void {
  status = "connecting";
  gaps = 0;
  listeners.clear();
}
