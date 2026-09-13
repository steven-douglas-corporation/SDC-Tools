import type { TmHoursDrillKey } from "@/lib/tm-hours-classify";
import type { TmPartsDrillKey } from "@/lib/tm-report";

// ── The T&M drill-through drawer's own state machine ────────────────────────
//
// Root cause of the intermittent "Detail crashes the whole T&M page" bug:
// `openDrill` (which card), `drillRows` (what data) and `drillError` (what
// went wrong) used to be THREE independent `useState`s. A click on a
// different card called `setOpenDrill(newKey)` alone — `drillRows` and
// `drillError` were only cleared a commit LATER, inside a `useEffect` that
// runs on the NEXT pass. That leaves exactly one render where `openDrill`
// already names the NEW card but `drillRows` still holds the OLD card's rows.
// Switching within one family (Engineering -> Shop) just flashed stale-but-
// compatible data for a frame; switching FAMILIES (any Hours card -> any
// Parts card, or back) is a genuine crash, because the row shapes don't
// overlap — `TmPartsDrillPanel` calls `r.quantity.toLocaleString()` and
// `usd(r.unitPrice)` on what is actually a `TmHoursDrillRow` (no `quantity`
// field at all), and `TmHoursDrillPanel` calls `hoursCell(r.hours)` on what
// is actually a `TmPartsDrillRow`. Both throw `Cannot read properties of
// undefined` mid-render, and since nothing wrapped the drawer content in an
// Error Boundary (see TmDrillErrorBoundary.tsx — built, but never mounted),
// that throw propagated straight to the route-level `error.tsx`, replacing
// the whole page. This is "intermittent" only in the sense that it depends on
// which two cards you cross between, not on timing — any Hours<->Parts
// switch while data was already loaded reproduced it every time.
//
// The fix: ONE state value, not three. `key` and its data can never disagree
// mid-render because they are the same object, replaced atomically by a
// single dispatch. `resolved`/`failed` additionally REFUSE to apply unless
// they target the currently-open key — a second, independent guard on top of
// request-sequence.ts's own lane staleness check, so this remains correct
// even if a caller ever misused the lane (defense in depth, not a substitute
// for `sequenced()` — that still owns "is this the newest network response").

export type TmDrillKey = TmHoursDrillKey | TmPartsDrillKey;

export type TmDrawerState<TRow> =
  | { status: "closed" }
  | { status: "loading"; key: TmDrillKey }
  | { status: "success"; key: TmDrillKey; rows: TRow[] }
  | { status: "empty"; key: TmDrillKey }
  | { status: "error"; key: TmDrillKey; message: string };

export type TmDrawerAction<TRow> =
  // A card's Detail/row was clicked. Toggles closed if it's already the open card.
  | { type: "open"; key: TmDrillKey }
  | { type: "close" }
  // The effect (re)issuing a fetch for the currently-open card — on first open,
  // on a filter change, or on Retry. A no-op if `key` isn't the open card.
  | { type: "loading"; key: TmDrillKey }
  | { type: "resolved"; key: TmDrillKey; rows: TRow[] }
  | { type: "failed"; key: TmDrillKey; message: string };

export function tmDrawerReducer<TRow>(state: TmDrawerState<TRow>, action: TmDrawerAction<TRow>): TmDrawerState<TRow> {
  switch (action.type) {
    case "open":
      if (state.status !== "closed" && state.key === action.key) return { status: "closed" };
      return { status: "loading", key: action.key };
    case "close":
      return state.status === "closed" ? state : { status: "closed" };
    case "loading":
      // Belongs to a card that isn't open any more (closed, or the user has
      // since switched to a different one) — an in-flight effect racing a
      // click. Dropping it is what keeps the drawer's own `key` from ever
      // being overwritten by work nobody asked to see any more.
      if (state.status === "closed" || state.key !== action.key) return state;
      return { status: "loading", key: action.key };
    case "resolved":
      if (state.status === "closed" || state.key !== action.key) return state;
      return action.rows.length === 0 ? { status: "empty", key: action.key } : { status: "success", key: action.key, rows: action.rows };
    case "failed":
      if (state.status === "closed" || state.key !== action.key) return state;
      return { status: "error", key: action.key, message: action.message };
    default:
      return state;
  }
}

/** The card currently open, or null — the one thing the fetch effect needs to depend on. */
export function tmDrawerOpenKey<TRow>(state: TmDrawerState<TRow>): TmDrillKey | null {
  return state.status === "closed" ? null : state.key;
}

/** The 3-state shape TmKpiSummary/KpiRow already understand — "empty" and "success" both just mean "not busy, not broken" from a KPI row's point of view. */
export function tmDrawerRowState<TRow>(state: TmDrawerState<TRow>): "idle" | "loading" | "error" {
  return state.status === "loading" ? "loading" : state.status === "error" ? "error" : "idle";
}
