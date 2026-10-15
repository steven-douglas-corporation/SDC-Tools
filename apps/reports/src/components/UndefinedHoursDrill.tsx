"use client";

import { useEffect, useState } from "react";
import { UndefinedHoursPanel } from "@/components/UndefinedHoursPanel";
import { loadUnattributedDetail } from "@/lib/unattributed-actions";
import type { UnattributedDetail } from "@/lib/unattributed-hours";

// The Dashboard's Data Quality tab hosting of the Monthly ETC "Data Quality — Undefined
// Hours" drill. It is the SAME panel fed by the SAME action (loadUnattributedDetail), so
// the rows, reason cards, filters, grouping and the KPI reconciliation line are
// identical by construction rather than by two implementations agreeing.
//
// Fetched when the tile is opened, not with the page, for the reason the action itself
// gives: it is a read nobody should pay for unless they open the detail.
export function UndefinedHoursDrill({ month, onClose }: { month: string; onClose: () => void }) {
  const [state, setState] = useState<{ month: string; detail: UnattributedDetail | null; error: string | null } | null>(null);

  useEffect(() => {
    let live = true;
    loadUnattributedDetail(month)
      .then((detail) => live && setState({ month, detail, error: null }))
      .catch((e: unknown) => live && setState({ month, detail: null, error: e instanceof Error ? e.message : "Could not load." }));
    return () => {
      live = false;
    };
  }, [month]);

  const current = state && state.month === month ? state : null;

  if (!current) return <p className="text-xs text-sdc-muted">Loading undefined hours…</p>;
  if (current.error || !current.detail) {
    return (
      <p role="alert" className="text-xs font-medium text-sdc-red-text">
        Couldn&apos;t load the undefined hours: {current.error ?? "no data"}
      </p>
    );
  }
  return <UndefinedHoursPanel detail={current.detail} month={month} onClose={onClose} />;
}
