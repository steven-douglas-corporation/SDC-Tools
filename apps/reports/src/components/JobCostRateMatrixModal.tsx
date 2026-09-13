"use client";

import { useEffect, useRef, useState } from "react";
import type { CostRates, YearRateOverrides } from "@/lib/job-cost";
import { BUTTON_PRIMARY, BUTTON_SECONDARY, BUTTON_COMPACT_DANGER, INPUT, LABEL } from "@/components/ui/classnames";

// Ported from the standalone app's Rate Matrix modal (ensureRateMatrixModal/
// rateMatrixBody/saveRateMatrix in public/app.js) — same fields, same
// blank-means-default semantics, now writing through server actions instead
// of localStorage so every signed-in user sees the same rates.

export function JobCostRateMatrixModal({
  defaultRates,
  overrides,
  years,
  onClose,
  onSaveDefault,
  onSaveYear,
  onClearAll,
}: {
  defaultRates: CostRates;
  overrides: YearRateOverrides;
  years: string[];
  onClose: () => void;
  onSaveDefault: (rates: CostRates) => Promise<void>;
  onSaveYear: (year: string, partial: Partial<CostRates>) => Promise<void>;
  onClearAll: () => Promise<void>;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [def, setDef] = useState(defaultRates);
  const [rows, setRows] = useState<Record<string, Partial<CostRates>>>(overrides);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  function fieldValue(year: string, key: keyof CostRates): string {
    const v = rows[year]?.[key];
    return v == null ? "" : String(v);
  }
  function setField(year: string, key: keyof CostRates, raw: string) {
    setRows((prev) => {
      const next = { ...prev, [year]: { ...prev[year] } };
      if (raw.trim() === "") delete next[year][key];
      else next[year][key] = Number(raw);
      return next;
    });
  }
  async function blurField(year: string) {
    await onSaveYear(year, rows[year] ?? {});
  }

  return (
    <div
      className="motion-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => {
        if (!dialogRef.current?.contains(e.target as Node)) onClose();
      }}
    >
      <div ref={dialogRef} className="max-h-[calc(var(--app-vh)_*_0.85)] w-full max-w-2xl overflow-auto rounded-xl border border-sdc-border bg-white p-5 shadow-lg">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-heading text-base font-semibold text-sdc-navy">Rate Matrix — rates by year</h2>
          <button className="text-2xl leading-none text-sdc-gray-400 hover:text-sdc-navy" aria-label="Close" onClick={onClose}>×</button>
        </div>

        <div className="mb-4 grid grid-cols-4 gap-3">
          {(["engRate", "shopRate", "pmPct", "mfgPct"] as const).map((k) => (
            <label key={k} className="flex flex-col gap-1">
              <span className={LABEL}>{{ engRate: "Eng $/hr", shopRate: "Shop $/hr", pmPct: "PM %", mfgPct: "Mfg %" }[k]}</span>
              <input
                type="number"
                min={0}
                step={k === "engRate" || k === "shopRate" ? 5 : 0.5}
                className={INPUT}
                value={def[k]}
                onChange={(e) => setDef((d) => ({ ...d, [k]: Number(e.target.value) || 0 }))}
                onBlur={() => onSaveDefault(def)}
              />
            </label>
          ))}
        </div>

        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-sdc-border text-left text-label font-semibold uppercase text-sdc-gray-600">
              <th className="py-1.5">Year</th>
              <th className="py-1.5">Eng $/hr</th>
              <th className="py-1.5">Shop $/hr</th>
              <th className="py-1.5">PM %</th>
              <th className="py-1.5">Mfg %</th>
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
                {(["engRate", "shopRate", "pmPct", "mfgPct"] as const).map((k) => (
                  <td key={k} className="py-1.5 pr-2">
                    <input
                      type="number"
                      min={0}
                      step={k === "engRate" || k === "shopRate" ? 5 : 0.5}
                      className={`${INPUT} w-24`}
                      placeholder={String(def[k])}
                      value={fieldValue(year, k)}
                      onChange={(e) => setField(year, k, e.target.value)}
                      onBlur={() => blurField(year)}
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

        <div className="mt-5 flex items-center gap-2">
          <button className={BUTTON_COMPACT_DANGER} onClick={() => { setRows({}); void onClearAll(); }}>Clear all</button>
          <div className="flex-1" />
          <button className={BUTTON_SECONDARY} onClick={onClose}>Close</button>
          <button className={BUTTON_PRIMARY} onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
