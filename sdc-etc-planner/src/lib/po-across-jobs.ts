import "server-only";
import { getPartsCostForJobs, type PartsCostLine } from "@/lib/sync-totaleto";
import { withTotalEto } from "@/lib/totaleto-connection";
import { leftToInvoiceForLines, rawLeftToInvoice } from "@/lib/left-to-invoice";

// ── One purchase order, across every job it touches ──────────────────────────
//
// Asked in the 2026-09 parts-cost variance review, about PO 103046 — thirteen G2V
// Optics lines split across jobs 1130, 1142 and 1143, $3,600,500 in total. Answering
// it took three separate lookups in the Procurement drawer plus manual addition,
// because that drawer is deliberately single-job: it is built around a BOM tree, and
// a BOM tree belongs to one job.
//
// docs/PARTS-COST-VARIANCE-2026-09.md §5.1 recorded that as a gap. This is it closed.
//
// ── Built ON the parts pipeline, not beside it ──────────────────────────────
//
// The tempting implementation is a fresh query against tblPurchaseOrderHeader — and it
// would be a second definition of purchased/invoiced/left, free to drift from the one
// every other screen uses. This session has now fixed that same class of drift three
// times (the Left to Invoice formula written out four times, the GL-posted flag
// written out twice, Money Spent Month on an unstated basis), so:
//
//   1. one cheap query asks WHICH jobs carry the PO — ids only, no money;
//   2. getPartsCostForJobs then returns those jobs' lines through the ordinary
//      pipeline, and the lines are filtered by PO number here.
//
// Every figure below is therefore the same figure the Parts List shows, by
// construction rather than by agreement. The cost is one extra round trip, on a lookup
// nobody runs in a loop.

export type PoJobBreakdown = {
  /** Total ETO job number, e.g. "1130". */
  jobNumber: string;
  lines: number;
  purchased: number;
  /** GL-posted, the app's one definition of parts actual. */
  invoiced: number;
  /** Floored at 0, matching every other place this figure is shown. */
  leftToInvoice: number;
  /** Unfloored, so an over-invoiced job is visible rather than reading as a clean $0. */
  leftToInvoiceRaw: number;
  suppliers: string[];
};

export type PoLookup = {
  poNumber: string;
  /** Empty when the PO number matches nothing — not an error, just no such PO. */
  jobs: PoJobBreakdown[];
  totals: { lines: number; purchased: number; invoiced: number; leftToInvoice: number };
  /** True when more than one job is charged, which is the whole reason this exists. */
  spansJobs: boolean;
};

/**
 * Which jobs carry `poNumber`. Ids only — the money comes from the shared pipeline.
 *
 * Both branches the parts pipeline itself unions: PO lines are attributed through
 * tblSpec/tblProjects, and extra costs (freight, fees, tariffs) carry their own
 * ProjectID. A PO whose only charge to a job is freight would otherwise be missed.
 */
async function jobsCarryingPo(poNumber: string): Promise<string[]> {
  const numeric = Number(poNumber);
  return withTotalEto(async (pool) => {
    const r = await pool
      .request()
      .input("po", poNumber)
      .input("poNum", Number.isFinite(numeric) ? numeric : -1)
      .query(
        `SELECT DISTINCT JobId FROM (
           SELECT CAST(P.ProjectID AS varchar(32)) AS JobId
             FROM tblPurchaseOrderHeader POH WITH(NOLOCK)
                  INNER JOIN tblPurchaseOrderDetails POD WITH(NOLOCK) ON POH.PurchaseOrderID = POD.PurchaseOrderID
                  LEFT JOIN tblSpec S WITH(NOLOCK) ON S.SpecID = POD.SpecID AND S.ProjectID = POD.ProjectID
                  LEFT JOIN tblProjects P WITH(NOLOCK) ON S.ProjectID = P.ProjectID
            WHERE POH.PurchaseOrderID = @poNum AND P.ProjectID IS NOT NULL
           UNION
           SELECT CAST(EC.ProjectID AS varchar(32)) AS JobId
             FROM vwCostingExtraCostsDetailed EC WITH(NOLOCK)
            WHERE EC.ProjectID IS NOT NULL AND CAST(EC.APDocNumber AS varchar(64)) = @po
         ) x WHERE JobId IS NOT NULL`,
      );
    return r.recordset.map((row: Record<string, unknown>) => String(row.JobId));
  }, { feed: "po_across_jobs.jobs_carrying_po" });
}

/** Case- and space-insensitive, because a PO is typed by hand into a search box. */
const samePo = (a: string | null, b: string) => (a ?? "").trim().toUpperCase() === b.trim().toUpperCase();

/**
 * Everything charged to `poNumber`, grouped by job.
 *
 * Never throws for "no such PO" — an empty `jobs` array is the answer, because a
 * mistyped PO number is an ordinary thing for a search box to receive.
 */
export async function lookupPoAcrossJobs(poNumber: string): Promise<PoLookup> {
  const po = poNumber.trim();
  const empty: PoLookup = {
    poNumber: po,
    jobs: [],
    totals: { lines: 0, purchased: 0, invoiced: 0, leftToInvoice: 0 },
    spansJobs: false,
  };
  if (!po) return empty;

  const jobNumbers = [...new Set(await jobsCarryingPo(po))].filter(Boolean);
  if (jobNumbers.length === 0) return empty;

  const byJob = await getPartsCostForJobs(jobNumbers);

  const jobs: PoJobBreakdown[] = [];
  for (const jobNumber of jobNumbers) {
    // The PO's own lines only. A job carries thousands; this PO is a handful of them.
    const lines = (byJob.get(jobNumber) ?? []).filter((l: PartsCostLine) => samePo(l.poNumber, po));
    if (lines.length === 0) continue;
    jobs.push({
      jobNumber,
      lines: lines.length,
      purchased: lines.reduce((a, l) => a + l.totalPrice, 0),
      invoiced: lines.reduce((a, l) => a + l.actualAmount, 0),
      leftToInvoice: leftToInvoiceForLines(lines),
      leftToInvoiceRaw: rawLeftToInvoice(lines),
      suppliers: [...new Set(lines.map((l) => l.supplier).filter((s): s is string => !!s))],
    });
  }
  jobs.sort((a, b) => b.purchased - a.purchased);

  return {
    poNumber: po,
    jobs,
    totals: {
      lines: jobs.reduce((a, j) => a + j.lines, 0),
      purchased: jobs.reduce((a, j) => a + j.purchased, 0),
      invoiced: jobs.reduce((a, j) => a + j.invoiced, 0),
      // Summed from the per-job FLOORED figures, so the total equals the column above
      // it. Summing raw and flooring once would give a different number from the rows,
      // which is the reconciliation complaint this whole area keeps producing.
      leftToInvoice: jobs.reduce((a, j) => a + j.leftToInvoice, 0),
    },
    spansJobs: jobs.length > 1,
  };
}
