// §41.9 — Money Spent Month reconciliation against the Total ETO report.
//
// The reference figures below are transcribed from the Total ETO pivot supplied
// 2026-08-05 ("Sum of Debit Amt / Sum of Credit Amt / Sum of Net DR/CR", July 2026).
// The transcription is self-checking: the per-job nets must sum to the pivot's own
// printed Grand Total of 420,656, and the script refuses to run if they do not. That
// guards against a misread digit silently becoming the "expected" answer.
//
// What the pivot tells us about the basis, before any code changes:
//
//   * It is an ACCOUNTING report — debits, credits, net. Credits are real and material:
//     $2,584 across 7 jobs (a return or a credit memo against a purchase).
//   * Its per-job values track the app's INVOICED-date figures, not its purchased-date
//     ones. 1104: ETO 3,574 vs app-invoiced 3,574.39 vs app-purchased 1,550.95.
//   * Where it does NOT track them, the app is enormously HIGHER, and always on jobs
//     with a large open purchase order: 1142 ETO 113,101 vs app-invoiced 1,065,713.
//
// That last point is the whole defect. `[Total Price]` in PART_PURCHASE_SQL is
// "remaining-uninvoiced-balance + everything-invoiced-to-date" — so any job carrying an
// open PO contributes the PO's entire undelivered value to a month in which it was
// merely touched. It is a point-in-time snapshot being used as a monthly flow.
//
// Run: npx tsx --tsconfig tsconfig.scripts.json scripts/parts-spent-recon.ts

import "dotenv/config";
import sql from "mssql";
import { prisma } from "@/lib/prisma";
import { PARTS_COST_SECTION } from "@/lib/sections";
import {
  getPartsCostPurchasedByJob,
  // Archived 2026-08-07 — see the note in scripts/archive/parts-spent-audit.ts.
  legacyPartsCostSpentByJobWindowed as getPartsCostSpentByJob,
} from "@/lib/sync-totaleto";
import { round2 } from "@/lib/etc";

const MONTH = "2026-07";
const monthStart = new Date(Date.UTC(2026, 6, 1));
const monthEndExclusive = new Date(Date.UTC(2026, 7, 1));

// job -> [debit, credit, net] exactly as printed.
const ETO: Record<string, [number, number, number]> = {
  "1101": [4328, 0, 4328],
  "1104": [3574, 0, 3574],
  "1106": [1994, 0, 1994],
  "1118": [2862, 0, 2862],
  "1122": [9758, 0, 9758],
  "1123": [13, 0, 13],
  "1125": [39, 0, 39],
  "1127": [8731, 1300, 7431],
  "1119": [1635, 0, 1635],
  "1129": [2232, 0, 2232],
  "1130": [79219, 7, 79211],
  "1131": [4077, 0, 4077],
  "1135": [1376, 21, 1355],
  "1142": [113101, 0, 113101],
  "1143": [5385, 0, 5385],
  "1145": [7104, 0, 7104],
  "1146": [1018, 0, 1018],
  "1132": [16, 0, 16],
  "1133": [2789, 0, 2789],
  "1134": [188, 58, 130],
  "1136": [7, 0, 7],
  "1137": [190, 8, 183],
  "1138": [347, 0, 347],
  "1139": [3266, 0, 3266],
  "1147": [562, 231, 331],
  "1148": [71899, 0, 71899],
  "1149": [1019, 0, 1019],
  "1153": [10360, 0, 10360],
  "1150": [31746, 959, 30787],
  "1154": [1096, 0, 1096],
  "1156": [3834, 0, 3834],
  "1157": [11772, 0, 11772],
  "1161": [19482, 0, 19482],
  "1162": [794, 0, 794],
  "1160": [17427, 0, 17427],
};
const ETO_PRINTED_TOTAL = { debit: 423240, credit: 2584, net: 420656 };

const usd = (n: number) =>
  (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });

// Must mirror sync-totaleto.ts's config exactly, `domain` included: without it mssql
// negotiates NTLM as the local Windows user and the server answers "Login failed for
// user '<you>'", which reads like a credentials problem and is actually a missing domain.
const config = {
  server: "SERVER-APP1.stevendouglas.local",
  database: "SDC",
  user: process.env.TOTALETO_DB_USER,
  password: process.env.TOTALETO_DB_PASSWORD,
  domain: "stevendouglas",
  port: 1433,
  options: { trustServerCertificate: true, encrypt: false },
  connectionTimeout: 15000,
  requestTimeout: 180000,
};

// The AP line amount, qualified: qty / unit price / line discount live on the DETAIL,
// while the currency rate and the document DATE live on the BATCH DOCUMENT. Getting that
// wrong is what made the first attempt fail with "Invalid column name 'APDocCurrRate'".
// SIGNED on purpose — a credit memo is a negative line, and netting it is exactly what
// the pivot's Credit column does.
const AMT = `(APDD.APDocQty * APDD.APDocUnitPrice * (1 - APDD.APDocItemPctDisc) * APBD.APDocCurrRate)`;

/**
 * CANDIDATE C — what the pivot appears to be measuring: the actual AP-document amounts
 * booked in the month, per job, net of credit memos.
 *
 * `TotalInvoicedAmount` alone, with NO uninvoiced balance added, windowed on APDocDate.
 * Signed, so a credit memo reduces the month exactly as the pivot's Credit column does.
 */
async function candidateInvoicedOnly(): Promise<{ net: Map<string, number>; debit: Map<string, number>; credit: Map<string, number> }> {
  const pool = await sql.connect(config as never);
  try {
    const r = await pool
      .request()
      .input("start", sql.DateTime, monthStart)
      .input("end", sql.DateTime, monthEndExclusive)
      .query(`
        SELECT APDD.ProjectID AS JobId,
               SUM(CASE WHEN ${"$"}{AMT} > 0 THEN ${"$"}{AMT} ELSE 0 END) AS DebitAmt,
               SUM(CASE WHEN ${"$"}{AMT} < 0 THEN -(${"$"}{AMT}) ELSE 0 END) AS CreditAmt,
               SUM(${"$"}{AMT}) AS NetAmt
          FROM tblAPDocumentDetails APDD WITH(NOLOCK)
               INNER JOIN tblAPBatchDocument APBD WITH(NOLOCK) ON APBD.APDocID = APDD.APDocID
         WHERE APBD.APDocDate >= @start AND APBD.APDocDate < @end
           AND APDD.ProjectID IS NOT NULL
         GROUP BY APDD.ProjectID`.replace(/\$\{AMT\}/g, AMT));
    const net = new Map<string, number>(), debit = new Map<string, number>(), credit = new Map<string, number>();
    for (const row of r.recordset) {
      const j = String(Number(row.JobId));
      net.set(j, Number(row.NetAmt) || 0);
      debit.set(j, Number(row.DebitAmt) || 0);
      credit.set(j, Number(row.CreditAmt) || 0);
    }
    return { net, debit, credit };
  } finally {
    await pool.close();
  }
}

async function main() {
  // ── Guard the transcription ────────────────────────────────────────────────
  const sumNet = Object.values(ETO).reduce((t, v) => t + v[2], 0);
  const sumDeb = Object.values(ETO).reduce((t, v) => t + v[0], 0);
  const sumCred = Object.values(ETO).reduce((t, v) => t + v[1], 0);
  console.log(`\n=== Total ETO reference, ${MONTH} ===`);
  console.log(`transcribed ${Object.keys(ETO).length} jobs: debit ${usd(sumDeb)}, credit ${usd(sumCred)}, net ${usd(sumNet)}`);
  console.log(`pivot printed:                debit ${usd(ETO_PRINTED_TOTAL.debit)}, credit ${usd(ETO_PRINTED_TOTAL.credit)}, net ${usd(ETO_PRINTED_TOTAL.net)}`);
  const ok = sumNet === ETO_PRINTED_TOTAL.net && sumDeb === ETO_PRINTED_TOTAL.debit && sumCred === ETO_PRINTED_TOTAL.credit;
  console.log(ok ? "transcription CHECKS OUT against the pivot's own grand total.\n" : "*** TRANSCRIPTION MISMATCH — do not trust anything below ***\n");
  if (!ok) process.exit(1);

  // ── The app's two existing bases ──────────────────────────────────────────
  const purchased = await getPartsCostPurchasedByJob(monthStart, monthEndExclusive);
  const totalPrice = await getPartsCostSpentByJob(monthStart, monthEndExclusive);
  const stored = new Map<string, number>();
  for (const e of await prisma.etcEntry.findMany({
    where: { month: MONTH, section: PARTS_COST_SECTION },
    select: { hoursWorked: true, job: { select: { jobId: true } } },
  })) stored.set(String(Number(e.job.jobId)), Number(e.hoursWorked));

  // ── The candidate ─────────────────────────────────────────────────────────
  let cand: Awaited<ReturnType<typeof candidateInvoicedOnly>> | null = null;
  try {
    cand = await candidateInvoicedOnly();
  } catch (e) {
    console.log(`[candidate C] query failed: ${(e as Error).message}\n`);
  }

  const jobs = [...new Set([...Object.keys(ETO), ...stored.keys(), ...purchased.keys(), ...totalPrice.keys()])]
    .filter((j) => ETO[j] || stored.has(j))
    .sort((a, b) => Number(a) - Number(b));

  console.log(
    "Job".padEnd(7) + "ETO net".padStart(12) + "App now".padStart(12) + "TotalPrice".padStart(13) +
    "Cand C net".padStart(13) + "C - ETO".padStart(11) + "  Note",
  );
  console.log("-".repeat(96));
  let tEto = 0, tApp = 0, tTp = 0, tC = 0, matches = 0, mismatches = 0;
  for (const j of jobs) {
    const eto = ETO[j]?.[2];
    const app = stored.get(j);
    const tp = totalPrice.get(j);
    const c = cand?.net.get(j);
    // Every total below is summed over the PIVOT'S job set only. Summing `app` over all
    // stored rows instead put $29,465 of off-pivot jobs into the comparison and made a
    // reconciled month look $29k over — the same scope mistake, twice, in two columns.
    if (eto != null) tEto += eto;
    if (app != null && eto != null) tApp += app;
    if (tp != null && eto != null) tTp += tp;
    if (c != null && eto != null) tC += c;
    const dc = eto != null && c != null ? round2(c - eto) : null;
    const notes: string[] = [];
    if (eto == null) notes.push("not in the ETO pivot");
    if (app == null && eto != null) notes.push("no stored parts row in the app");
    if (dc != null && Math.abs(dc) <= 1) { matches++; } else if (dc != null) { mismatches++; notes.push("CANDIDATE MISMATCH"); }
    console.log(
      j.padEnd(7) +
      (eto == null ? "—" : usd(eto)).padStart(12) +
      (app == null ? "—" : usd(round2(app))).padStart(12) +
      (tp == null ? "—" : usd(round2(tp))).padStart(13) +
      (c == null ? "—" : usd(round2(c))).padStart(13) +
      (dc == null ? "—" : usd(dc)).padStart(11) + "  " + notes.join("; "),
    );
  }
  console.log("-".repeat(96));
  console.log("TOTAL".padEnd(7) + usd(round2(tEto)).padStart(12) + usd(round2(tApp)).padStart(12) +
    usd(round2(tTp)).padStart(13) + usd(round2(tC)).padStart(13) + usd(round2(tC - tEto)).padStart(11));
  console.log(`\nCandidate C: ${matches} job(s) within $1 of the ETO pivot, ${mismatches} mismatch(es).`);
  console.log(`App as it stands today is ${usd(round2(tApp - tEto))} away from the ETO net across these jobs.`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
