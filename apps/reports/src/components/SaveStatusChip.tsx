"use client";

import { useSyncExternalStore } from "react";
import { autosaveLabel, type AutosaveStatus } from "@/lib/autosave";
import { subscribeCellSaveStates, invalidCellNames, conflictCellNames } from "@/lib/etc-save-state";

// The autosave read-out for both grids. It replaces nothing — the manual Save
// button stays — but with edits committing on their own, "did that save?"
// becomes the question the toolbar has to answer at a glance, and an unlabelled
// spinner is not an answer.
//
// Ported in spirit from the Scheduler's save-status chip (2026-07-23), which
// was built after a manager lost 1,148 meeting notes to an autosave everyone
// assumed was working. The lesson there was that the failure state needs to be
// loud and needs a way out, hence the Retry.
export function SaveStatusChip({
  status,
  onRetry,
  // Does this chip speak for the ETC GRID's cells? Only one of the three chips on the
  // page does. lib/etc-save-state.ts is a store about grid cells, so the pool panel's
  // chip and the Projects chip must not read from it — before this prop existed, an
  // invalid New ETC cell made the Standard Fees panel's own chip claim something in
  // IT needed fixing, and the banner rendered twice.
  watchesGridCells = false,
}: {
  status: AutosaveStatus;
  onRetry?: () => void;
  watchesGridCells?: boolean;
}) {
  // ── An invalid cell outranks everything this chip could otherwise say (§27.9) ──
  //
  // "Do not display 'All changes saved'" is the requirement, and it is the right one:
  // a cell holding text this column will not accept is never sent, so the autosave
  // genuinely has nothing pending and would sit there — truthfully, and completely
  // misleadingly — on a green "All changes saved" while a red cell sat on screen.
  //
  // Counted rather than merely flagged, because on a grid of ~1,180 inputs "one of
  // them is wrong" is not something a person can act on.
  const invalidCount = useSyncExternalStore(
    subscribeCellSaveStates,
    () => invalidCellNames().length,
    () => 0, // server render: nothing has been typed yet, so nothing can be invalid
  );
  // ── A refused cell outranks "All changes saved" too (2026-08-31) ───────────
  //
  // Same requirement as the invalid case, same reason: the write did not land.
  // Ranked BELOW invalid only because an invalid value is the one the user can fix
  // without looking anything up; a conflict asks them to go read the stored figure
  // first. Both must stop the green chip, which is the whole point.
  //
  // Subscribed HERE, beside the invalid count and above every early return — both are
  // hooks, so neither may sit behind one of the `return`s below.
  const conflictCount = useSyncExternalStore(
    subscribeCellSaveStates,
    () => conflictCellNames().length,
    () => 0, // server render: nothing has been saved yet, so nothing can be refused
  );
  if (watchesGridCells && invalidCount > 0) {
    return (
      <span
        role="status"
        aria-live="polite"
        className="flex items-center gap-1.5 rounded-md border border-sdc-red-border bg-sdc-red-bg px-2 py-1 text-note font-medium text-sdc-red-text"
        title="A cell holds a value this column does not accept. It has not been saved and is not counted in any total — hover the red cell to see what it expects."
      >
        <WarnIcon />
        {invalidCount === 1 ? "1 cell needs fixing" : `${invalidCount} cells need fixing`}
      </span>
    );
  }

  if (watchesGridCells && conflictCount > 0) {
    return (
      <span
        role="status"
        aria-live="polite"
        className="flex items-center gap-1.5 rounded-md border border-sdc-red-border bg-sdc-red-bg px-2 py-1 text-note font-medium text-sdc-red-text"
        title="Another user changed these cells first, so your values were not saved. Check the figure that is stored now before re-entering."
      >
        <WarnIcon />
        {conflictCount === 1 ? "1 cell not saved — changed by someone else" : `${conflictCount} cells not saved — changed by someone else`}
      </span>
    );
  }

  if (status === "idle") return null;
  const label = autosaveLabel(status);

  if (status === "error") {
    return (
      <span className="flex items-center gap-1.5 rounded-md border border-sdc-red-border bg-sdc-red-bg px-2 py-1 text-note font-medium text-sdc-red-text">
        <WarnIcon />
        {label}
        {onRetry && (
          <button type="button" onClick={onRetry} className="ml-0.5 underline underline-offset-2 hover:no-underline">
            Retry
          </button>
        )}
      </span>
    );
  }

  return (
    <span
      role="status"
      aria-live="polite"
      className={`flex items-center gap-1.5 text-note font-medium ${
        status === "saved" ? "text-sdc-green-text" : "text-sdc-gray-600"
      }`}
    >
      {status === "saving" && <Spinner />}
      {status === "saved" && <CheckIcon />}
      {status === "pending" && <DotIcon />}
      {label}
    </span>
  );
}

function Spinner() {
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" className="animate-spin" aria-hidden>
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.25" />
      <path d="M8 2 a6 6 0 0 1 6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M3 8.5 L6.5 12 L13 4.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function DotIcon() {
  return (
    <svg viewBox="0 0 16 16" width="9" height="9" aria-hidden>
      <circle cx="8" cy="8" r="4" fill="currentColor" opacity="0.55" />
    </svg>
  );
}
function WarnIcon() {
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M8 3.5 L14 13 H2 Z" strokeLinejoin="round" />
      <path d="M8 7v2.5" strokeLinecap="round" />
      <circle cx="8" cy="11.4" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  );
}
