// ── Parts List PO-breakdown reconciliation, any job (2026-09-10) ────────────
//
// Re-runnable proof for the one-row-per-part change. The Parts List row is one
// part and its money is the SUM of every PO that part was bought on; the part
// panel breaks that sum back out per PO. This checks that the two agree, on
// real jobs, rather than trusting that they must.
//
// Four properties, all conservation properties:
//
//   row total  vs sum(groups)   Every dollar on the row is on some PO row in the
//                               panel. The only legitimate difference is a part
//                               with NO purchases, whose Total $ is the BOM's own
//                               cost estimate — the script separates those out
//                               and reports anything left as unexplained.
//   row invcd  vs sum(groups)   Same, for invoiced money.
//   unit x qty vs group total   Each PO row self-adds, which is the thing the
//                               main table could not do before.
//   lines under two rows        A purchase line reaching two rows is only correct
//                               when both are entitled to it (two BOM rows with
//                               the same part number, each taking a share via
//                               shareOf) — which is why the total check above is
//                               the real guard, not this count.
//
// Verified 2026-09-10 on jobs 1116, 1101, 1123, 1125 and 1104: 0 unexplained
// total mismatches, 0 invoiced mismatches and 0 unit x qty failures on all five,
// with each delta equal to the cent to that job's BOM estimates on never-
// purchased parts.
//
// Usage:  npx tsx -r ./scripts/shim-server-only.cjs scripts/audit-parts-po-breakdown.ts 1116 1101

import "dotenv/config";
import { getJobBom } from "../src/lib/job-bom";
import { getJobPartsCost } from "../src/lib/sync-totaleto";
import { flattenBomParts } from "../src/lib/po-detail";

const usd = (n: number) => (n < 0 ? "-" : "") + "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const CENT = 0.005;

async function main() {
  const jobs = process.argv.slice(2);
  for (const job of jobs) {
    const [bom, pc] = await Promise.all([getJobBom(job), getJobPartsCost(job)]);
    const parts = flattenBomParts(bom, pc.lines);
    let badTotal = 0, badInv = 0, badQty = 0, dupLine = 0;
    const unexplained: string[] = [];
    const seenLineIds = new Set<string>();
    let rowsWithBreakdown = 0, groups = 0, multiPo = 0, multiLinePo = 0, datedGroups = 0;

    for (const p of parts) {
      const b = p.poBreakdown;
      if (b.length) rowsWithBreakdown++;
      groups += b.length;
      if (b.length > 1) multiPo++;
      for (const g of b) {
        if (g.lineCount > 1) multiLinePo++;
        if (g.expectedDate || g.deliveredDate) datedGroups++;
        // unit x qty must equal the group's own total.
        if (g.unitPrice !== null && Math.abs(g.unitPrice * g.qty - g.totalPrice) > CENT) badQty++;
      }
      if (Math.abs(b.reduce((s, g) => s + g.totalPrice, 0) - p.totalPrice) > CENT) {
        badTotal++;
        if (p.matchReason !== "no-purchase") unexplained.push(`${p.pn} (${p.matchReason}, ${b.length} groups)`);
      }
      if (Math.abs(b.reduce((s, g) => s + g.invoicedAmount, 0) - p.invoicedAmount) > CENT) badInv++;
    }
    // No purchase line may appear under two rows.
    for (const p of parts) for (const g of p.poBreakdown) for (const id of g.lineIds) {
      if (seenLineIds.has(id)) dupLine++;
      seenLineIds.add(id);
    }

    const jobTotal = parts.reduce((s, p) => s + p.totalPrice, 0);
    const breakdownTotal = parts.reduce((s, p) => s + p.poBreakdown.reduce((t, g) => t + g.totalPrice, 0), 0);

    console.log(`\n═══ job ${job} ═══`);
    console.log(`rows ${parts.length}  with breakdown ${rowsWithBreakdown}  PO groups ${groups}  rows on >1 PO ${multiPo}  groups with >1 line on one PO ${multiLinePo}`);
    console.log(`groups carrying expected/delivered dates from the BOM join: ${datedGroups}/${groups}`);
    console.log(`row total  vs sum(groups): mismatches ${badTotal} — of which NOT explained by "no purchase lines, so the total is the BOM estimate": ${unexplained.length}`);
    if (unexplained.length) for (const u of unexplained.slice(0, 8)) console.log("  " + u);
    const noPurchase = parts.filter((x) => x.matchReason === "no-purchase");
    console.log(`rows with no purchase lines: ${noPurchase.length}, their estimated total ${usd(noPurchase.reduce((s2, x) => s2 + x.totalPrice, 0))}`);
    console.log(`row invcd  vs sum(groups): mismatches ${badInv}`);
    console.log(`unit x qty vs group total: mismatches ${badQty}`);
    console.log(`purchase lines counted under two rows: ${dupLine}`);
    console.log(`job total ${usd(jobTotal)}   sum of every PO group ${usd(breakdownTotal)}   delta ${usd(breakdownTotal - jobTotal)}`);

    const sample = parts.filter((p) => !p.nonBom && p.poBreakdown.length >= 3 && p.poBreakdown.length <= 6).sort((a, b) => b.totalPrice - a.totalPrice)[0];
    if (sample) {
      console.log(`\nworked example — ${sample.pn}  (row: qty ${sample.qty}, total ${usd(sample.totalPrice)}, subs ${sample.lineCount - 1})`);
      const eff = sample.qty !== 0 ? sample.totalPrice / sample.qty : null;
      console.log(`  row blended unit = ${eff === null ? "—" : usd(eff)}  x qty ${sample.qty} = ${usd((eff ?? 0) * sample.qty)}`);
      console.log("  PO#        lines  qty      unit        total      invoiced   left      purchased   expected    delivered   supplier");
      for (const g of sample.poBreakdown) {
        console.log(
          `  ${String(g.poNumber ?? "—").padEnd(10)} ${String(g.lineCount).padEnd(6)} ${String(g.qty).padEnd(8)} ` +
          `${(g.unitPrice === null ? "—" : usd(g.unitPrice)).padEnd(11)} ${usd(g.totalPrice).padEnd(10)} ${usd(g.invoicedAmount).padEnd(10)} ${usd(g.leftToInvoice).padEnd(9)} ` +
          `${(g.purchaseDate ?? "—").padEnd(11)} ${(g.expectedDate?.slice(0, 10) ?? "—").padEnd(11)} ${(g.deliveredDate?.slice(0, 10) ?? "—").padEnd(11)} ${g.supplier ?? "—"}`,
        );
      }
      const s = sample.poBreakdown.reduce((a, g) => ({ q: a.q + g.qty, t: a.t + g.totalPrice, i: a.i + g.invoicedAmount }), { q: 0, t: 0, i: 0 });
      console.log(`  SUM        ${String(sample.poBreakdown.length).padEnd(6)} ${String(s.q).padEnd(8)} ${"".padEnd(11)} ${usd(s.t).padEnd(10)} ${usd(s.i)}`);
      console.log(`  row says   qty ${sample.qty}  total ${usd(sample.totalPrice)}  invoiced ${usd(sample.invoicedAmount)}`);
    }
  }
  process.exit(0);
}
main().catch((e) => { console.error("FATAL", e); process.exit(1); });
