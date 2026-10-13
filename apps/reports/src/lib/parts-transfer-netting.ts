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
//   - unambiguous matches first; a genuine tie goes to the from -> to route with the most
//     unambiguous matches, then the nearest date, then the lowest pull id (deterministic)
//   - a transfer booked in PIECES (8 units out, 1 + 7 in) is matched in a second pass, only
//     when the pieces sum exactly to the single pull on the other side, on ONE other job;
//     if more than one job could complete the sum it is ambiguous and nothing is applied
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
  /** Total units moved. */
  qty: number;
  /** Dollars leaving `fromJob` (positive number), summed over every leaving pull. */
  costOut: number;
  /** Dollars arriving at `toJob` (positive number), summed over every arriving pull. */
  costIn: number;
  /** The latest fulfilment day of any pull in it. A transfer counts "as of" a day once every half is done. */
  day: string;
  /** The leaving pulls (one, or several when the departure was booked in pieces). */
  negPullIds: number[];
  /** The arriving pulls (one, or several when the arrival was booked in pieces). */
  posPullIds: number[];
};

const MS_DAY = 86_400_000;
const dayMs = (day: string) => Date.parse(`${day}T00:00:00Z`);
const cents = (n: number) => Math.round(n * 100) / 100;
const gapDays = (a: string, b: string) => Math.abs(dayMs(a) - dayMs(b)) / MS_DAY;
const QTY_EPS = 1e-6;

/**
 * A transfer booked in pieces (8 units out, 1 + 7 in) is matched when the pieces on the
 * short side add up EXACTLY to the one pull on the other, never more than this many pieces.
 * Fewer pieces means fewer chances that unrelated pulls happen to sum to the same number.
 */
export const TRANSFER_MAX_PIECES = 6;
/** At most this many candidate pulls per (item, other job) are searched for a sum. */
const SPLIT_CANDIDATE_CAP = 14;

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

const byDayThenId = (a: PullRow, b: PullRow) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.id - b.id);

/**
 * The first set of 2..TRANSFER_MAX_PIECES pulls (searched in the order given, which the caller
 * sorts nearest-date first, so the result is deterministic) whose quantities add up to `target`
 * exactly and whose summed cost agrees with `cost`. `dir` 1: the pieces are the arriving side;
 * -1: they are the leaving side.
 */
function findPieces(cands: readonly PullRow[], target: number, cost: number, dir: 1 | -1): PullRow[] | null {
  const pool = cands.slice(0, SPLIT_CANDIDATE_CAP);
  const pick: PullRow[] = [];
  const dfs = (start: number, qtyLeft: number): boolean => {
    if (Math.abs(qtyLeft) <= QTY_EPS) {
      if (pick.length < 2) return false;
      const sum = pick.reduce((s, r) => s + Math.abs(r.cost), 0);
      return dir === 1 ? costsAgree(cost, sum) : costsAgree(sum, cost);
    }
    if (pick.length >= TRANSFER_MAX_PIECES) return false;
    for (let i = start; i < pool.length; i++) {
      const q = Math.abs(pool[i].qty);
      if (q > qtyLeft + QTY_EPS) continue;
      pick.push(pool[i]);
      if (dfs(i + 1, qtyLeft - q)) return true;
      pick.pop();
    }
    return false;
  };
  return dfs(0, target) ? [...pick] : null;
}

/**
 * Pairs transfers out of a set of fulfilled pulls. Pure: no I/O, no clock.
 *
 * Two passes, in this order, so the safest match always wins:
 *   1. one leaving pull to one arriving pull of the same quantity;
 *   2. what is left, where one side was booked in pieces — 1155 -> 1160 item 2744 left as one
 *      pull of 8 and arrived as 1 + 7. The pieces must sum EXACTLY to the single pull on the
 *      other side, all on ONE other job, same item, inside the window, with costs of the same
 *      order. If pieces would complete the sum on more than one candidate job it is ambiguous
 *      and nothing is applied; it stays in `unmatched` for a person.
 *
 * `rows` must include positive pulls up to TRANSFER_WINDOW_DAYS BEFORE `from`, since the
 * arriving half of a transfer is sometimes booked a few days ahead of the leaving half.
 * `asOf` (YYYY-MM-DD) keeps only transfers whose halves are all done by that day.
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
  // Arriving pulls that can be half of a transfer, by item.
  const posByItem = new Map<number, PullRow[]>();
  for (const r of usable) {
    if (r.qty <= 0 || r.poLinked) continue;
    const list = posByItem.get(r.itemId) ?? [];
    list.push(r);
    posByItem.set(r.itemId, list);
  }
  const negatives = usable.filter((r) => r.qty < 0 && r.day >= from).sort(byDayThenId);
  const negByItem = new Map<number, PullRow[]>();
  for (const r of negatives) {
    const list = negByItem.get(r.itemId) ?? [];
    list.push(r);
    negByItem.set(r.itemId, list);
  }

  const used = new Set<number>();
  const transfers: Transfer[] = [];
  const record = (negs: PullRow[], poss: PullRow[]) => {
    for (const r of [...negs, ...poss]) used.add(r.id);
    transfers.push({
      fromJob: String(negs[0].jobId),
      toJob: String(poss[0].jobId),
      itemId: negs[0].itemId,
      qty: negs.reduce((s, r) => s + Math.abs(r.qty), 0),
      costOut: negs.reduce((s, r) => s + Math.abs(r.cost), 0),
      costIn: poss.reduce((s, r) => s + r.cost, 0),
      day: [...negs, ...poss].reduce((d, r) => (r.day > d ? r.day : d), ""),
      negPullIds: negs.map((r) => r.id),
      posPullIds: poss.map((r) => r.id),
    });
  };

  // Pass 1 — one to one, in two steps so a tie is settled by evidence and not by pull id.
  //
  // Every leaving pull's qualifying arrivals are listed first. Two identical leaving pulls
  // (1155 and 1096, same item, same day) and two identical arrivals (1160 and 1162) can pair
  // either way round; breaking that by id produced "1155 -> 1162" beside "1096 -> 1160" for a
  // $17.60 item while 122 other items moved 1155 -> 1160 that same day.
  //   A. a leaving pull with exactly ONE arrival left is matched — nothing to decide. Repeats
  //      until none is left, because each match can leave another with a single choice. The
  //      from -> to routes these establish are counted.
  //   B. whatever still has several arrivals goes to the route with the most unambiguous
  //      matches, then the nearest date, then the lowest id.
  const arrivalsFor = new Map<number, PullRow[]>();
  for (const n of negatives) {
    const list: PullRow[] = [];
    for (const p of posByItem.get(n.itemId) ?? []) {
      if (p.jobId === n.jobId) continue;
      if (Math.abs(p.qty + n.qty) > QTY_EPS) continue;
      if (gapDays(p.day, n.day) > TRANSFER_WINDOW_DAYS) continue;
      if (!costsAgree(Math.abs(n.cost), p.cost)) continue;
      list.push(p);
    }
    arrivalsFor.set(n.id, list);
  }
  const routeCount = new Map<string, number>();
  const route = (n: PullRow, p: PullRow) => `${n.jobId}>${p.jobId}`;
  for (let progressed = true; progressed; ) {
    progressed = false;
    for (const n of negatives) {
      if (used.has(n.id)) continue;
      const open = (arrivalsFor.get(n.id) ?? []).filter((p) => !used.has(p.id));
      if (open.length !== 1) continue;
      record([n], [open[0]]);
      routeCount.set(route(n, open[0]), (routeCount.get(route(n, open[0])) ?? 0) + 1);
      progressed = true;
    }
  }
  // The strongest evidence is committed first — across ALL the leftover pairs, not in pull-id
  // order. Walking leaving pulls by id let 1096 (lower id) take the 1160 arrival ahead of 1155,
  // whose route to 1160 carries 122 other items that day.
  for (;;) {
    let best: { n: PullRow; p: PullRow; affinity: number; gap: number } | null = null;
    for (const n of negatives) {
      if (used.has(n.id)) continue;
      for (const p of arrivalsFor.get(n.id) ?? []) {
        if (used.has(p.id)) continue;
        const affinity = routeCount.get(route(n, p)) ?? 0;
        const gap = gapDays(p.day, n.day);
        const better =
          best === null ||
          affinity > best.affinity ||
          (affinity === best.affinity &&
            (gap < best.gap || (gap === best.gap && (n.id < best.n.id || (n.id === best.n.id && p.id < best.p.id)))));
        if (better) best = { n, p, affinity, gap };
      }
    }
    if (!best) break;
    record([best.n], [best.p]);
    routeCount.set(route(best.n, best.p), (routeCount.get(route(best.n, best.p)) ?? 0) + 1);
  }

  // Pass 2a — one leaving pull, arriving in pieces on a single other job.
  for (const n of negatives) {
    if (used.has(n.id)) continue;
    const need = Math.abs(n.qty);
    const byJob = new Map<number, PullRow[]>();
    for (const p of posByItem.get(n.itemId) ?? []) {
      if (used.has(p.id) || p.jobId === n.jobId || Math.abs(p.qty) >= need - QTY_EPS) continue;
      if (gapDays(p.day, n.day) > TRANSFER_WINDOW_DAYS) continue;
      const list = byJob.get(p.jobId) ?? [];
      list.push(p);
      byJob.set(p.jobId, list);
    }
    const found: PullRow[][] = [];
    for (const list of byJob.values()) {
      list.sort((a, b) => gapDays(a.day, n.day) - gapDays(b.day, n.day) || a.id - b.id);
      const pieces = findPieces(list, need, Math.abs(n.cost), 1);
      if (pieces) found.push(pieces);
    }
    if (found.length === 1) record([n], found[0]);
  }

  // Pass 2b — one arriving pull, leaving in pieces from a single other job.
  const leftoverPos = [...posByItem.values()].flat().filter((p) => !used.has(p.id)).sort(byDayThenId);
  for (const p of leftoverPos) {
    if (used.has(p.id)) continue;
    const need = Math.abs(p.qty);
    const byJob = new Map<number, PullRow[]>();
    for (const n of negByItem.get(p.itemId) ?? []) {
      if (used.has(n.id) || n.jobId === p.jobId || Math.abs(n.qty) >= need - QTY_EPS) continue;
      if (gapDays(p.day, n.day) > TRANSFER_WINDOW_DAYS) continue;
      const list = byJob.get(n.jobId) ?? [];
      list.push(n);
      byJob.set(n.jobId, list);
    }
    const found: PullRow[][] = [];
    for (const list of byJob.values()) {
      list.sort((a, b) => gapDays(a.day, p.day) - gapDays(b.day, p.day) || a.id - b.id);
      const pieces = findPieces(list, need, p.cost, -1);
      if (pieces) found.push(pieces);
    }
    if (found.length === 1) record(found[0], [p]);
  }

  const kept = asOf ? transfers.filter((t) => t.day <= asOf) : transfers;
  const unmatched = usable.filter((r) => r.day >= from && !used.has(r.id));
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

// ── What a Parts Cost card shows for a set of jobs (2026-10-13) ──────────────
//
// The Job Details Parts Cost card covers one job — or several at once. A transfer
// between two jobs INSIDE the selection never left it, so it is not shown and not
// counted; only transfers with the other side outside the selection are. For a single
// job (the usual case) this is exactly `netTransfersByJob`'s figure for that job.

export type JobTransferEntry = {
  direction: "in" | "out";
  /** The job on the other side of the transfer. */
  otherJob: string;
  /** Signed, as it moves the selection's Parts Actual: positive in, negative out. */
  amount: number;
  /** How many matched transfers (item movements) it is made of. */
  transfers: number;
  /** The latest day any of them completed, YYYY-MM-DD. */
  lastDay: string;
};

export type JobTransferSummary = {
  /** Sum of `entries` — what the card adds to both Invoiced and Purchased. */
  net: number;
  entries: JobTransferEntry[];
};

export const EMPTY_TRANSFER_SUMMARY: JobTransferSummary = { net: 0, entries: [] };

export function summarizeTransfersForJobs(
  transfers: readonly Transfer[],
  jobs: Iterable<string>,
): JobTransferSummary {
  const set = new Set(jobs);
  const byKey = new Map<string, JobTransferEntry>();
  for (const t of transfers) {
    const fromIn = set.has(t.fromJob);
    const toIn = set.has(t.toJob);
    if (fromIn === toIn) continue; // outside the selection entirely, or wholly inside it
    const direction = toIn ? "in" : "out";
    const otherJob = toIn ? t.fromJob : t.toJob;
    const key = `${direction}:${otherJob}`;
    const e = byKey.get(key) ?? { direction, otherJob, amount: 0, transfers: 0, lastDay: "" };
    e.amount += toIn ? t.costIn : -t.costOut;
    e.transfers++;
    if (t.day > e.lastDay) e.lastDay = t.day;
    byKey.set(key, e);
  }
  const entries = [...byKey.values()]
    .map((e) => ({ ...e, amount: cents(e.amount) }))
    .filter((e) => e.amount !== 0)
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount) || a.otherJob.localeCompare(b.otherJob));
  return { net: cents(entries.reduce((s, e) => s + e.amount, 0)), entries };
}

const wholeDollars = (n: number) => `$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;

/**
 * One line of words for a card: "moved to job 1160 (−$20,463)", "moved in from job 1155
 * (+$20,463)", several joined, the smallest dropped into "+N more" past three. Pure and
 * shared by every screen that names a transfer, so they cannot phrase the same fact two ways.
 */
export function describeTransfers(entries: readonly JobTransferEntry[], max = 3): string {
  if (entries.length === 0) return "no transfers";
  const one = (e: JobTransferEntry) =>
    e.direction === "out"
      ? `moved to job ${e.otherJob} (−${wholeDollars(e.amount)})`
      : `moved in from job ${e.otherJob} (+${wholeDollars(e.amount)})`;
  const shown = entries.slice(0, max).map(one);
  const more = entries.length - shown.length;
  return more > 0 ? `${shown.join(", ")}, +${more} more` : shown.join(", ");
}
