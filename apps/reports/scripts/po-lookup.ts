import "dotenv/config";
import { lookupPoAcrossJobs } from "../src/lib/po-across-jobs";

// ── What did one PO cost, across every job it touches? ───────────────────────
//
//   npx tsx -r ./scripts/shim-server-only.cjs scripts/po-lookup.ts 103046
//
// The Procurement drawer is deliberately single-job — it is built around a BOM tree,
// and a BOM tree belongs to one job — so a PO split across three jobs took three
// lookups and manual addition. That was recorded as a gap in
// docs/PARTS-COST-VARIANCE-2026-09.md §5.1; lib/po-across-jobs.ts closes it, and this
// is the way to ask it today.
//
// Read-only. Every figure comes from the ordinary parts pipeline
// (getPartsCostForJobs), not a second query, so it agrees with the Parts List by
// construction rather than by coincidence.

const usd = (n: number) =>
  (n < 0 ? "-" : "") + "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function main() {
  const po = process.argv[2];
  if (!po) {
    console.error("usage: po-lookup.ts <po number>   e.g. 103046");
    process.exitCode = 1;
    return;
  }

  const r = await lookupPoAcrossJobs(po);
  if (r.jobs.length === 0) {
    console.log(`\nPO ${r.poNumber}: no job-attributed lines found.\n`);
    return;
  }

  console.log(`\nPO ${r.poNumber} — ${r.jobs.length} job(s)${r.spansJobs ? "   ** spans jobs **" : ""}\n`);
  console.log(
    "  JOB   " + "LINES".padStart(6) + "PURCHASED".padStart(17) + "INVOICED".padStart(17) + "LEFT TO INV".padStart(15) + "  SUPPLIER",
  );
  for (const j of r.jobs) {
    // The unfloored figure is shown only when it differs, i.e. the job is
    // over-invoiced on this PO — otherwise a clean $0 would hide a real negative.
    const floorNote = Math.abs(j.leftToInvoiceRaw - j.leftToInvoice) > 0.005 ? ` (raw ${usd(j.leftToInvoiceRaw)})` : "";
    console.log(
      `  ${j.jobNumber.padEnd(6)}${String(j.lines).padStart(6)}${usd(j.purchased).padStart(17)}${usd(j.invoiced).padStart(17)}${usd(j.leftToInvoice).padStart(15)}  ${(j.suppliers[0] ?? "—").slice(0, 34)}${j.suppliers.length > 1 ? ` +${j.suppliers.length - 1}` : ""}${floorNote}`,
    );
  }
  console.log(
    `  ${"TOTAL".padEnd(6)}${String(r.totals.lines).padStart(6)}${usd(r.totals.purchased).padStart(17)}${usd(r.totals.invoiced).padStart(17)}${usd(r.totals.leftToInvoice).padStart(15)}`,
  );
  console.log("\n  Invoiced is GL-posted spend — the app's one definition of parts actual.\n");
}

main().catch((e) => {
  console.error(e?.originalError?.info?.message ?? e);
  process.exitCode = 1;
});
