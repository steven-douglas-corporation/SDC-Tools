"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { JobCostComputed, JobHourAllocation, YearRateOverrides, CostRates } from "@/lib/job-cost";
import { BUTTON_PRIMARY, BUTTON_SECONDARY, BUTTON_COMPACT_DANGER, INPUT } from "@/components/ui/classnames";

// Ported from the standalone app's per-job Hour Allocation modal
// (ensureJobRateMatrixModal/jobHoursBody/saveJobHoursMatrix in
// public/app.js) — a manual split of a job's Eng/Shop hours across years,
// each capped at the job's own actual hours for that type. Saved through a
// server action instead of localStorage.

type Row = { hours: string; type: "eng" | "shop"; year: string };

function capFor(row: JobCostComputed, type: "eng" | "shop"): number {
  return Math.round((type === "eng" ? row.engineeringHours : row.shopHours) || 0);
}

function knownYears(row: JobCostComputed): string[] {
  const set = new Set(Object.keys(row.hoursByYear ?? {}));
  if (row.completeDate) set.add(row.completeDate.slice(0, 4));
  if (set.size === 0) set.add(String(new Date().getFullYear()));
  return [...set].sort((a, b) => b.localeCompare(a));
}

function defaultRowsForType(row: JobCostComputed, type: "eng" | "shop"): Row[] {
  const hby = row.hoursByYear ?? {};
  const years = Object.keys(hby).filter((y) => Math.round(hby[y][type] || 0) > 0).sort((a, b) => b.localeCompare(a));
  if (years.length) return years.map((y) => ({ hours: String(Math.round(hby[y][type] || 0)), type, year: y }));
  const total = capFor(row, type);
  const fallbackYear = knownYears(row)[0];
  return total ? [{ hours: String(total), type, year: fallbackYear }] : [];
}

export function JobCostHourAllocationModal({
  row,
  allocation,
  onClose,
  onSave,
}: {
  row: JobCostComputed;
  rates: CostRates;
  overrides: YearRateOverrides;
  allocation: JobHourAllocation | null;
  onClose: () => void;
  onSave: (allocation: JobHourAllocation | null) => Promise<void>;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [rows, setRows] = useState<Row[]>(() =>
    allocation
      ? [...allocation.eng.map((r) => ({ hours: String(r.hours), type: "eng" as const, year: r.year })), ...allocation.shop.map((r) => ({ hours: String(r.hours), type: "shop" as const, year: r.year }))]
      : [...defaultRowsForType(row, "eng"), ...defaultRowsForType(row, "shop")],
  );
  const years = useMemo(() => knownYears(row), [row]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const caps = { eng: capFor(row, "eng"), shop: capFor(row, "shop") };
  const totals = {
    eng: Math.round(rows.filter((r) => r.type === "eng").reduce((s, r) => s + (Number(r.hours) || 0), 0)),
    shop: Math.round(rows.filter((r) => r.type === "shop").reduce((s, r) => s + (Number(r.hours) || 0), 0)),
  };
  const overCap = totals.eng > caps.eng || totals.shop > caps.shop;

  function updateRow(idx: number, patch: Partial<Row>) {
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }
  function addRow() {
    setRows((prev) => [...prev, { hours: "", type: "eng", year: years[0] }]);
  }
  function removeRow(idx: number) {
    setRows((prev) => prev.filter((_, i) => i !== idx));
  }

  async function apply() {
    if (overCap) return;
    const clean = (type: "eng" | "shop") =>
      rows.filter((r) => r.type === type && Number(r.hours) > 0 && r.year).map((r) => ({ hours: Math.round(Number(r.hours)), year: r.year }));
    const eng = clean("eng");
    const shop = clean("shop");
    await onSave(eng.length || shop.length ? { eng, shop } : null);
    onClose();
  }
  async function clearAll() {
    await onSave(null);
    onClose();
  }

  return (
    <div
      className="motion-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => {
        if (!dialogRef.current?.contains(e.target as Node)) onClose();
      }}
    >
      <div ref={dialogRef} className="max-h-[calc(var(--app-vh)_*_0.85)] w-full max-w-lg overflow-auto rounded-xl border border-sdc-border bg-white p-5 shadow-lg">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-heading text-base font-semibold text-sdc-navy">Job Hours — Job {row.jobId}</h2>
          <button className="text-2xl leading-none text-sdc-gray-400 hover:text-sdc-navy" aria-label="Close" onClick={onClose}>×</button>
        </div>

        <div className="mb-3 flex gap-4 text-sm">
          <span className={totals.eng > caps.eng ? "font-semibold text-sdc-red-text" : "text-sdc-navy"}>
            Engineering: {totals.eng} / {caps.eng} hrs
          </span>
          <span className={totals.shop > caps.shop ? "font-semibold text-sdc-red-text" : "text-sdc-navy"}>
            Shop: {totals.shop} / {caps.shop} hrs
          </span>
        </div>

        <div className="flex flex-col gap-2">
          {rows.length === 0 && <p className="text-sm text-sdc-muted">No rows yet.</p>}
          {rows.map((r, idx) => (
            <div key={idx} className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                step={1}
                placeholder="hrs"
                className={`${INPUT} w-24`}
                value={r.hours}
                onChange={(e) => updateRow(idx, { hours: e.target.value })}
              />
              <select className={INPUT} value={r.type} onChange={(e) => updateRow(idx, { type: e.target.value as "eng" | "shop" })}>
                <option value="eng">Engineering</option>
                <option value="shop">Shop</option>
              </select>
              <select className={INPUT} value={r.year} onChange={(e) => updateRow(idx, { year: e.target.value })}>
                {years.map((y) => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </select>
              <button className="text-lg text-sdc-gray-400 hover:text-sdc-red-text" title="Remove row" onClick={() => removeRow(idx)}>×</button>
            </div>
          ))}
          <button className={`${BUTTON_SECONDARY} self-start`} onClick={addRow}>+ Add row</button>
        </div>

        {overCap && (
          <p className="mt-3 text-xs text-sdc-red-text">
            Allocated hours exceed this job&apos;s actual total. Remove or reduce a row before applying.
          </p>
        )}
        <p className="mt-3 text-note text-sdc-muted">
          Hours here are costed at the rate for the selected year (global Rate Matrix, or the default). Overrides apply to job {row.jobId} only.
        </p>

        <div className="mt-5 flex items-center gap-2">
          <button className={BUTTON_COMPACT_DANGER} onClick={clearAll}>Clear job overrides</button>
          <div className="flex-1" />
          <button className={BUTTON_SECONDARY} onClick={onClose}>Close</button>
          <button className={BUTTON_PRIMARY} disabled={overCap} onClick={apply}>Apply</button>
        </div>
      </div>
    </div>
  );
}
