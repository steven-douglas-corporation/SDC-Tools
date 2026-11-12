"use client";

import { useEffect, useState } from "react";
import { PoPanel } from "@/components/procurement/PoDetailPanel";
import { OpenPoPanel } from "@/components/open-pos/OpenPoPanel";
import type { DrawerBadge } from "@/components/build-readiness/BuildReadinessDrawer";
import { TOOLBAR_BTN_COMPACT, TOOLBAR_BTN_NEUTRAL } from "@/components/ui/classnames";
import { loadPoDetailForJob, type PoDetailResult } from "@/lib/build-readiness-po-actions";
import type { OpenPoRow } from "@/lib/open-pos-rules";
import { fitsSplit } from "@/lib/split-view";
import { useWorkspaceActions } from "@/components/useWorkspaceActions";
import { useSplitNav } from "@/components/useSplitNav";

// ── A PO opened from Open POs: the same panel as Job Details ─────────────────────────────
//
// Job Details' PO panel (PoDetailPanel.tsx's PoPanel) is built from one job's BOM parts, so
// on click this reads that job's BOM and parts cost, the same call Build Readiness makes for
// a job it hasn't loaded (loadPoDetailForJob). The job is the card's own on a project card,
// otherwise the PO's first job; a PO split across jobs links to each of them below the bars.
//
// When the panel can't be built (Total ETO didn't answer, or none of the PO's lines are BOM
// parts, e.g. a PO for services), Open POs' own panel opens instead: it shows every PO line
// from data the page already has, so a click always shows the PO.

export function OpenPoDetail({
  row,
  jobId,
  badge,
  jobName,
  schedulerVendorPosUrl,
  onClose,
}: {
  row: OpenPoRow;
  jobId: string;
  /** For the fallback panel. */
  badge: DrawerBadge & { title?: string };
  jobName: (jobId: string) => string;
  schedulerVendorPosUrl?: string;
  onClose: () => void;
}) {
  const [state, setState] = useState<"loading" | PoDetailResult>("loading");
  const { openInSplitView } = useWorkspaceActions();
  const { isSplit } = useSplitNav();

  // A part clicked in the panel: Job Details for this job beside Open POs, with that part
  // highlighted in its Parts List (?part=, the Parts List's own drill: filters cleared,
  // scroll and flash). Already split: the other side shows it. Too narrow for two readable
  // panes (fitsSplit, measured on <main> as the workspace does): a new browser tab instead.
  const openPartInJobDetails = (partId: number) => {
    const params = { jobs: jobId, part: String(partId) };
    const main = document.getElementById("main-content");
    if ((isSplit || fitsSplit(main?.clientWidth ?? window.innerWidth)) && openInSplitView("/job-hours", { params })) return;
    window.open(`/job-hours?${new URLSearchParams(params)}`, "_blank", "noopener");
  };
  useEffect(() => {
    let live = true;
    loadPoDetailForJob(jobId, row.suppliers[0] ?? null, row.poNumber)
      .then((r) => live && setState(r))
      .catch(() => live && setState({ ok: false, reason: "unavailable" }));
    return () => {
      live = false;
    };
  }, [jobId, row.poNumber, row.suppliers]);

  if (state === "loading") {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-sdc-navy/20" onClick={onClose}>
        <div role="status" className="flex items-center gap-2 rounded-lg border border-sdc-border bg-white px-4 py-3 text-sm text-sdc-gray-600 shadow-lg">
          <svg viewBox="0 0 16 16" width="14" height="14" className="shrink-0 animate-spin" aria-hidden>
            <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2" strokeOpacity="0.25" />
            <path d="M8 2 a6 6 0 0 1 6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          Loading PO {row.poNumber} from job {jobId}…
        </div>
      </div>
    );
  }

  if (!state.ok) {
    return <OpenPoPanel row={row} badge={badge} jobName={jobName} schedulerVendorPosUrl={schedulerVendorPosUrl} onClose={onClose} />;
  }

  const others = row.jobIds.filter((j) => j !== jobId);
  return (
    <PoPanel
      supplier={state.supplier}
      po={state.po}
      authoritative={state.authoritative}
      onClose={onClose}
      onPartClick={(p) => openPartInJobDetails(p.id)}
      onOpenPo={() => {}}
      schedulerVendorPosUrl={schedulerVendorPosUrl}
      actions={
        <>
          {[jobId, ...others].map((j) => (
            <a
              key={j}
              href={`/job-hours?jobs=${encodeURIComponent(j)}`}
              title={
                j === jobId
                  ? `The parts shown are job ${j}'s. Opens it in Job Details, with its full Parts List`
                  : `This PO also charges job ${j}. Opens it in Job Details`
              }
              className={`${TOOLBAR_BTN_COMPACT} ${TOOLBAR_BTN_NEUTRAL}`}
            >
              {j}
              {jobName(j) ? ` · ${jobName(j)}` : ""} in Job Details
            </a>
          ))}
        </>
      }
    />
  );
}
