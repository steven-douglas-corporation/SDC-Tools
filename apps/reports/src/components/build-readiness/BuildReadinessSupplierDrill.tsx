"use client";

import { useMemo } from "react";
import { usd } from "@/components/ui/format";
import { EmptyState } from "@/components/ui/EmptyState";
import { Stat } from "@/components/procurement/PoDetailPanel";
import { computeSupplierRisk } from "@/lib/build-readiness-forecast";
import type { JobSnapshotRow } from "@/lib/build-readiness-types";
import type { DrillFrame } from "./useDrillStack";

function num(n: number): string {
  return Math.round(n).toLocaleString();
}

export function SupplierDrillView({ jobs, supplier, push }: { jobs: JobSnapshotRow[]; supplier: string; push: (f: DrillFrame) => void }) {
  // Reuse the EXACT aggregation the Supplier Risk row itself was built from —
  // guarantees this header always matches the row that opened it, never a
  // second, independently-computed set of numbers.
  const summary = useMemo(() => computeSupplierRisk(jobs).find((r) => r.supplier === supplier) ?? null, [jobs, supplier]);

  const poRows = useMemo(() => {
    const out: { jobId: string; jobName: string; poId: string; received: number; itemCount: number; pct: number }[] = [];
    for (const j of jobs) {
      const vendor = j.detail.vendors.find((v) => v.name === supplier);
      if (!vendor) continue;
      for (const po of vendor.pos) {
        out.push({ jobId: j.jobId, jobName: j.jobName, poId: po.poId, received: po.received, itemCount: po.itemCount, pct: po.pct });
      }
    }
    return out.sort((a, b) => a.pct - b.pct);
  }, [jobs, supplier]);

  return (
    <div className="flex flex-col gap-4 p-4">
      {summary && (
        <div className="grid grid-cols-2 gap-3 rounded-lg border border-sdc-border bg-sdc-gray-50 p-3 sm:grid-cols-4">
          <Stat label="Open POs" value={num(summary.openPOs)} />
          <Stat label="Outstanding" value={num(summary.partsOutstanding)} />
          <Stat label="Past Due" value={num(summary.pastDue)} />
          <Stat label="Avg Days Late" value={summary.avgDaysLate != null ? `${summary.avgDaysLate}d` : "—"} />
          <Stat label="Projects Affected" value={num(summary.projectsAffected)} />
          <Stat label="Assemblies Blocked" value={num(summary.assembliesBlocked)} />
          <Stat label="Material $" value={usd(summary.materialValue)} />
        </div>
      )}

      {poRows.length === 0 ? (
        <EmptyState title="No open POs for this supplier across the loaded projects." />
      ) : (
        <div className="overflow-auto rounded-lg border border-sdc-border">
          <table className="w-full border-collapse text-left">
            <thead className="sticky top-0 z-[1]">
              <tr className="bg-sdc-navy text-micro font-bold uppercase tracking-wider text-white">
                <th className="px-3 py-2">Job</th>
                <th className="border-l border-white/15 px-2 py-2">PO</th>
                <th className="border-l border-white/15 px-2 py-2 text-right">Received</th>
                <th className="border-l border-white/15 px-2 py-2 text-right">%</th>
              </tr>
            </thead>
            <tbody>
              {poRows.map((po) => (
                <tr key={`${po.jobId}-${po.poId}`} className="border-b border-sdc-border-soft/60 hover:bg-sdc-blue-light/20">
                  <td className="px-3 py-1.5">
                    <button
                      type="button"
                      onClick={() => push({ kind: "assemblies", jobId: po.jobId, filter: "all" })}
                      className="font-mono text-note font-semibold text-sdc-blue hover:underline"
                      title={po.jobName}
                    >
                      {po.jobId}
                    </button>
                  </td>
                  <td className="border-l border-sdc-border-soft px-2 py-1.5">
                    <button
                      type="button"
                      onClick={() => push({ kind: "po", jobId: po.jobId, supplier, poNumber: po.poId })}
                      className="font-mono text-note text-sdc-blue hover:underline"
                    >
                      {po.poId}
                    </button>
                  </td>
                  <td className="border-l border-sdc-border-soft px-2 py-1.5 text-right font-mono text-note tabular-nums">{po.received}/{po.itemCount}</td>
                  <td className="border-l border-sdc-border-soft px-2 py-1.5 text-right font-mono text-note tabular-nums">{po.pct}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
