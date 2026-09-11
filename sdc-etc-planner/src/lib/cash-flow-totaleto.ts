import { TOTALETO_TIMEOUT, withTotalEto } from "@/lib/totaleto-connection";

// ── Raw Total ETO extraction for Cash Flow Forecast (2026-08-19) ────────────
//
// Same server/db/creds/config SHAPE as sync-totaleto.ts and job-bom.ts (see
// those files' own "DO NOT CHANGE" notes) — a fourth copy rather than a
// shared helper, matching the existing precedent rather than refactoring
// three other files' working connections as a side effect of this one.
//
// Total ETO has NO table or view of its own backing the "Project Cash Flow
// Forecast" report (confirmed live: no table/view anywhere in this database
// named anything like CashFlow/Forecast) — every query below reproduces one
// piece of it from the same base tables that report itself must be built on:
//
//   AR (Incoming)  -> tblARSalesTerms, the full milestone payment schedule —
//                     BOTH already-invoiced (ARTReleased=1) and still-pending
//                     (ARTReleased=0) rows, refined against the real invoice's
//                     own due date once released (tblARDocumentDetails/
//                     Header) since that's more precise than the term's
//                     original planned date.
//   AP (Outgoing)  -> tblAPBatchDocument.APDocDueDate — the real due date
//                     Total ETO itself tracks per AP document, joined to
//                     tblAPDocumentDetails for the per-project amount and
//                     the SAME GL-posted rule (APDocDoNotExport) sync-
//                     totaleto.ts's own AP reconciliation already uses.
//   PO (Outgoing)  -> tblPurchaseOrderHeader/Details, remaining commitment
//                     (ordered - already-invoiced-to-AP), bucketed by
//                     DateRequired. Total ETO carries NO purchase-order due/
//                     payment date anywhere (confirmed live) — DateRequired
//                     (expected receipt) is the closest real date on a PO
//                     line, so it stands in as a documented approximation,
//                     never presented as an authoritative due date.
//   Estimates      -> vwProjectEstimate (Sales Price / Material / Labor /
//                     Total Estimate / Margin) + vwProjectActualsVSEstimates_
//                     LaborAndMaterials (TotalBudget - ActTotalCost, the
//                     dollar figure "remaining ETC" allocation is spread
//                     across future months from).

// ── The shared pool, not a pool per query (2026-09-09) ──────────────────────
//
// Every function below used to open a ConnectionPool of its own on the shared
// config,
// run one statement, and close it again — so a Cash Flow snapshot capture cost
// four full TCP connections and four NTLM logins, and a drill click cost another
// three. The 2026-09-03 shared-pool work (lib/totaleto-connection.ts) never
// reached these two files, which still carried the config-only half of the
// 2026-09-01 consolidation.
//
// They use withTotalEto now, which means they get the one long-lived pool, the
// bounded retries, and the per-attempt diagnostics with everything else that
// talks to Total ETO. Connection churn of that shape is also the thing most
// likely to make a healthy server look unreliable: each login is a fresh chance
// to be refused, time out, or lose a race, for no benefit at all.
//
// Safe only BECAUSE the pool is now instance-tagged: `.input("projectId",
// sql.Int, ...)` below binds a type constant from THIS module's copy of mssql,
// and handing that to a pool another copy had built is the exact fault that broke
// Parts cost for five days. See totaleto-connection.ts.
export type ProjectEstimateRow = {
  projectId: string;
  customer: string | null;
  salesPrice: number;
  materialEstimate: number;
  laborEstimate: number;
  totalEstimate: number;
  projectProfit: number;
  /** TotalBudget - ActTotalCost from vwProjectActualsVSEstimates_LaborAndMaterials — the dollar figure ETC allocations are spread against. Null if the project has no row in that view (e.g. not yet started). */
  remainingCost: number | null;
};

export type ArForecastRow = {
  projectId: string;
  /** ISO "yyyy-mm-dd", or null for a term with no date on file at all — the "unknown AR due date" case. */
  dueDate: string | null;
  amount: number;
  released: boolean;
  description: string | null;
};

export type ApForecastRow = {
  projectId: string;
  /** null when the AP document itself carries no due date — the "unknown AP due date" case. */
  dueDate: string | null;
  amount: number;
};

export type PoForecastRow = {
  projectId: string;
  /** null when neither the line nor its header carries a required date — the "unknown PO due date" case. */
  dueDate: string | null;
  /** Remaining (uninvoiced) commitment on this PO line — never negative. */
  remainingAmount: number;
};

function toIso(d: unknown): string | null {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(String(d));
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export async function fetchProjectEstimates(): Promise<ProjectEstimateRow[]> {
  return withTotalEto(async (pool) => {
    const result = await pool.request().query(`
      SELECT
        E.ProjectID AS ProjectID,
        S.CName AS Customer,
        E.SalesPrice AS SalesPrice,
        E.TotalMaterial AS MaterialEstimate,
        E.TotalLabor AS LaborEstimate,
        E.TotalEstimate AS TotalEstimate,
        E.Margin AS Margin,
        (AE.TotalBudget - AE.ActTotalCost) AS RemainingCost
      FROM vwProjectEstimate E WITH(NOLOCK)
      LEFT JOIN vwSalesOrder S WITH(NOLOCK) ON S.ProjectID = E.ProjectID
      LEFT JOIN vwProjectActualsVSEstimates_LaborAndMaterials AE WITH(NOLOCK) ON AE.ProjectID = E.ProjectID
    `);
    return result.recordset.map((r) => ({
      projectId: String(r.ProjectID),
      customer: r.Customer ?? null,
      salesPrice: num(r.SalesPrice),
      materialEstimate: num(r.MaterialEstimate),
      laborEstimate: num(r.LaborEstimate),
      totalEstimate: num(r.TotalEstimate),
      projectProfit: num(r.Margin),
      remainingCost: r.RemainingCost == null ? null : num(r.RemainingCost),
    }));
  }, { requestTimeout: TOTALETO_TIMEOUT.cashFlow, feed: "cash_flow.project_estimates" });
}

// One row per sales term, refined against the real invoice due date/amount
// once released. `ARDocTermPrj`/`ARDocTermId` is the join back from an
// invoiced AR line to the term it fulfills — confirmed live (tblARSalesTerms'
// ARTProjectId/ARTTermId is the same composite key).
export async function fetchArForecastRows(): Promise<ArForecastRow[]> {
  return withTotalEto(async (pool) => {
    const result = await pool.request().query(`
      SELECT
        T.ARTProjectId AS ProjectID,
        T.ARTAmount AS TermAmount,
        T.ARTDate AS TermDate,
        T.ARTReleased AS Released,
        T.Description AS Description,
        H.ARDueDate AS InvoiceDueDate,
        D.ARDocAmount AS InvoiceAmount
      FROM tblARSalesTerms T WITH(NOLOCK)
      LEFT JOIN tblARDocumentDetails D WITH(NOLOCK)
        ON D.ARDocTermPrj = T.ARTProjectId AND D.ARDocTermId = T.ARTTermId
      LEFT JOIN tblARDocumentHeader H WITH(NOLOCK)
        ON H.ARDocId = D.ARDocHeaderId AND ISNULL(H.ARDocDeleted, 0) = 0
      WHERE ISNULL(T.Archived, 0) = 0
    `);
    return result.recordset.map((r) => {
      const released = !!r.Released;
      // Once invoiced, the real invoice's own due date/amount is more precise
      // than the term's original plan (partial invoicing, a due date moved by
      // actual terms-of-sale) — fall back to the term's own values if for some
      // reason the join found no matching invoice line yet.
      const dueDate = released ? (toIso(r.InvoiceDueDate) ?? toIso(r.TermDate)) : toIso(r.TermDate);
      const amount = released && r.InvoiceAmount != null ? num(r.InvoiceAmount) : num(r.TermAmount);
      return { projectId: String(r.ProjectID), dueDate, amount, released, description: r.Description ?? null };
    });
  }, { requestTimeout: TOTALETO_TIMEOUT.cashFlow, feed: "cash_flow.ar_forecast" });
}

// The exact GL-posted rule sync-totaleto.ts's own AP reconciliation uses
// (APDocDoNotExport) — an AP document excluded from the GL never belongs in
// a cash-outgoing forecast any more than it belongs in the actual-spend
// figures that rule already protects.
const GL_POSTED_AP = "ISNULL(APBD.APDocDoNotExport, 0) = 0";
const AP_LINE_AMOUNT = "(APDD.APDocQty * APDD.APDocUnitPrice * (1 - APDD.APDocItemPctDisc) * APBD.APDocCurrRate)";

export async function fetchApForecastRows(): Promise<ApForecastRow[]> {
  return withTotalEto(async (pool) => {
    const result = await pool.request().query(`
      SELECT
        APDD.ProjectID AS ProjectID,
        APBD.APDocDueDate AS DueDate,
        SUM(${AP_LINE_AMOUNT}) AS Amount
      FROM tblAPDocumentDetails APDD WITH(NOLOCK)
      JOIN tblAPBatchDocument APBD WITH(NOLOCK) ON APBD.APDocID = APDD.APDocID
      WHERE ${GL_POSTED_AP}
        AND APDD.ProjectID IS NOT NULL
        AND ISNULL(APDD.Archived, 0) = 0
      GROUP BY APDD.ProjectID, APBD.APDocDueDate
    `);
    return result.recordset.map((r) => ({ projectId: String(r.ProjectID), dueDate: toIso(r.DueDate), amount: num(r.Amount) }));
  }, { requestTimeout: TOTALETO_TIMEOUT.cashFlow, feed: "cash_flow.ap_forecast" });
}

// Remaining (uninvoiced) commitment per PO line = ordered value minus
// whatever of that SAME line has already become an AP document
// (tblAPDocumentDetails.PurchaseDetailID is the join back to the PO line
// that AP invoice line fulfills). Deliberately simpler than job-bom.ts's full
// BOM-release-status/inventory-pull treatment — this is a cash-timing
// estimate, not the procurement-completeness report that file computes; a
// remaining commitment already reflected in booked AP above must never be
// double-counted here.
export async function fetchPoForecastRows(): Promise<PoForecastRow[]> {
  return withTotalEto(async (pool) => {
    const result = await pool.request().query(`
      SELECT
        POD.ProjectID AS ProjectID,
        ISNULL(POD.DateRequired, POH.PurchaseDateRequired) AS DueDate,
        (POD.PurchaseQty * POD.PurchasePrice) AS OrderedAmount,
        ISNULL(AP.InvoicedAmount, 0) AS InvoicedAmount
      FROM tblPurchaseOrderDetails POD WITH(NOLOCK)
      JOIN tblPurchaseOrderHeader POH WITH(NOLOCK) ON POH.PurchaseOrderID = POD.PurchaseOrderID
      OUTER APPLY (
        SELECT SUM(${AP_LINE_AMOUNT}) AS InvoicedAmount
        FROM tblAPDocumentDetails APDD WITH(NOLOCK)
        JOIN tblAPBatchDocument APBD WITH(NOLOCK) ON APBD.APDocID = APDD.APDocID
        WHERE APDD.PurchaseDetailID = POD.PurchaseDetailID AND ${GL_POSTED_AP}
      ) AP
      WHERE ISNULL(POD.Archived, 0) = 0 AND POD.ProjectID IS NOT NULL
    `);
    return result.recordset
      .map((r) => ({
        projectId: String(r.ProjectID),
        dueDate: toIso(r.DueDate),
        remainingAmount: Math.max(0, num(r.OrderedAmount) - num(r.InvoicedAmount)),
      }))
      .filter((r) => r.remainingAmount > 0.005); // fully-invoiced lines carry no remaining cash-out at all
  }, { requestTimeout: TOTALETO_TIMEOUT.cashFlow, feed: "cash_flow.po_forecast" });
}
