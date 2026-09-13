"use client";

import { useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { nextParams, notePendingParams } from "@/lib/url-params";

// ── The Dashboard's ONE month control, as a hook (2026-08-28) ───────────────
//
// Extracted from DashboardMonthSelect so a second control — the Execution
// Calendar's ‹ › month arrows — can move the month WITHOUT owning a month of
// its own. That is the whole point: `?m=YYYY-MM` is the single source, the
// server recomputes the entire page from it in one pass
// (lib/dashboard-overview.ts), and every figure moves together. A calendar with
// its own local month would silently disagree with the FAT KPI panel beside it
// and the utilization table below it.
//
// So the arrows are a shortcut for the dropdowns, not a separate mechanism, and
// there is one implementation of "go to this month" rather than two that have
// to be kept in step.

export type DashboardMonthNav = {
  /** The month to DISPLAY — the optimistic target while a change is in flight, else the committed one. */
  shown: string;
  /** True while a month change is navigating. */
  pending: boolean;
  /** Go to an absolute "YYYY-MM". */
  goTo: (month: string) => void;
  /** Step by whole months, +1 / -1. Handles the year boundary. */
  shift: (months: number) => void;
};

/** Add `months` to a "YYYY-MM", rolling the year over. */
export function shiftMonth(month: string, months: number): string {
  const [y, m] = month.split("-").map(Number);
  // Date handles the rollover in both directions, including -1 from January.
  const d = new Date(Date.UTC(y, m - 1 + months, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function useDashboardMonth(month: string): DashboardMonthNav {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  // `month` is a server prop and cannot change until the new page commits, so a
  // controlled <select> would snap back to the old month for the whole
  // round-trip and read as broken. The optimistic target covers that gap.
  const [target, setTarget] = useState<string | null>(null);

  const goTo = (ym: string) => {
    if (ym === month) return;
    setTarget(ym);
    // See lib/url-params.ts: useSearchParams still reports the pre-navigation
    // value while a change is in flight, so building straight from it can revert
    // whatever the Data Quality tab or another control set a moment ago.
    const currentQs = searchParams.toString();
    const qs = nextParams(currentQs);
    qs.set("m", ym);
    const q = qs.toString();
    notePendingParams(currentQs, q);
    startTransition(() => {
      router.push(`${pathname}?${q}`, { scroll: false });
    });
  };

  const shown = pending && target ? target : month;
  return { shown, pending, goTo, shift: (months) => goTo(shiftMonth(shown, months)) };
}
