"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { BUTTON_SECONDARY, TOOLBAR_MIN_W } from "@/components/ui/classnames";
import { saveStandardRates } from "@/lib/execution-rate-actions";

// The "ETC Rates" toolbar control for the Monthly ETC grid's inline Standard
// Sheet view. It replaces the old per-job ENGR/Shop/Parts rate columns with a
// single global rate set: enter the three values once here and every row's
// Total ETC $ / % Total / Standard Fees recalculate from them. Saving persists
// to StandardSheetSetting and revalidates /etc, so the grid refreshes.
export function EtcRatesButton({
  engrRate,
  shopRate,
  partsMarkup,
  contingencyRate,
  disabled,
}: {
  engrRate: number;
  shopRate: number;
  partsMarkup: number;
  contingencyRate: number;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [engr, setEngr] = useState(String(engrRate));
  const [shop, setShop] = useState(String(shopRate));
  const [parts, setParts] = useState(String(partsMarkup));
  const [conting, setConting] = useState(String(contingencyRate));
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const wrapRef = useRef<HTMLDivElement>(null);

  // Open the panel, seeding the inputs from the currently-persisted values
  // (which reflect the latest save after each revalidate). Seeding on open —
  // rather than syncing props into state via an effect — keeps state changes
  // out of render/effect passes.
  const openPanel = useCallback(() => {
    setEngr(String(engrRate));
    setShop(String(shopRate));
    setParts(String(partsMarkup));
    setConting(String(contingencyRate));
    setError(null);
    setOpen(true);
  }, [engrRate, shopRate, partsMarkup, contingencyRate]);

  // Close on outside click / Escape, like a normal popover.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function save() {
    const e = Number(engr);
    const s = Number(shop);
    const p = Number(parts);
    const c = Number(conting);
    if (![e, s, p, c].every((n) => Number.isFinite(n) && n >= 0)) {
      setError("Enter valid non-negative numbers.");
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        await saveStandardRates(e, s, p, c);
        setOpen(false);
      } catch {
        setError("Could not save — try again.");
      }
    });
  }

  const field = "w-24 rounded-md border border-sdc-border px-2 py-1.5 text-sm text-right outline-none focus:border-sdc-blue disabled:opacity-50";

  return (
    <div ref={wrapRef} className="relative">
      <button type="button" className={`${BUTTON_SECONDARY} ${TOOLBAR_MIN_W} justify-center`} onClick={() => (open ? setOpen(false) : openPanel())} title="Set the global ENGR / Shop / Parts rates used to compute the Standard Sheet values.">
        ETC Rates
      </button>
      {open && (
        <div className="motion-menu-panel absolute left-0 top-full z-30 mt-1 w-64 rounded-lg border border-sdc-border bg-white p-3 shadow-lg">
          <p className="mb-2 text-xs font-semibold text-sdc-navy">ETC Rates (applied to all jobs)</p>
          <div className="space-y-2">
            <label className="flex items-center justify-between gap-2 text-sm text-sdc-navy">
              <span>ENGR rate</span>
              <input type="number" step="0.01" min="0" value={engr} onChange={(e) => setEngr(e.target.value)} disabled={disabled || pending} className={field} aria-label="ENGR rate" />
            </label>
            <label className="flex items-center justify-between gap-2 text-sm text-sdc-navy">
              <span>Shop rate</span>
              <input type="number" step="0.01" min="0" value={shop} onChange={(e) => setShop(e.target.value)} disabled={disabled || pending} className={field} aria-label="Shop rate" />
            </label>
            <label className="flex items-center justify-between gap-2 text-sm text-sdc-navy">
              <span>Parts markup</span>
              <input type="number" step="0.01" min="0" value={parts} onChange={(e) => setParts(e.target.value)} disabled={disabled || pending} className={field} aria-label="Parts markup" />
            </label>
            <label className="flex items-center justify-between gap-2 border-t border-sdc-border pt-2 text-sm text-sdc-navy">
              <span>Contingency rate</span>
              <input type="number" step="0.01" min="0" value={conting} onChange={(e) => setConting(e.target.value)} disabled={disabled || pending} className={field} aria-label="Contingency rate" />
            </label>
          </div>
          {disabled && (
            <p className="mt-2 text-xs text-sdc-muted">This month is submitted and frozen — rates cannot be changed.</p>
          )}
          {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
          <div className="mt-3 flex justify-end gap-2">
            <button type="button" className="rounded-md px-3 py-1.5 text-sm text-sdc-gray-600 hover:bg-sdc-gray-100" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={disabled || pending}
              className="rounded-md bg-sdc-blue px-3 py-1.5 text-sm font-semibold text-white hover:bg-sdc-blue-dark disabled:cursor-not-allowed disabled:opacity-50"
            >
              {pending ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
