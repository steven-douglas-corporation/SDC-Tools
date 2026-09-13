"use client";

import { useMemo, useState, useTransition } from "react";
import { BuildReadinessDrawer } from "@/components/build-readiness/BuildReadinessDrawer";
import { createHiringPosition } from "@/lib/hiring-actions";
import { WORKFORCE_GROUPS, workforceGroupForCardKey, type WorkforceGroupKey } from "@/lib/employee-workforce-groups";
import { EMPLOYEE_TEAMS } from "@/lib/employee-teams";
import { MANUAL_JOB_STATUSES, DEFAULT_MANUAL_JOB_STATUS, isOpenHiringStatus } from "@/lib/hiring-position-status";
import type { HiringPosition } from "@/lib/hiring-positions";

// The "+ Create Position" drawer (2026-08-19) — same BuildReadinessDrawer
// shell every other Employees/Build Readiness drilldown uses. Writes through
// createHiringPosition (HiringPositionCreated — see that action's own
// comment for why this never touches Job.xlsx directly), then hands the
// caller the finished HiringPosition so EmployeesGrid can slot it into local
// state immediately — no reload, matching the task's own "no page refresh
// should be required".
//
// Group/Department cascade the same way HiringMoveToControl's two selects do
// — picking a group resets department to that group's first option, so
// there is no way to submit a mismatched pair.

const ASSIGNABLE_GROUPS = WORKFORCE_GROUPS.filter((g) => g.key !== "other");

const INPUT = "h-9 w-full rounded-lg border border-sdc-border bg-white px-2.5 text-sm text-sdc-navy outline-none focus:border-sdc-blue";
const LABEL = "text-xs font-semibold uppercase tracking-wide text-sdc-muted";

export function CreateHiringPositionDrawer({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (position: HiringPosition) => void;
}) {
  const [title, setTitle] = useState("");
  // Held as a STRING, not a number (2026-08-24). A number state forces a
  // decision about what the field shows the instant someone selects "1" and
  // types — NaN, or a silent snap back to 1 that fights the keystroke. Keeping
  // the raw text lets the field be briefly empty or mid-edit while typing, and
  // the value is parsed and validated once, on submit.
  const [quantity, setQuantity] = useState("1");
  const [jobStatus, setJobStatus] = useState<string>(DEFAULT_MANUAL_JOB_STATUS);
  const [workforceGroup, setWorkforceGroup] = useState<WorkforceGroupKey>("engineering");
  const [department, setDepartment] = useState<string>("");
  const [workLocDescription, setWorkLocDescription] = useState("");
  const [expectedStartDate, setExpectedStartDate] = useState("");
  const [remote, setRemote] = useState(false);
  const [internal, setInternal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const departmentsInGroup = useMemo(
    () => EMPLOYEE_TEAMS.filter((t) => workforceGroupForCardKey(t.schedulerCode) === workforceGroup),
    [workforceGroup],
  );
  const selectedDepartment = department || departmentsInGroup[0]?.schedulerCode || "";

  function submit() {
    setError(null);
    if (!title.trim()) {
      setError("Position Title is required.");
      return;
    }
    if (!selectedDepartment) {
      setError("Department is required.");
      return;
    }
    const parsedQuantity = Number(quantity);
    if (!quantity.trim() || !Number.isInteger(parsedQuantity) || parsedQuantity < 1) {
      setError("Quantity must be a whole number of 1 or more.");
      return;
    }
    startTransition(async () => {
      const startDate = expectedStartDate ? new Date(expectedStartDate) : null;
      const result = await createHiringPosition({
        title,
        jobStatus,
        workforceGroup,
        department: selectedDepartment,
        workLocDescription: workLocDescription || null,
        remote,
        internal,
        expectedStartDate: startDate,
        quantity: parsedQuantity,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onCreated({
        sourceId: result.sourceId,
        title: title.trim(),
        status: jobStatus,
        subStatus: null,
        // Same single rule the server applies -- see the matching comment in
        // HiringPositionDetailDrawer. A position created as Published counts
        // as open immediately, exactly like the workbook's Published rows.
        // A freshly created position has nothing filled yet, so remaining ==
        // quantity and its open-ness is decided by status alone — the same
        // answer the server's own readOpenings() gives for filledCount 0.
        isOpen: isOpenHiringStatus(jobStatus, null, false),
        quantity: parsedQuantity,
        filledCount: 0,
        remainingQuantity: parsedQuantity,
        source: "manual",
        workforceGroup,
        department: selectedDepartment,
        isManuallyAssigned: true,
        expectedStartDate: startDate,
        isVisible: true,
        functionDescription: null,
        sectionDescription: null,
        workLocDescription: workLocDescription || null,
        createdDate: new Date().toLocaleDateString("en-US"),
        createdBy: null,
        modifiedBy: null,
        remote,
        internal,
      });
      onClose();
    });
  }

  return (
    <BuildReadinessDrawer title="Create Position" breadcrumb={["Hiring Positions", "Create Position"]} onBreadcrumbClick={() => {}} onClose={onClose}>
      <form
        className="flex flex-col gap-4 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label className="flex flex-col gap-1">
          <span className={LABEL}>Position Title *</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Controls Engineer" className={INPUT} autoFocus />
        </label>

        {/* Quantity — directly below Position Title, as requested. Typed OR
            stepped: `type="number"` gives the browser's own +/- spinner and
            arrow-key stepping for free, and min/step/inputMode tell it (and a
            phone keyboard) that only whole numbers from 1 up make sense. None
            of that is a real constraint on what reaches the server, which is
            why hiring-actions.ts validates it again — see parseQuantity there. */}
        <label className="flex flex-col gap-1">
          <span className={LABEL}>Quantity *</span>
          <input
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            className={`${INPUT} w-24`}
            aria-describedby="qty-help"
          />
          <span id="qty-help" className="text-note text-sdc-muted">
            {(() => {
              const n = Number(quantity);
              return Number.isInteger(n) && n > 1
                ? `Counts as ${n} open positions and ${n}× one person's hiring capacity.`
                : "One position per opening — set 2 if you need two of this role.";
            })()}
          </span>
        </label>

        <label className="flex flex-col gap-1">
          <span className={LABEL}>Job Status *</span>
          <select value={jobStatus} onChange={(e) => setJobStatus(e.target.value)} className={INPUT}>
            {MANUAL_JOB_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className={LABEL}>Workforce Group *</span>
          <select
            value={workforceGroup}
            onChange={(e) => {
              const next = e.target.value as WorkforceGroupKey;
              setWorkforceGroup(next);
              setDepartment("");
            }}
            className={INPUT}
          >
            {ASSIGNABLE_GROUPS.map((g) => (
              <option key={g.key} value={g.key}>
                {g.title}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className={LABEL}>Department *</span>
          <select value={selectedDepartment} onChange={(e) => setDepartment(e.target.value)} className={INPUT}>
            {departmentsInGroup.map((t) => (
              <option key={t.schedulerCode} value={t.schedulerCode}>
                {t.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className={LABEL}>Work Location</span>
          <input value={workLocDescription} onChange={(e) => setWorkLocDescription(e.target.value)} placeholder="Optional" className={INPUT} />
        </label>

        <label className="flex flex-col gap-1">
          <span className={LABEL}>Expected Start Date</span>
          <input
            type="date"
            value={expectedStartDate}
            onChange={(e) => setExpectedStartDate(e.target.value)}
            className={INPUT}
          />
          <span className="text-note text-sdc-muted">
            Optional — prorates this position&apos;s Hiring Capacity hours by when it&apos;s expected to actually start. Left blank, it counts as full-year capacity.
          </span>
        </label>

        <div className="flex items-center gap-5">
          <label className="flex items-center gap-2 text-sm text-sdc-navy">
            <input type="checkbox" checked={remote} onChange={(e) => setRemote(e.target.checked)} className="h-3.5 w-3.5" />
            Remote
          </label>
          <label className="flex items-center gap-2 text-sm text-sdc-navy">
            <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} className="h-3.5 w-3.5" />
            Internal Only
          </label>
        </div>

        {error && (
          <p className="text-note text-sdc-red-text" role="alert">
            {error}
          </p>
        )}

        <div className="mt-2 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="h-9 rounded-lg border border-sdc-border px-3.5 text-sm font-medium text-sdc-navy hover:bg-sdc-gray-50">
            Cancel
          </button>
          <button
            type="submit"
            disabled={pending}
            className="h-9 rounded-lg bg-sdc-blue px-3.5 text-sm font-semibold text-white motion-interactive hover:brightness-95 disabled:opacity-60"
          >
            {pending ? "Creating…" : "Create Position"}
          </button>
        </div>
      </form>
    </BuildReadinessDrawer>
  );
}
