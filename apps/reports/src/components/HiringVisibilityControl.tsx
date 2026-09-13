"use client";

import { useState, useTransition } from "react";
import { setHiringPositionVisibility, setCreatedHiringPositionVisibility, type SetHiringPositionVisibilityResult } from "@/lib/hiring-actions";
import type { HiringPosition } from "@/lib/hiring-positions";

// The Show/Hide row action (2026-08-19) — a plain text link, matching
// HiringPositionsList's existing "Edit" link style, rather than a new icon
// system. Picks the right write path by source (workbook vs manually-created
// — see hiring-actions.ts's own comments on why each is a separate function),
// same as HiringPositionsList already does for HiringMoveToControl vs the
// plain "Edit" link.
//
// This ONLY ever changes isVisible — it never touches workforceGroup/
// department/expectedStartDate/status. Visibility is display-only; hiding a
// position must never move it out of Open Positions/Planned Headcount/Hiring
// Capacity Hours (those stay driven by isOpen — see redactHiddenPositions in
// hiring-positions.ts for how hiding actually takes effect).
export function HiringVisibilityControl({
  position,
  canAssign,
  onToggled,
}: {
  position: Pick<HiringPosition, "sourceId" | "source" | "isVisible">;
  canAssign: boolean;
  onToggled: (positionSourceId: string, isVisible: boolean) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (!canAssign) return null;

  function toggle() {
    setError(null);
    const next = !position.isVisible;
    startTransition(async () => {
      const result: SetHiringPositionVisibilityResult =
        position.source === "manual" ? await setCreatedHiringPositionVisibility(position.sourceId, next) : await setHiringPositionVisibility(position.sourceId, next);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onToggled(position.sourceId, next);
    });
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      <button
        type="button"
        onClick={toggle}
        disabled={pending}
        className="text-note font-medium text-sdc-blue hover:underline disabled:opacity-60"
        title={position.isVisible ? "Hide this position from the normal Hiring Positions view" : "Show this position again"}
      >
        {position.isVisible ? "Hide" : "Show"}
      </button>
      {error && (
        <span className="text-label text-sdc-red-text" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
