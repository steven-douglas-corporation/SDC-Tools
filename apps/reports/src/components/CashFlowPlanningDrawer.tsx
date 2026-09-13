"use client";

import { useState, useTransition } from "react";
import { BuildReadinessDrawer } from "@/components/build-readiness/BuildReadinessDrawer";
import { usd } from "@/components/ui/format";
import { setCashFlowEtcAllocation, setCashFlowForecastOverride } from "@/lib/cash-flow-actions";
import type { EtcAllocationRow, ForecastOverrideRow } from "@/lib/cash-flow-snapshot-store";

// PM forecast input (2026-08-19) — "System Actual / Committed" (the live
// Total ETO figures the rest of the page shows) is never touched by anything
// here; every write lands in CashFlowEtcAllocation/CashFlowForecastOverride
// only, and is audited (cash-flow-actions.ts, via the existing AuditLog).
// ELT-only in practice (the whole page is), so no separate `canEdit` prop —
// unlike Employees/Hiring's shared components, nothing here is ever rendered
// for a non-ELT viewer at all.

const MONTH_RE = /^\d{4}-\d{2}$/;

function MonthRow({
  forecastMonth,
  amount,
  note,
  onSave,
}: {
  forecastMonth: string;
  amount: number;
  note: string | null;
  onSave: (amount: number, note: string | null) => Promise<void>;
}) {
  const [value, setValue] = useState(String(amount));
  const [noteValue, setNoteValue] = useState(note ?? "");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const dirty = value !== String(amount) || noteValue !== (note ?? "");

  function save() {
    const n = Number(value);
    if (!Number.isFinite(n)) {
      setError("Enter a number.");
      return;
    }
    setError(null);
    startTransition(async () => {
      await onSave(n, noteValue.trim() || null);
    });
  }

  return (
    <div className="flex items-center gap-2 border-b border-sdc-border-soft px-3 py-2">
      <span className="w-16 shrink-0 font-mono text-sm text-sdc-navy">{forecastMonth}</span>
      <input
        type="number"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        disabled={pending}
        className="h-7 w-32 rounded border border-sdc-border px-1.5 text-right text-sm outline-none focus:border-sdc-blue"
      />
      <input
        type="text"
        value={noteValue}
        onChange={(e) => setNoteValue(e.target.value)}
        placeholder="Note…"
        disabled={pending}
        className="h-7 min-w-0 flex-1 rounded border border-sdc-border px-1.5 text-xs outline-none focus:border-sdc-blue"
      />
      <button
        type="button"
        onClick={save}
        disabled={pending || !dirty}
        className="h-7 shrink-0 rounded bg-sdc-blue px-2 text-xs font-semibold text-white disabled:opacity-40"
      >
        {pending ? "Saving…" : "Save"}
      </button>
      {error && <span className="text-label text-sdc-red-text">{error}</span>}
    </div>
  );
}

export function CashFlowPlanningDrawer({
  projectId,
  jobName,
  remainingCost,
  etcAllocations,
  arOverrides,
  months,
  onClose,
  onEtcSaved,
  onOverrideSaved,
}: {
  projectId: string;
  jobName: string | null;
  remainingCost: number | null;
  etcAllocations: EtcAllocationRow[];
  arOverrides: ForecastOverrideRow[];
  /** The months already visible on the page, offered as quick "add a row" choices. */
  months: string[];
  onClose: () => void;
  onEtcSaved: (forecastMonth: string, amount: number, note: string | null) => void;
  onOverrideSaved: (forecastMonth: string, amount: number, note: string | null) => void;
}) {
  const [newEtcMonth, setNewEtcMonth] = useState(months[0] ?? "");
  const [newArMonth, setNewArMonth] = useState(months[0] ?? "");

  const etcTotal = etcAllocations.reduce((s, a) => s + a.amount, 0);
  const etcRows = [...etcAllocations].sort((a, b) => a.forecastMonth.localeCompare(b.forecastMonth));
  const arRows = [...arOverrides].sort((a, b) => a.forecastMonth.localeCompare(b.forecastMonth));

  async function saveEtc(forecastMonth: string, amount: number, note: string | null) {
    const result = await setCashFlowEtcAllocation(projectId, forecastMonth, amount, note);
    if (result.ok) onEtcSaved(forecastMonth, amount, note);
  }

  async function saveOverride(forecastMonth: string, amount: number, note: string | null) {
    const result = await setCashFlowForecastOverride(projectId, forecastMonth, amount, note);
    if (result.ok) onOverrideSaved(forecastMonth, amount, note);
  }

  return (
    <BuildReadinessDrawer
      title={`Plan — ${jobName ?? projectId}`}
      subtitle={`Project ${projectId}`}
      breadcrumb={[`Plan — ${jobName ?? projectId}`]}
      onBreadcrumbClick={() => {}}
      onClose={onClose}
    >
      <div className="flex flex-col gap-6 p-4">
        <section>
          <div className="mb-2 flex items-baseline justify-between">
            <h3 className="text-sm font-bold text-sdc-navy">ETC monthly allocation</h3>
            <span className="text-xs text-sdc-muted">
              Allocated <span className={`font-semibold ${remainingCost != null && Math.abs(etcTotal - remainingCost) > 1 ? "text-sdc-yellow-text" : "text-sdc-green-text"}`}>{usd(etcTotal)}</span>
              {remainingCost != null && <> of remaining {usd(remainingCost)}</>}
            </span>
          </div>
          <p className="mb-2 text-note text-sdc-muted">When is the remaining project cost actually expected to be spent?</p>
          <div className="rounded-lg border border-sdc-border">
            {etcRows.length === 0 && <p className="px-3 py-3 text-note text-sdc-muted">No months allocated yet.</p>}
            {etcRows.map((a) => (
              <MonthRow key={a.forecastMonth} forecastMonth={a.forecastMonth} amount={a.amount} note={a.note} onSave={(amount, note) => saveEtc(a.forecastMonth, amount, note)} />
            ))}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <select value={newEtcMonth} onChange={(e) => setNewEtcMonth(e.target.value)} className="h-7 rounded border border-sdc-border px-1.5 text-xs">
              {months.filter((m) => !etcRows.some((r) => r.forecastMonth === m)).map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => MONTH_RE.test(newEtcMonth) && saveEtc(newEtcMonth, 0, null)}
              className="h-7 rounded border border-sdc-border px-2 text-xs font-medium text-sdc-blue hover:bg-sdc-blue-light/40"
            >
              + Add month
            </button>
          </div>
        </section>

        <section>
          <h3 className="mb-2 text-sm font-bold text-sdc-navy">AR forecast override</h3>
          <p className="mb-2 text-note text-sdc-muted">
            Replaces the TotalETO-derived AR figure for one month — never edits ERP data itself. Clear a row back to the
            system figure by deleting it in TotalETO&apos;s own sales terms, not here.
          </p>
          <div className="rounded-lg border border-sdc-border">
            {arRows.length === 0 && <p className="px-3 py-3 text-note text-sdc-muted">No overrides — every month shown uses the live TotalETO figure.</p>}
            {arRows.map((o) => (
              <MonthRow key={o.forecastMonth} forecastMonth={o.forecastMonth} amount={o.amount} note={o.note} onSave={(amount, note) => saveOverride(o.forecastMonth, amount, note)} />
            ))}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <select value={newArMonth} onChange={(e) => setNewArMonth(e.target.value)} className="h-7 rounded border border-sdc-border px-1.5 text-xs">
              {months.filter((m) => !arRows.some((r) => r.forecastMonth === m)).map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => MONTH_RE.test(newArMonth) && saveOverride(newArMonth, 0, null)}
              className="h-7 rounded border border-sdc-border px-2 text-xs font-medium text-sdc-blue hover:bg-sdc-blue-light/40"
            >
              + Add month
            </button>
          </div>
        </section>
      </div>
    </BuildReadinessDrawer>
  );
}
