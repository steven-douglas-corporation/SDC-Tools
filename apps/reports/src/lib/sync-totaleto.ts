import sql from "mssql";
import { TOTALETO_TIMEOUT, withTotalEto } from "@/lib/totaleto-connection";
import { prisma } from "@/lib/prisma";
import { VALID_JOB_TYPES } from "@/lib/job-filters";
import { applyRefundSign, sqlRefundSigned } from "@/lib/parts-refund";

// The exact query Power BI's 'Part Purchase' table runs against this same
// SQL server (extracted verbatim from the semantic model's TMDL). Verified
// 2026-07-19: aggregated by job and windowed on Invoiced Date, this matches
// Power BI's own [Part Cost Purchased] to the dollar for every real project
// job across Mar/Apr/May 2026 — the only divergences were non-project
// pseudo-IDs (spare-parts/service buckets) that Power BI's model excludes
// anyway and that never map to an app Job. Pulling this directly removes the
// last Power BI / data-gateway dependency for the live ETC month's parts.
const PART_PURCHASE_SQL = `-- Part Costs
SELECT
     [P].[ProjectID] as [Job ID]
    ,POD.[SpecID] as [Section ID]
    ,CASE WHEN POD.PurchaseQty >=0 THEN
        CASE WHEN InvoicedQty > (CASE WHEN RLS.SumOfQtyReceived >= POD.PurchaseQty THEN RLS.SumOfQtyReceived ELSE POD.PurchaseQty END)
             THEN 0
             ELSE ((CASE WHEN RLS.SumOfQtyReceived >= POD.PurchaseQty THEN RLS.SumOfQtyReceived ELSE POD.PurchaseQty END) - ISNULL(InvoicedQty,0))
        END * POD.PurchasePrice * POH.PurchaseCurrRate
    ELSE
        CASE WHEN InvoicedQty < (CASE WHEN RLS.SumOfQtyReceived >= POD.PurchaseQty THEN RLS.SumOfQtyReceived ELSE POD.PurchaseQty END)
             THEN 0
             ELSE ((CASE WHEN RLS.SumOfQtyReceived <= POD.PurchaseQty THEN RLS.SumOfQtyReceived ELSE POD.PurchaseQty END) - ISNULL(InvoicedQty,0))
        END * POD.PurchasePrice * POH.PurchaseCurrRate
    END + ISNULL(INVOICED.TotalInvoicedAmount, 0) AS [Total Price]
    ,INVOICED.[APDocDate] as [Invoiced Date]
FROM tblPurchaseOrderHeader POH with(nolock)
    INNER JOIN tblPurchaseOrderDetails POD with(nolock) ON POH.PurchaseOrderID = POD.PurchaseOrderID
    LEFT JOIN tblSpec S with(nolock) ON S.SpecID = POD.SpecID AND S.ProjectID = POD.ProjectID
    LEFT JOIN tblProjects P with(nolock) ON S.ProjectID = P.ProjectID
    LEFT JOIN ( SELECT APDD.PurchaseDetailID, BatchEntryTypeID, max(APDocDate) as APDocDate, SUM(APDocQty) AS InvoicedQty,
                    SUM(APDocQty * APDocUnitPrice * (1 - APDocItemPctDisc) * APDocCurrRate) AS TotalInvoicedAmount
                    FROM tblAPDocumentDetails APDD with(nolock)
                        INNER JOIN tblAPBatchDocument APBD with(nolock) ON APBD.APDocID = APDD.APDocID
                    WHERE BatchEntryTypeID NOT IN (2, 3) AND APDD.PurchaseDetailID IS NOT NULL
                    GROUP BY APDD.PurchaseDetailID, BatchEntryTypeID
                ) INVOICED ON POD.PurchaseDetailID = INVOICED.PurchaseDetailID
    LEFT JOIN vwReceiverLogSummed RLS with(nolock) ON RLS.PurchaseDetailID = POD.PurchaseDetailID

UNION ALL

-- Extra Costs
SELECT
     [EC].[ProjectID] as [Job ID]
    ,[EC].[SpecID] as [Section ID]
    ,[EC].[decExtraCostingValue] as [Total Price]
    ,[EC].[APDocDate] as [Invoiced Date]
FROM [dbo].[vwCostingExtraCostsDetailed] [EC] WITH(NOLOCK)`;

// ── Money Spent Month, by PURCHASED date (§30, 2026-08-04) ──────────────────
//
// Replaces the invoiced-date basis below. The rule, as decided: a part belongs to the
// month it was PURCHASED, because parts are routinely invoiced months after the buy
// and the ETC month is about what was committed in it.
//
// Three deliberate choices, each of which changes the figure:
//
//   * DATE — POH.PurchaseDate, the purchase-order header date. Not the receiver date
//     (when it arrived) and not APDocDate (when it was billed).
//
//   * AMOUNT — PurchaseQty × PurchasePrice × PurchaseCurrRate. This is NOT the
//     [Total Price] the invoiced-date query uses. That one is
//     `remaining-uninvoiced-balance + everything-invoiced-to-date`, a point-in-time
//     snapshot that cannot be attributed to any single date: window it by PO date and
//     a month's figure would keep MOVING as invoices landed against POs placed in it,
//     retroactively changing months that had already been submitted. The committed
//     PO value is stable — once a PO is placed, its contribution to that month never
//     changes again, which is the property a closed month needs.
//     The currency rate stays: without it a foreign-currency PO would be counted in
//     its own units.
//
//   * SCOPE — Part Costs ONLY. The Extra Costs branch (shipping, fees, tariffs) comes
//     from vwCostingExtraCostsDetailed, which carries no purchase date at all, so
//     there is nothing to window it on. Excluded outright rather than silently kept on
//     the invoiced-date basis, which would put two different rules in one total.
//
// Consequence worth stating: this figure no longer matches Power BI's
// [Part Cost Purchased], which the invoiced-date query was verified against to the
// dollar on 2026-07-19. The two now measure different things on purpose.
//
// Locked months are protected by syncPartsCost's own isMonthLocked guard, so applying
// this rule cannot rewrite a submitted month's stored figures.
export async function getPartsCostPurchasedByJob(monthStart: Date, monthEndExclusive: Date): Promise<Map<string, number>> {
  return withTotalEto(async (pool) => {
    const result = await pool
      .request()
      .input("start", sql.DateTime, monthStart)
      .input("end", sql.DateTime, monthEndExclusive)
      .query(
        `SELECT [P].[ProjectID] AS JobId,
                SUM(POD.PurchaseQty * POD.PurchasePrice * POH.PurchaseCurrRate) AS Purchased
           FROM tblPurchaseOrderHeader POH WITH(NOLOCK)
                INNER JOIN tblPurchaseOrderDetails POD WITH(NOLOCK) ON POH.PurchaseOrderID = POD.PurchaseOrderID
                LEFT JOIN tblSpec S WITH(NOLOCK) ON S.SpecID = POD.SpecID AND S.ProjectID = POD.ProjectID
                LEFT JOIN tblProjects P WITH(NOLOCK) ON S.ProjectID = P.ProjectID
          WHERE POH.PurchaseDate >= @start
            AND POH.PurchaseDate <  @end
            AND [P].[ProjectID] IS NOT NULL
          GROUP BY [P].[ProjectID]`,
      );
    const map = new Map<string, number>();
    for (const r of result.recordset) {
      const purchased = Number(r.Purchased);
      // A null/NaN sum is a data problem, not a zero — skipping keeps it out of the
      // month rather than silently reporting nothing bought (§30.14).
      if (Number.isFinite(purchased)) map.set(String(Number(r.JobId)), purchased);
    }
    return map;
  }, { requestTimeout: 120_000, feed: "parts_cost.purchased_by_job" });
}

// ── Money Spent Month, reconciled to the Total ETO report (§41) ──────────────
//
// THE authoritative Money Spent Month figure. Everything else in this file that looks
// like a monthly spend is either a different measure or superseded; see below.
//
// Reconciled 2026-08-05 against the Total ETO pivot for July 2026 ("Sum of Debit Amt /
// Sum of Credit Amt / Sum of Net DR/CR"): 31 of 35 jobs to the dollar, total $420,616
// against the pivot's $420,656 — a 0.0095% residual on four jobs. The proof is
// re-runnable: scripts/parts-spent-recon.ts.
//
// ── The two formulas this replaces, and why each was wrong ──────────────────
//
// 1. `getPartsCostSpentByJob` sums `[Total Price]`, which is
//    "remaining-uninvoiced-balance + everything-invoiced-to-date". That is a
//    point-in-time PO snapshot, not a monthly flow: a job carrying a large open PO
//    contributes the PO's whole undelivered value to any month it was touched in.
//    Job 1142, July 2026: $1,065,713 reported against the pivot's $113,101.
//
// 2. `getPartsCostPurchasedByJob` (§30) sums the committed PO value on POH.PurchaseDate.
//    Stable and defensible, and it is what the app shipped with — but it is not what the
//    business's own report measures, and it was off by $30,117 for the month and by
//    multiples on individual jobs (1160: app $103,231 vs pivot $17,427).
//
// ── The definitions, spelled out (§41.4) ────────────────────────────────────
//
//   DATE    APBD.APDocDate — the AP document date, on the BATCH DOCUMENT table.
//           This is what the pivot windows on. NOTE FOR WHOEVER READS §41.3: the
//           business calls this the "Purchased Date", but it is NOT
//           POH.PurchaseDate. A part bought in June and billed in July lands in
//           JULY on this basis. That is the reference report's rule, not a choice
//           made here.
//   AMOUNT  APDocQty x APDocUnitPrice x (1 - APDocItemPctDisc) x APDocCurrRate.
//           Qty, price and line discount are on the DETAIL row; the currency rate
//           and the date are on the BATCH DOCUMENT. Mixing those up fails with
//           "Invalid column name 'APDocCurrRate'".
//   SIGN    Kept. A credit memo is a negative line and nets off, which is exactly
//           what the pivot's Credit column does ($2,584 across 7 jobs in July;
//           job 1127's $1,300 credit reconciles to the cent).
//   JOB     APDD.ProjectID, straight off the AP line — not the PO -> Spec -> Project
//           chain the other queries walk. In July 2026 every AP line carried one, so
//           nothing is silently unattributed; `unmatchedLines` reports it if that
//           ever stops being true.
//   SCOPE   Part-cost AP lines only. Extra Costs (shipping, fees, tariffs) are
//           EXCLUDED, and that is now a measured fact rather than a convenience:
//           July had $39,987 of them across 23 jobs, and including any of it would
//           have moved the four residual jobs the wrong way (1153 carries $624.85 of
//           extra costs while sitting $2 BELOW the pivot).
//   DEDUPE  None needed, and none applied. The grain is the AP document line
//           (APDocDetailID), which is already one row per booked line, so there is
//           nothing to collapse — and deduping on amount+date would destroy genuine
//           repeat purchases (§41.7).
//   ARCHIVED  NOT filtered. `Archived = 1` on 774 of July's 818 lines, so it plainly
//           does not mean "void"; filtering it would have reported $39,987 instead
//           of $491,206.
export type PartsBookedByJob = {
  /** job number -> net booked amount for the month (credits already netted off). */
  net: Map<string, number>;
  /** Debits and credits kept apart, so a reconciliation can compare all three columns. */
  debit: Map<string, number>;
  credit: Map<string, number>;
  /** AP lines in the window carrying no ProjectID — nobody's spend. Should stay 0. */
  unmatchedLines: number;
  unmatchedAmount: number;
};

// The raw AP line amount, before the refund rule below. Kept separate only so
// the rule can be applied to it in one visible place.
const AP_LINE_AMOUNT_RAW =
  "(APDD.APDocQty * APDD.APDocUnitPrice * (1 - APDD.APDocItemPctDisc) * APBD.APDocCurrRate)";

// ── Refund lines count as negative spend (2026-08-31) ───────────────────────
//
// A line whose Part / Item description says "Refund" is money coming back, and
// TotalETO records some of them positive — a $31,765 "Refund" was adding to
// parts spend on the Monthly ETC drill instead of subtracting from it.
//
// Applied HERE, to the one canonical AP-line-amount expression, rather than at
// each call site. Every job / month / lifetime AP aggregate in this file already
// routes through this constant — getPartsCostBookedByJob (Money Spent Month),
// getPartsInvoicedByJob, getPartsActualByJob (Parts Actual) and
// getJobPartsInvoicedInMonth's own line amounts — so all of them inherit the
// rule and none of them has to know it exists. See lib/parts-refund.ts.
//
// ── What this deliberately changes ──────────────────────────────────────────
//
// getPartsCostBookedByJob's debit/credit split moves a refund into the CREDIT
// column, which is where a refund belongs, and its net drops by the refund
// amount. That means the app will now DIFFER from TotalETO's own pivot on any
// month containing a positive-signed refund line — the reconciliation noted
// above ("job 1127's $1,300 credit reconciles to the cent") held against a pivot
// that treats those refunds as spend. That divergence is the requested change,
// not a regression.
const AP_LINE_AMOUNT = sqlRefundSigned(AP_LINE_AMOUNT_RAW, "APDD.APDocItemDesc");

// ── The GL-posted rule (2026-08-10, corrected 2026-09-04) ───────────────────
//
// Deliberately the FLAG and not the export DATE. `APDocExportDate IS NULL` looks
// like the same test and is not: measured 2026-08-10 across every job-attributed AP
// line, 45 lines / $41,352.47 had no export date while NOT being flagged, and all of
// them were dated within the previous week — genuinely-real invoices merely queued
// for the next export run. Filtering on the date would silently delete real, current
// cost every time someone looked before an export ran. The flag, by contrast, spans
// 2024-11 to 2026-08 (338 documents, 1,614 lines, $621,483.80).
//
// ── What the flag actually means (corrected 2026-09-04) ─────────────────────
//
// This block used to open by asserting that a flagged document "is never posted to
// the general ledger, so it never appears on a job ledger." Both halves are wrong,
// and the correction comes from Lisa in accounting:
//
//   "Our norm is to enter all purchasing activity for jobs into ETO and then export
//    it from ETO and import into Sage for payments. However there are times when
//    items are entered into Sage first but need to be reflected in ETO — these are
//    then reflected as do not export and have been paid."
//
// So the flag means "do not export this to Sage AGAIN", not "this never reaches the
// ledger". A Sage-first document is already paid and already posted.
//
// Verified against the August 2026 job ledger draft rather than taken on trust: all
// six of job 1101's flagged SDC Credit Card charges appear in it as GENJ journal
// rows (referenced `07.31 WESBANCO CC` and so on), reconciling to the cent — three
// matched directly and three are split there into freight and food-expense
// components. Across the whole ledger, CC journal postings total $75,068.36 on 31
// jobs against $76,508.61 of flagged CC lines in ETO: the same money counted from
// both ends.
//
// ── Why this is NOT simply "stop excluding flagged documents" ───────────────
//
// Because the flag is overloaded. Measured across the 33 jobs with any flagged
// spend, only 6 reconcile to the ledger to the cent; $296,091 has no ledger
// counterpart at all. Job 1106 is why — its $253,667 is five accounting corrections,
// not purchases:
//
//     -$675,000  SOLAR SIMULATOR 6000B-100-002   Innovations in Optics
//     +$337,500  DISCOUNT Correction             Innovations in Optics
//     +$252,800  DISCOUNT Correction             Innovations in Optics
//     +$209,625  Adjustment to match Sage        PO number `1106 correction`
//     +$128,090  EXCESS MATERIALS RELATED TO PO  Innovations in Optics
//
// Those exist ONLY to make ETO agree with Sage. Counting them as spend would
// double-count the very figure they correct toward, which is why they have no ledger
// counterpart. Flipping the flag wholesale would have added a quarter of a million
// dollars of correction entries to one job.
//
// So the rule is narrower than the flag: a flagged document counts as posted when it
// came from a SAGE-FIRST vendor. Only the credit card qualifies today, because it is
// the only category verified line-for-line against the ledger.
//
// ── Why an exact vendor name, and not a LIKE ────────────────────────────────
//
// `CName LIKE '%credit card%'` would also match `onlinecomponents.com  CREDIT CARD`
// (CompanyID 1071) — a real outside supplier that merely has the words in its name.
// It has 8 AP documents and ZERO of them flagged, so the mistake would be invisible
// today and would surface the first time somebody ticked the box on one. This is the
// same hazard lib/vendor-normalize.ts documents for the "SDC" acronym, and it gets
// the same treatment: match narrowly, and prefer a false negative.
//
// A vendor that SHOULD be here and is not simply keeps today's behaviour — it stays
// excluded, understating cost, which is the safe direction. scripts/audit-sage-first-
// vendors.ts lists every flagged vendor with its ledger status so a new one surfaces
// rather than waiting to be noticed.
//
// STILL EXCLUDED, pending an answer from accounting on how to tell them apart from
// the above: `Steven Douglas Corp.` internal billings (280 lines, $58,281),
// `Steven Douglas Corp. Expense Reports` (21 lines, $15,324) and
// `Reconciling With Sage - SDC` (2 lines, $610).
// ── Expense Reports added 2026-09-04, on the same evidence as the card ──────
//
// Job 1101's ETO material-costs report lists four expense-report lines as Extra
// Payables. Three fall inside the August ledger draft, and all three reconcile to the
// cent as GENJ "Payroll" postings — one of them split across two employees on the same
// day, exactly the way the card charges are split into freight and food components:
//
//     2026-02-20   $57.64   Employee reimbursements - Shaffer
//     2026-05-29   $40.00   Employee reimbursements - Klingensmith  } $61.02
//     2026-05-29   $21.02   Employee reimbursements - Siegfried     }
//     2026-07-24   $10.49   Employee reimbursements - Novotney
//                 $129.15 = 57.64 + 61.02 + 10.49
//
// (The fourth, $22.02, is dated 2026-09-04 — after that draft — so its absence is the
// ledger's period, not evidence against it.)
//
// These are employees paid back for things bought for the job. They are real cost,
// they post through payroll, and they appear on the job ledger — the same three tests
// the credit card had to pass.
const SAGE_FIRST_VENDORS = "'SDC Credit Card', 'Steven Douglas Corp. Expense Reports'";

/**
 * The GL-posted test, against an ALREADY-JOINED tblCompany alias.
 *
 * Takes the alias rather than correlating a subquery because one of the three call
 * sites evaluates this inside `SUM(CASE WHEN ... )`, and SQL Server refuses a
 * subquery there outright ("Cannot perform an aggregate function on an expression
 * containing an aggregate or a subquery", error 130). A joined column is a plain
 * comparison and is legal everywhere, so all three sites can share one predicate.
 */
/**
 * The raw flag, named once.
 *
 * Both the posted test below and the unclassified-vendor diagnostic need it, in
 * opposite directions, and a second hand-written copy is precisely how the extra-costs
 * branch escaped the 2026-09-04 correction. One spelling, two readers.
 */
const AP_DOC_FLAGGED = "ISNULL(APBD.APDocDoNotExport, 0) = 1";

const glPostedAp = (companyAlias: string) =>
  `(NOT ${AP_DOC_FLAGGED} OR ${companyAlias}.CName IN (${SAGE_FIRST_VENDORS}))`;

/** The join `glPostedAp` needs, for the sites that do not already have the vendor. */
const sageFirstJoin = (alias: string) =>
  `LEFT JOIN tblCompany ${alias} WITH(NOLOCK) ON ${alias}.CompanyID = APBD.CompanyID`;

// ── Money Spent Month is on the SAME basis as Parts Actual (2026-09-04) ─────
//
// It was not, and nothing said so. This query carried no GL-posted test at all while
// getPartsActualByJob carried one, so two figures that sit next to each other on the
// Monthly ETC row — "money spent this month", which draws Prior ETC down into New
// ETC, and Parts Actual — were computed on different bases.
//
// Worse, parts-budget-projection.ts states the opposite in as many words: that
// `hoursWorked` on the PARTS_COST entry comes from "the AP-document/GL-posted basis
// ... the exact same basis as `actual`". It did not. Measured on August 2026: 170 of
// 2,494 lines, $56,740.45, counted as money spent this month and NOT as Parts Actual.
//
// That is the same class of defect as the Do Not Export misreading itself — a comment
// asserting a property the code did not have, believed because it was written down.
//
// Both now go through glPostedAp, so the allow-list is the ONLY thing that decides
// what counts, and a change to it moves both figures together. That is the property
// the variance report asked for in its closing line: "both columns should then be
// defined the same way, or this variance reappears every month."
//
// ── The direction is NOT predictable, and August moves UP ───────────────────
//
// The obvious assumption is that removing lines lowers the total. It does not, because
// AP_LINE_AMOUNT is refund-signed: a credit is negative, and flagged documents include
// refunds. Measured on August 2026 by running this function with and without the
// predicate:
//
//     unfiltered   $790,193.05   across 106 jobs
//     filtered     $803,574.94   across 105 jobs   (+$13,381.89)
//
// It rose, because the biggest single flagged line in the month is BlackHawk Supply's
// -$31,765.20 refund (2026-08-18) and dropping a negative raises a sum. One job also
// leaves the map entirely: its only booked activity that month was a flagged document.
//
// Money spent RISING lowers the New ETC the grid suggests (New ETC = prior − spent),
// so this is not a uniformly "more conservative" change and must not be described as
// one. What it is: both figures now answer the same question. An ETO-side correction
// whose purpose is to make ETO agree with Sage is not new spend on the job, and job
// 1106's five adjustment entries are what force that reading.
/**
 * Flagged spend in a month from a vendor NOT on the Sage-first allow-list.
 *
 * ── Why the sync asks this every run ────────────────────────────────────────
 *
 * SAGE_FIRST_VENDORS is an allow-list, and an allow-list rots silently. A new company
 * card, a renamed vendor, or a second Sage-first arrangement would simply keep today's
 * behaviour — excluded, understating cost — with nothing anywhere to say a decision was
 * never made about it. The failure mode is a number that is quietly wrong for months
 * and then turns up in a variance review, which is exactly how the 2026-09-03 report
 * came to be written.
 *
 * So the hourly refresh names them. Reported, never acted on: whether a flagged vendor
 * is a Sage-first purchase (should count) or an ETO-side reconciling adjustment (must
 * never count) is a question for accounting, and guessing it in code is how a quarter
 * of a million dollars of corrections becomes reported job cost. See
 * scripts/audit-sage-first-vendors.ts for the whole-history view.
 */
export async function getUnclassifiedFlaggedSpend(
  monthStart: Date,
  monthEndExclusive: Date,
): Promise<{ vendor: string; lines: number; amount: number }[]> {
  return withTotalEto(async (pool) => {
    const amt = AP_LINE_AMOUNT;
    const result = await pool
      .request()
      .input("start", sql.DateTime, monthStart)
      .input("end", sql.DateTime, monthEndExclusive)
      .query(
        `SELECT ISNULL(SFC.CName, '(no vendor)') AS Vendor,
                COUNT(*) AS Lines,
                SUM(${amt}) AS Amount
           FROM tblAPDocumentDetails APDD WITH(NOLOCK)
                INNER JOIN tblAPBatchDocument APBD WITH(NOLOCK) ON APBD.APDocID = APDD.APDocID
                ${sageFirstJoin("SFC")}
          WHERE APBD.APDocDate >= @start AND APBD.APDocDate < @end
            AND APDD.ProjectID IS NOT NULL
            AND ${AP_DOC_FLAGGED}
            AND ISNULL(SFC.CName, '') NOT IN (${SAGE_FIRST_VENDORS})
          GROUP BY SFC.CName
          ORDER BY SUM(ABS(${amt})) DESC`,
      );
    return result.recordset.map((r: Record<string, unknown>) => ({
      vendor: String(r.Vendor),
      lines: Number(r.Lines) || 0,
      amount: Number(r.Amount) || 0,
    }));
  }, { feed: "parts_cost.unclassified_flagged_spend" });
}

export async function getPartsCostBookedByJob(
  monthStart: Date,
  monthEndExclusive: Date,
): Promise<PartsBookedByJob> {
  return withTotalEto(async (pool) => {
    const amt = AP_LINE_AMOUNT;
    const result = await pool
      .request()
      .input("start", sql.DateTime, monthStart)
      .input("end", sql.DateTime, monthEndExclusive)
      .query(
        `SELECT APDD.ProjectID AS JobId,
                SUM(CASE WHEN ${amt} > 0 THEN ${amt} ELSE 0 END) AS DebitAmt,
                SUM(CASE WHEN ${amt} < 0 THEN -(${amt}) ELSE 0 END) AS CreditAmt,
                SUM(${amt}) AS NetAmt
           FROM tblAPDocumentDetails APDD WITH(NOLOCK)
                INNER JOIN tblAPBatchDocument APBD WITH(NOLOCK) ON APBD.APDocID = APDD.APDocID
                ${sageFirstJoin("SFC")}
          WHERE APBD.APDocDate >= @start AND APBD.APDocDate < @end
            AND APDD.ProjectID IS NOT NULL
            AND ${glPostedAp("SFC")}
          GROUP BY APDD.ProjectID`,
      );
    const net = new Map<string, number>();
    const debit = new Map<string, number>();
    const credit = new Map<string, number>();
    for (const r of result.recordset) {
      const job = String(Number(r.JobId));
      const n = Number(r.NetAmt);
      // A null/NaN sum is a data problem, not a zero — skipping keeps it out of the month
      // rather than silently reporting nothing bought (§30.14).
      if (!Number.isFinite(n)) continue;
      net.set(job, n);
      debit.set(job, Number(r.DebitAmt) || 0);
      credit.set(job, Number(r.CreditAmt) || 0);
    }

    // Anything the month booked that no job will ever show. Reported rather than
    // dropped silently (§41.6) — a purchase must never be reassigned to another job.
    const un = await pool
      .request()
      .input("start", sql.DateTime, monthStart)
      .input("end", sql.DateTime, monthEndExclusive)
      .query(
        `SELECT COUNT(*) AS Lines, ISNULL(SUM(${amt}), 0) AS Amt
           FROM tblAPDocumentDetails APDD WITH(NOLOCK)
                INNER JOIN tblAPBatchDocument APBD WITH(NOLOCK) ON APBD.APDocID = APDD.APDocID
          WHERE APBD.APDocDate >= @start AND APBD.APDocDate < @end
            AND APDD.ProjectID IS NULL`,
      );
    return {
      net,
      debit,
      credit,
      unmatchedLines: Number(un.recordset[0]?.Lines ?? 0),
      unmatchedAmount: Number(un.recordset[0]?.Amt ?? 0),
    };
  }, { requestTimeout: 180_000, feed: "parts_cost.booked_by_job" });
}

// ── Row-count baseline, for detecting a join fan-out (§82) ──────────────────
//
// A one-to-many join anywhere in getJobPartsInvoicedInMonth's LEFT JOIN chain
// (to tblPurchaseOrderDetails / tblEngItemMaster / tlkpItemMaster_Categories,
// added there for supplier/part/category enrichment that this query has no
// reason to carry) would duplicate a single real AP-document-detail row into
// several output rows — each still carrying the row's full amount, so the
// duplicated rows would inflate that function's own total by exactly the
// duplicated amount. This query is the join-free baseline to catch that: the
// SAME WHERE clause as getPartsCostBookedByJob, with nothing else joined in,
// so its per-job COUNT is what a correct getJobPartsInvoicedInMonth must
// return exactly as many lines as (see verify-parts-invoiced-reconciliation.ts).
//
// Not itself proof of no fan-out — two real, distinct AP documents CAN
// legitimately share the same part/qty/price/date (found live: job 1142,
// 2026-08-01, two separate invoices each for 64 × KQ2L04-M5A @ $1.30 — two
// different APDocID/APDocDetailID rows, not one row counted twice) — a count
// match only rules out the join MULTIPLYING rows, which is the specific
// failure mode this exists to catch.
export async function getApLineCountByJob(monthStart: Date, monthEndExclusive: Date): Promise<Map<string, number>> {
  return withTotalEto(async (pool) => {
    const result = await pool
      .request()
      .input("start", sql.DateTime, monthStart)
      .input("end", sql.DateTime, monthEndExclusive)
      .query(`
        SELECT APDD.ProjectID AS JobId, COUNT(*) AS Lines
          FROM tblAPDocumentDetails APDD WITH(NOLOCK)
               INNER JOIN tblAPBatchDocument APBD WITH(NOLOCK) ON APBD.APDocID = APDD.APDocID
         WHERE APBD.APDocDate >= @start AND APBD.APDocDate < @end
           AND APDD.ProjectID IS NOT NULL
         GROUP BY APDD.ProjectID
      `);
    const counts = new Map<string, number>();
    for (const r of result.recordset) counts.set(String(Number(r.JobId)), Number(r.Lines) || 0);
    return counts;
  }, { requestTimeout: 120_000, feed: "parts_cost.ap_line_count_by_job" });
}

// Net AP-document amount per job over an arbitrary window, as a SINGLE query —
// for Job Cost Explorer's lifetime "Parts Invoiced" column (§ integration with
// the standalone Job Cost Explorer app). Deliberately NOT a call to
// getPartsCostBookedByJob above with a 1990-2100 window: that function's SECOND
// query (the unmatched-lines diagnostic, only meaningful for a single ETC
// month) left the connection in a bad state under a multi-decade window in
// testing ("Connection is closed" on the second request) — a failure mode its
// existing callers, all scoped to one month, never hit. This mirrors
// getPartsCostSpentByJob's already-proven-safe one-query shape for a wide
// window instead of extending the two-query function into an untested range.
export async function getPartsInvoicedByJob(monthStart: Date, monthEndExclusive: Date): Promise<Map<string, number>> {
  return withTotalEto(async (pool) => {
    const amt = AP_LINE_AMOUNT;
    const result = await pool
      .request()
      .input("start", sql.DateTime, monthStart)
      .input("end", sql.DateTime, monthEndExclusive)
      .query(
        `SELECT APDD.ProjectID AS JobId, SUM(${amt}) AS NetAmt
           FROM tblAPDocumentDetails APDD WITH(NOLOCK)
                INNER JOIN tblAPBatchDocument APBD WITH(NOLOCK) ON APBD.APDocID = APDD.APDocID
          WHERE APBD.APDocDate >= @start AND APBD.APDocDate < @end
            AND APDD.ProjectID IS NOT NULL
          GROUP BY APDD.ProjectID`,
      );
    const net = new Map<string, number>();
    for (const r of result.recordset) {
      const n = Number(r.NetAmt);
      if (Number.isFinite(n)) net.set(String(Number(r.JobId)), n);
    }
    return net;
  }, { requestTimeout: 180_000, feed: "parts_cost.invoiced_by_job" });
}

// ── THE definition of Parts Actual (2026-08-10) ─────────────────────────────
//
// Net AP-document amount POSTED TO THE GENERAL LEDGER, per job. This is the one
// source of truth for "what has this job actually spent on parts", and every view
// that shows a Parts Actual figure resolves to this function or to the per-line
// `actualAmount` that carries the same rule (see PARTS_DETAIL_SQL).
//
// ── Why this exists: the job-1116 audit ─────────────────────────────────────
//
// Reported by Dan: job 1116 showed ~$400K parts actual/projection against a job
// ledger of ~$340K on a ~$300K budget. Audited 2026-08-10 against Lisa's own
// "1116 Molex as of 7.31.26" Job Ledger export, whose net is $349,732.10
// (re-derivable from source at any time — scripts/_analyze_1116_ledger.ts; the
// figure is deliberately NOT hardcoded in app code).
//
// The app said $399,176.51. That number came from getPartsCostSpentByJob below,
// SUM([Total Price]), and TWO independent causes made it wrong — both of them
// general, neither specific to 1116:
//
//   1. OPEN PO COMMITMENT COUNTED AS ACTUAL.  [Total Price] is
//      "remaining-uninvoiced-PO-balance + everything-invoiced-to-date", so a job
//      sitting on open purchase orders reports their whole undelivered value as
//      money already spent. On 1116 that was $32,986.24 (110 PO lines, the largest
//      a $19,389.58 robot not yet billed). Across all 100 app jobs with parts
//      activity: $2,108,517.44. This is the "projection used as actual" failure —
//      a forecast in a column labelled actual.
//
//   2. AP DOCUMENTS THAT NEVER POST TO THE GL COUNTED AS ACTUAL.  See
//      GL_POSTED_AP above. On 1116: 54 lines / $19,950.40, spanning both part
//      lines ($10,161.10) and extra costs ($9,789.30). Across the database:
//      $621,483.80.
//
//      NARROWED 2026-09-04. "Never post" was the wrong reading of the flag — see
//      GL_POSTED_AP. Sage-first vendors (the credit card) DO post and now count.
//      This job's own $19,950.40 is unaffected: none of it is credit card, so the
//      1116 figures below still stand as derived. The residual noted at the end of
//      this block — "$1,928.73 of the ledger's own CDJ/GENJ/CRJ journal rows" —
//      should be revisited though, because some GENJ rows are now known to be the
//      ledger side of flagged ETO documents rather than postings ETO cannot reach.
//
// Removing both lands 1116 at $346,101.12 as of 7/31/26 against the ledger's
// $349,732.10 — a $3,630.98 (1.0%) residual, of which $1,928.73 is the ledger's
// own CDJ/GENJ/CRJ journal rows: cash-disbursement, general-journal and
// cash-receipt postings that exist ONLY in the accounting system's general
// ledger. TotalETO holds no journal-transaction table at all (checked: zero
// tables or views carry a journal / debit / credit column), so no AP-based query
// can reach them, by construction. The remaining ~$1,702 is at that same grain —
// chiefly a subcontractor invoice the ledger books to 1116 that TotalETO
// attributes elsewhere. Stated here rather than closed by a fudge factor.
//
// ── Causes ruled OUT, with evidence ─────────────────────────────────────────
//
//   * Stale cached values — none. Job.costActualHistorical matched the live query
//     exactly for every job that had one (0 of 234 differed).
//   * Duplicate PO/part rows — none that are the app's doing. 14 PO lines on 1116
//     carry more than one AP line, but they are legitimate progressive billing
//     (a bowl feeder invoiced 0.3 then 0.7; deposit-then-final pairs), and the
//     job ledger contains them too. Deduping them would have made the app WRONG.
//   * Joins multiplying rows — measured at zero jobs affected today, though
//     PART_PURCHASE_SQL does carry the latent hazard (its invoiced subquery groups
//     by BatchEntryTypeID as well as PurchaseDetailID, so a PO line billed under
//     two entry types would join twice and count its remaining balance twice).
//     PARTS_DETAIL_SQL, which feeds the per-line views, groups by
//     PurchaseDetailID alone and cannot. Guarded by a test rather than "fixed",
//     since changing a query with no live defect risks more than it gains.
//   * Wrong attribution field — POD.ProjectID and APDD.ProjectID agree perfectly
//     on 1116 (0 disagreements in either direction), and no AP line or PO line
//     fails to attribute to a job.
//   * Line/document discounts mishandled — no. APDocPctDisc is 0 on all 7,216
//     documents and APDocItemPctDisc is 0 on all but one line; discounts are
//     booked as their own negative lines, which SIGN-preserving SUM already nets.
//
// ── Deliberately NOT applied to Money Spent Month ───────────────────────────
//
// getPartsCostBookedByJob (the ETC grid's monthly figure) keeps its own rule, on
// purpose. It is reconciled to the business's own TotalETO pivot as it stands
// (§41), it feeds months that have been submitted and locked, and adding the
// GL-posted rule would move July 2026 by $13,672.97 on a $491,206.43 month across
// 21 jobs — a retroactive change to signed-off numbers. That is a business
// decision about which reference report the monthly measure should follow, not a
// bug to fix in passing. Flagged, not silently changed.
// ── Why the zero-fill branches exist ────────────────────────────────────────
//
// The result must contain an entry for every job TotalETO tracks ANY parts
// activity for, including jobs whose GL-posted spend is genuinely $0 — a job
// sitting on open purchase orders having paid nothing yet. Without that,
// syncPartsCostActual (which iterates THIS map) never visits such a job, and
// whatever stale figure it already had survives untouched. Found exactly that way:
// after the first pass of this fix, 5 of 100 jobs stayed wrong, job 1158 still
// reporting $99,606.54 of pure open-PO commitment as actual spend because it had
// no AP rows at all for the GROUP BY to produce.
//
// The two zero-fill branches reproduce PART_PURCHASE_SQL's own job set exactly —
// PO lines attributed through tblSpec/tblProjects, plus the Extra Costs view — so
// the population this writes is precisely the population the old basis wrote, and
// no job silently changes hands. Jobs with NO TotalETO parts footprint whatsoever
// stay absent, which is what protects the 116 pre-TotalETO jobs whose actuals were
// entered by hand (see syncPartsCostActual).
export async function getPartsActualByJob(): Promise<Map<string, number>> {
  return withTotalEto(async (pool) => {
    const result = await pool.request().query(
      `SELECT JobId, SUM(Actual) AS Actual FROM (
         SELECT APDD.ProjectID AS JobId, SUM(${AP_LINE_AMOUNT}) AS Actual
           FROM tblAPDocumentDetails APDD WITH(NOLOCK)
                INNER JOIN tblAPBatchDocument APBD WITH(NOLOCK) ON APBD.APDocID = APDD.APDocID
                ${sageFirstJoin("SFC")}
          WHERE APDD.ProjectID IS NOT NULL AND ${glPostedAp("SFC")}
          GROUP BY APDD.ProjectID
         UNION ALL
         SELECT P.ProjectID AS JobId, 0 AS Actual
           FROM tblPurchaseOrderHeader POH WITH(NOLOCK)
                INNER JOIN tblPurchaseOrderDetails POD WITH(NOLOCK) ON POH.PurchaseOrderID = POD.PurchaseOrderID
                LEFT JOIN tblSpec S WITH(NOLOCK) ON S.SpecID = POD.SpecID AND S.ProjectID = POD.ProjectID
                LEFT JOIN tblProjects P WITH(NOLOCK) ON S.ProjectID = P.ProjectID
          WHERE P.ProjectID IS NOT NULL
          GROUP BY P.ProjectID
         UNION ALL
         SELECT EC.ProjectID AS JobId, 0 AS Actual
           FROM vwCostingExtraCostsDetailed EC WITH(NOLOCK)
          WHERE EC.ProjectID IS NOT NULL
          GROUP BY EC.ProjectID
       ) x
       GROUP BY JobId`,
    );
    const map = new Map<string, number>();
    for (const r of result.recordset) {
      const actual = Number(r.Actual);
      // A null/NaN sum is a data problem, not a zero — skipping keeps the job out
      // rather than reporting a confident $0 spend (§30.14).
      if (Number.isFinite(actual)) map.set(String(Number(r.JobId)), actual);
    }
    return map;
  }, { requestTimeout: 180_000, feed: "parts_actual.by_job" });
}

// Parts COMMITMENT (not actual) per job, straight from TotalETO — SUM(Total
// Price) across EVERY PO/Extra-Cost line the job has, invoiced or not. Keyed by
// numeric Job Id string (e.g. "1150"), matching how the rest of the app keys
// jobs. A longer request timeout than the project sync since this query fans out
// across the full PO/AP history.
//
// NOT Parts Actual — see getPartsActualByJob above, which is. This figure
// includes each open PO's undelivered balance, so it answers "how much has this
// job committed", which is the right question for procurement/PO tracking and the
// wrong one for a column labelled actual. It fed Job.costActualHistorical until
// 2026-08-10; that was root cause #1 of the 1116 overstatement.
//
// NOT Money Spent Month — see getPartsCostBookedByJob above for that. `[Total Price]`
// includes each PO's uninvoiced remaining balance, which is meaningful for the Projects
// grid's and Job Cost Explorer's lifetime-to-date total and badly wrong for a single
// month — do not window this by month and call it a monthly spend.
//
// UNWINDOWED ON PURPOSE (bug found 2026-08-07): this used to take a date window and
// filter `WHERE [Invoiced Date] >= @start AND [Invoiced Date] < @end`, called with a
// 1990-2100 "lifetime" range from both callers below. That still excluded every line
// with NOTHING invoiced against it yet — `[Invoiced Date]` is NULL for an open PO, and
// `NULL >= @start` is SQL's UNKNOWN, not true, so the row silently dropped out of the
// WHERE clause no matter how wide the window was. A job sitting on a large open PO with
// zero invoices vanished from the result map entirely (never touched by
// syncPartsCostActual's update loop below, frozen at whatever it last was); a job with
// a mix of invoiced and open lines undercounted by exactly the open lines' value.
// Verified live across every job with a nonzero Job.costActualHistorical: the gap
// between this query's old result and getJobPartsCost's per-job total (which has NO
// invoiced-date filter — the drill-through/Job Hour Details basis) matched the sum of
// that job's zero-invoice lines to the cent, for all of them. Fixed by dropping the
// invoiced-date filter (and the now-pointless date parameters) entirely — this is
// supposed to be "every dollar committed to the job, ever," the same thing
// getJobPartsCost already computes one job at a time; this is that same computation as
// one aggregate query across every job, which is what both callers actually need.
export async function getPartsCostSpentByJob(): Promise<Map<string, number>> {
  return withTotalEto(async (pool) => {
    const result = await pool.request().query(
      `WITH pp AS (\n${PART_PURCHASE_SQL}\n)\n` +
        `SELECT [Job ID] AS JobId, SUM([Total Price]) AS Spent FROM pp ` +
        `WHERE [Job ID] IS NOT NULL ` +
        `GROUP BY [Job ID]`
    );
    const map = new Map<string, number>();
    for (const r of result.recordset) {
      const spent = Number(r.Spent);
      if (Number.isFinite(spent)) map.set(String(Number(r.JobId)), spent);
    }
    return map;
  }, { requestTimeout: 120_000, feed: "parts_cost.spent_by_job" });
}

// Frozen copy of getPartsCostSpentByJob's PRE-2026-08-07 behavior — windowed on
// [Invoiced Date], which silently drops every never-invoiced line (see the fix note
// above). Exists ONLY so the historical diagnostic scripts that compared this exact
// (buggy) basis against others — scripts/parts-spent-audit.ts,
// scripts/archive/parts-spent-recon.ts, scripts/archive/_recon_july_2026.ts — still
// run and still reproduce the numbers their own commentary discusses. The real app
// never calls this; do not add a new caller.
export async function legacyPartsCostSpentByJobWindowed(monthStart: Date, monthEndExclusive: Date): Promise<Map<string, number>> {
  return withTotalEto(async (pool) => {
    const result = await pool
      .request()
      .input("start", sql.DateTime, monthStart)
      .input("end", sql.DateTime, monthEndExclusive)
      .query(
        `WITH pp AS (\n${PART_PURCHASE_SQL}\n)\n` +
          `SELECT [Job ID] AS JobId, SUM([Total Price]) AS Spent FROM pp ` +
          `WHERE [Invoiced Date] >= @start AND [Invoiced Date] < @end AND [Job ID] IS NOT NULL ` +
          `GROUP BY [Job ID]`
      );
    const map = new Map<string, number>();
    for (const r of result.recordset) {
      const spent = Number(r.Spent);
      if (Number.isFinite(spent)) map.set(String(Number(r.JobId)), spent);
    }
    return map;
  }, { requestTimeout: 120_000, feed: "parts_cost.spent_by_job_windowed" });
}

// ── Per-job Parts Cost detail (live) — for the Job Hour Details dashboard ────
// Per-part line items + rollups, straight from TotalETO, mirroring the Power BI
// "Parts Cost" table. Part Costs branch joins supplier (tblCompany), item
// master (manufacturer / part# / category); Extra Costs branch (fees, shipping,
// tariffs) comes from vwCostingExtraCostsDetailed.
export type PartsCostLine = {
  /**
   * Stable Total ETO identity for this purchase line.
   *
   * `pod:<PurchaseDetailID>` for a PO line — verified 1:1 with rows on job 1116
   * (1083 rows, 1083 distinct ids), so it is the real grain of the PO branch.
   * Extra-cost rows have no PurchaseDetailID at all (NULL on all 22 of 1116's),
   * and APDocID repeats across them (20 ids for 22 rows), so those get a
   * composite `ec:<APDocID>:<item>:<value>` — unique on all 22.
   *
   * Why it exists: the Parts List groups a part's purchases by PO, and grouping
   * on part number alone is not safe. The two queries that describe the same
   * purchase line spell the part number differently — PARTS_DETAIL_SQL uses
   * `PurchaseSupplierItem || ManufacturerPartNumber`, job-bom's PO_SQL uses
   * `ItemCompanyID` — and they disagree on 34 of 1116's 1083 lines. A name join
   * silently drops those 3%; an id join cannot.
   */
  lineId: string;
  purchaseDate: string | null;
  invoicedDate: string | null;
  supplier: string | null;
  manufacturer: string | null;
  category: string | null;
  poNumber: string | null;
  partNumber: string | null;
  description: string | null;
  quantity: number;
  unitPrice: number;
  totalPrice: number; // "Purchased" — committed, incl. this line's open balance
  invoicedAmount: number; // "Paid" — everything billed against this line
  // "Actual" — the slice of invoicedAmount that actually posted to the general
  // ledger, i.e. the part of it a job ledger would show (see GL_POSTED_AP).
  // Equal to invoicedAmount for the overwhelming majority of lines; lower on any
  // line billed by a document flagged never-to-export. Summing THIS field is how
  // every view gets a Parts Actual that agrees with every other view.
  actualAmount: number;
};

export type JobPartsCost = {
  purchased: number;
  paid: number;
  /** Parts Actual — GL-posted spend. THE figure to show as "actual". */
  actual: number;
  leftToPay: number;
  lines: PartsCostLine[];
};

// Per-line "purchased" amount — the same remaining-uninvoiced + invoiced formula
// PART_PURCHASE_SQL aggregates, kept per line here.
const LINE_TOTAL_PRICE = `
  CASE WHEN POD.PurchaseQty >= 0 THEN
    CASE WHEN ISNULL(INV.InvoicedQty,0) > (CASE WHEN RLS.SumOfQtyReceived >= POD.PurchaseQty THEN RLS.SumOfQtyReceived ELSE POD.PurchaseQty END)
      THEN 0
      ELSE ((CASE WHEN RLS.SumOfQtyReceived >= POD.PurchaseQty THEN RLS.SumOfQtyReceived ELSE POD.PurchaseQty END) - ISNULL(INV.InvoicedQty,0))
    END * POD.PurchasePrice * POH.PurchaseCurrRate
  ELSE
    CASE WHEN ISNULL(INV.InvoicedQty,0) < (CASE WHEN RLS.SumOfQtyReceived >= POD.PurchaseQty THEN RLS.SumOfQtyReceived ELSE POD.PurchaseQty END)
      THEN 0
      ELSE ((CASE WHEN RLS.SumOfQtyReceived <= POD.PurchaseQty THEN RLS.SumOfQtyReceived ELSE POD.PurchaseQty END) - ISNULL(INV.InvoicedQty,0))
    END * POD.PurchasePrice * POH.PurchaseCurrRate
  END + ISNULL(INV.TotalInvoicedAmount, 0)`;

// ── One statement, two scopes (2026-09-02) ─────────────────────────────────
//
// Parameterized by its WHERE clauses rather than copied, because the alternative is
// two near-identical 60-line queries over the same tables that must be kept in step
// forever — and this one carries the GL-posted split, the open-balance term and the
// Extra Costs branch, every one of which has already been the subject of a fix.
//
// `JobId` is selected in both branches so a multi-job result can be split back out
// per job. The per-job caller ignores it.
const partsDetailSql = (where: { pod: string; ec: string }) => `
SELECT
   POD.ProjectID AS JobId
  ,CONCAT('pod:', CAST(POD.PurchaseDetailID AS varchar(20))) AS LineId
  ,CONVERT(varchar(10), POH.PurchaseDate, 23) AS PurchaseDate
  ,CONVERT(varchar(10), INV.APDocDate, 23) AS InvoicedDate
  ,SUP.CName AS Supplier
  ,IM.Manufacturer AS Manufacturer
  ,CAT.CategoryDescription AS Category
  ,CAST(POH.PurchaseOrderID AS varchar(32)) AS PONumber
  ,COALESCE(NULLIF(POD.PurchaseSupplierItem,''), IM.ManufacturerPartNumber) AS PartNumber
  ,COALESCE(NULLIF(POD.PurchaseSupplierDescription,''), IM.ItemDescription) AS Description
  ,POD.PurchaseQty AS Qty
  ,(POD.PurchasePrice * POH.PurchaseCurrRate) AS UnitPrice
  ,(${LINE_TOTAL_PRICE}) AS TotalPrice
  ,ISNULL(INV.TotalInvoicedAmount, 0) AS InvoicedAmount
  ,ISNULL(INV.GlPostedAmount, 0) AS ActualAmount
FROM tblPurchaseOrderHeader POH WITH(NOLOCK)
  INNER JOIN tblPurchaseOrderDetails POD WITH(NOLOCK) ON POH.PurchaseOrderID = POD.PurchaseOrderID
  LEFT JOIN tblCompany SUP WITH(NOLOCK) ON SUP.CompanyID = POH.PurchaseSupplierID
  LEFT JOIN tblEngItemMaster IM WITH(NOLOCK) ON IM.ItemID = POD.ItemID
  LEFT JOIN tlkpItemMaster_Categories CAT WITH(NOLOCK) ON CAT.ItemCategory = IM.ItemCategory
  -- GlPostedAmount is a SECOND aggregate alongside TotalInvoicedAmount, not a
  -- filter on the subquery. InvoicedQty deliberately still counts EVERY billed
  -- document, GL-posted or not: a part billed on a never-exported invoice has
  -- still been billed, so narrowing InvoicedQty would inflate the open-balance
  -- term in LINE_TOTAL_PRICE and overstate the commitment we are trying to stop
  -- overstating. Only the MONEY splits.
  LEFT JOIN ( SELECT APDD.PurchaseDetailID, max(APDocDate) AS APDocDate, SUM(APDocQty) AS InvoicedQty,
                SUM(APDocQty * APDocUnitPrice * (1 - APDocItemPctDisc) * APDocCurrRate) AS TotalInvoicedAmount,
                SUM(CASE WHEN ${glPostedAp("SFC")}
                         THEN APDocQty * APDocUnitPrice * (1 - APDocItemPctDisc) * APDocCurrRate
                         ELSE 0 END) AS GlPostedAmount
              FROM tblAPDocumentDetails APDD WITH(NOLOCK)
                INNER JOIN tblAPBatchDocument APBD WITH(NOLOCK) ON APBD.APDocID = APDD.APDocID
                ${sageFirstJoin("SFC")}
              WHERE BatchEntryTypeID NOT IN (2, 3) AND APDD.PurchaseDetailID IS NOT NULL
              GROUP BY APDD.PurchaseDetailID ) INV ON POD.PurchaseDetailID = INV.PurchaseDetailID
  LEFT JOIN vwReceiverLogSummed RLS WITH(NOLOCK) ON RLS.PurchaseDetailID = POD.PurchaseDetailID
WHERE ${where.pod}

UNION ALL

SELECT
   EC.ProjectID AS JobId
  -- CONCAT, not '+': it coerces and treats NULL as '', so one null component
  -- cannot collapse the whole id to NULL the way string concatenation would.
  ,CONCAT('ec:', CAST(EC.APDocID AS varchar(20)), ':', EC.PurchaseSupplierItem, ':', CAST(EC.decExtraCostingValue AS varchar(40))) AS LineId
  ,CONVERT(varchar(10), EC.APDocDate, 23) AS PurchaseDate
  ,CONVERT(varchar(10), EC.APDocDate, 23) AS InvoicedDate
  ,EC.Vendor AS Supplier
  ,NULL AS Manufacturer
  ,EC.APDocDesc AS Category
  ,CAST(EC.APDocNumber AS varchar(32)) AS PONumber
  ,EC.PurchaseSupplierItem AS PartNumber
  ,EC.APDocItemDesc AS Description
  ,EC.APDocQty AS Qty
  ,(EC.APDocUnitPrice * EC.APDocCurrRate) AS UnitPrice
  ,EC.decExtraCostingValue AS TotalPrice
  ,EC.decExtraCostingValue AS InvoicedAmount
  -- Extra Costs (shipping, fees, tariffs) carry the same GL-posted rule. The view
  -- exposes APDocID but not the flag, so it joins back to the batch document for
  -- it. On job 1116 this branch alone held $9,789.30 of never-posted cost, so
  -- applying the rule to the PO branch only would have left a third of the
  -- problem in place.
  --
  -- This spelled the flag test out by hand until 2026-09-04 rather than using the
  -- shared predicate, and that is exactly why the Sage-first correction missed it on
  -- the first pass: the monthly credit-card charges are EXTRA COSTS, not PO lines, so
  -- this branch is the one that decides them. It now calls glPostedAp like the other
  -- three, and a test asserts no site spells the flag out again.
  ,CASE WHEN ${glPostedAp("SFC")} THEN EC.decExtraCostingValue ELSE 0 END AS ActualAmount
FROM vwCostingExtraCostsDetailed EC WITH(NOLOCK)
  LEFT JOIN tblAPBatchDocument APBD WITH(NOLOCK) ON APBD.APDocID = EC.APDocID
  ${sageFirstJoin("SFC")}
WHERE ${where.ec}`;

/** The per-job form — unchanged behaviour, now one instantiation of the template. */
const PARTS_DETAIL_SQL = partsDetailSql({ pod: "POD.ProjectID = @job", ec: "EC.ProjectID = @job" });

/** One recordset row -> one PartsCostLine. Shared so the two scopes cannot map differently. */
function toPartsCostLine(r: Record<string, unknown>): PartsCostLine {
  return {
    lineId: (r.LineId as string) ?? "",
    purchaseDate: (r.PurchaseDate as string) ?? null,
    invoicedDate: (r.InvoicedDate as string) ?? null,
    supplier: (r.Supplier as string) ?? null,
    manufacturer: (r.Manufacturer as string) ?? null,
    category: (r.Category as string) ?? null,
    poNumber: (r.PONumber as string) ?? null,
    partNumber: (r.PartNumber as string) ?? null,
    description: (r.Description as string) ?? null,
    quantity: Number(r.Qty) || 0,
    unitPrice: Number(r.UnitPrice) || 0,
    totalPrice: Number(r.TotalPrice) || 0,
    invoicedAmount: Number(r.InvoicedAmount) || 0,
    actualAmount: Number(r.ActualAmount) || 0,
  };
}

/** The same "drop zero-noise rows, newest purchase first" pass both scopes apply. */
function meaningfulLines(lines: PartsCostLine[]): PartsCostLine[] {
  const out = lines.filter((l) => l.totalPrice !== 0 || l.invoicedAmount !== 0 || l.quantity !== 0);
  out.sort((a, b) => (b.purchaseDate ?? "").localeCompare(a.purchaseDate ?? ""));
  return out;
}

/**
 * Every part line for MANY jobs, in ONE round trip.
 *
 * The per-job function fanned out at 6 concurrent connections, which is fine for a
 * card showing one job and slow for a page showing all of them: T&M's "All Jobs"
 * took 5.8s over 239 jobs. This is the same rows through the same template and the
 * same mapping — one query instead of 239.
 *
 * Job ids are coerced to integers and inlined, which is safe BECAUSE of that
 * coercion: a value that is not a finite number never reaches the string. Inlined
 * rather than passed through STRING_SPLIT so the plan sees a plain integer IN list.
 */
export async function getPartsCostForJobs(jobIds: string[]): Promise<Map<string, PartsCostLine[]>> {
  const out = new Map<string, PartsCostLine[]>();
  const numeric = [...new Set(jobIds.map((j) => Number(j)).filter((n) => Number.isFinite(n) && n > 0))];
  if (numeric.length === 0) return out;
  const list = numeric.join(",");

  return withTotalEto(async (pool) => {
    const result = await pool
      .request()
      .query(partsDetailSql({ pod: `POD.ProjectID IN (${list})`, ec: `EC.ProjectID IN (${list})` }));
    const byJob = new Map<string, PartsCostLine[]>();
    for (const r of result.recordset) {
      const job = String(Number(r.JobId));
      const arr = byJob.get(job);
      const line = applyRefundSign(toPartsCostLine(r));
      if (arr) arr.push(line);
      else byJob.set(job, [line]);
    }
    for (const [job, lines] of byJob) out.set(job, meaningfulLines(lines));
    return out;
  }, { requestTimeout: 300_000, feed: "parts_cost.lines_for_jobs" });
}

// ── Genuinely month-scoped invoice lines, for the Parts Spent drill (2026-08-07) ──
//
// getJobPartsCost's whole-history result is correct for Job Hour Details/Procurement
// (below), but the Parts Spent drill nests it directly under a job row that shows THIS
// MONTH's spend — and a job whose big invoice landed in a different month showed that
// invoice's full line among rows sitting under a much smaller total. Reported as a bug:
// a total must never be exceeded by one of its own visible rows.
//
// ── Why this is a SEPARATE query, not a date filter over getJobPartsCost's result ──
//
// The first attempt at this fix filtered getJobPartsCost's lines by "does this line's
// invoicedDate fall in the month" — and it was wrong. `invoicedDate`/`invoicedAmount`
// there come from a subquery grouped by PurchaseDetailID ALONE (MAX(APDocDate),
// SUM(amount) across every AP document that PO line has EVER received) — a lifetime
// aggregate collapsed onto one row. A PO line invoiced across 7 different months (found
// live on job 1142: $1,207,300 spanning 2025-11 through 2026-08) would have its ENTIRE
// cumulative total misattributed to whichever single month happens to contain its LATEST
// invoice — exactly the "mixing monthly and full-history values in the same total" the
// fix was supposed to prevent, just relocated to a different month instead of removed.
//
// This query instead joins to tblAPDocumentDetails/tblAPBatchDocument directly and
// filters `APBD.APDocDate` BEFORE aggregating, one row per actual invoice event within
// the window — the same basis and the same date field (APDocDate) getPartsCostBookedByJob
// windows Money Spent Month on. A multi-month PO line now correctly contributes only
// the slice of it that was actually invoiced in THIS month, split across each month's
// drill rather than dumped whole into one of them.
//
// Job attribution is `APDD.ProjectID` DIRECTLY — the exact field getPartsCostBookedByJob
// groups by — not the PO chain (`POD.ProjectID`) the rest of this file's PO-detail
// queries use. That distinction matters here specifically: found live, job 1122 had 5 AP
// lines in July ($5,252.77 — freight, a tariff, an expense reimbursement) attributed to
// it directly with NO purchase order at all. The PO-chain tables are LEFT JOINed, not
// INNER, so these still surface as rows (PO/part columns blank, description falls back
// to the AP line's own), rather than being silently dropped the way an INNER JOIN through
// tblPurchaseOrderDetails would drop them. No BatchEntryTypeID filter either — matching
// getPartsCostBookedByJob's own definition exactly, not the separate PO-tracking queries'
// filter (which exists for a different reason: avoiding double-counting a PO's own
// remaining-balance calculation, not relevant to a plain AP-document sum). Verified live
// against getPartsCostBookedByJob's per-job figure for 10 real jobs in July 2026 — exact
// match, to the cent, every time.
export async function getJobPartsInvoicedInMonth(jobId: string, monthStart: Date, monthEndExclusive: Date): Promise<JobPartsCost> {
  const numericJob = Number(jobId);
  if (!Number.isFinite(numericJob)) return { purchased: 0, paid: 0, actual: 0, leftToPay: 0, lines: [] };
  return withTotalEto(async (pool) => {
    // §82: was two hand-typed copies of the AP-line-amount expression (one for
    // InvoicedAmount, one inside the ActualAmount CASE) instead of this shared
    // AP_LINE_AMOUNT constant — the same formula getPartsCostBookedByJob (the
    // Money Spent Month source) and every other AP-document query in this file
    // already reference. They happened to still agree, because both copies were
    // kept in careful lockstep by hand, but "kept in sync by hand" is exactly how
    // this kind of figure drifts the moment someone edits one copy and not the
    // other three. This is the one canonical AP-line-amount definition now, used
    // everywhere: Money Spent Month, this function (the Monthly ETC Parts Spent
    // drill AND the Parts List "Invoiced" window — see loadJobPartsLines /
    // loadPartsListInvoicedInWindow in hours-detail-actions.ts), and Parts Actual.
    const amt = AP_LINE_AMOUNT;
    const result = await pool
      .request()
      .input("job", sql.Int, numericJob)
      .input("start", sql.DateTime, monthStart)
      .input("end", sql.DateTime, monthEndExclusive)
      .query(`
        SELECT
          -- This drill's grain is the AP document DETAIL, not the purchase line
          -- (it LEFT JOINs POD, and a non-PO line has none), so its stable id is
          -- APDocDetailID. Prefixed distinctly so an id from here can never be
          -- mistaken for a 'pod:' one from PARTS_DETAIL_SQL.
           CONCAT('apdd:', CAST(APDD.APDocDetailID AS varchar(20))) AS LineId
          ,CONVERT(varchar(10), POH.PurchaseDate, 23) AS PurchaseDate
          ,CONVERT(varchar(10), APBD.APDocDate, 23) AS InvoicedDate
          ,SUP.CName AS Supplier
          ,IM.Manufacturer AS Manufacturer
          ,CAT.CategoryDescription AS Category
          ,CAST(POH.PurchaseOrderID AS varchar(32)) AS PONumber
          ,COALESCE(NULLIF(POD.PurchaseSupplierItem,''), IM.ManufacturerPartNumber) AS PartNumber
          ,COALESCE(NULLIF(POD.PurchaseSupplierDescription,''), IM.ItemDescription, NULLIF(APDD.APDocItemDesc,'')) AS Description
          ,APDD.APDocQty AS Qty
          ,COALESCE(POD.PurchasePrice * POH.PurchaseCurrRate, APDD.APDocUnitPrice * APBD.APDocCurrRate) AS UnitPrice
          ,(${amt}) AS InvoicedAmount
          -- Same GL-posted split every other parts query carries, so a drill row's
          -- actual agrees with the total above it. No filter here: this drill is
          -- reconciled line-for-line against getPartsCostBookedByJob, which counts
          -- every AP line, so dropping rows would break that agreement. The row
          -- still reports what DID post, separately.
          ,CASE WHEN ${glPostedAp("SUP")}
                THEN (${amt})
                ELSE 0 END AS ActualAmount
        FROM tblAPDocumentDetails APDD WITH(NOLOCK)
          INNER JOIN tblAPBatchDocument APBD WITH(NOLOCK) ON APBD.APDocID = APDD.APDocID
          LEFT JOIN tblPurchaseOrderDetails POD WITH(NOLOCK) ON POD.PurchaseDetailID = APDD.PurchaseDetailID
          LEFT JOIN tblPurchaseOrderHeader POH WITH(NOLOCK) ON POH.PurchaseOrderID = POD.PurchaseOrderID
          -- Supplier from the AP document's own vendor (tblAPBatchDocument.CompanyID), not the
          -- PO's — this is who was actually billed, and it is the only source at all for a
          -- non-PO line.
          LEFT JOIN tblCompany SUP WITH(NOLOCK) ON SUP.CompanyID = APBD.CompanyID
          LEFT JOIN tblEngItemMaster IM WITH(NOLOCK) ON IM.ItemID = POD.ItemID
          LEFT JOIN tlkpItemMaster_Categories CAT WITH(NOLOCK) ON CAT.ItemCategory = IM.ItemCategory
        WHERE APDD.ProjectID = @job
          AND APBD.APDocDate >= @start AND APBD.APDocDate < @end
      `);
    const lines: PartsCostLine[] = result.recordset.map((r) => ({
      lineId: r.LineId ?? "",
      purchaseDate: r.PurchaseDate ?? null,
      invoicedDate: r.InvoicedDate ?? null,
      supplier: r.Supplier ?? null,
      manufacturer: r.Manufacturer ?? null,
      category: r.Category ?? null,
      poNumber: r.PONumber ?? null,
      partNumber: r.PartNumber ?? null,
      description: r.Description ?? null,
      quantity: Number(r.Qty) || 0,
      // No remaining-uninvoiced-balance concept at this grain — this row IS one
      // invoice event, so what was purchased (this event's worth) and what was
      // invoiced are the same number. leftToPay is meaningless per-line here too;
      // it is computed once, correctly, at the returned total below.
      unitPrice: Number(r.UnitPrice) || 0,
      totalPrice: Number(r.InvoicedAmount) || 0,
      invoicedAmount: Number(r.InvoicedAmount) || 0,
      actualAmount: Number(r.ActualAmount) || 0,
    }))
      // Belt and braces over the SQL rule in AP_LINE_AMOUNT. That one can only
      // read APDD.APDocItemDesc; `description` above is a COALESCE preferring the
      // PO / item-master text, so a line can read "Refund" here while the AP
      // line's own description does not. `-abs()` is idempotent, so a line caught
      // by both is signed once. See lib/parts-refund.ts.
      .map(applyRefundSign);
    const meaningful = lines.filter((l) => l.invoicedAmount !== 0);
    meaningful.sort((a, b) => (b.invoicedDate ?? "").localeCompare(a.invoicedDate ?? ""));
    const paid = meaningful.reduce((s, l) => s + l.invoicedAmount, 0);
    const actual = meaningful.reduce((s, l) => s + l.actualAmount, 0);
    return { purchased: paid, paid, actual, leftToPay: 0, lines: meaningful };
  }, { requestTimeout: 120_000, feed: "parts_cost.job_invoiced_in_month" });
}

export async function getJobPartsCost(jobId: string): Promise<JobPartsCost> {
  const numericJob = Number(jobId);
  if (!Number.isFinite(numericJob)) return { purchased: 0, paid: 0, actual: 0, leftToPay: 0, lines: [] };
  return withTotalEto(async (pool) => {
    const result = await pool.request().input("job", sql.Int, numericJob).query(PARTS_DETAIL_SQL);
    const lines: PartsCostLine[] = result.recordset.map(toPartsCostLine)
      // PARTS_DETAIL_SQL has its OWN amount expressions and never touches
      // AP_LINE_AMOUNT, so this is the only place the refund rule reaches these
      // lines — and the reduce below builds purchased / paid / actual from them,
      // so the totals inherit it too. See lib/parts-refund.ts.
      .map(applyRefundSign);
    // Sort newest purchase first; drop fully-zero noise rows.
    const meaningful = meaningfulLines(lines);
    const purchased = meaningful.reduce((s, l) => s + l.totalPrice, 0);
    const paid = meaningful.reduce((s, l) => s + l.invoicedAmount, 0);
    const actual = meaningful.reduce((s, l) => s + l.actualAmount, 0);
    return { purchased, paid, actual, leftToPay: purchased - paid, lines: meaningful };
  }, { requestTimeout: 120_000, feed: "parts_cost.job_detail" });
}

// Credentials come from the environment, same as every other integration in
// this app (Power BI, Auth, Standard Sheet password) — this was previously
// the one exception, with a live username/password hardcoded in this file.
// Set TOTALETO_DB_USER / TOTALETO_DB_PASSWORD in .env (gitignored).
// The connection config moved to lib/totaleto-connection.ts (2026-09-01):
// this file held one of FOUR byte-identical copies, which is what made a single
// shared credential failure look like four unrelated ones.
//
// The local `config` is gone too (2026-09-03). Every query here now goes through
// `withTotalEto`, which owns the pool as well as the config — see that file's header
// for why closing a pool per call was corrupting concurrent queries.

interface TotalEtoProject {
  "Job ID": number;
  Description: string;
  Customer: string | null;
  Status: string;
  // Customer IDENTITY, not just the name — see lib/customer-canonical.ts for why
  // the accounting account is the field that actually groups customers and the
  // company id (largely) does not.
  CompanyID: number | null;
  AccountID: string | null;
}

interface TotalEtoCosting {
  "Job ID": number;
  EstEngHours: number | null;
  ActEngHours: number | null;
  EstMfgHours: number | null;
  ActMfgHours: number | null;
}

// Pulls active ("Sold") projects + actuals-vs-estimates costing from the
// TotalETO production database (vwProjects / vwProjectActualsVSEstimates —
// the same views the TotalETO MCP connector uses) and upserts into Job.
//
// TotalETO has no project "Type" (Custom/Duplicate/Hybrid/Service) field —
// that classification only exists in the spreadsheet-derived data. Per
// requirement, jobs with no Type must never be imported or shown, so this
// sync only UPDATES jobs that already exist with a valid Type; it never
// creates a new job (which would necessarily have Type = null).
// ── Parts Cost Actual (Job.costActualHistorical) ────────────────────────────
//
// The Projects grid's "Parts Cost Actual" column, filled from TotalETO instead
// of typed in.
//
// Policy set 2026-08-03: Jessica enters new projects, their quoted hours and
// their Parts Cost Quoted; the app pulls actual hours and actual parts cost. This
// is the second half of that — the column was manager-entered and had NO sync at
// all (Power BI's model has no equivalent measure; see the note in
// sync-actuals.ts).
//
// Source: getPartsActualByJob — GL-posted AP spend, the same definition every
// other Parts Actual in the app resolves to.
//
// This read getPartsCostSpentByJob (SUM([Total Price])) until 2026-08-10. That was
// the bug behind job 1116's ~$400K against a ~$340K job ledger: [Total Price]
// carries each open PO's undelivered balance, so the column labelled ACTUAL was
// reporting commitment plus forecast. See getPartsActualByJob for the full audit,
// both root causes, and the causes ruled out. Measured effect of the switch: 100
// jobs corrected, $2,686,954.34 of overstatement removed in total.
//
// NOT the same source as the ETC grid's "Money Spent Month" (getPartsCostBookedByJob)
// — that is deliberately a monthly question with its own reconciled rule.
//
// Cumulative, not per-month: the column is a running actual, unwindowed.
//
// Every job with a real Type, whatever its Status — Complete jobs are precisely
// the ones whose parts spend is finished and worth reporting, and they were the
// rows sitting empty.
//
// Jobs absent from TotalETO are left ALONE, not zeroed. 116 app jobs predate
// TotalETO's data (its AP history starts 2024-10-30) and carry a manually-entered
// historical figure totalling $18.76M; the loop below iterates the source map, so
// a job TotalETO has never heard of is never written. Reversing that iteration
// would silently destroy all of it.
export async function syncPartsCostActual(): Promise<{ jobsUpdated: number; jobsNotFound: number }> {
  const spentByJobId = await getPartsActualByJob();

  const jobs = await prisma.job.findMany({
    where: { type: { in: [...VALID_JOB_TYPES] } },
    select: { id: true, jobId: true, costActualHistorical: true },
  });
  const byJobId = new Map(jobs.map((j) => [j.jobId, j]));

  let jobsUpdated = 0;
  let jobsNotFound = 0;
  for (const [jobId, spent] of spentByJobId) {
    const job = byJobId.get(jobId);
    if (!job) {
      // TotalETO carries spare-parts/service pseudo-IDs that never map to an app
      // job. Counted, not warned about one by one.
      jobsNotFound++;
      continue;
    }
    // Only write a real change: this runs on every pass, and rewriting an
    // identical Decimal would churn updatedAt on all 233 rows for nothing.
    const current = job.costActualHistorical == null ? null : Number(job.costActualHistorical);
    const next = Math.round(spent * 100) / 100;
    if (current != null && Math.abs(current - next) < 0.005) continue;
    await prisma.job.update({ where: { id: job.id }, data: { costActualHistorical: next } });
    jobsUpdated++;
  }
  return { jobsUpdated, jobsNotFound };
}

export async function syncFromTotalEto(): Promise<{ jobsUpdated: number; skippedNoType: number }> {
  return withTotalEto(async (pool) => {
    const projects = await pool.request().query<TotalEtoProject>(`
      SELECT
        P.ProjectID AS [Job ID],
        P.PDescription AS [Description],
        P.CName AS [Customer],
        P.PStatus AS [Status],
        P.CompanyID AS [CompanyID],
        -- The accounting customer ACCOUNT. LEFT JOIN, not INNER: a project whose
        -- company record has been removed must still sync its hours and its
        -- name, just without an account.
        C.CAccCustomerID AS [AccountID]
      FROM vwProjects P WITH(NOLOCK)
      LEFT JOIN tblCompany C WITH(NOLOCK) ON C.CompanyID = P.CompanyID
      WHERE P.PStatus = 'Sold'
      ORDER BY P.PDelivery ASC
    `);

    const costing = await pool.request().query<TotalEtoCosting>(`
      SELECT
        C.ProjectID AS [Job ID],
        C.EstEngHours, C.ActEngHours, C.EstMfgHours, C.ActMfgHours
      FROM vwProjectActualsVSEstimates C WITH(NOLOCK)
      WHERE C.ProjectID IN (SELECT ProjectID FROM tblProjects WITH(NOLOCK) WHERE PStatus = 'Sold')
    `);
    const costingByJobId = new Map(costing.recordset.map((c) => [c["Job ID"], c]));

    const existingJobs = await prisma.job.findMany({
      where: { jobId: { in: projects.recordset.map((p) => String(p["Job ID"])) }, type: { in: [...VALID_JOB_TYPES] } },
      select: { jobId: true, customerManuallyEdited: true },
    });
    const existingJobIds = new Set(existingJobs.map((j) => j.jobId));
    // A manager's manual Customer edit on the Projects tab must survive this
    // sync instead of being silently overwritten — see customerManuallyEdited.
    const manuallyEditedJobIds = new Set(existingJobs.filter((j) => j.customerManuallyEdited).map((j) => j.jobId));

    let jobsUpdated = 0;
    let skippedNoType = 0;
    const now = new Date();
    for (const p of projects.recordset) {
      const jobId = String(p["Job ID"]);
      if (!existingJobIds.has(jobId)) {
        skippedNoType++;
        continue;
      }
      const c = costingByJobId.get(p["Job ID"]);

      await prisma.job.update({
        where: { jobId },
        data: {
          ...(manuallyEditedJobIds.has(jobId) ? {} : { customer: p.Customer }),
          // NOT gated on manuallyEditedJobIds, unlike `customer` above. These
          // two describe the TotalETO PROJECT, not somebody's preferred label
          // for it, so a manual name edit is no reason to let them go stale.
          // customer-canonical.ts honours the manual override by declining to
          // group on the account for such a job — the override is respected
          // where it means something, without blinding this app to the source.
          totEtoCompanyId: p.CompanyID ?? null,
          totEtoAccountId: p.AccountID?.trim() || null,
          totEtoEstEngHours: c?.EstEngHours ?? undefined,
          totEtoActEngHours: c?.ActEngHours ?? undefined,
          totEtoEstMfgHours: c?.EstMfgHours ?? undefined,
          totEtoActMfgHours: c?.ActMfgHours ?? undefined,
          totEtoSyncedAt: now,
        },
      });
      jobsUpdated++;
    }

    return { jobsUpdated, skippedNoType };
  }, { requestTimeout: TOTALETO_TIMEOUT.sync, feed: "totaleto_jobs.mirror" });
}
