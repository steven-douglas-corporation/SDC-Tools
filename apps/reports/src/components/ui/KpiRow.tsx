"use client";

import { memo } from "react";
import { useValueFlash } from "@/components/useMotion";

// ── The one KPI-row design (§37 → shared for every KPI summary) ─────────────
//
// Extracted from EtcMonthKpiCards.tsx's original `MetricBlock`, unchanged in markup,
// styling and behavior — only generalized so a second KPI summary (the T&M tab) can
// use the exact same row instead of growing its own near-identical copy that could
// drift from this one. See EtcMonthKpiCards.tsx for the surrounding card chrome
// (the collapsible "Hide/Show summary" header, the hairline-divided grid, the
// side-by-side drill column) — that part stays local to each summary, since what
// each one drills INTO differs completely; this file is just the row.
//
// `TDrill` is generic (a string literal union — Monthly ETC's `DrillScope`, T&M's own
// drill-key union, or plain `string`) so callers keep their own type-safe drill scope
// without this file depending on either domain.

export type KpiTone = "warn" | "danger";
export type KpiStatusKind = "variance" | "unplanned" | "text";

// Flat on purpose (see the original note this carries forward): every field is a
// primitive so a React.memo'd row's shallow prop comparison actually does something
// — a nested object would be a fresh identity every render and defeat the memo.
export type KpiRowData<TDrill extends string = string> = {
  id: string;
  label: string;
  /** Formatted for display, or "—" when genuinely unavailable rather than zero. */
  value: string;
  hint: string | null;
  tone: KpiTone | null;
  /** A non-colour restatement of `tone`, for screen readers — null when there's no tone. */
  toneLabel: string | null;
  drill: TDrill | null;
  statusKind: KpiStatusKind;
  statusArrow: "▲" | "▼" | "";
  statusText: string;
  statusSign: -1 | 0 | 1;
  statusTitle: string;
  /** Middle-column context, shown only when it says something ("2 jobs", "24 engineers") — null when it wouldn't. */
  countLabel: string | null;
};

export function KpiRow<TDrill extends string>({
  id,
  label,
  value,
  hint,
  tone,
  toneLabel,
  drill,
  statusKind,
  statusArrow,
  statusText,
  statusSign,
  statusTitle,
  countLabel,
  drillOpen,
  detailState,
  onDrill,
  onRetry,
  rowOpensDetail,
}: KpiRowData<TDrill> & {
  /** Whether THIS row's panel is the one currently open, so its link can say so. */
  drillOpen: boolean;
  /** This row's own fetch state — only an OPEN drill ever fetches, so at most one row is ever non-idle. */
  detailState: "idle" | "loading" | "error";
  onDrill: (scope: TDrill) => void;
  onRetry: (scope: TDrill) => void;
  /**
   * Also opens the drill on a click anywhere in the row (or the Enter/Space key),
   * not just the Detail link — opt-in and false by default, so Monthly ETC's rows
   * keep their existing Detail-only behavior unless a caller asks for the wider
   * target (the T&M summary does, to match its own task's explicit requirement).
   */
  rowOpensDetail?: boolean;
}) {
  const changed = useValueFlash(value);
  const labelId = `kpi-${id}-label`;
  const rowClickable = Boolean(rowOpensDetail && drill != null && detailState !== "error");
  return (
    <div
      className={`motion-interactive flex min-w-0 items-center gap-3 px-3 py-2 ${changed ? "motion-flash" : ""} ${rowClickable ? "cursor-pointer" : ""} ${
        tone === "danger"
          ? "border-l-4 border-l-sdc-red bg-sdc-red-bg/70"
          : tone === "warn"
            ? "border-l-4 border-l-sdc-yellow bg-sdc-yellow-bg/70"
            : "border-l-4 border-l-transparent bg-white"
      }`}
      title={hint ?? undefined}
      role="group"
      aria-labelledby={labelId}
      onClick={rowClickable ? () => onDrill(drill as TDrill) : undefined}
      onKeyDown={
        rowClickable
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onDrill(drill as TDrill);
              }
            }
          : undefined
      }
      tabIndex={rowClickable ? 0 : undefined}
    >
      <p id={labelId} className="min-w-0 flex-1 truncate text-label font-semibold uppercase tracking-wide text-sdc-muted">
        {toneLabel && (
          <>
            <span aria-hidden="true" className={`mr-1 ${tone === "danger" ? "text-sdc-red-text" : "text-sdc-yellow-text"}`}>
              ⚠
            </span>
            <span className="sr-only">{toneLabel}: </span>
          </>
        )}
        {label}
      </p>
      <div className="flex min-w-0 flex-wrap items-baseline justify-end gap-3">
        <p
          className={`min-w-0 truncate text-note font-semibold tabular-nums ${
            statusKind === "unplanned"
              ? "text-sdc-yellow-text"
              : statusKind === "text" || statusSign === 0
                ? "text-sdc-gray-400"
                : statusSign > 0
                  ? "text-sdc-green-text"
                  : "text-sdc-red-text"
          }`}
          title={statusTitle}
        >
          {statusArrow && (
            <span aria-hidden="true" className="mr-0.5">
              {statusArrow}
            </span>
          )}
          {statusText}
        </p>
        {countLabel && <p className="min-w-0 shrink truncate text-note font-medium text-sdc-muted">{countLabel}</p>}
        <p className="font-heading min-w-[5.5rem] text-right text-lg leading-tight font-bold tabular-nums text-sdc-navy">
          {value}
        </p>
        {drill != null && (
          <button
            type="button"
            onClick={(e) => {
              // Stops the click from also reaching the row's own onClick above —
              // without this, a click on Detail while rowOpensDetail is set would
              // fire both handlers and toggle the drill open then immediately shut.
              e.stopPropagation();
              if (detailState === "error") onRetry(drill);
              else onDrill(drill);
            }}
            aria-expanded={drillOpen}
            aria-label={
              detailState === "error"
                ? `Retry loading the ${label} detail`
                : drillOpen
                  ? `Hide the ${label} detail`
                  : `Show the ${label} detail`
            }
            title={drillOpen ? "Hide this detail" : "Show the detail behind this figure"}
            className={`motion-interactive shrink-0 text-right text-label font-medium underline decoration-dotted underline-offset-2 min-w-[3.2rem] ${
              detailState === "error"
                ? "text-sdc-red-text"
                : drillOpen
                  ? "text-sdc-navy"
                  : "text-sdc-blue hover:text-sdc-blue-dark"
            }`}
          >
            {detailState === "error" ? "Retry" : detailState === "loading" ? "Loading…" : drillOpen ? "Hide" : "Detail"}
          </button>
        )}
      </div>
    </div>
  );
}

// memo'd via a wrapper rather than `memo(KpiRow)` directly: React.memo erases a
// generic component's type parameter, which would force every caller back to
// whatever single `TDrill` the LAST memo() call happened to see. Casting the
// memo'd value back to the original generic signature keeps both call sites
// (Monthly ETC's DrillScope, T&M's own drill-key union) type-safe.
export const MemoKpiRow = memo(KpiRow) as typeof KpiRow;
