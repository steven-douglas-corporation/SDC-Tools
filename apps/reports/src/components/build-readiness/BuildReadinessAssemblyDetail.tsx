"use client";

import { useEffect, useState } from "react";
import { pct } from "@/components/ui/format";
import { usd } from "@/components/ui/format";
import { EmptyState } from "@/components/ui/EmptyState";
import { Stat } from "@/components/procurement/PoDetailPanel";
import { sequenced } from "@/lib/request-sequence";
import { loadAssemblyPartsForJob, type AssemblyPartsResult } from "@/lib/build-readiness-assembly-actions";
import { mergeAssemblyInstances } from "@/lib/build-readiness-forecast";
import type { FlatPart } from "@/lib/po-detail";
import type { JobSnapshotRow } from "@/lib/build-readiness-types";
import type { DrillFrame } from "./useDrillStack";

function num(n: number): string {
  return Math.round(n).toLocaleString();
}
function fmtDate(s: string | null): string {
  if (!s) return "—";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// ── Assembly detail — the "What Can We Build Now" row drill, and every
// assembly-row click elsewhere on the page ───────────────────────────────────
//
// The summary half (required/buildable/readiness/material/next delivery/
// limiting components) reads straight off the snapshot's own AssemblyDetail —
// instant, and already what the KPI counts are built from. The NAMED parts
// lists (available/missing/on-order) are the one genuine snapshot gap: only
// counts and the bottleneck subset are persisted, never a full per-part
// array. Per-decision, those are fetched live via loadAssemblyPartsForJob
// (build-readiness-assembly-actions.ts) — the same two-call, time-boxed
// pattern already shipped for the PO drawer.
export function AssemblyDetailDrillView({
  job,
  assemblyKeys,
  highlightPn,
  push,
}: {
  job: JobSnapshotRow;
  assemblyKeys: string[];
  highlightPn?: string;
  push: (f: DrillFrame) => void;
}) {
  const instances = job.detail.assemblies.filter((a) => assemblyKeys.includes(a.key));
  // A stable identity for the fetch/dedup key below — order-independent, so
  // reopening the same merged row (whatever order its keys happen to be
  // rebuilt in) joins the same in-flight request instead of starting a new one.
  const keySignature = [...assemblyKeys].sort().join("|");
  const [state, setState] = useState<"loading" | AssemblyPartsResult>("loading");

  useEffect(() => {
    // Reset to "loading" synchronously so switching to a new assembly (a
    // dependency change, not just mount) doesn't briefly show the PREVIOUS
    // assembly's parts while the new fetch is in flight -- can't be a lazy
    // initializer since this needs to re-fire on every keySignature change.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState("loading");
    sequenced("build-readiness-assembly-parts", `${job.jobId}::${keySignature}`, () => loadAssemblyPartsForJob(job.jobId, assemblyKeys)).then((out) => {
      if (out.ok) setState(out.value);
      else if (out.reason === "error") setState({ ok: false, reason: "unavailable" });
      // reason: "stale" — a newer assembly was opened before this one resolved; leave it alone.
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job.jobId, keySignature]);

  if (instances.length === 0) {
    return (
      <div className="p-4">
        <EmptyState title="This assembly is no longer in the snapshot." message="It may have been removed by the project's last refresh." />
      </div>
    );
  }

  // Single position (the overwhelming majority): mergeAssemblyInstances over
  // one instance reduces to that instance's own exact figures — see its own
  // header comment for why this never distorts the common case.
  const merged = mergeAssemblyInstances(instances);

  return (
    <div className="flex flex-col gap-4 p-4">
      {instances.length > 1 && (
        <p className="rounded-lg border border-sdc-blue-light bg-sdc-blue-light/40 px-3 py-2 text-note text-sdc-blue-dark">
          This assembly is used in {instances.length} places in this job&apos;s BOM — the figures below are combined across all of them.
        </p>
      )}
      <div className="grid grid-cols-2 gap-3 rounded-lg border border-sdc-border bg-sdc-gray-50 p-3 sm:grid-cols-3">
        <Stat label="Required Qty" value={num(merged.requiredQty)} />
        <Stat label="Buildable Now" value={merged.buildableQty == null ? "—" : `${num(merged.buildableQty)} (${merged.buildablePct}%)`} />
        <Stat label="Readiness" value={pct(merged.readinessPct)} />
        <Stat label="Material Value" value={usd(merged.materialValue)} />
        <Stat label="Next Delivery" value={fmtDate(merged.nextExpectedDelivery)} />
        <Stat label="Est. Buildable" value={fmtDate(merged.estimatedBuildableDate)} />
      </div>

      {merged.limitingParts.length > 0 && (
        <div className="rounded-lg border border-sdc-yellow-border bg-sdc-yellow-bg/40 p-3">
          <p className="mb-1.5 text-micro font-bold uppercase tracking-wide text-sdc-yellow-text">Limiting component(s)</p>
          <ul className="flex flex-wrap gap-2">
            {merged.limitingParts.map((lp) => (
              <li key={lp.pn} className="rounded bg-white px-2 py-1 font-mono text-note text-sdc-navy shadow-sm">
                {lp.pn} — {lp.available}/{lp.required}
              </li>
            ))}
          </ul>
        </div>
      )}

      {state === "loading" && (
        <div className="flex items-center gap-2 text-note text-sdc-gray-600">
          <svg viewBox="0 0 16 16" width="14" height="14" className="shrink-0 animate-spin" aria-hidden>
            <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2" strokeOpacity="0.25" />
            <path d="M8 2 a6 6 0 0 1 6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          Loading this assembly&apos;s parts…
        </div>
      )}
      {state !== "loading" && !state.ok && (
        <p className="rounded-lg border border-sdc-red-border bg-sdc-red-bg/40 px-3 py-2 text-note text-sdc-red-text">
          {state.reason === "not-found"
            ? "This assembly's parts couldn't be located — the BOM may have changed since the last refresh."
            : "Couldn't load this assembly's parts — try again."}
        </p>
      )}
      {state !== "loading" && state.ok && (
        <PartsMiniTable parts={state.parts} highlightPn={highlightPn} onOpenPo={(sup, po) => po && push({ kind: "po", jobId: job.jobId, supplier: sup, poNumber: po })} />
      )}
    </div>
  );
}

// Grouped by the same live status classification JobProcurement.tsx's own
// Parts List uses (FlatPart.st.key) — unambiguous, and the closest thing to
// "available/missing/on-order, by name" this app already knows how to say.
function PartsMiniTable({
  parts,
  highlightPn,
  onOpenPo,
}: {
  parts: FlatPart[];
  highlightPn?: string;
  onOpenPo: (supplier: string | null, poNumber: string | null) => void;
}) {
  const groups: { label: string; items: FlatPart[] }[] = [
    { label: "Available", items: parts.filter((p) => p.st.key === "received" || p.st.key === "stock" || p.st.key === "process") },
    { label: "Missing", items: parts.filter((p) => p.st.key === "noPO") },
    { label: "On Order", items: parts.filter((p) => p.st.key === "ordered" || p.st.key === "soon" || p.st.key === "overdue") },
    { label: "On Hold", items: parts.filter((p) => p.st.key === "hold") },
  ].filter((g) => g.items.length > 0);

  if (groups.length === 0) return <EmptyState title="No parts found for this assembly." />;

  return (
    <div className="flex flex-col gap-3">
      {groups.map((g) => (
        <div key={g.label} className="overflow-hidden rounded-lg border border-sdc-border">
          <div className="bg-sdc-gray-100 px-3 py-1.5 text-micro font-bold uppercase tracking-wide text-sdc-gray-600">
            {g.label} ({g.items.length})
          </div>
          <table className="w-full border-collapse text-left">
            <tbody>
              {g.items.map((p) => (
                <tr key={p.id} className={`border-b border-sdc-border-soft/60 last:border-b-0 ${p.pn === highlightPn ? "bg-sdc-yellow-bg" : ""}`}>
                  <td className="px-3 py-1.5 font-mono text-note font-semibold text-sdc-navy">{p.pn}</td>
                  <td className="max-w-[220px] truncate px-2 py-1.5 text-note text-sdc-gray-600" title={p.desc}>{p.desc || "—"}</td>
                  <td className="px-2 py-1.5 text-right font-mono text-note tabular-nums">{num(p.qty)}</td>
                  <td className="px-2 py-1.5">
                    {p.poNumber ? (
                      <button type="button" onClick={() => onOpenPo(p.supplier, p.poNumber)} className="font-mono text-note text-sdc-blue hover:underline">
                        {p.poNumber}
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
      ))}
    </div>
  );
}
