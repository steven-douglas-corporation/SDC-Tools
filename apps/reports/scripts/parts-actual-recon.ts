import "dotenv/config";
import sql from "mssql";
import { prisma } from "../src/lib/prisma";
import { getPartsActualByJob, getPartsCostSpentByJob } from "../src/lib/sync-totaleto";

// ── Parts Actual reconciliation, every job (2026-08-10) ──────────────────────
//
// Re-runnable proof for the Parts Actual fix. Reported: job 1116 showed a
// ~$400K Parts Cost actual/projection against a job ledger of ~$340K on a ~$300K
// budget.
//
// Ledger truth for 1116, as of 7/31/26, is $349,732.10 net — derived from Lisa's
// own export by scripts/_analyze_1116_ledger.ts and deliberately NOT hardcoded in
// app code. This script does not use it either; it reconciles the app against the
// SOURCE the ledger is built from, which is what generalises.
//
// Columns:
//   APP ACTUAL     Job.costActualHistorical — what the Projects grid, exports and
//                  job detail page actually show. Written by syncPartsCostActual.
//   SOURCE ACTUAL  getPartsActualByJob() — net AP-document amount posted to the
//                  general ledger. The app's one definition of Parts Actual.
//   OLD BASIS      getPartsCostSpentByJob() — SUM([Total Price]), what the column
//                  used to be filled from. Kept in the report so the size of the
//                  correction stays visible after the fix lands.
//
// A job whose APP and SOURCE agree is reconciled. Anything else is itemised with
// the difference decomposed into the two root causes.
//
// Usage:  npx tsx scripts/parts-actual-recon.ts
//         npx tsx scripts/parts-actual-recon.ts --job 1116
//         npx tsx scripts/parts-actual-recon.ts --mismatches
//         npx tsx scripts/parts-actual-recon.ts --csv > recon.csv

const config: sql.config = {
  server: "SERVER-APP1.stevendouglas.local",
  database: "SDC",
  user: process.env.TOTALETO_DB_USER,
  password: process.env.TOTALETO_DB_PASSWORD,
  domain: "stevendouglas",
  options: { encrypt: false, trustServerCertificate: true },
};

const AMT = "(APDD.APDocQty * APDD.APDocUnitPrice * (1 - APDD.APDocItemPctDisc) * APBD.APDocCurrRate)";

const money = (n: number) =>
  (n < 0 ? "-" : "") + "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

type Row = {
  jobId: string;
  jobName: string | null;
  appActual: number | null;
  sourceActual: number;
  oldBasis: number | null;
  openPo: number;
  doNotExport: number;
  inTotalEto: boolean;
};

async function main() {
  const args = process.argv.slice(2);
  const onlyJob = args.includes("--job") ? args[args.indexOf("--job") + 1] : null;
  const onlyMismatches = args.includes("--mismatches");
  const asCsv = args.includes("--csv");

  // The raw diagnostic queries run FIRST, on their own pool, and the two library
  // functions afterwards. `mssql`'s sql.connect() hands back a GLOBAL pool and
  // both library functions close it when they finish — so calling them while this
  // script still holds `pool` fails the next request with "Connection is closed".
  // Same hazard the note on getPartsInvoicedByJob describes.
  const pool = await sql.connect({ ...config, requestTimeout: 300000 });
  let doNotExportRaw: Map<string, number>;
  let openPoRaw: Map<string, number>;
  try {
    // Root cause 2, isolated: AP lines flagged never-to-post-to-the-GL.
    const dneRes = await pool.request().query(`
      SELECT APDD.ProjectID AS JobId, SUM(${AMT}) AS Amt
        FROM tblAPDocumentDetails APDD WITH(NOLOCK)
             INNER JOIN tblAPBatchDocument APBD WITH(NOLOCK) ON APBD.APDocID = APDD.APDocID
       WHERE APDD.ProjectID IS NOT NULL AND ISNULL(APBD.APDocDoNotExport, 0) = 1
       GROUP BY APDD.ProjectID
    `);
    const doNotExport = new Map<string, number>();
    for (const r of dneRes.recordset) doNotExport.set(String(Number(r.JobId)), Number(r.Amt) || 0);

    // Root cause 1, isolated: uninvoiced open-PO commitment, computed with
    // PART_PURCHASE_SQL's own remaining-balance expression so it is the same
    // arithmetic the app used to ship as "actual".
    const openRes = await pool.request().query(`
      SELECT P.ProjectID AS JobId, SUM(
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
        END) AS OpenPo
        FROM tblPurchaseOrderHeader POH WITH(NOLOCK)
             INNER JOIN tblPurchaseOrderDetails POD WITH(NOLOCK) ON POH.PurchaseOrderID = POD.PurchaseOrderID
             LEFT JOIN tblSpec S WITH(NOLOCK) ON S.SpecID = POD.SpecID AND S.ProjectID = POD.ProjectID
             LEFT JOIN tblProjects P WITH(NOLOCK) ON S.ProjectID = P.ProjectID
             LEFT JOIN ( SELECT APDD.PurchaseDetailID, SUM(APDD.APDocQty) AS InvoicedQty
                           FROM tblAPDocumentDetails APDD WITH(NOLOCK)
                                INNER JOIN tblAPBatchDocument APBD WITH(NOLOCK) ON APBD.APDocID = APDD.APDocID
                          WHERE APBD.BatchEntryTypeID NOT IN (2,3) AND APDD.PurchaseDetailID IS NOT NULL
                          GROUP BY APDD.PurchaseDetailID ) INV ON INV.PurchaseDetailID = POD.PurchaseDetailID
             LEFT JOIN vwReceiverLogSummed RLS WITH(NOLOCK) ON RLS.PurchaseDetailID = POD.PurchaseDetailID
       WHERE P.ProjectID IS NOT NULL
       GROUP BY P.ProjectID
    `);
    const openPo = new Map<string, number>();
    for (const r of openRes.recordset) openPo.set(String(Number(r.JobId)), Number(r.OpenPo) || 0);
    doNotExportRaw = doNotExport;
    openPoRaw = openPo;
  } finally {
    await pool.close();
  }

  const doNotExport = doNotExportRaw;
  const openPo = openPoRaw;
  const [sourceActual, oldBasis] = [await getPartsActualByJob(), await getPartsCostSpentByJob()];

  try {
    const jobs = await prisma.job.findMany({
      where: { type: { not: null } },
      select: { jobId: true, jobName: true, costActualHistorical: true },
      orderBy: { jobId: "asc" },
    });

    const rows: Row[] = [];
    for (const j of jobs) {
      if (onlyJob && j.jobId !== onlyJob) continue;
      const inTotalEto = sourceActual.has(j.jobId) || oldBasis.has(j.jobId);
      rows.push({
        jobId: j.jobId,
        jobName: j.jobName,
        appActual: j.costActualHistorical == null ? null : Number(j.costActualHistorical),
        sourceActual: sourceActual.get(j.jobId) ?? 0,
        oldBasis: oldBasis.get(j.jobId) ?? null,
        openPo: openPo.get(j.jobId) ?? 0,
        doNotExport: doNotExport.get(j.jobId) ?? 0,
        inTotalEto,
      });
    }

    const tracked = rows.filter((r) => r.inTotalEto);
    const legacy = rows.filter((r) => !r.inTotalEto && r.appActual != null);

    if (asCsv) {
      console.log("Job,App Actual,Source Actual,Difference,Old Basis,Open PO Commitment,Never Posted To GL,Root Cause");
      for (const r of tracked) {
        const diff = (r.appActual ?? 0) - r.sourceActual;
        console.log(
          [
            r.jobId,
            r.appActual ?? "",
            r.sourceActual.toFixed(2),
            diff.toFixed(2),
            r.oldBasis?.toFixed(2) ?? "",
            r.openPo.toFixed(2),
            r.doNotExport.toFixed(2),
            JSON.stringify(rootCause(r)),
          ].join(","),
        );
      }
      return;
    }

    console.log("=== Parts Actual: app vs source (GL-posted AP), all TotalETO-tracked jobs ===\n");
    console.log(
      "Job".padEnd(7) +
        "App Actual".padStart(15) +
        "Source Actual".padStart(16) +
        "Difference".padStart(14) +
        "Old Basis".padStart(16) +
        "  Root Cause",
    );
    console.log("-".repeat(130));

    let mismatches = 0;
    let tApp = 0;
    let tSrc = 0;
    let tOld = 0;
    for (const r of tracked) {
      const app = r.appActual ?? 0;
      const diff = app - r.sourceActual;
      tApp += app;
      tSrc += r.sourceActual;
      tOld += r.oldBasis ?? 0;
      const material = Math.abs(diff) >= 0.01;
      if (material) mismatches++;
      if (onlyMismatches && !material) continue;
      console.log(
        r.jobId.padEnd(7) +
          money(app).padStart(15) +
          money(r.sourceActual).padStart(16) +
          money(diff).padStart(14) +
          money(r.oldBasis ?? 0).padStart(16) +
          "  " +
          rootCause(r),
      );
    }
    console.log("-".repeat(130));
    console.log(
      "TOTAL".padEnd(7) + money(tApp).padStart(15) + money(tSrc).padStart(16) + money(tApp - tSrc).padStart(14) + money(tOld).padStart(16),
    );

    console.log(`\nTotalETO-tracked jobs compared : ${tracked.length}`);
    console.log(`  reconciled to the cent        : ${tracked.length - mismatches}`);
    console.log(`  still mismatched              : ${mismatches}`);
    console.log(`\nCorrection this fix applies (old basis -> source): ${money(tOld - tSrc)}`);

    // Jobs the app carries a figure for that TotalETO has never heard of. NOT a
    // mismatch and NOT something the sync may touch: TotalETO's AP history starts
    // 2024-10-30, and these jobs' actuals were entered by hand before that.
    const legacyTotal = legacy.reduce((s, r) => s + (r.appActual ?? 0), 0);
    console.log(`\n=== Outside TotalETO's coverage — left untouched by design ===`);
    console.log(`  jobs: ${legacy.length}, carrying ${money(legacyTotal)} of manually-entered historical actuals`);
    console.log(`  (TotalETO AP history begins 2024-10-30; syncPartsCostActual iterates the SOURCE map,`);
    console.log(`   so a job TotalETO has no record of is never written and never zeroed.)`);
  } finally {
    await prisma.$disconnect();
  }
}

function rootCause(r: Row): string {
  const app = r.appActual ?? 0;
  const diff = app - r.sourceActual;
  if (r.appActual == null) return r.sourceActual === 0 ? "no parts activity" : "app has no stored actual — run the sync";
  if (Math.abs(diff) < 0.01) return "reconciled";
  const parts: string[] = [];
  if (Math.abs(r.openPo) >= 1) parts.push(`open-PO commitment ${money(r.openPo)}`);
  if (Math.abs(r.doNotExport) >= 1) parts.push(`never posted to GL ${money(r.doNotExport)}`);
  const unexplained = diff - r.openPo - r.doNotExport;
  if (Math.abs(unexplained) >= 1) parts.push(`unexplained ${money(unexplained)}`);
  return parts.length ? `STALE — ${parts.join("; ")}` : "STALE — re-run the sync";
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
