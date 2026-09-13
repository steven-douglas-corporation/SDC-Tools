"use server";

import { prisma } from "@/lib/prisma";
import { assertStandardSheetUnlocked } from "@/lib/standard-sheet-gate";
import { loadEffectivePools } from "@/lib/standard-sheet-actions";
import { newProjectsEnteringMonth } from "@/lib/standard-pool-local";
import { POOL_PANEL_META } from "@/lib/pool-panel-meta";
import { checkMonthlyReport } from "@/lib/monthly-report-actions";
import type { NewProjectRow, PoolPanelRow } from "@/components/StandardPoolPanel";
import type { MonthlyReportStatus } from "@/lib/monthly-report-actions";

// The Standard Fees card's data, on its own (§48).
//
// ── Why this exists ─────────────────────────────────────────────────────────
//
// The card used to be reachable only through a render of the whole Monthly ETC page: its
// props were computed inside that page's `if (showStandards)` block, so the only way to
// make it appear was to make the server render 49 jobs x 83 columns, the KPI card and
// every query behind them again. Measured before the change: 2,911ms, 4 requests and
// 190KB to reveal a card the server had finished computing on the render before.
//
// So the card's own inputs are gathered here, and nothing else is. §48: "do not refetch
// Monthly ETC grid data when Show Standards is clicked", "do not recalculate unrelated
// formulas or KPI values".
//
// ── The gate is still the gate ──────────────────────────────────────────────
//
// `assertStandardSheetUnlocked()` first, before a single figure is read. A server action
// is directly callable by any signed-in user who captures its id, so this is not
// decoration — it is the same check the page makes and the same one every Standard Sheet
// mutation makes. Without the HMAC cookie this returns nothing at all, which is what
// makes it safe for the client to ASK for the card whenever it likes.
//
// It is also why §48's "preload the Standard Fees data when the Monthly ETC page loads"
// is implemented as "preload it when the page loads AND the request already carried the
// cookie": preloading it for a locked visitor would hand the confidential figures to
// exactly the person the gate exists to keep them from.

export type StandardFeesCardData = {
  month: string;
  monthName: string;
  carriedFrom: string | null;
  upstreamNote: string | null;
  rows: PoolPanelRow[];
  newProjects: NewProjectRow[];
  isSubmitted: boolean;
  poolsEditable: boolean;
  initialStatus: MonthlyReportStatus | null;
};

export async function getStandardFeesCard(month: string): Promise<StandardFeesCardData> {
  await assertStandardSheetUnlocked();

  // One wave. These four are independent, and awaiting them in sequence is how a
  // "background load" becomes something the user waits on.
  const [effective, newProjects, freshness, submittedRow, initialStatus] = await Promise.all([
    // The same carry-forward fallback the grid uses, so the card and the columns never
    // disagree about which month's pools they are showing.
    loadEffectivePools(month),
    // Always for THIS month, never the carried-from one: the list explains which jobs
    // started in the month you are looking at.
    newProjectsEnteringMonth(month),
    // The pools sync records WHY a month has no figures of its own (normally: Power BI
    // has not published the period yet), so the panel can say it rather than telling
    // people to click a Refresh that cannot help.
    prisma.powerBiFreshness.findUnique({ where: { source: "standard_pools" }, select: { status: true } }),
    prisma.standardSheetSnapshot.findFirst({ where: { month }, select: { id: true } }),
    checkMonthlyReport(month),
  ]);

  const pools = effective.pools;
  const isSubmitted = !!submittedRow;

  return {
    month,
    monthName: new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1).toLocaleString("en-US", {
      month: "long",
    }),
    carriedFrom: effective.carriedFrom,
    upstreamNote: freshness?.status?.startsWith("Waiting: ")
      ? freshness.status.slice("Waiting: ".length)
      : null,
    // The identical mapping the page performs. Kept here rather than exported from the
    // page because a page cannot export helpers to a server module — and duplicated
    // shape is guarded by PoolPanelRow, which both sides must satisfy.
    rows: POOL_PANEL_META.map(({ category, group, dept }) => {
      const p = pools.find((x) => x.category === category);
      return {
        category,
        group,
        dept,
        previousMonthPulledHours: p ? Number(p.previousMonthPulledHours) : 0,
        newHoursAddedThisMonth: p ? Number(p.newHoursAddedThisMonth) : 0,
        hoursAvailable: p ? Number(p.hoursAvailable) : 0,
        hoursWorkedThisMonth: p ? Number(p.hoursWorkedThisMonth) : 0,
        hoursPulledThisMonth: p ? Number(p.hoursPulledThisMonth) : 0,
        rate: p ? Number(p.rate) : 0,
        newEtcHours: p ? Number(p.newEtcHours) : 0,
        standardFee: p ? Number(p.standardFee) : 0,
        hasData: !!p,
      };
    }),
    newProjects,
    isSubmitted,
    // The same rule the page applies: a frozen month is not editable, and neither is one
    // whose pools are a carry-forward estimate rather than its own figures.
    poolsEditable: !isSubmitted && !effective.carriedFrom,
    initialStatus,
  };
}
