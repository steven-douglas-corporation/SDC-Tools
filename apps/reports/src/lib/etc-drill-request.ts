"use client";

import type { DrillScope } from "@/lib/etc-kpi-strip";

// "Open that KPI's drill-through" — asked for from outside the KPI card.
//
// ── Why a module store rather than lifted state ─────────────────────────────
//
// The issues indicator lives in the page header and the drill lives inside
// EtcMonthKpiCards; their nearest common ancestor is the route itself, which is a
// Server Component. Lifting `drill` up there is not possible, and threading a callback
// down would mean making the header a client component that re-renders whenever the
// card's state moves.
//
// Same pattern, and the same reasoning, as etc-live-totals, etc-save-state and
// kpi-strip-pref: publishers and subscribers with no useful common ancestor talk
// through a module. This one is deliberately the smallest possible version — one
// pending value and a bump counter.
//
// ── Why a counter and not just the scope ────────────────────────────────────
//
// Asking twice for the SAME drill has to work. A user opens "Undefined hours" from the
// indicator, closes the panel, then clicks the same row again — if the store held only
// the scope, the second request would be indistinguishable from the first and the
// subscriber would see no change. The counter makes every request distinct.

type Request = { scope: DrillScope; n: number } | null;

let pending: Request = null;
let counter = 0;
const listeners = new Set<() => void>();

export function requestKpiDrill(scope: DrillScope): void {
  counter += 1;
  pending = { scope, n: counter };
  for (const l of [...listeners]) l();
}

export function readKpiDrillRequest(): Request {
  return pending;
}

// A stable reference for the SSR/first-paint snapshot, so useSyncExternalStore cannot
// loop on a fresh object each read.
export function serverKpiDrillRequest(): Request {
  return null;
}

export function subscribeKpiDrillRequest(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
