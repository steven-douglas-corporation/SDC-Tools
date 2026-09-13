"use client";

import { useMemo } from "react";
import { usd } from "@/components/ui/format";
import { useColumnSort } from "@/components/useColumnSort";
import { SortableTh } from "@/components/ui/SortableHeader";
import { sortRows, type SortColumns } from "@/lib/table-sort";
import { EmptyState } from "@/components/ui/EmptyState";
import { ReadinessPill } from "@/components/build-readiness/ReadinessPill";
import { computeUpcomingUnlocks } from "@/lib/build-readiness-forecast";
import type { AssemblyDetail, JobSnapshotRow, BlockerEntry, BlockerReason, UpcomingDeliveryEntry } from "@/lib/build-readiness-types";
import type { DrillFrame } from "./useDrillStack";
import { useStableNow } from "@/lib/use-stable-now";

// ── Small, table-shaped drilldowns — everything except the PO drawer (reused
// as-is), the live assembly-part-list fetch (BuildReadinessAssemblyDetail.tsx)
// and the cross-job supplier rollup (BuildReadinessSupplierDrill.tsx), which
// each need their own imports/state. See useDrillStack.ts's DrillFrame for
// the full catalog and the plan's reconciliation-map comment for exactly
// which snapshot field each view below filters, and why. ────────────────────

function num(n: number): string {
  return Math.round(n).toLocaleString();
}
function fmtDate(s: string | null): string {
  if (!s) return "—";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// ── Assemblies (Job ID / Project / Readiness % / Assemblies / Ready / Partial / Blocked) ──

type AsmSortKey = "assembly" | "release" | "required" | "covered" | "readiness" | "buildable" | "missing" | "onOrder" | "pastDue" | "nextDelivery" | "estBuildable";

const ASM_COLUMNS: SortColumns<AssemblyDetail, AsmSortKey> = {
  assembly: { type: "text", value: (r) => r.label },
  release: { type: "text", value: (r) => r.release },
  required: { type: "number", value: (r) => r.requiredQty },
  covered: { type: "number", value: (r) => r.coveredQty },
  readiness: { type: "number", value: (r) => r.readinessPct },
  buildable: { type: "number", value: (r) => r.buildableQty },
  missing: { type: "number", value: (r) => r.missingParts },
  onOrder: { type: "number", value: (r) => r.onOrderParts },
  pastDue: { type: "number", value: (r) => r.pastDueParts },
  nextDelivery: { type: "date", value: (r) => r.nextExpectedDelivery },
  estBuildable: { type: "date", value: (r) => r.estimatedBuildableDate },
};

const RELEASE_LABEL: Record<AssemblyDetail["release"], string> = {
  contentsOnly: "Contents Only",
  assemblyOnly: "Assembly Only",
  bothAssemblyAndContents: "Both Assembly + Contents",
};

// The base "counted" set every assemblies-total-derived KPI (Assemblies/
// Ready/Partial/Blocked) shares — a "Contents Only" container has no buy/
// build unit concept and doesn't count toward `assembliesTotal` in
// build-readiness-sync.ts, so it must not appear here either, or the row
// count would exceed the KPI this view is supposed to reconcile with.
export function filterAssemblies(assemblies: AssemblyDetail[], filter: "all" | "ready" | "partial" | "blocked"): AssemblyDetail[] {
  const counted = assemblies.filter((a) => a.buildableQty !== null);
  switch (filter) {
    case "all":
      return counted;
    case "ready":
      return counted.filter((a) => a.buildableQty! >= a.requiredQty);
    case "partial":
      return counted.filter((a) => a.buildableQty! > 0 && a.buildableQty! < a.requiredQty);
    case "blocked":
      return counted.filter((a) => a.buildableQty === 0);
  }
}

export function AssembliesDrillView({
  job,
  filter,
  push,
  onRefresh,
  refreshing,
}: {
  job: JobSnapshotRow;
  filter: "all" | "ready" | "partial" | "blocked";
  push: (f: DrillFrame) => void;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const sort = useColumnSort<AsmSortKey>();
  const filtered = useMemo(() => filterAssemblies(job.detail.assemblies, filter), [job.detail.assemblies, filter]);
  const rows = useMemo(() => sortRows(filtered, sort.sort, ASM_COLUMNS), [filtered, sort.sort]);
  const v = "border-l border-sdc-border-soft";

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-sdc-gray-600">Computed {new Date(job.computedAt).toLocaleString()}</p>
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          className="rounded-md border border-sdc-border bg-white px-2.5 py-1 text-xs font-medium text-sdc-navy hover:bg-sdc-blue-light disabled:cursor-not-allowed disabled:opacity-50"
        >
          {refreshing ? "Refreshing…" : "Refresh this project"}
        </button>
      </div>
      {rows.length === 0 ? (
        <EmptyState title="No assemblies match this view." />
      ) : (
        <div className="overflow-auto rounded-lg border border-sdc-border">
          <table className="w-full min-w-[900px] border-collapse text-left">
            <thead className="sticky top-0 z-[1]">
              <tr className="bg-sdc-navy text-micro font-bold uppercase tracking-wider text-white">
                <SortableTh label="Assembly" sortKey="assembly" type="text" sort={sort.sort} onSort={sort.onSort} className="px-3 py-2" />
                <SortableTh label="Release Status" sortKey="release" type="text" sort={sort.sort} onSort={sort.onSort} className={`px-2 py-2 ${v}`} />
                <SortableTh label="Required Qty" sortKey="required" type="number" sort={sort.sort} onSort={sort.onSort} className={`px-2 py-2 ${v}`} />
                <SortableTh label="Covered Qty" sortKey="covered" type="number" sort={sort.sort} onSort={sort.onSort} className={`px-2 py-2 ${v}`} />
                <SortableTh label="Readiness %" sortKey="readiness" type="number" sort={sort.sort} onSort={sort.onSort} className={`px-2 py-2 ${v}`} />
                <SortableTh label="Buildable Now" sortKey="buildable" type="number" sort={sort.sort} onSort={sort.onSort} className={`px-2 py-2 ${v}`} />
                <SortableTh label="Missing" sortKey="missing" type="number" sort={sort.sort} onSort={sort.onSort} className={`px-2 py-2 ${v}`} />
                <SortableTh label="On Order" sortKey="onOrder" type="number" sort={sort.sort} onSort={sort.onSort} className={`px-2 py-2 ${v}`} />
                <SortableTh label="Past Due" sortKey="pastDue" type="number" sort={sort.sort} onSort={sort.onSort} className={`px-2 py-2 ${v}`} />
                <SortableTh label="Next Expected" sortKey="nextDelivery" type="date" sort={sort.sort} onSort={sort.onSort} className={`px-2 py-2 ${v}`} />
                <SortableTh label="Est. Buildable" sortKey="estBuildable" type="date" sort={sort.sort} onSort={sort.onSort} className={`px-2 py-2 ${v}`} />
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr
                  key={a.key}
                  onClick={() => push({ kind: "assemblyDetail", jobId: job.jobId, assemblyKeys: [a.key] })}
                  className="group cursor-pointer border-b border-sdc-border-soft/60 hover:bg-sdc-blue-light/20"
                  title={a.limitingParts.length ? `Limiting: ${a.limitingParts.map((lp) => `${lp.pn} (${lp.available}/${lp.required})`).join(", ")}` : undefined}
                >
                  <td className="px-3 py-1.5 text-note font-semibold text-sdc-blue group-hover:underline">{a.label}</td>
                  <td className={`px-2 py-1.5 text-note text-sdc-gray-600 ${v}`}>{RELEASE_LABEL[a.release]}</td>
                  <td className={`px-2 py-1.5 text-right font-mono text-note tabular-nums ${v}`}>{num(a.requiredQty)}</td>
                  <td className={`px-2 py-1.5 text-right font-mono text-note tabular-nums ${v}`}>{num(a.coveredQty)}</td>
                  <td className={`px-2 py-1.5 text-right ${v}`}>
                    <span className="inline-flex justify-end">
                      <ReadinessPill pct={a.readinessPct} />
                    </span>
                  </td>
                  <td className={`px-2 py-1.5 text-right font-mono text-note font-semibold tabular-nums ${v} ${a.buildableQty == null ? "text-sdc-gray-400" : a.buildableQty >= a.requiredQty ? "text-sdc-green-text" : a.buildableQty > 0 ? "text-sdc-yellow-text" : "text-sdc-red-text"}`}>
                    {a.buildableQty == null ? "—" : `${num(a.buildableQty)} (${a.buildablePct}%)`}
                  </td>
                  <td className={`px-2 py-1.5 text-right font-mono text-note tabular-nums text-sdc-red-text ${v}`}>{num(a.missingParts)}</td>
                  <td className={`px-2 py-1.5 text-right font-mono text-note tabular-nums ${v}`}>{num(a.onOrderParts)}</td>
                  <td className={`px-2 py-1.5 text-right font-mono text-note tabular-nums text-sdc-red-text ${v}`}>{num(a.pastDueParts)}</td>
                  <td className={`whitespace-nowrap px-2 py-1.5 font-mono text-label text-sdc-gray-600 ${v}`}>{fmtDate(a.nextExpectedDelivery)}</td>
                  <td className={`whitespace-nowrap px-2 py-1.5 font-mono text-label text-sdc-gray-600 ${v}`}>{fmtDate(a.estimatedBuildableDate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Blocker rows — shared by Missing/Past Due (job-scoped) and Top Blockers
// (cross-job, `showJobColumn`) ───────────────────────────────────────────────

export function BlockerRowsTable({ rows, push, showJobColumn }: { rows: BlockerEntry[]; push: (f: DrillFrame) => void; showJobColumn: boolean }) {
  if (rows.length === 0) return <EmptyState title="Nothing here." />;
  const v = "border-l border-white/15";
  const vBody = "border-l border-sdc-border-soft";
  return (
    <div className="overflow-auto rounded-lg border border-sdc-border">
      <table className="w-full min-w-[760px] border-collapse text-left">
        <thead className="sticky top-0 z-[1]">
          <tr className="bg-sdc-navy text-micro font-bold uppercase tracking-wider text-white">
            {showJobColumn && <th className="px-3 py-2">Project</th>}
            <th className={`px-2 py-2 ${showJobColumn ? v : "px-3"}`}>Assembly</th>
            <th className={`px-2 py-2 ${v}`}>Part</th>
            <th className={`px-2 py-2 ${v}`}>Supplier</th>
            <th className={`px-2 py-2 text-right ${v}`}>Material $</th>
            <th className={`px-2 py-2 text-right ${v}`}>Days Late</th>
            <th className={`px-2 py-2 ${v}`}>Expected</th>
            <th className={`px-2 py-2 ${v}`}>PO</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((b, i) => (
            <tr key={`${b.jobId}-${b.assemblyKey}-${b.partPn}-${i}`} className="border-b border-sdc-border-soft/60 hover:bg-sdc-blue-light/20">
              {showJobColumn && (
                <td className="px-3 py-1.5">
                  <button type="button" onClick={() => push({ kind: "assemblies", jobId: b.jobId, filter: "all" })} className="font-mono text-note font-semibold text-sdc-blue hover:underline">
                    {b.jobId}
                  </button>
                </td>
              )}
              <td className={`px-2 py-1.5 ${showJobColumn ? vBody : ""}`}>
                <button type="button" onClick={() => push({ kind: "assemblyDetail", jobId: b.jobId, assemblyKeys: [b.assemblyKey], highlightPn: b.partPn })} className="text-note text-sdc-blue hover:underline">
                  {b.assemblyLabel}
                </button>
              </td>
              <td className={`px-2 py-1.5 font-mono text-note text-sdc-navy ${vBody}`} title={b.partDesc}>{b.partPn}</td>
              <td className={`px-2 py-1.5 text-note text-sdc-gray-600 ${vBody}`}>{b.supplier ?? "—"}</td>
              <td className={`px-2 py-1.5 text-right font-mono text-note tabular-nums ${vBody}`}>{usd(b.materialValue)}</td>
              <td className={`px-2 py-1.5 text-right font-mono text-note tabular-nums text-sdc-red-text ${vBody}`}>{b.daysLate ?? "—"}</td>
              <td className={`whitespace-nowrap px-2 py-1.5 font-mono text-label text-sdc-gray-600 ${vBody}`}>{fmtDate(b.expectedDate)}</td>
              <td className={`px-2 py-1.5 ${vBody}`}>
                {b.poNumber ? (
                  <button type="button" onClick={() => push({ kind: "po", jobId: b.jobId, supplier: b.supplier, poNumber: b.poNumber! })} className="font-mono text-note text-sdc-blue hover:underline">
                    {b.poNumber}
                  </button>
                ) : (
                  <span className="text-note text-sdc-gray-400">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Upcoming-delivery rows — shared by Due≤7d/On Order (job-scoped), Next
// Unlock (job-scoped), and the 8-Week Forecast drill (cross-job, `showJobColumn`) ──

export function UpcomingRowsTable({ rows, push, showJobColumn }: { rows: UpcomingDeliveryEntry[]; push: (f: DrillFrame) => void; showJobColumn: boolean }) {
  if (rows.length === 0) return <EmptyState title="Nothing here." />;
  const v = "border-l border-white/15";
  const vBody = "border-l border-sdc-border-soft";
  return (
    <div className="overflow-auto rounded-lg border border-sdc-border">
      <table className="w-full min-w-[640px] border-collapse text-left">
        <thead className="sticky top-0 z-[1]">
          <tr className="bg-sdc-navy text-micro font-bold uppercase tracking-wider text-white">
            <th className="px-3 py-2">Expected</th>
            {showJobColumn && <th className={`px-2 py-2 ${v}`}>Job</th>}
            <th className={`px-2 py-2 ${v}`}>PO</th>
            <th className={`px-2 py-2 ${v}`}>Supplier</th>
            <th className={`px-2 py-2 ${v}`}>Assembly</th>
            <th className={`px-2 py-2 ${v}`}>Part</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((u, i) => (
            <tr key={`${u.jobId}-${u.assemblyKey}-${i}`} className="border-b border-sdc-border-soft/60">
              <td className="whitespace-nowrap px-3 py-1.5 font-mono text-label text-sdc-gray-600">{fmtDate(u.expectedDate)}</td>
              {showJobColumn && (
                <td className={`px-2 py-1.5 ${vBody}`}>
                  <button type="button" onClick={() => push({ kind: "assemblies", jobId: u.jobId, filter: "all" })} className="font-mono text-note text-sdc-blue hover:underline">
                    {u.jobId}
                  </button>
                </td>
              )}
              <td className={`px-2 py-1.5 ${vBody}`}>
                {u.poNumber ? (
                  <button type="button" onClick={() => push({ kind: "po", jobId: u.jobId, supplier: u.supplier, poNumber: u.poNumber! })} className="font-mono text-note text-sdc-blue hover:underline">
                    {u.poNumber}
                  </button>
                ) : (
                  "No PO"
                )}
              </td>
              <td className={`px-2 py-1.5 text-note text-sdc-navy ${vBody}`}>{u.supplier ?? "—"}</td>
              <td className={`px-2 py-1.5 ${vBody}`}>
                <button type="button" onClick={() => push({ kind: "assemblyDetail", jobId: u.jobId, assemblyKeys: [u.assemblyKey] })} className="text-note text-sdc-blue hover:underline">
                  {u.assemblyLabel}
                </button>
              </td>
              <td className={`px-2 py-1.5 text-note text-sdc-gray-600 ${vBody}`}>{u.incomingParts.map((p) => `+${p.qty} ${p.pn}`).join(", ")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Missing / Past Due / Due≤7d / On Order (job-scoped) ──────────────────────

export function PartsDrillView({ job, filter, push }: { job: JobSnapshotRow; filter: "missing" | "pastDue" | "dueSoon" | "onOrder"; push: (f: DrillFrame) => void }) {
  // Called unconditionally, before the early return below, per the Rules of
  // Hooks -- unused by the missing/pastDue branch, but still one frozen
  // value for the component's lifetime rather than a fresh Date.now() read
  // on every render.
  const now = useStableNow();
  if (filter === "missing" || filter === "pastDue") {
    const rows = job.detail.blockers.filter((b) => (filter === "missing" ? b.reason === "no_po" : b.reason === "past_due" || b.reason === "supplier_delay"));
    return (
      <div className="p-4">
        <BlockerRowsTable rows={rows} push={push} showJobColumn={false} />
      </div>
    );
  }
  const weekEnd = now + 7 * 86_400_000;
  const rows = job.detail.upcoming.filter((u) => {
    if (filter === "onOrder") return u.onOrder;
    const t = new Date(u.expectedDate).getTime();
    return Number.isFinite(t) && t >= now && t <= weekEnd;
  });
  return (
    <div className="p-4">
      <UpcomingRowsTable rows={rows} push={push} showJobColumn={false} />
    </div>
  );
}

// ── Material $ breakdown (job-scoped, unfiltered — reconciles with materialValueTotal) ──

export function MaterialDrillView({ job }: { job: JobSnapshotRow }) {
  const rows = useMemo(() => [...job.detail.assemblies].sort((a, b) => b.materialValue - a.materialValue), [job.detail.assemblies]);
  const total = job.materialValueTotal;
  return (
    <div className="p-4">
      <div className="overflow-auto rounded-lg border border-sdc-border">
        <table className="w-full border-collapse text-left">
          <thead className="sticky top-0 z-[1]">
            <tr className="bg-sdc-navy text-micro font-bold uppercase tracking-wider text-white">
              <th className="px-3 py-2">Assembly</th>
              <th className="border-l border-white/15 px-2 py-2 text-right">Material $</th>
              <th className="border-l border-white/15 px-2 py-2 text-right">% of Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.key} className="border-b border-sdc-border-soft/60">
                <td className="px-3 py-1.5 text-note text-sdc-navy">{a.label}</td>
                <td className="border-l border-sdc-border-soft px-2 py-1.5 text-right font-mono text-note tabular-nums">{usd(a.materialValue)}</td>
                <td className="border-l border-sdc-border-soft px-2 py-1.5 text-right font-mono text-note tabular-nums text-sdc-gray-600">{total > 0 ? `${Math.round((a.materialValue / total) * 100)}%` : "—"}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="bg-sdc-gray-100 font-semibold">
              <td className="px-3 py-1.5 text-note text-sdc-navy">Total</td>
              <td className="border-l border-sdc-border-soft px-2 py-1.5 text-right font-mono text-note tabular-nums">{usd(total)}</td>
              <td className="border-l border-sdc-border-soft" />
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

// ── Next Unlock — every entry landing on the job's own nextUnlockDate ────────

export function NextUnlockDrillView({ job, push }: { job: JobSnapshotRow; push: (f: DrillFrame) => void }) {
  if (!job.nextUnlockDate) return <div className="p-4"><EmptyState title="No upcoming deliveries for this project." /></div>;
  const rows = job.detail.upcoming.filter((u) => u.expectedDate === job.nextUnlockDate);
  return (
    <div className="p-4">
      <UpcomingRowsTable rows={rows} push={push} showJobColumn={false} />
    </div>
  );
}

// ── Buildable before/after (Upcoming Unlocks' "Buildable" cell) ─────────────

export function BuildableCalcDrillView({ frame, push }: { frame: Extract<DrillFrame, { kind: "buildableCalc" }>; push: (f: DrillFrame) => void }) {
  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-center justify-center gap-4 rounded-lg border border-sdc-border bg-sdc-gray-50 p-6">
        <div className="text-center">
          <div className="text-micro font-bold uppercase tracking-wide text-sdc-gray-400">Current Buildable Qty</div>
          <div className="text-2xl font-bold tabular-nums text-sdc-navy">{frame.buildableBefore ?? "—"}</div>
        </div>
        <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 text-sdc-gray-400" aria-hidden>
          <path d="M5 12h14M13 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <div className="text-center">
          <div className="text-micro font-bold uppercase tracking-wide text-sdc-gray-400">Buildable Qty After Delivery</div>
          <div className="text-2xl font-bold tabular-nums text-sdc-green-text">{frame.buildableAfter ?? "—"}</div>
        </div>
      </div>
      <div className="rounded-lg border border-sdc-border p-3 text-note text-sdc-gray-600">
        <p>
          <span className="font-semibold text-sdc-navy">+{frame.incomingQty} × {frame.incomingPn}</span> expected {fmtDate(frame.expectedDate)}
          {frame.supplier ? ` from ${frame.supplier}` : ""}.
        </p>
        {frame.poNumber && (
          <button
            type="button"
            onClick={() => push({ kind: "po", jobId: frame.jobId, supplier: frame.supplier, poNumber: frame.poNumber! })}
            className="mt-2 font-mono text-note text-sdc-blue hover:underline"
          >
            View PO {frame.poNumber}
          </button>
        )}
      </div>
      <button
        type="button"
        onClick={() => push({ kind: "assemblyDetail", jobId: frame.jobId, assemblyKeys: [frame.assemblyKey], highlightPn: frame.incomingPn })}
        className="self-start rounded-md border border-sdc-border bg-white px-3 py-1.5 text-note font-medium text-sdc-navy hover:bg-sdc-blue-light"
      >
        View this assembly&apos;s full detail →
      </button>
    </div>
  );
}

// ── Top Blockers row → every blocker sharing that reason, across all jobs ────

export function BlockerReasonDrillView({ jobs, reason, push }: { jobs: JobSnapshotRow[]; reason: BlockerReason; push: (f: DrillFrame) => void }) {
  const rows = useMemo(() => jobs.flatMap((j) => j.detail.blockers.filter((b) => b.reason === reason)), [jobs, reason]);
  return (
    <div className="p-4">
      <BlockerRowsTable rows={rows} push={push} showJobColumn />
    </div>
  );
}

// ── 8-Week Forecast row → that week's deliveries (same data as Upcoming
// Unlocks), plus a supplier breakdown ────────────────────────────────────────

export function ForecastWeekDrillView({ jobs, week, now, push }: { jobs: JobSnapshotRow[]; week: number; now: number; push: (f: DrillFrame) => void }) {
  const rows = useMemo(() => computeUpcomingUnlocks(jobs, week, now), [jobs, week, now]);
  const bySupplier = useMemo(() => {
    const m = new Map<string, { parts: number }>();
    for (const r of rows) {
      const key = r.supplier ?? "Unknown supplier";
      const entry = m.get(key) ?? { parts: 0 };
      entry.parts += r.incomingParts.reduce((s, p) => s + p.qty, 0);
      m.set(key, entry);
    }
    return [...m.entries()].map(([supplier, v]) => ({ supplier, ...v })).sort((a, b) => b.parts - a.parts);
  }, [rows]);

  return (
    <div className="flex flex-col gap-4 p-4">
      <div>
        <p className="mb-2 text-xs font-bold uppercase tracking-wide text-sdc-gray-400">Deliveries expected in week {week}</p>
        <UpcomingRowsTable rows={rows} push={push} showJobColumn />
      </div>
      {bySupplier.length > 0 && (
        <div>
          <p className="mb-2 text-xs font-bold uppercase tracking-wide text-sdc-gray-400">By supplier</p>
          <div className="overflow-auto rounded-lg border border-sdc-border">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="bg-sdc-navy text-micro font-bold uppercase tracking-wider text-white">
                  <th className="px-3 py-2">Supplier</th>
                  <th className="border-l border-white/15 px-2 py-2 text-right">Parts</th>
                </tr>
              </thead>
              <tbody>
                {bySupplier.map((s) => (
                  <tr key={s.supplier} className="border-b border-sdc-border-soft/60">
                    <td className="px-3 py-1.5 text-note text-sdc-navy">
                      <button type="button" onClick={() => push({ kind: "supplier", supplier: s.supplier })} className="text-sdc-blue hover:underline">
                        {s.supplier}
                      </button>
                    </td>
                    <td className="border-l border-sdc-border-soft px-2 py-1.5 text-right font-mono text-note tabular-nums">{s.parts}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
