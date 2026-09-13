import "server-only";
import { prisma } from "@/lib/prisma";
import { getPartsCostForJobs, type PartsCostLine } from "@/lib/sync-totaleto";
import { computePartsProjection, computeYetToInvoice } from "@/lib/parts-projection";
import { readPriorEtcByJob, sumPriorEtc } from "@/lib/parts-prior-etc";
import { computePartsBudgetProjection, purchasedTotal, actualTotal } from "@/lib/parts-budget-projection";
import { withTimeoutOrNull } from "@/lib/with-timeout";
// The type and the pure rounding helper live in a sibling module with no
// "server-only"/Prisma/TotalETO dependency (see its own header) so a CLIENT
// component (PartsCostSummary.tsx) can import `reconcilePartsCostRounding`
// without pulling this whole server-only file into its bundle. Re-exported
// here too so existing server-side imports of `PartsCostFinancials` from
// THIS module keep working unchanged.
export type { PartsCostFinancials } from "@/lib/parts-cost-financials-shared";
import type { PartsCostFinancials } from "@/lib/parts-cost-financials-shared";
import { leftToInvoiceForLines } from "@/lib/left-to-invoice";

// ── THE one Parts Cost reconciliation, for any job or set of jobs ───────────
//
// Audited 2026-08-15 (report: "Audit Parts Cost Projection Formula Across All
// Projects") after several projects showed a large "over budget" projection
// and the request was to confirm the three components — Invoiced, Left to be
// Invoiced, ETC — aren't double-counting the same money. That audit concluded
// they weren't, on the grounds that each is a distinctly-defined, non-
// overlapping slice — true of their DEFINITIONS, but it didn't check whether
// summing all three double-counts the same dollar across TIME, which it does.
// Corrected 2026-08-17 after a real project's figures were reviewed and found
// to double-count exactly this way (see parts-budget-projection.ts's header
// for the full mechanism):
//
//   invoiced       = actualTotal(lines)      — GL-posted spend only (lifetime)
//   leftToInvoice  = purchasedTotal(lines) − invoiced, floored at 0
//                    — committed (open PO balance + anything invoiced but not
//                      yet GL-posted). Displayed, and included in
//                      `totalSpent`, but NOT in `projection` — see below.
//   etc            = the job's Parts New ETC for the applicable month —
//                    floored at 0 so an overspent month can't push the
//                    projection below money already spent. This is drawn down
//                    by GL-posted spend only (the same basis as `invoiced`),
//                    NEVER by an open PO's balance — so it still contains
//                    whatever `leftToInvoice` represents until that PO is
//                    actually invoiced. Summing `invoiced + leftToInvoice +
//                    etc` counted that money twice; `invoiced + etc` does not,
//                    because a manager's ETC is meant to already answer "what
//                    will it cost to finish this job", which necessarily
//                    accounts for whatever's already on order.
//
//   Total Parts Cost Spent = invoiced + leftToInvoice   (unchanged — this is
//                                                         real money moved or
//                                                         committed to date)
//   Projection             = invoiced + max(leftToInvoice, etc ?? 0)
//                                                        (2026-08-17, floored 2026-08-19)
//
// `leftToInvoice` stays a real, displayed figure — "how much of ETC is
// already spoken for by an open PO" is worth knowing — it is just never
// SUMMED alongside `etc` into `projection` (that would double-count, the
// 2026-08-17 fix). As of 2026-08-19 it also acts as a floor: reported live on
// job 1119 (Karl Storz), Projection ($127,219 = invoiced + etc) read BELOW
// Total Parts Cost Spent ($133,428 = invoiced + leftToInvoice) because that
// job's ETC hadn't caught up to its own open PO balance — a projected FINAL
// cost below money already spent/committed, which the business requires
// never happen. `computePartsBudgetProjection`'s `projectionResidual` now
// takes whichever of leftToInvoice/etc is larger, so Projection can never
// fall below Total Parts Cost Spent again, while staying byte-identical to
// the 2026-08-17 formula whenever ETC is current (the common case).
//
// This reads `computePartsBudgetProjection` — the one function every "ETC"
// figure on this card traces back to — relabeled to the vocabulary the audit
// asked for, plus `Job.costQuoted` for Budget and the variance arithmetic, so
// every consumer reads ONE function instead of separately re-deriving (and
// risking re-deriving differently) the same numbers `job-hours/page.tsx` used
// to compute inline.
//
// A real (if usually sub-dollar) display artifact also lives here: components
// rounded independently for display do not always sum to a total rounded
// independently — see `reconcilePartsCostRounding` below.

function monthKeyOf(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// Resolves which ETC month to read the Parts New ETC from. Defaults to the
// latest month these jobs have ANY EtcEntry for (locked or not) — the same
// rule job-hours-dashboard.ts's own `latestEtcMonth` already uses, so calling
// this with no `asOfDate` reproduces today's behavior exactly. `asOfDate`
// narrows to the latest month AT OR BEFORE it — a best-effort "as of a past
// date" reading of the ETC carry-forward chain, not a full historical
// reconstruction of Purchased/Actual (those come from a live TotalETO query,
// which has no "as of" mode to time-travel).
async function resolveEtcMonth(jobIds: number[], asOfDate: Date | undefined): Promise<string | null> {
  if (jobIds.length === 0) return null;
  const where = asOfDate ? { jobId: { in: jobIds }, month: { lte: monthKeyOf(asOfDate) } } : { jobId: { in: jobIds } };
  const latest = await prisma.etcEntry.findFirst({ where, orderBy: { month: "desc" }, select: { month: true } });
  return latest?.month ?? null;
}

/** One call covering the whole selection now, so the window is sized for the set rather than one job. */
const PARTS_BATCH_BUDGET_MS = 120_000;

export async function getPartsCostFinancials(jobIds: number[], opts?: { asOfDate?: Date }): Promise<PartsCostFinancials> {
  if (jobIds.length === 0) {
    return {
      budget: null, invoiced: 0, leftToInvoice: 0, etc: null, totalSpent: 0, projection: 0,
      purchased: 0, billedNotPosted: 0, priorEtc: null, priorEtcSource: "none", partsSpentThisMonth: 0,
      adjustedEtcRaw: null, adjustedEtc: 0, openBalance: 0, externalOpen: 0,
      inHouseExcluded: 0, inHouseRows: 0, additionalExposure: 0, coverageLine: null,
      etcUnknown: true, etcMonth: null,
      variance: null, variancePct: null, failedJobs: 0, lineCount: 0, lines: [],
    };
  }

  const jobs = await prisma.job.findMany({ where: { id: { in: jobIds } }, select: { id: true, jobId: true, costQuoted: true } });
  const quoted = jobs.reduce((s, j) => s + Number(j.costQuoted ?? 0), 0);
  const budget = quoted > 0 ? quoted : null;

  // ── ONE round trip, not one per job (2026-09-02) ──────────────────────────
  //
  // This fanned out at 6 concurrent calls — a bounded improvement on the 59
  // simultaneous requests it replaced in 2026-08-24, but still one Total ETO
  // round trip per job. `getPartsCostForJobs` is the SAME SQL through the same
  // template, scoped by an IN list instead of a single id, so the rows and their
  // mapping are unchanged and only the number of connections differs. Measured on
  // the identical work in T&M: 5,766ms across 239 jobs became 571ms.
  //
  // It also ended the burst of `Connection is closing` / `aborted` errors this
  // page produced under load, which were the fan-out colliding with itself.
  //
  // ── The failure mode moved, deliberately ──────────────────────────────────
  //
  // Per job it was partial: one job times out, its rows are lost, `failedJobs`
  // counts it and the card says so. One query is all-or-nothing, so a failed read
  // reports EVERY job as failed rather than returning an empty set with
  // `failedJobs: 0`. That distinction is the whole point — the second would render
  // $0 as though it were an answer, on a card people read as a budget position.
  const byJob = await withTimeoutOrNull(
    `TotalETO parts (${jobs.length} jobs)`,
    PARTS_BATCH_BUDGET_MS,
    () => getPartsCostForJobs(jobs.map((j) => j.jobId)),
    (e) => console.error("getPartsCostFinancials: getPartsCostForJobs failed:", e),
  );
  const failedJobs = byJob ? 0 : jobs.length;
  const lines: PartsCostLine[] = byJob ? jobs.flatMap((j) => byJob.get(j.jobId) ?? []) : [];

  const etcMonth = await resolveEtcMonth(jobs.map((j) => j.id), opts?.asOfDate);
  const projection = await computePartsBudgetProjection(jobs.map((j) => j.id), lines, etcMonth).catch(() => null);

  const invoiced = actualTotal(lines);
  // Billed but not GL-posted. Signed on purpose — a flagged refund makes it negative,
  // and clamping would hide exactly the case worth seeing (job 1148's -$31,765
  // BlackHawk credit). See the field's own note in parts-cost-financials-shared.ts.
  const billedNotPosted = lines.reduce((a, l) => a + (l.invoicedAmount - l.actualAmount), 0);
  // `toComplete` in the spec's vocabulary: the remaining open parts exposure, which
  // is the same figure the card has always shown as "Left to be invoiced". One
  // quantity, two names — never two addends (spec §8).
  // Both branches are now literally the same function: committedNotPosted IS
  // leftToInvoiceForLines (see parts-budget-projection.ts). Kept as two branches only
  // because the projection may fail to resolve, and the figure must still appear.
  const leftToInvoice = projection ? projection.committedNotPosted : leftToInvoiceForLines(lines);
  const totalSpent = invoiced + leftToInvoice;

  // ── Dan's projection model (2026-09-03) ───────────────────────────────────
  //
  //   adjustedEtc        = max(0, priorEtc - partsSpentThisMonth)
  //   yetToInvoice       = external remaining exposure, EXCLUDING in-house SDC
  //   additionalExposure = max(0, yetToInvoice - adjustedEtc)
  //   totalProjection    = invoiced + adjustedEtc + additionalExposure
  //
  // lib/parts-projection.ts holds the arithmetic, the in-house classification and
  // their tests (including both worked examples from the spec and job 1101's real
  // figures). lib/parts-prior-etc.ts resolves the two ETC inputs off the selected
  // month's own Monthly ETC row, so the card and the grid cannot disagree.
  //
  // `computePartsBudgetProjection` is still called above — it supplies
  // `committedNotPosted`, which the card still shows as the whole open balance — but
  // its own `total` now feeds nothing. That figure was the ETC-driven projection
  // this replaces.
  const priorByJob = await readPriorEtcByJob(jobs.map((j) => j.id), etcMonth).catch(() => null);
  const priorEtc = priorByJob
    ? sumPriorEtc(jobs.map((j) => j.id), priorByJob)
    : { priorEtc: null, partsSpentThisMonth: 0, source: "none" as const, month: null };
  // Excludes in-house SDC: work SDC does itself never produces a supplier invoice,
  // so counting it overstates what the job still owes the outside world (spec §6).
  const yet = computeYetToInvoice(lines);
  // `yet.allRows` — the WHOLE open balance — not `yet.amount`, which excludes
  // in-house SDC. Passing the external figure here was the 2026-09-03 bug: it made
  // the projection fall below Purchased on 7 of 10 audited jobs, by exactly the
  // in-house balance. See lib/parts-projection.ts's header. `yet.amount` is still
  // reported, as the part of the balance that will not arrive as a supplier invoice.
  const projected = computePartsProjection({
    invoiced,
    priorEtc: priorEtc.priorEtc,
    partsSpentThisMonth: priorEtc.partsSpentThisMonth,
    openBalance: yet.allRows,
  });
  const etc = priorEtc.priorEtc;
  const projectionTotal = projected.totalProjection;

  // Against the whole projected exposure, never against invoiced alone (spec §11).
  const variance = budget != null ? projectionTotal - budget : null;
  const variancePct = budget != null && budget !== 0 ? (variance! / budget) * 100 : null;

  return {
    budget,
    invoiced,
    leftToInvoice,
    etc,
    totalSpent,
    projection: projectionTotal,
    purchased: purchasedTotal(lines),
    billedNotPosted,
    priorEtc: projected.priorEtc,
    priorEtcSource: priorEtc.source,
    partsSpentThisMonth: projected.partsSpentThisMonth,
    adjustedEtcRaw: projected.adjustedEtcRaw,
    adjustedEtc: projected.adjustedEtc,
    openBalance: projected.openBalance,
    externalOpen: yet.amount,
    inHouseExcluded: yet.inHouseExcluded,
    inHouseRows: yet.inHouseRows,
    additionalExposure: projected.additionalExposure,
    coverageLine: projected.coverageLine,
    etcUnknown: projected.etcUnknown,
    etcMonth: priorEtc.month ?? etcMonth,
    variance,
    variancePct,
    failedJobs,
    lineCount: lines.length,
    lines,
  };
}
