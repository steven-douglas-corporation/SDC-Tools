"use client";

import { useState, useTransition } from "react";
import { setHiringFilled, setHiringPositionQuantity, type SetHiringOpeningsResult } from "@/lib/hiring-actions";

// ── Openings on a hiring position: how many, and how many are filled ────────
//
// Same small-inline-control shape as HiringMoveToControl/
// HiringExpectedStartDateControl, and like them it writes through a narrow
// server action rather than a whole-form save, so it can never revert a field
// somebody else changed a moment earlier.
//
// Unlike those two it serves BOTH position sources. Which table backs a
// position is an implementation detail here — "we need two of this role, one is
// hired" means exactly the same thing whether the requisition came from
// Paylocity's workbook or was created in this app — so the actions take the
// source id and dispatch internally (see setHiringFilled's own comment).
//
// Two separate writes, deliberately not one "openings" form: raising Quantity
// (we need another one of these) and marking one hired (we filled one) are
// different events, they get different audit entries, and one is far more
// common than the other. A single form would make the common action a
// three-step edit.

export function HiringOpeningsControl({
  positionSourceId,
  quantity,
  filledCount,
  canAssign,
  onSaved,
  saveQuantity = setHiringPositionQuantity,
  saveFilled = setHiringFilled,
}: {
  positionSourceId: string;
  quantity: number;
  filledCount: number;
  canAssign: boolean;
  /** Handed the new pair so the caller can patch its own state without a reload — matching HiringExpectedStartDateControl's onSaved contract. */
  onSaved: (positionSourceId: string, next: { quantity: number; filledCount: number }) => void;
  /** Injectable for tests, same as the sibling controls. */
  saveQuantity?: (positionSourceId: string, quantity: number) => Promise<SetHiringOpeningsResult>;
  saveFilled?: (positionSourceId: string, filledCount: number) => Promise<SetHiringOpeningsResult>;
}) {
  // Raw text, not a number — see the same note on the Create form's field: a
  // number state has to decide what to show the moment the input is empty
  // mid-edit, and every answer fights the keystroke.
  const [draftQuantity, setDraftQuantity] = useState(String(quantity));
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const remaining = Math.max(0, quantity - filledCount);
  const fullyFilled = remaining === 0;

  function commitQuantity() {
    setError(null);
    const next = Number(draftQuantity);
    if (!draftQuantity.trim() || !Number.isInteger(next) || next < 1) {
      setError("Quantity must be a whole number of 1 or more.");
      setDraftQuantity(String(quantity));
      return;
    }
    if (next === quantity) return;
    startTransition(async () => {
      const result = await saveQuantity(positionSourceId, next);
      if (!result.ok) {
        setError(result.error);
        setDraftQuantity(String(quantity));
        return;
      }
      onSaved(positionSourceId, { quantity: next, filledCount });
    });
  }

  function changeFilled(next: number) {
    setError(null);
    startTransition(async () => {
      const result = await saveFilled(positionSourceId, next);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onSaved(positionSourceId, { quantity, filledCount: next });
    });
  }

  if (!canAssign) {
    return (
      <span className="text-sm text-sdc-navy tabular-nums">
        {quantity === 1 ? "1 opening" : `${quantity} openings`}
        {filledCount > 0 && <span className="text-sdc-muted"> · {filledCount} filled</span>}
      </span>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex items-center gap-2">
        <input
          type="number"
          min={1}
          step={1}
          inputMode="numeric"
          value={draftQuantity}
          disabled={pending}
          onChange={(e) => setDraftQuantity(e.target.value)}
          // Commit on blur and on Enter, never on every keystroke — a write per
          // digit would audit "2 → 25 → 2" while somebody corrected a typo.
          onBlur={commitQuantity}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.currentTarget.blur();
            }
            if (e.key === "Escape") setDraftQuantity(String(quantity));
          }}
          aria-label="Number of openings"
          className="h-8 w-16 rounded-lg border border-sdc-border bg-white px-2 text-sm tabular-nums text-sdc-navy outline-none focus:border-sdc-blue disabled:opacity-50"
        />
        <span className="text-note text-sdc-muted">
          {filledCount > 0 ? `${filledCount} filled · ${remaining} remaining` : "openings"}
        </span>
      </div>

      <div className="flex items-center gap-1.5">
        <button
          type="button"
          disabled={pending || fullyFilled}
          onClick={() => changeFilled(filledCount + 1)}
          title={fullyFilled ? "Every opening on this position is filled" : "Record that one of these openings has been hired"}
          className="rounded-lg border border-sdc-border px-2 py-1 text-note font-semibold text-sdc-navy hover:bg-sdc-blue-light disabled:opacity-40"
        >
          Mark one hired
        </button>
        {filledCount > 0 && (
          <button
            type="button"
            disabled={pending}
            onClick={() => changeFilled(filledCount - 1)}
            title="Undo one — the hire fell through, or it was recorded by mistake"
            className="rounded-lg border border-sdc-border px-2 py-1 text-note text-sdc-muted hover:bg-sdc-blue-light disabled:opacity-40"
          >
            Undo
          </button>
        )}
      </div>

      {fullyFilled && (
        <span className="text-note font-semibold text-sdc-muted">
          All {quantity} filled — no longer counted as open
        </span>
      )}
      {error && <span className="text-note text-sdc-red-text">{error}</span>}
    </div>
  );
}
