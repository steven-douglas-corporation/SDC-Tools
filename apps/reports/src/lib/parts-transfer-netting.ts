// ── Job-to-job part transfers, netted into Parts Actual (2026-10-13) ─────────
//
// Reported: job 1155's parts were transferred to job 1160 and the app kept showing
// the cost on 1155 and not on 1160.
//
// WHY: every Parts Actual figure in the app sums AP invoice lines, each counted
// against the job written on the line. Total ETO cannot re-code an invoice from one
// job to another (confirmed with accounting), so a transfer is booked as INVENTORY
// PULLS instead: a negative pull on the job the parts leave and a positive pull of
// the same item and quantity on the job they arrive at. The invoices stay put, and
// the app never read the pulls, so the money stayed on the wrong job. Total ETO's
// own material-cost report does net the pulls, which is how the two came to disagree.
//
// ── Why only MATCHED pairs, never raw pulls ─────────────────────────────────
//
// A pull is also how stock is issued and returned in the ordinary course. Measured
// 2026-10-13 across the database: 2,733 negative pulls worth -$4.90M against 1,703
// positive worth +$0.20M, almost all of it job 99999 (the stock bin). Adding raw
// pulls would have corrupted about 100 jobs. A transfer has a signature a normal
// issue does not: the same item, the same quantity, leaving one job and arriving at
// another within days. 1155 -> 1160 is 122 such pairs, all on 2026-08-24.
// `StockTransfer` is no help: it is false on every pull in the database.
//
// ── The rule ────────────────────────────────────────────────────────────────
//
//   - fulfilled pulls only, on a real job (not the stock bin)
//   - a negative pull is matched to ONE positive pull on a DIFFERENT job, same
//     item, same quantity (opposite sign), fulfilled within TRANSFER_WINDOW_DAYS
//   - the positive side must NOT be linked to a purchase order: such a pull
//     draws on that job's own receipt, whose invoice the app already counts
//   - the two costs must be of the same order (within 2x), else it is not the same movement
//   - the nearest date wins; ties go to the lowest pull id, so it is deterministic
//   - the from-job is reduced by the negative pull's cost, the to-job increased by
//     the positive pull's own cost (each side's own booked value, as Total ETO does)
//   - only transfers from TRANSFER_NETTING_FROM onward; nothing earlier moves
//
// Unmatched pulls are never applied. See `matchTransfers`' `unmatched` for the list
// that is left for a person to review.

/** First day (inclusive, YYYY-MM-DD) a transfer is netted. Earlier ones stay as signed off. */
export const TRANSFER_NETTING_FROM = "2026-08-01";

/** The two halves of a transfer must be fulfilled within this many days of each other. */
export const TRANSFER_WINDOW_DAYS = 14;

/** The inventory/stock-bin pseudo-job. Pulls on it are stock movement, not job cost. */
export const STOCK_BIN_JOB_ID = 99999;

/**
 * The two costs of one transfer may differ by up to this much (absolute), or the arriving cost
 * must be within a factor of TRANSFER_COST_RATIO of the leaving one. Each side is costed by
 * Total ETO on its own (1155 -> 1160 item 2726 left at $225.00 and arrived at $168.00), so
 * they are never exactly equal; what they must not be is unrelated (a $21.32 pull against a
 * $0 one is not the same movement).
 */
const TRANSFER_COST_SLACK = 1;
const TRANSFER_COST_RATIO = 2;

export type PullRow = {
  id: number;
  jobId: number;
  itemId: number;
  /** Signed: negative leaves the job, positive arrives. */
  qty: number;
  /** The pull's own booked cost (CostingValue), signed with the quantity. */
  cost: number;
  /** FulfilledDate, as YYYY-MM-DD. */
  day: string;
  /** True when the pull draws on a purchase order line (PurchaseDetailID set). */
  poLinked: boolean;
};

export type Transfer = {
  fromJob: string;
  toJob: string;
  itemId: number;
  qty: number;
  /** Dollars leaving `fromJob` (positive number). */
  costOut: number;
  /** Dollars arriving at `toJob` (positive number). */
  costIn: number;
  /** The later of the two fulfilment days. A transfer counts "as of" a day once both halves are done. */
  day: string;
  negPullId: number;
  posPullId: number;
};

const MS_DAY = 86_400_000;
const dayMs = (day: string) => Date.parse(`${day}T00:00:00Z`);
const cents = (n: number) => Math.round(n * 100) / 100;

function costsAgree(costOut: number, costIn: number): boolean {
  if (Math.abs(costOut - costIn) <= TRANSFER_COST_SLACK) return true;
  if (costOut <= 0 || costIn <= 0) return false;
  const ratio = costIn / costOut;
  return ratio >= 1 / TRANSFER_COST_RATIO && ratio <= TRANSFER_COST_RATIO;
}

export type MatchResult = {
  transfers: Transfer[];
  /** Pulls on or after the cutoff that matched nothing — left for review, never applied. */
  unmatched: PullRow[];
};

/**
 * Pairs transfers out of a set of fulfilled pulls. Pure: no I/O, no clock.
 *
 * `rows` must include positive pulls up to TRANSFER_WINDOW_DAYS BEFORE `from`, since the
 * arriving half of a transfer is sometimes booked a few days ahead of the leaving half.
 * `asOf` (YYYY-MM-DD) keeps only transfers whose both halves are done by that day.
 */
export function matchTransfers(
  rows: readonly PullRow[],
  opts: { from?: string; asOf?: string | null } = {},
): MatchResult {
  const from = opts.from ?? TRANSFER_NETTING_FROM;
  const asOf = opts.asOf ?? null;

  const usable = rows.filter(
    (r) => r.jobId !== STOCK_BIN_JOB_ID && Number.isFinite(r.cost) && Number.isFinite(r.qty) && r.qty !== 0,
  );
  const byItem = new Map<number, PullRow[]>();
  for (const r of usable) {
    if (r.qty <= 0 || r.poLinked) continue;
    const list = byItem.get(r.itemId) ?? [];
    list.push(r);
    byItem.set(r.itemId, list);
  }

  const negatives = usable
    .filter((r) => r.qty < 0 && r.day >= from)
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.id - b.id));

  const used = new Set<number>();
  const matchedNeg = new Set<number>();
  const transfers: Transfer[] = [];

  for (const n of negatives) {
    let best: PullRow | null = null;
    let bestGap = Infinity;
    for (const p of byItem.get(n.itemId) ?? []) {
      if (used.has(p.id) || p.jobId === n.jobId) continue;
      if (Math.abs(p.qty + n.qty) > 1e-6) continue;
      const gap = Math.abs(dayMs(p.day) - dayMs(n.day)) / MS_DAY;
      if (gap > TRANSFER_WINDOW_DAYS) continue;
      if (!costsAgree(Math.abs(n.cost), p.cost)) continue;
      if (gap < bestGap || (gap === bestGap && best && p.id < best.id)) {
        best = p;
        bestGap = gap;
      }
    }
    if (!best) continue;
    used.add(best.id);
    matchedNeg.add(n.id);
    transfers.push({
      fromJob: String(n.jobId),
      toJob: String(best.jobId),
      itemId: n.itemId,
      qty: Math.abs(n.qty),
      costOut: Math.abs(n.cost),
      costIn: best.cost,
      day: n.day > best.day ? n.day : best.day,
      negPullId: n.id,
      posPullId: best.id,
    });
  }

  const kept = asOf ? transfers.filter((t) => t.day <= asOf) : transfers;
  const unmatched = usable.filter((r) => r.day >= from && !matchedNeg.has(r.id) && !used.has(r.id));
  return { transfers: kept, unmatched };
}

/**
 * The dollars each job's Parts Actual moves by: minus what left it, plus what arrived.
 * Keyed by job number string, like every other per-job map in the app. Jobs that net to
 * exactly zero are left out.
 */
export function netTransfersByJob(transfers: readonly Transfer[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of transfers) {
    out.set(t.fromJob, (out.get(t.fromJob) ?? 0) - t.costOut);
    out.set(t.toJob, (out.get(t.toJob) ?? 0) + t.costIn);
  }
  for (const [job, v] of out) {
    const r = cents(v);
    if (r === 0) out.delete(job);
    else out.set(job, r);
  }
  return out;
}

/**
 * Adds `adjustments` onto a Parts Actual map, in place.
 *
 * A job that is NOT already in `actual` is skipped, never created: absence is how
 * getPartsActualByJob says "no Total ETO data for this job", which protects the
 * manually-typed historical actuals (see syncPartsCostActual). A pull alone does not
 * make a job a Total ETO job.
 */
export function applyNetting(actual: Map<string, number>, adjustments: ReadonlyMap<string, number>): void {
  for (const [job, delta] of adjustments) {
    const cur = actual.get(job);
    if (cur === undefined) continue;
    actual.set(job, cents(cur + delta));
  }
}
