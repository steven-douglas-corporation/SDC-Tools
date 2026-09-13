// ── The KPI strip's ONE definition of what is live and what is not (§28) ─────
//
// The Monthly ETC cards were reported as "not updating when values change in the
// tables". They half were, and the half is the bug.
//
// What was actually happening (§28.3 — the root cause, not a symptom):
//
//   EtcMonthKpiCards computed the three DIFFS from the live cell store
//   (lib/etc-live-totals.ts) and took everything else from the server figures the
//   page was rendered with. But `diff` is defined as `Hours Left − New ETC`, and
//   `newEtc` was NOT overridden — so after a manager typed a New ETC, the card
//   showed a LIVE diff next to a STALE New ETC. The Parts card put both in one
//   sentence:
//
//       title="Money Left ($X) − New ETC ($Y)"     ← both server, page-load values
//       value=partsDiff                            ← live
//
//   so the tooltip explained the number with arithmetic that did not produce it.
//   Two figures, one formula, two different vintages.
//
// The fix is not "refresh the cards". It is to stop having two vintages: this module
// is the single place that says, per KPI, whether the authoritative value is the
// SYNCED one (from Paylocity punches, TotalETO purchases, the pool ledger) or the
// EDITABLE one (what a manager is typing right now), and it derives the whole strip
// from that one answer.
//
// Deliberately pure and dependency-free so it can be tested directly and so the
// component has no arithmetic of its own left to drift.
//
// ── The rule, stated once (§28.4) ───────────────────────────────────────────
//
// A KPI field is LIVE when, and only when, it is a function of New ETC — the one
// column on this page anybody can edit. Everything else describes what already
// happened and cannot move until a Refresh Data pass changes it:
//
//   FIELD          AUTHORITY   SOURCE                              WHY
//   prior          synced      EtcEntry.priorEtc                   last month's close
//   worked         synced      Paylocity punches -> hoursWorked    time already booked
//   hoursLeft      synced      prior − worked                      both sides synced
//   people         synced      JobHoursDetail distinct employeeId  who booked time
//   parts.spent    synced      TotalETO invoiced parts             money already spent
//   parts.moneyLeft synced     parts.prior − parts.spent           both sides synced
//   newEtc         EDITABLE    the New ETC cells                   what is being typed
//   diff           EDITABLE    hoursLeft − max(newEtc, 0)          derives from newEtc
//   diffUnplanned  EDITABLE    the part of diff nobody has planned  derives from newEtc
//
// Scope (§28.9/§28.10): the live store is fed by the cells the GRID rendered, which
// is the month's full authorised set after the Billable filter — the same set
// getEtcMonthKpis is handed on the server. It is NOT the visible rows: every cell
// publishes on mount whether or not it is scrolled into view, and the grid does not
// virtualise. A column hidden by the Columns filter DOES unmount its cells, which is
// why `hasLiveData` below falls back to the server figure rather than reporting a
// confident partial sum.
//
// Blanks, zero and cleared values (§28.7/§28.8) are not decided here: the cells
// publish figures already computed by newEtcDiff/effectiveNewEtc in lib/etc.ts, which
// is the same code getEtcMonthKpis calls on the server. That is what makes the live
// preview and the backend-authoritative value the same number rather than two
// implementations that agree today.

import type { EtcMonthKpis } from "@/lib/etc-month-kpis";
import type { JobTotals } from "@/lib/etc-live-totals";
import { roundTo } from "@/lib/cell-rules";

// What the live cell store adds up to, across every job currently published.
type LiveGroup = { newEtc: number; diff: number; diffUnplanned: number; plannedHoursLeft: number; plannedNewEtc: number };

export type LiveKpiRollup = {
  engineering: LiveGroup;
  shop: LiveGroup;
  // null when no Parts Cost cell has published — the column can be filtered out of
  // the grid, and a confident $0 would be a worse answer than the server's figure.
  parts: { newEtc: number; diff: number; plannedMoneyLeft: number; plannedNewEtc: number } | null;
};

// Sum the published cells. Pure addition, no formulas: every value here was computed
// by the cell itself using lib/etc.ts, so this module cannot introduce a second
// definition of anything (the same rule lib/etc-live-totals.ts is built on).
export function rollupLiveTotals(totals: Map<number, JobTotals>): LiveKpiRollup | null {
  if (totals.size === 0) return null;
  const eng = { newEtc: 0, diff: 0, diffUnplanned: 0, plannedHoursLeft: 0, plannedNewEtc: 0 };
  const shop = { newEtc: 0, diff: 0, diffUnplanned: 0, plannedHoursLeft: 0, plannedNewEtc: 0 };
  const parts = { newEtc: 0, diff: 0, plannedMoneyLeft: 0, plannedNewEtc: 0 };
  let sawParts = false;
  for (const t of totals.values()) {
    eng.newEtc += t.engineering.newEtc;
    eng.diff += t.engineering.diff;
    eng.diffUnplanned += t.engineering.diffUnplanned;
    eng.plannedHoursLeft += t.engineering.plannedHoursLeft;
    eng.plannedNewEtc += t.engineering.plannedNewEtc;
    shop.newEtc += t.shop.newEtc;
    shop.diff += t.shop.diff;
    shop.diffUnplanned += t.shop.diffUnplanned;
    shop.plannedHoursLeft += t.shop.plannedHoursLeft;
    shop.plannedNewEtc += t.shop.plannedNewEtc;
    if (t.parts) {
      parts.newEtc += t.parts.newEtc;
      parts.diff += t.parts.diff;
      // One Parts cell per job, so the decided-test and the clamp are applied here
      // rather than in the store — same rule, same place in the pipeline.
      if (t.parts.decided) {
        parts.plannedMoneyLeft += t.parts.left;
        parts.plannedNewEtc += Math.max(t.parts.newEtc, 0);
      }
      sawParts = true;
    }
  }
  return { engineering: eng, shop, parts: sawParts ? parts : null };
}

// ── The whole strip, reconciled (§28.5, §28.11) ─────────────────────────────
//
// Takes the server's figures (authoritative, and what the page rendered with) and the
// live rollup (what is on screen right now), and returns ONE EtcMonthKpis in which
// every field comes from whichever of the two owns it per the table above.
//
// Returning the same shape matters: the component then has no branches of its own, so
// there is no second place for a card to pick the wrong vintage — which is precisely
// how the Parts tooltip came to contradict the number above it.
//
// `live === null` means nothing has published yet (the strip can be open on a month
// whose grid rows have not mounted). Every figure then comes from the server, which is
// correct rather than merely safe: it is the same computation, run on the same data,
// one round trip earlier.
export function reconcileEtcKpis(server: EtcMonthKpis, live: LiveKpiRollup | null): EtcMonthKpis {
  if (live === null) return server;
  // round2 on the way out, to the same precision the server applies in
  // getEtcMonthKpis — otherwise a live figure and the figure that replaces it after a
  // save could differ in the last cent purely from summation order (§27.18).
  const r = (n: number) => roundTo(n, 2);
  // ── The card's variance is the PLANNED subtraction, not the cells' own ──────
  //
  // The grid cells publish a `diff` that is deliberately NOT the KPI's variance. Since
  // 2026-08-04 the Diff COLUMN prints the full Hours Left for a cell nobody has
  // decided — by request, so an unplanned section reads as work unaccounted for. The
  // server's newEtcDiff does the opposite for the same cell: it returns 0, because an
  // undecided cell has no variance to report.
  //
  // Both are right for their own purpose, and summing the first into a card is what
  // produced the reported figure: July's Parts card said "▲ $1,085,685 under" when the
  // 13 decided cells net to exactly $0 and the $1,085,685 was entirely money with no
  // New ETC entered. That is the precise thing newEtcDiff's own comment calls the card
  // lying ("printing '+4,070 under' when the truth is 'nobody has planned 4,070 hours'").
  //
  // So the card takes `plannedHoursLeft − plannedNewEtc`, which is newEtcDiff's rule by
  // construction. Three things fall out of it at once: the card now matches the server,
  // the tooltip's subtraction produces the number beside it, and `diffUnplanned` below
  // is left to say how much is merely unplanned — which is the honest second sentence.
  const diffOf = (g: { plannedHoursLeft: number; plannedNewEtc: number }) => r(g.plannedHoursLeft - g.plannedNewEtc);
  return {
    ...server,
    engineering: {
      ...server.engineering,
      newEtc: r(live.engineering.newEtc),
      diff: diffOf(live.engineering),
      diffUnplanned: r(live.engineering.diffUnplanned),
      plannedHoursLeft: r(live.engineering.plannedHoursLeft),
      plannedNewEtc: r(live.engineering.plannedNewEtc),
    },
    shop: {
      ...server.shop,
      newEtc: r(live.shop.newEtc),
      diff: diffOf(live.shop),
      diffUnplanned: r(live.shop.diffUnplanned),
      plannedHoursLeft: r(live.shop.plannedHoursLeft),
      plannedNewEtc: r(live.shop.plannedNewEtc),
    },
    parts:
      live.parts === null
        ? server.parts
        : {
            ...server.parts,
            newEtc: r(live.parts.newEtc),
            diff: r(live.parts.plannedMoneyLeft - live.parts.plannedNewEtc),
            plannedMoneyLeft: r(live.parts.plannedMoneyLeft),
            plannedNewEtc: r(live.parts.plannedNewEtc),
          },
  };
}

// ── A tooltip whose subtraction actually produces the number (§28.15) ───────
//
// The old sentence quoted the GROUP totals:
//
//     Money Left ($2,996,607) − New ETC ($4,038,388)      shown: $1,085,685 under
//
// which does not subtract to the figure beside it, and never could. Two reasons, and
// only the first was a vintage problem:
//
//   1. the operands were the page-load values while the variance was live (fixed by
//      reconcileEtcKpis above); and
//   2. `diff` is summed PER CELL, where an undecided cell contributes exactly 0 while
//      its Hours Left and its New ETC still land in the group totals. So the group
//      subtraction includes hundreds of cells the variance deliberately excludes.
//
// `plannedHoursLeft` / `plannedNewEtc` are the same two sums restricted to the cells
// that DO contribute, clamped identically — so `planned left − planned New ETC` is
// `diff`, exactly, by construction. That is what this quotes, and the count says which
// cells it is talking about so the smaller figures are not mistaken for the month's
// totals.
export function varianceTooltip(opts: {
  leftLabel: string;
  plannedLeft: number;
  plannedNewEtc: number;
  format: (n: number) => string;
  // What the month's totals are, when they differ — so the tooltip explains the gap
  // rather than looking like it has lost some of the month.
  groupLeft?: number;
  groupNewEtc?: number;
}): string {
  const line = `${opts.leftLabel} (${opts.format(opts.plannedLeft)}) − New ETC (${opts.format(opts.plannedNewEtc)}), across the cells with a New ETC entered`;
  if (opts.groupLeft === undefined || opts.groupNewEtc === undefined) return line;
  const unplannedLeft = opts.groupLeft - opts.plannedLeft;
  // Only worth saying when there IS something excluded; on a fully-planned month the
  // two are the same and the caveat would be noise.
  if (Math.abs(unplannedLeft) < 0.5) return line;
  return (
    `${line}.\nCells nobody has planned are excluded: ${opts.format(unplannedLeft)} of ` +
    `${opts.leftLabel.toLowerCase()} has no New ETC entered yet, so it is not counted as a variance.`
  );
}
