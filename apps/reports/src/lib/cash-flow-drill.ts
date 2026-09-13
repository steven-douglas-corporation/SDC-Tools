import sql from "mssql";
import { TOTALETO_TIMEOUT, withTotalEto } from "@/lib/totaleto-connection";

// Record-level drill-through behind one Cash Flow cell — CURRENT only. A
// stored snapshot keeps only the aggregated (project, month, category)
// amount (CashFlowSnapshotLine has no line-item detail — storing every
// invoice/PO row per snapshot would multiply storage for a feature whose own
// point is compact historical comparison, not a permanent invoice archive),
// so a historical "As Of" cell's drill panel shows the total only; these
// queries back "Current" drill-through, always live against Total ETO.

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
function toIso(d: unknown): string | null {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(String(d));
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export type ArDrillRow = {
  customer: string | null;
  invoiceNumber: string | null;
  description: string | null;
  amount: number;
  invoiceDate: string | null;
  dueDate: string | null;
  status: string; // "Invoiced" | "Pending"
};

export async function fetchArDrillRows(projectId: string): Promise<ArDrillRow[]> {
  return withTotalEto(async (pool) => {
    const result = await pool
      .request()
      .input("projectId", sql.Int, Number(projectId))
      .query(`
        SELECT
          T.Description AS Description,
          T.ARTAmount AS TermAmount,
          T.ARTReleased AS Released,
          T.ARTDate AS TermDate,
          H.ARDocInvoiceNumber AS InvoiceNumber,
          H.ARDocDate AS InvoiceDate,
          H.ARDueDate AS InvoiceDueDate,
          D.ARDocAmount AS InvoiceAmount
        FROM tblARSalesTerms T WITH(NOLOCK)
        LEFT JOIN tblARDocumentDetails D WITH(NOLOCK)
          ON D.ARDocTermPrj = T.ARTProjectId AND D.ARDocTermId = T.ARTTermId
        LEFT JOIN tblARDocumentHeader H WITH(NOLOCK)
          ON H.ARDocId = D.ARDocHeaderId AND ISNULL(H.ARDocDeleted, 0) = 0
        WHERE T.ARTProjectId = @projectId AND ISNULL(T.Archived, 0) = 0
        ORDER BY ISNULL(H.ARDueDate, T.ARTDate)
      `);
    return result.recordset.map((r) => {
      const released = !!r.Released;
      return {
        customer: null,
        invoiceNumber: r.InvoiceNumber != null ? String(r.InvoiceNumber) : null,
        description: r.Description ?? null,
        amount: released && r.InvoiceAmount != null ? num(r.InvoiceAmount) : num(r.TermAmount),
        invoiceDate: released ? toIso(r.InvoiceDate) : null,
        dueDate: released ? (toIso(r.InvoiceDueDate) ?? toIso(r.TermDate)) : toIso(r.TermDate),
        status: released ? "Invoiced" : "Pending",
      };
    });
  }, { requestTimeout: TOTALETO_TIMEOUT.sync, feed: "cash_flow_drill.ar_lines" });
}

export type ApDrillRow = {
  supplier: string | null;
  invoiceNumber: string | null;
  amount: number;
  invoiceDate: string | null;
  dueDate: string | null;
};

const AP_LINE_AMOUNT = "(APDD.APDocQty * APDD.APDocUnitPrice * (1 - APDD.APDocItemPctDisc) * APBD.APDocCurrRate)";

export async function fetchApDrillRows(projectId: string): Promise<ApDrillRow[]> {
  return withTotalEto(async (pool) => {
    const result = await pool
      .request()
      .input("projectId", sql.Int, Number(projectId))
      .query(`
        SELECT
          APBD.APDocNumber AS InvoiceNumber,
          APBD.APDocDate AS InvoiceDate,
          APBD.APDocDueDate AS DueDate,
          SUM(${AP_LINE_AMOUNT}) AS Amount
        FROM tblAPDocumentDetails APDD WITH(NOLOCK)
        JOIN tblAPBatchDocument APBD WITH(NOLOCK) ON APBD.APDocID = APDD.APDocID
        WHERE APDD.ProjectID = @projectId
          AND ISNULL(APBD.APDocDoNotExport, 0) = 0
          AND ISNULL(APDD.Archived, 0) = 0
        GROUP BY APBD.APDocNumber, APBD.APDocDate, APBD.APDocDueDate
        ORDER BY APBD.APDocDueDate
      `);
    return result.recordset.map((r) => ({
      supplier: null,
      invoiceNumber: r.InvoiceNumber ?? null,
      amount: num(r.Amount),
      invoiceDate: toIso(r.InvoiceDate),
      dueDate: toIso(r.DueDate),
    }));
  }, { requestTimeout: TOTALETO_TIMEOUT.sync, feed: "cash_flow_drill.ap_lines" });
}

export type PoDrillRow = {
  poNumber: string | null;
  supplier: string | null;
  expectedDate: string | null;
  orderedAmount: number;
  invoicedAmount: number;
  remainingAmount: number;
};

export async function fetchPoDrillRows(projectId: string): Promise<PoDrillRow[]> {
  return withTotalEto(async (pool) => {
    const result = await pool
      .request()
      .input("projectId", sql.Int, Number(projectId))
      .query(`
        SELECT
          POH.PurchaseOrderID AS PoNumber,
          ISNULL(POD.DateRequired, POH.PurchaseDateRequired) AS ExpectedDate,
          (POD.PurchaseQty * POD.PurchasePrice) AS OrderedAmount,
          ISNULL(AP.InvoicedAmount, 0) AS InvoicedAmount
        FROM tblPurchaseOrderDetails POD WITH(NOLOCK)
        JOIN tblPurchaseOrderHeader POH WITH(NOLOCK) ON POH.PurchaseOrderID = POD.PurchaseOrderID
        OUTER APPLY (
          SELECT SUM(${AP_LINE_AMOUNT}) AS InvoicedAmount
          FROM tblAPDocumentDetails APDD WITH(NOLOCK)
          JOIN tblAPBatchDocument APBD WITH(NOLOCK) ON APBD.APDocID = APDD.APDocID
          WHERE APDD.PurchaseDetailID = POD.PurchaseDetailID AND ISNULL(APBD.APDocDoNotExport, 0) = 0
        ) AP
        WHERE POD.ProjectID = @projectId AND ISNULL(POD.Archived, 0) = 0
        ORDER BY ExpectedDate
      `);
    return result.recordset
      .map((r) => ({
        poNumber: r.PoNumber != null ? String(r.PoNumber) : null,
        supplier: null,
        expectedDate: toIso(r.ExpectedDate),
        orderedAmount: num(r.OrderedAmount),
        invoicedAmount: num(r.InvoicedAmount),
        remainingAmount: Math.max(0, num(r.OrderedAmount) - num(r.InvoicedAmount)),
      }))
      .filter((r) => r.remainingAmount > 0.005);
  }, { requestTimeout: TOTALETO_TIMEOUT.sync, feed: "cash_flow_drill.po_lines" });
}
