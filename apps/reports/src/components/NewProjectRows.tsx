"use client";

import { Fragment } from "react";
import { VALID_JOB_TYPES } from "@/lib/job-filters";
import { useNewProjectRowIds, removeNewProjectRow } from "@/components/NewProjectRowsStore";
import { dateCellProps } from "@/lib/date-cell";
import { MoneyCell } from "@/components/MoneyCell";
import { NEW_ROW_PREFIX } from "@/components/ProjectsLiveTotals";

type PhaseGroup = { phase: string; sections: { code: string; name: string }[] };

// Renders one blank, fully editable row per pending "+ Add Project" click —
// same column shape as a real job row (see quoted/page.tsx), just keyed by a
// client-side temp id instead of a job.id. Field names use the `newRow__`/
// `newRowHours__` prefixes quoted-actions.ts looks for; Job Id is the only
// field it requires non-empty before it'll create anything.
export function NewProjectRows({
  phaseGroups,
  allStatuses,
  hidden = [],
}: {
  phaseGroups: PhaseGroup[];
  allStatuses: string[];
  // Mirrors the page's "Columns" dropdown — hidden info columns are omitted
  // from the add-project row too, so it stays column-aligned with the grid
  // (saveNewRows defaults blank Name/Customer/etc. sensibly).
  hidden?: string[];
}) {
  const tempIds = useNewProjectRowIds();
  const hiddenSet = new Set(hidden);
  const show = (key: string) => !hiddenSet.has(key);

  return (
    <>
      {tempIds.map((tempId) => (
        <tr key={tempId} className="bg-sdc-yellow-bg/30 hover:bg-sdc-yellow-bg/50">
          <td className="frozen-col sticky left-0 z-10 w-8 min-w-8 overflow-hidden bg-sdc-yellow-bg px-1 py-1.5 text-center align-middle whitespace-nowrap">
            <button
              type="button"
              onClick={() => removeNewProjectRow(tempId)}
              title="Remove this new row"
              aria-label="Remove new project row"
              className="text-sdc-gray-400 hover:text-red-600"
            >
              ×
            </button>
          </td>
          <td className="frozen-col sticky left-8 z-10 w-20 min-w-20 max-w-20 overflow-hidden bg-sdc-yellow-bg px-2 py-1.5 text-center align-middle font-mono text-label whitespace-nowrap">
            <input
              type="number"
              step="1"
              min="1"
              name={`newRow__${tempId}__jobId`}
              placeholder="Job Id *"
              required
              aria-label="New project Job Id"
              className="w-full min-w-0 text-center font-semibold"
            />
          </td>
          {show("job") && (
            <td
              style={{ width: "var(--job-col-width, 280px)", minWidth: "var(--job-col-width, 280px)" }}
              className="frozen-col frozen-col-last sticky left-[7rem] z-10 overflow-hidden border-l border-r border-sdc-border bg-sdc-yellow-bg px-2 py-1.5 text-left align-middle text-label font-medium whitespace-nowrap text-sdc-navy"
            >
              <input
                type="text"
                name={`newRow__${tempId}__jobName`}
                placeholder="Job Name (defaults to Job Id)"
                aria-label="New project Job Name"
                className="w-full min-w-0 text-left"
              />
            </td>
          )}
          {show("customer") && (
            <td
              style={{ width: "var(--customer-col-width, 120px)", minWidth: "var(--customer-col-width, 120px)", maxWidth: "var(--customer-col-width, 120px)" }}
              className="overflow-hidden whitespace-nowrap px-2 py-1.5 text-left align-middle text-label text-sdc-gray-600"
            >
              <input type="text" name={`newRow__${tempId}__customer`} placeholder="—" aria-label="New project Customer" className="w-full text-left" />
            </td>
          )}
          {show("type") && (
            <td className="overflow-hidden whitespace-nowrap px-1 py-1.5 text-center align-middle text-label text-sdc-gray-600">
              <select name={`newRow__${tempId}__type`} defaultValue="" aria-label="New project Type" className="text-center">
                <option value="">—</option>
                {VALID_JOB_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </td>
          )}
          {show("billable") && (
            <td className="overflow-hidden whitespace-nowrap px-1 py-1.5 text-center align-middle text-label">
              <select name={`newRow__${tempId}__billable`} defaultValue="Billable" aria-label="New project Billable" className="text-center">
                <option value="Billable">Billable</option>
                <option value="Non-Billable">Non-Billable</option>
              </select>
            </td>
          )}
          {show("status") && (
            <td className="overflow-hidden whitespace-nowrap px-1 py-1.5 text-center align-middle text-label font-medium text-sdc-blue-dark">
              <select name={`newRow__${tempId}__status`} defaultValue="Active" aria-label="New project Status" className="text-center">
                {allStatuses.map((st) => (
                  <option key={st} value={st}>
                    {st}
                  </option>
                ))}
              </select>
            </td>
          )}
          {show("startDate") && (
            <td className="overflow-hidden whitespace-nowrap px-1 py-1.5 text-left align-middle text-label text-sdc-muted">
              <input {...dateCellProps({ name: `newRow__${tempId}__startDate`, defaultValue: "", ariaLabel: "New project Start Date" })} />
            </td>
          )}
          {show("completeDate") && (
            <td className="overflow-hidden whitespace-nowrap px-1 py-1.5 text-left align-middle text-label text-sdc-muted">
              <input {...dateCellProps({ name: `newRow__${tempId}__completeDate`, defaultValue: "", ariaLabel: "New project Complete Date" })} />
            </td>
          )}
          {phaseGroups.map((g) =>
            g.sections.length ? (
              <Fragment key={g.phase}>
                {g.sections.map((s) => (
                  <td key={s.code} className="overflow-hidden border-l border-sdc-border px-1 py-1.5 text-center align-middle font-mono text-label whitespace-nowrap text-sdc-gray-600">
                    <input
                      type="number"
                      step="1"
                      min="0"
                      name={`newRowHours__${tempId}__${s.code}`}
                      placeholder="—"
                      aria-label={`New project quoted hours, ${s.name}`}
                      className="text-center"
                    />
                  </td>
                ))}
              </Fragment>
            ) : null
          )}
          {/* Grand-total columns (Engineering + Shop). These rendered a hardcoded
              "—" until 2026-08-03, so a new project's totals stayed blank however
              many hours were typed into the row — the only cells on this grid
              where the total wasn't merely stale but missing. ProjectsLiveTotals
              sums them through these hooks, exactly as it does for a saved row. */}
          <td
            data-total="eng"
            data-job={`${NEW_ROW_PREFIX}${tempId}`}
            data-actual="0"
            className="overflow-hidden border-l border-sdc-border bg-sdc-blue-light/60 px-1 py-1.5 text-center align-middle font-mono text-label font-medium whitespace-nowrap text-sdc-navy"
          >
            <span data-total-quoted>0</span>
          </td>
          <td
            data-total="shop"
            data-job={`${NEW_ROW_PREFIX}${tempId}`}
            data-actual="0"
            className="overflow-hidden border-l border-sdc-border bg-sdc-blue-light/60 px-1 py-1.5 text-center align-middle font-mono text-label font-medium whitespace-nowrap text-sdc-navy"
          >
            <span data-total-quoted>0</span>
          </td>
          {/* Merged Parts Cost column — same structure as the real rows in
              quoted/page.tsx: quoted first (blue), "/ actual" second (green)
              inside `.actual-suffix`, hidden by `.hide-actuals` with no extra
              markup needed here. Must stay column-count-aligned with those
              rows, which is why this mirrors them exactly rather than keeping
              its own two-column shape. No tone/background here (2026-08-11)
              — a brand-new row has nothing to compare yet (both figures
              start blank), so it just keeps its own "new row" yellow tint. */}
          <td className="overflow-hidden whitespace-nowrap border-l border-sdc-border bg-sdc-yellow-bg/60 px-1 py-1.5 text-left align-middle text-label font-medium">
            <span className="parts-cost-quoted inline-flex items-center gap-0.5 text-sdc-blue-dark">
              <span>$</span>
              <MoneyCell
                name={`newRow__${tempId}__costQuoted`}
                defaultValue=""
                ariaLabel="New project Parts Cost Quoted"
                className="w-[4.5rem] min-w-0 border-none bg-transparent text-left tabular-nums outline-none"
              />
            </span>
            <span className="actual-suffix inline-flex items-center gap-0.5 text-sdc-green-text">
              <span className="actual-sep text-sdc-muted">/</span>
              <span>$</span>
              <MoneyCell
                name={`newRow__${tempId}__costActualHistorical`}
                defaultValue=""
                ariaLabel="New project Parts Cost Actual"
                className="w-[4.5rem] min-w-0 border-none bg-transparent text-left tabular-nums outline-none"
                maxFractionDigits={0}
              />
            </span>
          </td>
        </tr>
      ))}
    </>
  );
}
