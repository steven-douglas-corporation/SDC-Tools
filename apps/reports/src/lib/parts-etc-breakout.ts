import "server-only";
import { getPartsCostForJobs } from "@/lib/sync-totaleto";
import { withTimeoutOrNull, UPSTREAM_BUDGET_MS } from "@/lib/with-timeout";
import { explainLeftToInvoice, monthEndCutoff } from "@/lib/left-to-invoice";

// ── Seeding the Parts Cost breakout ──────────────────────────────────────────
//
// The Monthly ETC grid splits Parts Cost New ETC into two manager-entered cells —
//
//     Left to Invoice   already on a purchase order, not yet invoiced
//     Left to Purchase  on the BOM, not bought yet
//
// and New ETC is their sum, calculated rather than typed (components/
// PartsBreakoutCell.tsx carries the why).
//
// This file supplies ONE thing, and it is no longer a value: what Total ETO says is on
// a purchase order and not yet invoiced, which the grid puts on the TOOLTIP of an empty
// Left to Invoice cell. Nothing here reaches the box.
//
// It stopped being a seed on 2026-09-03, and not for taste. A live, unstored seed
// cannot coexist with New ETC being the sum of the two halves: the box showed $59,205
// against a stored null, so a save carrying only Left to Purchase derived New ETC from
// 0 + $2,500 and stored $2,500 under a cell reading $61,705. Storing the seed instead
// would freeze a live upstream number as though a manager had entered it, and marking
// the cell dirty on arrival would put the unsaved-changes warning on an untouched
// month. A tooltip is the only place this figure can sit without claiming to be an
// answer — which is exactly what the grid already does with New ETC's own suggestion.
//
// ── Left to Purchase is NOT computed here any more (2026-09-03) ─────────────
//
// It used to be: a per-job getJobBom fan-out that priced every BOM part with no
// purchase line against it. Removed by request — "remove any automatically populated
// values, all Left to Purchase cells start blank" — and the measurements say the same
// thing independently. That half needed 49 separate BOM reads (one measured at 101.7
// seconds), it could only run when the batched parts-lines query had ALREADY
// succeeded, and when that query aborted under real page load the column reported $0
// on every job rather than nothing. So the expensive half was also the unreliable
// one, and it now costs the page nothing at all: this is a single batched query with
// one timeout, where it used to be a bounded fan-out under a shared deadline.
//
// null still means "we could not find out". The cell renders blank and the manager
// types the figure, which is the same thing a blank Left to Purchase asks of them.

export type PartsEtcBreakout = {
  /** Purchased − invoiced as of month end, floored at 0. Null when the lines could not be read. */
  leftToInvoice: number | null;
  /**
   * The same figure BEFORE the aggregate floor.
   *
   * Equal to `leftToInvoice` except on an over-invoiced job, where it is negative. Two
   * jobs in August 2026 (1134 at −$427.54, 1149 at −$93.74, $521.28 together) — and
   * that is the ONE place this figure and the Parts List's own column legitimately
   * disagree, because that column is a signed per-row sum and must stay signed
   * (over-invoicing is the reason to look at it). Carried so the grid can SAY it has
   * floored rather than presenting a bare $0 that cannot be reconciled.
   */
  rawLeftToInvoice: number | null;
  /**
   * GL postings dated AFTER the cutoff that this figure nonetheless subtracts.
   *
   * The Parts List's rule — and therefore this one — takes a purchase-date cutoff with
   * lifetime invoicing, so a September posting against an August PO reduces August
   * retroactively. 31 of 49 jobs in August 2026, $76,866.43 in total. This does NOT
   * make the two surfaces disagree (they drift together, which is why parity holds on
   * any given day); it makes a closed month's figure keep moving. Carried so the grid
   * can disclose the amount instead of a manager discovering it by rereading the cell
   * next week.
   */
  postedAfterCutoff: number;
};

export type PartsEtcBreakoutResult = {
  byJobPk: Map<number, PartsEtcBreakout>;
  /** True when the batched parts-lines query failed, so no Left to Invoice is known. */
  linesFailed: boolean;
};

const EMPTY: PartsEtcBreakout = { leftToInvoice: null, rawLeftToInvoice: null, postedAfterCutoff: 0 };

/**
 * The Left to Invoice figure for a month's jobs.
 *
 * `jobs` pairs the internal PK (what the grid is keyed by) with the job NUMBER (what
 * Total ETO is keyed by). Returning a map keyed by PK keeps the caller from having to
 * hold that translation.
 *
 * `month` is the ETC month being closed, and it is what makes this figure MEAN
 * anything: it becomes an inclusive month-end cutoff, so opening August shows August's
 * position rather than today's. Without it this read was "as of right now" on a page
 * whose whole job is closing a named month — worth $100,376.71 of September POs
 * counted as August exposure on 2026-09-03. Pass null only for a genuinely lifetime
 * figure; there is no such caller today.
 *
 * Never throws. A total upstream failure yields nulls throughout and every cell simply
 * starts blank.
 */
export async function readPartsEtcBreakout(
  jobs: readonly { pk: number; jobNumber: string }[],
  month: string | null,
): Promise<PartsEtcBreakoutResult> {
  const byJobPk = new Map<number, PartsEtcBreakout>();
  for (const j of jobs) byJobPk.set(j.pk, { ...EMPTY });
  if (jobs.length === 0) return { byJobPk, linesFailed: false };

  const jobNumbers = [...new Set(jobs.map((j) => j.jobNumber).filter(Boolean))];
  const linesByJob = await withTimeoutOrNull(
    `TotalETO parts lines (${jobNumbers.length} jobs, ETC grid)`,
    UPSTREAM_BUDGET_MS,
    () => getPartsCostForJobs(jobNumbers),
    (e) => console.error("[parts-etc-breakout] batched parts lines failed:", e),
  );
  if (linesByJob == null) return { byJobPk, linesFailed: true };

  // Inclusive last day of the month, or null on a month string we do not understand —
  // in which case this degrades to the lifetime figure it used to be, rather than to
  // an empty one.
  const asOf = monthEndCutoff(month);

  for (const j of jobs) {
    // ── Absent from the map is ZERO, not unknown (fixed 2026-09-03) ─────────
    //
    // getPartsCostForJobs only returns an entry for a job that HAS lines, so a job
    // with nothing purchased yet is simply missing from the map. This used to
    // `continue`, leaving leftToInvoice null — and measured on 2026-08, 6 of 49 jobs
    // fell into it and lost their seed entirely.
    //
    // That conflated two different things. If the batched query SUCCEEDED, a job with
    // no lines has nothing on order: its Left to Invoice is $0, a real answer. Only a
    // FAILED query means unknown, and that returns above.
    const lines = linesByJob.get(j.jobNumber) ?? [];
    // THE shared definition (lib/left-to-invoice.ts) — the same function the Parts
    // List's column, the Parts Cost card and the projection all call, with this
    // month's cutoff applied. Deliberately not re-expressed here: this file having
    // its own copy of `totalPrice − actualAmount` is how it drifted from the Parts
    // List in the first place.
    // explainLeftToInvoice rather than leftToInvoiceForLines: same arithmetic, and it
    // also returns the two things the grid has to be able to say out loud — what the
    // figure was before flooring, and how much of it a post-cutoff posting has already
    // taken off. Both are documented remaining differences from the Parts List, and a
    // documented difference nobody can see on the screen is still a surprise.
    const x = explainLeftToInvoice(lines, { asOf });
    byJobPk.set(j.pk, {
      leftToInvoice: x.total,
      rawLeftToInvoice: x.raw,
      postedAfterCutoff: x.postedAfterCutoff,
    });
  }

  return { byJobPk, linesFailed: false };
}
