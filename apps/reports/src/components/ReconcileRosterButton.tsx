"use client";

import { useState, useTransition } from "react";
import { reconcileSchedulerRosterAction } from "@/lib/employee-actions";
import type { RosterReconciliation } from "@/lib/sync-scheduler-team";
import { BUTTON_SECONDARY } from "@/components/ui/classnames";

// Read-only reconciliation of ETC's full roster (active + inactive) against the
// Scheduler's team list — shows "the number" plus who's only on one side.
export function ReconcileRosterButton() {
  const [pending, startTransition] = useTransition();
  const [r, setR] = useState<RosterReconciliation | null>(null);

  function run() {
    startTransition(async () => setR(await reconcileSchedulerRosterAction()));
  }

  return (
    <>
      <button
        type="button"
        onClick={run}
        disabled={pending}
        title="Compare ETC's full roster (active + inactive) with the SDC Scheduler's team list."
        className={BUTTON_SECONDARY}
      >
        {pending ? "Reconciling…" : "Reconcile with Scheduler"}
      </button>

      {r && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={() => setR(null)}>
          <div className="max-h-[calc(var(--app-vh)_*_0.8)] w-full max-w-lg overflow-auto rounded-xl border border-sdc-border bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            {!r.ok ? (
              <>
                <p className="mb-2 font-heading text-lg font-bold text-sdc-navy">Reconciliation unavailable</p>
                <p className="text-sm text-sdc-gray-600">{r.reason}</p>
              </>
            ) : (
              <>
                <p className="mb-1 font-heading text-lg font-bold text-sdc-navy">Roster reconciliation</p>
                <p className="mb-4 text-sm text-sdc-gray-600">
                  <strong className="text-sdc-navy">{r.matched}</strong> of{" "}
                  <strong className="text-sdc-navy">{r.schedulerCount}</strong> Scheduler people matched in ETC —{" "}
                  <strong className="text-sdc-green-text">{r.agree}</strong> agree on both status &amp; team.
                  <br />
                  ETC roster: {r.etcActiveCount} active · {r.etcTotalCount} total (incl. inactive).
                </p>

                {r.statusMismatches.length > 0 && (
                  <div className="mb-4">
                    <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[#B03A3A]">
                      Active/inactive disagrees ({r.statusMismatches.length})
                    </p>
                    <ul className="space-y-0.5 text-sm text-sdc-gray-700">
                      {r.statusMismatches.map((s) => (
                        <li key={s.name}>
                          {s.name}: ETC <strong>{s.etcActive ? "active" : "inactive"}</strong> · Scheduler <strong>{s.schedulerActive ? "active" : "inactive"}</strong>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {r.teamMismatches.length > 0 && (
                  <div className="mb-4">
                    <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[#8A6D00]">
                      Team disagrees ({r.teamMismatches.length})
                    </p>
                    <ul className="space-y-0.5 text-sm text-sdc-gray-700">
                      {r.teamMismatches.map((t) => (
                        <li key={t.name}>
                          {t.name}: ETC <strong>{t.etcTeam}</strong> · Scheduler <strong>{t.schedulerTeam}</strong>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {r.schedulerOnly.length > 0 && (
                  <div className="mb-4">
                    <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[#8A6D00]">
                      On the Scheduler, not in ETC at all ({r.schedulerOnly.length})
                    </p>
                    <p className="text-sm text-sdc-gray-700">{r.schedulerOnly.join(", ")}</p>
                  </div>
                )}

                {r.etcActiveOnly.length > 0 && (
                  <div className="mb-2">
                    <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-sdc-gray-400">
                      Active in ETC, not on the Scheduler roster ({r.etcActiveOnly.length})
                    </p>
                    <p className="text-sm text-sdc-gray-700">{r.etcActiveOnly.join(", ")}</p>
                  </div>
                )}
              </>
            )}

            <div className="mt-2 flex justify-end">
              <button type="button" onClick={() => setR(null)} className={BUTTON_SECONDARY}>Close</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
