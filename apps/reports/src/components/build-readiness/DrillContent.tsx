"use client";

import { useEffect, useState } from "react";
import { EmptyState } from "@/components/ui/EmptyState";
import { PoPanel } from "@/components/procurement/PoDetailPanel";
import { loadPoDetailForJob, type PoDetailResult } from "@/lib/build-readiness-po-actions";
import { sequenced } from "@/lib/request-sequence";
import { BLOCKER_REASON_LABEL, type JobSnapshotRow } from "@/lib/build-readiness-types";
import { BuildReadinessDrawer } from "./BuildReadinessDrawer";
import {
  AssembliesDrillView,
  PartsDrillView,
  MaterialDrillView,
  NextUnlockDrillView,
  BuildableCalcDrillView,
  BlockerReasonDrillView,
  ForecastWeekDrillView,
} from "./BuildReadinessDrillViews";
import { AssemblyDetailDrillView } from "./BuildReadinessAssemblyDetail";
import { SupplierDrillView } from "./BuildReadinessSupplierDrill";
import { frameJobId, type DrillFrame, type DrillStack } from "./useDrillStack";
import { useStableNow } from "@/lib/use-stable-now";

const PARTS_FILTER_LABEL: Record<Extract<DrillFrame, { kind: "parts" }>["filter"], string> = {
  missing: "Missing",
  pastDue: "Past Due",
  dueSoon: "Due ≤7d",
  onOrder: "On Order",
};

function frameLabel(frame: DrillFrame, jobs: JobSnapshotRow[]): string {
  switch (frame.kind) {
    case "assemblies":
      return frame.filter === "all" ? frame.jobId : `${frame.jobId} — ${frame.filter[0].toUpperCase()}${frame.filter.slice(1)}`;
    case "parts":
      return `${frame.jobId} — ${PARTS_FILTER_LABEL[frame.filter]}`;
    case "material":
      return `${frame.jobId} — Material $`;
    case "nextUnlock":
      return `${frame.jobId} — Next Unlock`;
    case "assemblyDetail": {
      const job = jobs.find((j) => j.jobId === frame.jobId);
      const asm = job?.detail.assemblies.find((a) => frame.assemblyKeys.includes(a.key));
      return asm?.label ?? "Assembly";
    }
    case "buildableCalc":
      return "Buildable Calculation";
    case "blockerReason":
      return BLOCKER_REASON_LABEL[frame.reason];
    case "supplier":
      return frame.supplier;
    case "forecastWeek":
      return `Week ${frame.week}`;
    case "po":
      return `PO ${frame.poNumber}`;
  }
}

// ── The single render point for the whole drill stack ───────────────────────
//
// Mounted once at BuildReadinessDashboard's level (the one owner of the
// stack). When the top frame is a PO, this renders the real, existing
// `<PoPanel>` directly — unmodified, fed by the same `loadPoDetailForJob`
// action Upcoming Unlocks already used — so the leaf of every drill chain is
// byte-for-byte the PO drawer Job Hour Details -> Procurement already ships.
// Every other frame renders inside the generic `BuildReadinessDrawer` shell.
//
// Closing (the X button, backdrop click, or Escape — all route through each
// drawer's own `onClose`) pops exactly ONE level (`popTo(stack.length - 2)`,
// which naturally empties the stack once nothing is left), so backing out of
// a PO returns to the list that led to it rather than dropping the user back
// at the table. A breadcrumb segment click jumps to that level directly.
export function DrillContent({
  jobs,
  drill,
  onRefreshProject,
  refreshingProjectId,
}: {
  jobs: JobSnapshotRow[];
  drill: DrillStack;
  onRefreshProject: (jobId: string) => void;
  refreshingProjectId: string | null;
}) {
  const now = useStableNow();
  const { stack, top, push, popTo } = drill;
  const closeOneLevel = () => popTo(stack.length - 2);

  const poFrame = top && top.kind === "po" ? top : null;
  const [poState, setPoState] = useState<"loading" | PoDetailResult | null>(null);

  useEffect(() => {
    if (!poFrame) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPoState(null);
      return;
    }
    // Reset to "loading" synchronously so switching to a different PO frame
    // doesn't briefly show the PREVIOUS one's detail while the new fetch is
    // in flight -- can't be a lazy initializer since this needs to re-fire
    // on every poFrame change, same reasoning as
    // BuildReadinessAssemblyDetail.tsx's identical pattern.
    setPoState("loading");
    sequenced("build-readiness-po-detail", `${poFrame.jobId}::${poFrame.poNumber}`, () => loadPoDetailForJob(poFrame.jobId, poFrame.supplier, poFrame.poNumber)).then((out) => {
      if (out.ok) setPoState(out.value);
      else if (out.reason === "error") setPoState({ ok: false, reason: "unavailable" });
      // reason: "stale" — a newer PO was opened before this one resolved; leave it alone.
    });
    // poFrame's primitive fields, not the object itself -- a new but
    // equivalent `top` from the parent must not re-trigger this fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poFrame?.jobId, poFrame?.poNumber, poFrame?.supplier]);

  if (!top) return null;

  if (top.kind === "po") {
    if (poState === "loading" || poState === null) {
      return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-sdc-navy/20">
          <div className="flex items-center gap-2 rounded-lg border border-sdc-border bg-white px-4 py-3 text-sm text-sdc-gray-600 shadow-lg">
            <svg viewBox="0 0 16 16" width="14" height="14" className="shrink-0 animate-spin" aria-hidden>
              <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2" strokeOpacity="0.25" />
              <path d="M8 2 a6 6 0 0 1 6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            Loading PO {top.poNumber}…
          </div>
        </div>
      );
    }
    if (!poState.ok) {
      return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-sdc-navy/20" onClick={closeOneLevel}>
          <div className="flex flex-col gap-3 rounded-lg border border-sdc-border bg-white px-4 py-3 shadow-lg" onClick={(e) => e.stopPropagation()}>
            <p className="text-sm font-medium text-sdc-red-text">
              {poState.reason === "not-found" ? "This PO's parts couldn't be found — the data may be out of date." : "Couldn't load this PO — try again."}
            </p>
            <button type="button" onClick={closeOneLevel} className="self-end rounded-md border border-sdc-border bg-white px-3 py-1 text-xs font-medium text-sdc-navy hover:bg-sdc-blue-light">
              Back
            </button>
          </div>
        </div>
      );
    }
    return (
      <PoPanel
        supplier={poState.supplier}
        po={poState.po}
        authoritative={poState.authoritative}
        onClose={closeOneLevel}
        onPartClick={() => {}}
        onOpenPo={(sup, poNumber) => poNumber && push({ kind: "po", jobId: top.jobId, supplier: sup, poNumber })}
      />
    );
  }

  const jobId = frameJobId(top);
  const job = jobId ? jobs.find((j) => j.jobId === jobId) ?? null : null;
  const breadcrumb = stack.map((f) => frameLabel(f, jobs));

  return (
    <BuildReadinessDrawer title={frameLabel(top, jobs)} subtitle={job?.jobName} breadcrumb={breadcrumb} onBreadcrumbClick={popTo} onClose={closeOneLevel}>
      {top.kind === "assemblies" &&
        (job ? (
          <AssembliesDrillView job={job} filter={top.filter} push={push} onRefresh={() => onRefreshProject(job.jobId)} refreshing={refreshingProjectId === job.jobId} />
        ) : (
          <EmptyState title="This project is no longer in the loaded data." />
        ))}
      {top.kind === "parts" && (job ? <PartsDrillView job={job} filter={top.filter} push={push} /> : <EmptyState title="This project is no longer in the loaded data." />)}
      {top.kind === "material" && (job ? <MaterialDrillView job={job} /> : <EmptyState title="This project is no longer in the loaded data." />)}
      {top.kind === "nextUnlock" && (job ? <NextUnlockDrillView job={job} push={push} /> : <EmptyState title="This project is no longer in the loaded data." />)}
      {top.kind === "assemblyDetail" &&
        (job ? (
          <AssemblyDetailDrillView job={job} assemblyKeys={top.assemblyKeys} highlightPn={top.highlightPn} push={push} />
        ) : (
          <EmptyState title="This project is no longer in the loaded data." />
        ))}
      {top.kind === "buildableCalc" && <BuildableCalcDrillView frame={top} push={push} />}
      {top.kind === "blockerReason" && <BlockerReasonDrillView jobs={jobs} reason={top.reason} push={push} />}
      {top.kind === "supplier" && <SupplierDrillView jobs={jobs} supplier={top.supplier} push={push} />}
      {top.kind === "forecastWeek" && <ForecastWeekDrillView jobs={jobs} week={top.week} now={now} push={push} />}
    </BuildReadinessDrawer>
  );
}
