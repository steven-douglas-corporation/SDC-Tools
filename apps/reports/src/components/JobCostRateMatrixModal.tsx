"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CostRates, YearRateOverrides } from "@/lib/job-cost";
import {
  RATE_KEYS,
  evaluateRateDraft,
  toDefaultDraft,
  toYearDraft,
  type DefaultDraft,
  type RateKey,
  type YearDraft,
} from "@/lib/job-cost-rate-draft";
import { BUTTON_PRIMARY, BUTTON_SECONDARY, INPUT, LABEL } from "@/components/ui/classnames";

// Ported from the standalone app's Rate Matrix modal (ensureRateMatrixModal/
// rateMatrixBody/saveRateMatrix in public/app.js) — same fields, same
// blank-means-default semantics, now writing through server actions instead
// of localStorage so every signed-in user sees the same rates.
//
// ── Draft, then Confirm (2026-10-21) ─────────────────────────────────────────
// Every cell used to save on blur, so a half-finished or mistyped edit was live
// for everyone the moment focus moved. Now the matrix edits a local DRAFT and
// nothing is written, and no figure on the page changes, until Confirm. Leaving
// with a draft that differs from the saved rates asks first; leaving anyway
// throws the draft away, so the rates are exactly what they were when the matrix
// opened. The modal is only reachable while the page's Edit toggle is on.

const LABELS: Record<RateKey, string> = { engRate: "Eng $/hr", shopRate: "Shop $/hr", pmPct: "PM %", mfgPct: "Mfg %" };
const step = (k: RateKey) => (k === "engRate" || k === "shopRate" ? 5 : 0.5);

export function JobCostRateMatrixModal({
  defaultRates,
  overrides,
  years,
  onClose,
  onConfirm,
}: {
  defaultRates: CostRates;
  overrides: YearRateOverrides;
  years: string[];
  onClose: () => void;
  /** Writes the confirmed rates. Rejects if the save failed, so the draft is kept. */
  onConfirm: (defaults: CostRates, overrides: YearRateOverrides) => Promise<void>;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [defDraft, setDefDraft] = useState<DefaultDraft>(() => toDefaultDraft(defaultRates));
  const [yearDraft, setYearDraft] = useState<YearDraft>(() => toYearDraft(overrides));
  const [askDiscard, setAskDiscard] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const state = useMemo(
    () => evaluateRateDraft(defaultRates, overrides, defDraft, yearDraft),
    [defaultRates, overrides, defDraft, yearDraft],
  );

  // The one door out for Close, ×, Esc and a click on the backdrop.
  const dirty = state.dirty;
  function requestClose() {
    if (saving) return;
    if (dirty) setAskDiscard(true);
    else onClose();
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" || saving) return;
      // With the discard prompt up, Esc answers it ("keep editing") instead of
      // stacking a second prompt on the first.
      if (askDiscard) setAskDiscard(false);
      else if (dirty) setAskDiscard(true);
      else onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [askDiscard, dirty, saving, onClose]);

  // Closing or reloading the browser tab with a draft in hand: the browser's own prompt.
  useEffect(() => {
    if (!state.dirty) return;
    function onBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [state.dirty]);

  function setDefault(k: RateKey, raw: string) {
    setError(null);
    setDefDraft((d) => ({ ...d, [k]: raw }));
  }
  function setYear(year: string, k: RateKey, raw: string) {
    setError(null);
    setYearDraft((prev) => ({ ...prev, [year]: { ...prev[year], [k]: raw } }));
  }

  async function confirm() {
    if (!state.dirty || !state.valid || !state.defaults || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onConfirm(state.defaults, state.overrides);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? `Couldn't save every rate — ${err.message}. Check the rates and try again.` : "Couldn't save every rate. Check the rates and try again.");
      setSaving(false);
    }
  }

  const invalidDefault = (k: RateKey) => {
    const v = defDraft[k];
    const n = Number(v);
    return v.trim() === "" || !Number.isFinite(n) || n < 0;
  };
  const invalidYear = (year: string, k: RateKey) => {
    const v = yearDraft[year]?.[k];
    if (v == null || v.trim() === "") return false;
    const n = Number(v);
    return !Number.isFinite(n) || n < 0;
  };

  return (
    <div
      className="motion-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => {
        if (!dialogRef.current?.contains(e.target as Node)) requestClose();
      }}
    >
      <div ref={dialogRef} className="max-h-[calc(var(--app-vh)_*_0.85)] w-full max-w-2xl overflow-auto rounded-xl border border-sdc-border bg-white p-5 shadow-lg">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-heading text-base font-semibold text-sdc-navy">Rate Matrix — rates by year</h2>
          <button className="text-2xl leading-none text-sdc-gray-400 hover:text-sdc-navy" aria-label="Close" onClick={requestClose}>×</button>
        </div>

        <div className="mb-4 grid grid-cols-4 gap-3">
          {RATE_KEYS.map((k) => (
            <label key={k} className="flex flex-col gap-1">
              <span className={LABEL}>{LABELS[k]}</span>
              <input
                type="number"
                min={0}
                step={step(k)}
                className={`${INPUT} ${invalidDefault(k) ? "border-sdc-red-border" : ""}`}
                aria-invalid={invalidDefault(k)}
                value={defDraft[k]}
                disabled={saving}
                onChange={(e) => setDefault(k, e.target.value)}
              />
            </label>
          ))}
        </div>

        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-sdc-border text-left text-label font-semibold uppercase text-sdc-gray-600">
              <th className="py-1.5">Year</th>
              {RATE_KEYS.map((k) => (
                <th key={k} className="py-1.5">{LABELS[k]}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {years.length === 0 && (
              <tr>
                <td colSpan={5} className="py-4 text-center text-sdc-muted">No years in the data yet.</td>
              </tr>
            )}
            {years.map((year) => (
              <tr key={year} className="border-b border-sdc-border-soft">
                <td className="py-1.5 font-semibold text-sdc-navy">{year}</td>
                {RATE_KEYS.map((k) => (
                  <td key={k} className="py-1.5 pr-2">
                    <input
                      type="number"
                      min={0}
                      step={step(k)}
                      className={`${INPUT} w-24 ${invalidYear(year, k) ? "border-sdc-red-border" : ""}`}
                      aria-invalid={invalidYear(year, k)}
                      placeholder={defDraft[k]}
                      value={yearDraft[year]?.[k] ?? ""}
                      disabled={saving}
                      onChange={(e) => setYear(year, k, e.target.value)}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-3 text-note text-sdc-muted">
          A job&apos;s hours are costed at the rate for the year they were worked; a job spanning years is blended automatically.
          PM &amp; Mfg % use the job&apos;s completion-year rate. Blank cell = default.
        </p>
        <p className="mt-1 text-note text-sdc-muted">Changes apply to every job, for everyone, only when you press Confirm.</p>

        {!state.valid && (
          <p role="alert" className="mt-2 text-note text-sdc-red-text">
            Every default needs a number, and no rate can be negative. Fix the highlighted cells to confirm.
          </p>
        )}
        {error && (
          <p role="alert" className="mt-2 text-note text-sdc-red-text">
            {error}
          </p>
        )}

        <div className="mt-5 flex items-center gap-2">
          <div className="flex-1" />
          <button className={BUTTON_SECONDARY} onClick={requestClose} disabled={saving}>Close</button>
          <button className={BUTTON_PRIMARY} onClick={confirm} disabled={!state.dirty || !state.valid || saving}>
            {saving ? "Saving…" : "Confirm"}
          </button>
        </div>
      </div>
        {askDiscard && (
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="rate-matrix-discard-title"
            className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-4"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="w-full max-w-sm rounded-lg border border-sdc-border bg-white p-4 shadow-lg">
              <h3 id="rate-matrix-discard-title" className="font-heading text-sm font-semibold text-sdc-navy">Changes are not saved</h3>
              <p className="mt-1 text-sm text-sdc-gray-600">
                You changed some rates but didn&apos;t confirm them. If you exit now they are discarded and the rates stay as they were.
                Exit without saving?
              </p>
              <div className="mt-4 flex justify-end gap-2">
                <button className={BUTTON_SECONDARY} autoFocus onClick={() => setAskDiscard(false)}>No, keep editing</button>
                <button
                  className={BUTTON_PRIMARY}
                  onClick={() => {
                    setAskDiscard(false);
                    onClose();
                  }}
                >
                  Yes, exit
                </button>
              </div>
            </div>
          </div>
        )}
    </div>
  );
}
