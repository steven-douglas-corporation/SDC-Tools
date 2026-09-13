"use client";

import { useState, useTransition } from "react";
import { setHiringPositionExpectedStartDate, type SetHiringExpectedStartDateResult } from "@/lib/hiring-actions";

// The expected-start-date editor for a workbook-sourced hiring position —
// same small-inline-control shape as HiringMoveToControl.tsx, but for an
// independent concern (see setHiringExpectedStartDate's own comment on why
// the two write paths are kept separate rather than folded together). Blank
// clears it back to "unknown," which counts as full-year capacity, not zero
// (workforce-capacity.ts's isStartedByMonth).
function toDateInputValue(d: Date | null): string {
  if (!d) return "";
  return d.toISOString().slice(0, 10);
}

export function HiringExpectedStartDateControl({
  positionSourceId,
  expectedStartDate,
  canAssign,
  onSaved,
  save = setHiringPositionExpectedStartDate,
}: {
  positionSourceId: string;
  expectedStartDate: Date | null;
  canAssign: boolean;
  onSaved: (positionSourceId: string, date: Date | null) => void;
  /** Defaults to setHiringPositionExpectedStartDate (workbook-sourced positions). Injectable for tests. */
  save?: (positionSourceId: string, date: Date | null) => Promise<SetHiringExpectedStartDateResult>;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [value, setValue] = useState(toDateInputValue(expectedStartDate));

  if (!canAssign) {
    return <span className="text-note text-sdc-muted">{expectedStartDate ? expectedStartDate.toLocaleDateString("en-US") : "Not set"}</span>;
  }

  function apply(next: string) {
    setValue(next);
    setError(null);
    startTransition(async () => {
      const date = next ? new Date(next) : null;
      const result = await save(positionSourceId, date);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onSaved(positionSourceId, date);
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <input
        type="date"
        value={value}
        disabled={pending}
        onChange={(e) => apply(e.target.value)}
        aria-label={`Set expected start date for "${positionSourceId}"`}
        className="h-7 rounded border border-sdc-border bg-white px-1.5 text-xs text-sdc-navy outline-none focus:border-sdc-blue disabled:opacity-60"
      />
      {error && (
        <span className="text-label text-sdc-red-text" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
