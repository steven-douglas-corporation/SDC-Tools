"use client";

import { useMemo, useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import {
  computeKpis,
  buildProjectRows,
  compareLines as compareLinesFn,
  currentMonthKey,
  shiftMonth,
  formatMonthLabel,
  type ProjectFlowRow,
} from "@/lib/cash-flow-view";
import type { CashFlowLine } from "@/lib/cash-flow-normalize";
import { usd, usdExact } from "@/components/ui/format";
import { CashFlowDrillDrawer } from "@/components/CashFlowDrillDrawer";
import { CashFlowPlanningDrawer } from "@/components/CashFlowPlanningDrawer";
import { loadProjectPlanning } from "@/lib/cash-flow-actions";
import type { ProjectEstimate, AsOf, SnapshotSummary } from "@/lib/cash-flow";
import type { EtcAllocationRow, ForecastOverrideRow } from "@/lib/cash-flow-snapshot-store";

const MONTHS_VISIBLE = 6;

function asOfParamValue(asOf: AsOf): string {
  return asOf.kind === "current" ? "current" : String(asOf.snapshot.id);
}

function formatSnapshotOption(s: SnapshotSummary): string {
  const d = new Date(s.snapshotDate);
  const label = d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
  return `${label} (#${s.id})`;
}

function Kpi({ label, value, tone }: { label: string; value: string; tone?: "green" | "red" }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border border-sdc-border bg-white px-3 py-2">
      <span className="text-label font-semibold uppercase tracking-wide text-sdc-muted">{label}</span>
      <span className={`font-mono text-lg font-bold tabular-nums ${tone === "green" ? "text-sdc-green-text" : tone === "red" ? "text-sdc-red-text" : "text-sdc-navy"}`}>{value}</span>
    </div>
  );
}

type DrillTarget = { projectId: string; jobName: string | null; forecastMonth: string; category: "AR" | "AP" | "PO" };
type PlanningTarget = { projectId: string; jobName: string | null; remainingCost: number | null };

export function CashFlowClient({
  estimates,
  lines,
  compareLines,
  snapshots,
  asOf,
  compareAsOf,
}: {
  estimates: ProjectEstimate[];
  lines: CashFlowLine[];
  compareLines: CashFlowLine[] | null;
  snapshots: SnapshotSummary[];
  asOf: AsOf;
  compareAsOf: AsOf | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [drill, setDrill] = useState<DrillTarget | null>(null);
  const [planning, setPlanning] = useState<PlanningTarget | null>(null);
  const [planningData, setPlanningData] = useState<{ etcAllocations: EtcAllocationRow[]; arOverrides: ForecastOverrideRow[] } | null>(null);
  const [monthOffset, setMonthOffset] = useState(0);

  const today = useMemo(() => new Date(), []);
  const thisMonth = currentMonthKey(today);
  const kpis = useMemo(() => computeKpis(lines, today), [lines, today]);
  const projectRows = useMemo(() => buildProjectRows(estimates, lines), [estimates, lines]);
  const comparisonRows = useMemo(() => (compareLines ? compareLinesFn(lines, compareLines) : null), [lines, compareLines]);

  const visibleMonths = useMemo(() => {
    const start = shiftMonth(thisMonth, monthOffset);
    return Array.from({ length: MONTHS_VISIBLE }, (_, i) => shiftMonth(start, i));
  }, [thisMonth, monthOffset]);

  const readOnly = asOf.kind !== "current"; // historical snapshots are immutable — no drill line-items, no editing

  function setParam(key: string, value: string) {
    const qs = new URLSearchParams(searchParams.toString());
    qs.set(key, value);
    router.push(`${pathname}?${qs.toString()}`);
  }

  async function openPlanning(row: ProjectFlowRow) {
    setPlanning({ projectId: row.projectId, jobName: row.jobName, remainingCost: row.remainingCost });
    setPlanningData(null);
    const data = await loadProjectPlanning(row.projectId);
    setPlanningData(data);
  }

  return (
    <div className="flex flex-col gap-5">
      {/* As Of / Compare To */}
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-semibold text-sdc-gray-600">As Of</label>
          <select
            value={asOfParamValue(asOf)}
            onChange={(e) => setParam("as", e.target.value)}
            className="h-8 rounded-lg border border-sdc-border bg-white px-2 text-sm text-sdc-navy outline-none focus:border-sdc-blue"
          >
            <option value="current">Current</option>
            {snapshots.map((s) => (
              <option key={s.id} value={s.id}>
                {formatSnapshotOption(s)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-semibold text-sdc-gray-600">Compare To</label>
          <select
            value={compareAsOf ? asOfParamValue(compareAsOf) : "none"}
            onChange={(e) => setParam("compare", e.target.value)}
            className="h-8 rounded-lg border border-sdc-border bg-white px-2 text-sm text-sdc-navy outline-none focus:border-sdc-blue"
          >
            <option value="none">None</option>
            <option value="current">Current</option>
            {snapshots
              .filter((s) => !(asOf.kind === "snapshot" && s.id === asOf.snapshot.id))
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {formatSnapshotOption(s)}
                </option>
              ))}
          </select>
        </div>
        {readOnly && (
          <p className="rounded border border-sdc-yellow bg-sdc-yellow-bg px-2 py-1 text-note text-sdc-yellow-text">
            Viewing a historical snapshot — immutable. Line-item drill-through and PM forecast edits are only available on Current.
          </p>
        )}
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        <Kpi label="Incoming — This Month" value={usd(kpis.incomingCurrentMonth)} />
        <Kpi label="Outgoing — This Month" value={usd(kpis.outgoingCurrentMonth)} />
        <Kpi label="Net Cash Flow" value={usd(kpis.netCurrentMonth)} tone={kpis.netCurrentMonth >= 0 ? "green" : "red"} />
        <Kpi label="Next 30 Days In" value={usd(kpis.next30Incoming)} />
        <Kpi label="Next 30 Days Out" value={usd(kpis.next30Outgoing)} />
        <Kpi label="AR Unknown Due" value={usd(kpis.arUnknown)} />
        <Kpi label="AP Unknown Due" value={usd(kpis.apUnknown)} />
        <Kpi label="PO Unknown Due" value={usd(kpis.poUnknown)} />
        {comparisonRows && (
          <Kpi
            label="Forecast Δ vs Compare"
            value={usd(comparisonRows.reduce((s, r) => s + (r.flowType === "incoming" ? r.changeAmount : -r.changeAmount), 0))}
          />
        )}
      </div>

      {/* Comparison table */}
      {comparisonRows && compareAsOf && (
        <section className="overflow-hidden rounded-xl border border-sdc-border bg-white shadow-sm">
          <header className="border-b border-sdc-border bg-sdc-gray-50 px-3.5 py-2 text-sm font-bold text-sdc-navy">
            {asOfParamValue(asOf) === "current" ? "Current" : formatSnapshotOption(asOf.kind === "snapshot" ? asOf.snapshot : snapshots[0])} vs{" "}
            {compareAsOf.kind === "current" ? "Current" : formatSnapshotOption(compareAsOf.snapshot)}
          </header>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-sdc-gray-50 text-label uppercase tracking-wide text-sdc-muted">
                <tr className="[&>th]:px-3 [&>th]:py-1.5 [&>th]:text-left">
                  <th>Month</th>
                  <th>Flow</th>
                  <th className="text-right">Current</th>
                  <th className="text-right">Previous</th>
                  <th className="text-right">Change $</th>
                  <th className="text-right">Change %</th>
                </tr>
              </thead>
              <tbody className="[&>tr]:border-t [&>tr]:border-sdc-border-soft">
                {comparisonRows
                  .filter((r) => r.current !== 0 || r.previous !== 0)
                  .map((r) => (
                    <tr key={`${r.forecastMonth}-${r.flowType}`}>
                      <td className="px-3 py-1.5 font-mono text-sdc-navy">{formatMonthLabel(r.forecastMonth)}</td>
                      <td className="px-3 py-1.5 capitalize text-sdc-muted">{r.flowType}</td>
                      <td className="px-3 py-1.5 text-right font-mono tabular-nums" title={usdExact(r.current)}>
                        {usd(r.current)}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono tabular-nums text-sdc-muted" title={usdExact(r.previous)}>
                        {usd(r.previous)}
                      </td>
                      <td className={`px-3 py-1.5 text-right font-mono tabular-nums font-semibold ${r.changeAmount > 0 ? "text-sdc-green-text" : r.changeAmount < 0 ? "text-sdc-red-text" : "text-sdc-muted"}`}>
                        {r.changeAmount > 0 ? "+" : ""}
                        {usd(r.changeAmount)}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono tabular-nums text-sdc-muted">{r.changePercent == null ? "—" : `${r.changePercent > 0 ? "+" : ""}${r.changePercent}%`}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Month window paging */}
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => setMonthOffset((o) => o - 1)} className="rounded border border-sdc-border px-2 py-1 text-sm text-sdc-blue hover:bg-sdc-blue-light/40">
          ← Earlier
        </button>
        <span className="text-sm text-sdc-muted">
          {formatMonthLabel(visibleMonths[0])} – {formatMonthLabel(visibleMonths[visibleMonths.length - 1])}
        </span>
        <button type="button" onClick={() => setMonthOffset((o) => o + 1)} className="rounded border border-sdc-border px-2 py-1 text-sm text-sdc-blue hover:bg-sdc-blue-light/40">
          Later →
        </button>
        {monthOffset !== 0 && (
          <button type="button" onClick={() => setMonthOffset(0)} className="text-xs font-medium text-sdc-muted hover:underline">
            Back to today
          </button>
        )}
      </div>

      {/* Main project table */}
      <div className="overflow-x-auto rounded-xl border border-sdc-border bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="bg-sdc-gray-50 text-label uppercase tracking-wide text-sdc-muted">
            <tr className="[&>th]:whitespace-nowrap [&>th]:px-3 [&>th]:py-2 [&>th]:text-left">
              <th>Project</th>
              <th>Customer</th>
              <th className="text-right">Sales Price</th>
              <th className="text-right">Remaining Cost</th>
              {visibleMonths.map((m) => (
                <th key={m} className="text-center" colSpan={2}>
                  {formatMonthLabel(m)}
                </th>
              ))}
              <th className="text-right">Unknown</th>
            </tr>
          </thead>
          <tbody className="[&>tr]:border-t [&>tr]:border-sdc-border-soft">
            {projectRows.map((row) => (
              <tr key={row.projectId} className="hover:bg-sdc-blue-light/20">
                <td className="px-3 py-2">
                  <button type="button" onClick={() => openPlanning(row)} className="font-medium text-sdc-navy hover:text-sdc-blue hover:underline" title="Plan ETC / override forecast">
                    {row.jobName ?? row.projectId}
                  </button>
                  <div className="font-mono text-label text-sdc-muted">{row.projectId}</div>
                </td>
                <td className="max-w-[10rem] truncate px-3 py-2 text-sdc-muted" title={row.customer ?? undefined}>
                  {row.customer ?? "—"}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-sdc-navy">{usd(row.salesPrice)}</td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-sdc-muted">{row.remainingCost != null ? usd(row.remainingCost) : "—"}</td>
                {visibleMonths.map((m) => {
                  const totals = row.byMonth.get(m);
                  return (
                    <MonthCells
                      key={m}
                      incoming={totals?.incoming ?? 0}
                      outgoing={totals?.outgoing ?? 0}
                      onIn={() => !readOnly && (totals?.ar ?? 0) !== 0 && setDrill({ projectId: row.projectId, jobName: row.jobName, forecastMonth: m, category: "AR" })}
                      onOut={() => !readOnly && setDrill({ projectId: row.projectId, jobName: row.jobName, forecastMonth: m, category: (totals?.po ?? 0) !== 0 ? "PO" : "AP" })}
                    />
                  );
                })}
                <td className="px-3 py-2 text-right font-mono tabular-nums text-sdc-muted">
                  {row.unknown.ar + row.unknown.ap + row.unknown.po !== 0 ? usd(row.unknown.ar + row.unknown.ap + row.unknown.po) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {drill && (
        <CashFlowDrillDrawer projectId={drill.projectId} jobName={drill.jobName} forecastMonth={drill.forecastMonth} category={drill.category} onClose={() => setDrill(null)} />
      )}

      {planning && planningData && (
        <CashFlowPlanningDrawer
          projectId={planning.projectId}
          jobName={planning.jobName}
          remainingCost={planning.remainingCost}
          etcAllocations={planningData.etcAllocations}
          arOverrides={planningData.arOverrides}
          months={visibleMonths}
          onClose={() => {
            setPlanning(null);
            setPlanningData(null);
          }}
          onEtcSaved={(forecastMonth, amount, note) =>
            setPlanningData((prev) =>
              prev
                ? { ...prev, etcAllocations: [...prev.etcAllocations.filter((a) => a.forecastMonth !== forecastMonth), { projectId: planning.projectId, forecastMonth, amount, note, updatedByEmail: null, updatedAt: new Date() }] }
                : prev,
            )
          }
          onOverrideSaved={(forecastMonth, amount, note) =>
            setPlanningData((prev) =>
              prev
                ? {
                    ...prev,
                    arOverrides: [
                      ...prev.arOverrides.filter((o) => o.forecastMonth !== forecastMonth),
                      { projectId: planning.projectId, category: "AR", forecastMonth, amount, note, updatedByEmail: null, updatedAt: new Date() },
                    ],
                  }
                : prev,
            )
          }
        />
      )}
    </div>
  );
}

function MonthCells({ incoming, outgoing, onIn, onOut }: { incoming: number; outgoing: number; onIn: () => void; onOut: () => void }) {
  return (
    <>
      <td className="px-2 py-2 text-right">
        <button type="button" onClick={onIn} disabled={incoming === 0} className="font-mono tabular-nums text-sdc-green-text hover:underline disabled:text-sdc-gray-300 disabled:no-underline">
          {incoming !== 0 ? usd(incoming) : "—"}
        </button>
      </td>
      <td className="px-2 py-2 text-right">
        <button type="button" onClick={onOut} disabled={outgoing === 0} className="font-mono tabular-nums text-sdc-red-text hover:underline disabled:text-sdc-gray-300 disabled:no-underline">
          {outgoing !== 0 ? usd(outgoing) : "—"}
        </button>
      </td>
    </>
  );
}
