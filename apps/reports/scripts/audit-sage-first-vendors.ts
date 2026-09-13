import "dotenv/config";
import { withTotalEto } from "../src/lib/totaleto-connection";

// ── Which vendors bill on never-exported AP documents, and how much ──────────
//
//   npx tsx -r ./scripts/shim-server-only.cjs scripts/audit-sage-first-vendors.ts
//
// ── Why this exists ─────────────────────────────────────────────────────────
//
// `APDocDoNotExport` does NOT mean "never posts to the general ledger" — it means
// "do not export this to Sage AGAIN". Some flagged documents were entered in Sage
// first, are already paid, and DO appear on the job ledger; others are corrections
// that exist only to make ETO agree with Sage and must never count as spend. The flag
// alone cannot tell them apart, so lib/sync-totaleto.ts counts a flagged document as
// posted only when it comes from a vendor on an explicit allow-list
// (SAGE_FIRST_VENDORS).
//
// An allow-list rots silently. A new card, a renamed vendor, or a second Sage-first
// arrangement would simply keep today's behaviour — excluded, understating cost —
// with nothing on screen to say so. This lists every vendor that bills on a flagged
// document so a new one SURFACES instead of waiting to be noticed in a variance
// review months later.
//
// Read-only. Verified 2026-09-04 against the August job ledger draft: the credit
// card's flagged charges appear there as GENJ journal rows, reconciling to the cent.

const usd = (n: number) =>
  (n < 0 ? "-" : "") + "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Kept in step with SAGE_FIRST_VENDORS in lib/sync-totaleto.ts — the test asserts they match. */
const ALLOWED = new Set(["SDC Credit Card", "Steven Douglas Corp. Expense Reports"]);

type Row = { CompanyID: number; CName: string; Docs: number; Lines: number; Amount: number; FirstSeen: string; LastSeen: string };

async function main() {
  const rows = await withTotalEto(async (pool) => {
    const r = await pool.request().query<Row>(`
      SELECT C.CompanyID,
             C.CName,
             COUNT(DISTINCT APBD.APDocID) AS Docs,
             COUNT(*) AS Lines,
             SUM(APDD.APDocQty * APDD.APDocUnitPrice * (1 - APDD.APDocItemPctDisc) * APBD.APDocCurrRate) AS Amount,
             CONVERT(varchar(10), MIN(APBD.APDocDate), 23) AS FirstSeen,
             CONVERT(varchar(10), MAX(APBD.APDocDate), 23) AS LastSeen
        FROM tblAPDocumentDetails APDD WITH(NOLOCK)
             INNER JOIN tblAPBatchDocument APBD WITH(NOLOCK) ON APBD.APDocID = APDD.APDocID
             LEFT JOIN tblCompany C WITH(NOLOCK) ON C.CompanyID = APBD.CompanyID
       WHERE ISNULL(APBD.APDocDoNotExport, 0) = 1
         AND APDD.ProjectID IS NOT NULL
       GROUP BY C.CompanyID, C.CName
       ORDER BY SUM(ABS(APDD.APDocQty * APDD.APDocUnitPrice * (1 - APDD.APDocItemPctDisc) * APBD.APDocCurrRate)) DESC`);
    return r.recordset;
  });

  console.log("\nVendors billing on never-exported AP documents (job-attributed lines only)\n");
  console.log(
    "  COUNTS AS SPENT  " + "ID".padEnd(7) + "DOCS".padStart(5) + "LINES".padStart(7) + "AMOUNT".padStart(16) + "  FIRST       LAST        VENDOR",
  );

  let counted = 0;
  let excluded = 0;
  for (const r of rows) {
    const name = r.CName ?? "(no vendor)";
    const on = ALLOWED.has(name);
    if (on) counted += Number(r.Amount);
    else excluded += Number(r.Amount);
    console.log(
      `  ${(on ? "     yes" : "      no").padEnd(17)}${String(r.CompanyID ?? "-").padEnd(7)}${String(r.Docs).padStart(5)}${String(r.Lines).padStart(7)}${usd(Number(r.Amount)).padStart(16)}  ${r.FirstSeen}  ${r.LastSeen}  ${name}`,
    );
  }

  console.log(`\n  counted as spent: ${usd(counted)}`);
  console.log(`  still excluded:   ${usd(excluded)}`);

  // The point of the script: a vendor nobody has classified.
  const unknown = rows.filter((r) => !ALLOWED.has(r.CName ?? "(no vendor)") && Math.abs(Number(r.Amount)) > 0);
  if (unknown.length) {
    console.log(
      `\n  ${unknown.length} vendor(s) bill on flagged documents and are NOT counted as spent.\n` +
        `  Each is either Sage-first (already paid, should count) or an ETO-side correction\n` +
        `  (must never count). Confirm with accounting before adding one to SAGE_FIRST_VENDORS,\n` +
        `  and check the job ledger for matching journal postings the way 1101's were checked.`,
    );
  }
  console.log();
}

main().catch((e) => {
  console.error(e?.originalError?.info?.message ?? e);
  process.exitCode = 1;
});
