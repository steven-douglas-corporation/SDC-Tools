import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { getPartsCostForJobs, type PartsCostLine } from "../src/lib/sync-totaleto";
import { PARTS_COST_SECTION } from "../src/lib/sections";
import {
  leftToInvoiceForLines,
  monthEndCutoff,
  explainLeftToInvoice,
  resolveLeftToInvoice,
} from "../src/lib/left-to-invoice";

// ── Why Monthly ETC's Left to Invoice and the Parts List disagree ────────────
//
//   npx tsx -r ./scripts/shim-server-only.cjs scripts/audit-left-to-invoice-parity.ts 2026-08
//
// Measures every candidate definition against the SAME rows, so the size of each
// difference is a number rather than an argument. Read-only.

const month = process.argv[2] ?? "2026-08";
const endOfMonth = (m: string) => {
  const [y, mm] = m.split("-").map(Number);
  return `${y}-${String(mm).padStart(2, "0")}-${String(new Date(y, mm, 0).getDate()).padStart(2, "0")}`;
};
const END = endOfMonth(month);
const day = (d: string | null) => (d ? d.slice(0, 10) : null);
const usd = (n: number) => (n < 0 ? "-" : "") + "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Every definition in play, over one job's lines.
const defs = {
  /** What Monthly ETC ships NOW — the shared function with this month's cutoff. */
  etcShipped: (ls: PartsCostLine[]) => leftToInvoiceForLines(ls, { asOf: monthEndCutoff(month) }),
  /** What it shipped BEFORE the fix: lifetime, no cutoff. */
  etcToday: (ls: PartsCostLine[]) => Math.max(0, ls.reduce((a, l) => a + (l.totalPrice - l.actualAmount), 0)),
  /** Same, unfloored — isolates how much the floor is doing. */
  etcUnfloored: (ls: PartsCostLine[]) => ls.reduce((a, l) => a + (l.totalPrice - l.actualAmount), 0),
  /** invoicedAmount (billed) instead of actualAmount (GL-posted). */
  billedBasis: (ls: PartsCostLine[]) => ls.reduce((a, l) => a + (l.totalPrice - l.invoicedAmount), 0),
  /** Parts List with a PURCHASE-date cutoff: drop lines purchased after month end. */
  purchaseCutoff: (ls: PartsCostLine[]) =>
    ls.filter((l) => day(l.purchaseDate) !== null && day(l.purchaseDate)! <= END).reduce((a, l) => a + (l.totalPrice - l.actualAmount), 0),
  /** Purchase cutoff AND an invoice not yet posted as of month end counts as 0. */
  asOfSnapshot: (ls: PartsCostLine[]) =>
    ls
      .filter((l) => day(l.purchaseDate) !== null && day(l.purchaseDate)! <= END)
      .reduce((a, l) => a + (l.totalPrice - (day(l.invoicedDate) !== null && day(l.invoicedDate)! <= END ? l.actualAmount : 0)), 0),
  /** Lines with NO purchase date at all — what a Parts List date filter silently drops. */
  droppedNoPurchaseDate: (ls: PartsCostLine[]) =>
    ls.filter((l) => day(l.purchaseDate) === null).reduce((a, l) => a + (l.totalPrice - l.actualAmount), 0),
  /** Lines purchased AFTER month end — leakage from the future into a closed month. */
  purchasedAfter: (ls: PartsCostLine[]) =>
    ls.filter((l) => (day(l.purchaseDate) ?? "") > END).reduce((a, l) => a + (l.totalPrice - l.actualAmount), 0),
  /** Actual posted AFTER month end against a line purchased on/before it. */
  postedAfter: (ls: PartsCostLine[]) =>
    ls
      .filter((l) => day(l.purchaseDate) !== null && day(l.purchaseDate)! <= END && (day(l.invoicedDate) ?? "") > END)
      .reduce((a, l) => a + l.actualAmount, 0),
};

async function main() {
  const entries = await prisma.etcEntry.findMany({
    where: { month, section: PARTS_COST_SECTION },
    // The three stored fields the CELL is rendered from. Added 2026-09-04: this audit
    // compared computed-against-computed and so reported parity while the screen showed
    // $10,000 against the Parts List's $35,496. See the DISPLAYED section below.
    select: { jobId: true, leftToInvoice: true, leftToPurchase: true, newEtcDraft: true, needsReview: true },
  });
  const jobs = await prisma.job.findMany({
    where: { id: { in: [...new Set(entries.map((e) => e.jobId))] } },
    select: { id: true, jobId: true, jobName: true },
  });
  const withNumbers = jobs.filter((j) => j.jobId);
  console.log(`\nMonth ${month} (cutoff ${END}) · ${withNumbers.length} Parts Cost jobs\n`);

  const byJob = await getPartsCostForJobs(withNumbers.map((j) => j.jobId));

  const totals: Record<string, number> = {};
  const rows: { job: string; name: string; lines: number; vals: Record<string, number> }[] = [];
  for (const j of withNumbers) {
    const ls = byJob.get(j.jobId) ?? [];
    const vals: Record<string, number> = {};
    for (const [k, fn] of Object.entries(defs)) {
      vals[k] = fn(ls);
      totals[k] = (totals[k] ?? 0) + vals[k];
    }
    rows.push({ job: j.jobId, name: (j.jobName ?? "").slice(0, 34), lines: ls.length, vals });
  }

  const keys = Object.keys(defs);
  console.log("TOTALS across every job");
  for (const k of keys) console.log(`  ${k.padEnd(24)} ${usd(totals[k]).padStart(16)}`);

  // THE parity check, on live data: what Monthly ETC now renders vs the Parts List
  // rule, per job and in total.
  let worstDelta = 0;
  let worstJob = "";
  for (const r of rows) {
    const d = Math.abs(r.vals.etcShipped - Math.max(0, r.vals.purchaseCutoff));
    if (d > worstDelta) { worstDelta = d; worstJob = r.job; }
  }
  const shippedTotal = rows.reduce((a, r) => a + r.vals.etcShipped, 0);
  const listTotal = rows.reduce((a, r) => a + Math.max(0, r.vals.purchaseCutoff), 0);
  console.log("");
  console.log(`PARITY: shipped Monthly ETC vs Parts List through ${END}`);
  console.log(`  Monthly ETC total ${usd(shippedTotal)}    Parts List total ${usd(listTotal)}`);
  console.log(`  worst per-job delta ${usd(worstDelta)}${worstJob ? " (job " + worstJob + ")" : ""}`);
  if (worstDelta > 0.005) {
    const x = explainLeftToInvoice(byJob.get(worstJob) ?? [], { asOf: monthEndCutoff(month) });
    console.log(`  job ${worstJob}: raw ${usd(x.raw)}, floored ${usd(x.total)}, ${x.linesIncluded} in / ${x.linesExcluded} out`);
    for (const e of x.excludedByCutoff.slice(0, 5)) console.log(`    excluded PO ${e.poNumber} ${e.partNumber} ${e.purchaseDate} ${usd(e.amount)}`);
  }
  console.log("");

  // Which jobs the aggregate floor actually bites on, and which carry postings dated
  // after the cutoff. These are the two documented remaining differences; naming the
  // jobs is the difference between a caveat and a fact.
  const negative = rows.filter((r) => r.vals.purchaseCutoff < -0.005);
  console.log(`FLOOR: ${negative.length} job(s) sit below zero before flooring`);
  for (const r of negative) {
    console.log(`  job ${r.job.padEnd(6)} raw ${usd(r.vals.purchaseCutoff).padStart(14)} -> shown ${usd(r.vals.etcShipped).padStart(12)}   ${r.name}`);
  }
  console.log(`  total floor effect ${usd(negative.reduce((a, r) => a - r.vals.purchaseCutoff, 0))}`);

  const drifting = rows
    .map((r) => ({ ...r, late: r.vals.asOfSnapshot - r.vals.purchaseCutoff }))
    .filter((r) => Math.abs(r.late) > 0.005)
    .sort((a, b) => b.late - a.late);
  console.log(`
DRIFT: ${drifting.length} job(s) have GL postings dated after ${END}`);
  for (const r of drifting.slice(0, 8)) {
    console.log(`  job ${r.job.padEnd(6)} shown ${usd(r.vals.etcShipped).padStart(14)}  frozen ${usd(Math.max(0, r.vals.asOfSnapshot)).padStart(14)}  late postings ${usd(r.late).padStart(13)}   ${r.name}`);
  }
  console.log("");

  // ── DISPLAYED vs COMPUTED — the check this audit was missing ─────────────
  //
  // Everything above compares two CALCULATIONS. They agree, and have since
  // 2026-09-03. What the 2026-09-04 report photographed is a different thing: the
  // grid's Left to Invoice column does not render the calculation. It renders the
  // manager's stored figure, or a pre-breakout hand-typed New ETC carried into the
  // cell, and the computed figure appears only in an empty cell's tooltip.
  //
  // So an audit that measures rows against rows keeps reporting parity while the
  // screen disagrees with the Parts List by any amount at all. This is the table the
  // report asked for — Job / Parts List / Monthly ETC / Difference — read from what
  // the column actually shows, plus the reason each figure is what it is.
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const dec = (v: unknown) => (v == null ? null : round2(Number(v)));
  const shownByJob = new Map<number, { leftToInvoice: number | null; leftToPurchase: number | null; newEtcDraft: number | null }>();
  const submittedByJob = new Map<number, boolean>();
  for (const e of entries) {
    const stored = {
      leftToInvoice: dec(e.leftToInvoice),
      leftToPurchase: dec(e.leftToPurchase),
      newEtcDraft: dec(e.newEtcDraft),
    };
    // The SAME function the grid and the save render the cell from, so this cannot
    // report a figure the screen does not show.
    // The SAME resolution the grid and the submission use, so this cannot report a
    // figure the screen does not show. `computed` is filled in per job below.
    shownByJob.set(e.jobId, stored);
    submittedByJob.set(e.jobId, !e.needsReview);
  }

  console.log("");
  console.log(`DISPLAYED: what the Monthly ETC column shows vs the Parts List through ${END}`);
  console.log(`  ${"job".padEnd(7)}${"Parts List".padStart(15)}${"Monthly ETC".padStart(15)}${"difference".padStart(15)}  source`);
  let shownTotal = 0;
  let listTotalShown = 0;
  const mismatches: { job: string; name: string; list: number; shown: number | null; source: string }[] = [];
  for (const j of withNumbers) {
    // RAW, not floored: the cell shows the signed figure now, which is exactly what the
    // Parts List column sums. See lib/left-to-invoice.ts.
    const list = round2(defs.purchaseCutoff(byJob.get(j.jobId) ?? []));
    const stored = shownByJob.get(j.id);
    const r = stored
      ? resolveLeftToInvoice({
          // The batched query succeeded, so a job with no lines genuinely has $0
          // on order — not "unknown". Null is reserved for an upstream failure.
          computed: list,
          stored: stored.leftToInvoice,
        })
      : { value: null, source: "no-entry" as const };
    const s = { shown: r.value, source: r.source };
    listTotalShown += list;
    shownTotal += s.shown ?? 0;
    const diff = (s.shown ?? 0) - list;
    if (s.shown !== null && Math.abs(diff) > 0.005) {
      mismatches.push({ job: j.jobId, name: (j.jobName ?? "").slice(0, 30), list, shown: s.shown, source: s.source });
    }
    console.log(
      `  ${j.jobId.padEnd(7)}${usd(list).padStart(15)}` +
        `${(s.shown === null ? "(blank)" : usd(s.shown)).padStart(15)}${usd(diff).padStart(15)}  ${s.source}`,
    );
  }
  console.log(`  ${"TOTAL".padEnd(7)}${usd(listTotalShown).padStart(15)}${usd(shownTotal).padStart(15)}${usd(shownTotal - listTotalShown).padStart(15)}`);
  console.log("");
  // A blank cell is deliberately NOT counted as a mismatch: it reconciles by
  // construction, because the computed figure is exactly what its tooltip offers.
  console.log(`  ${mismatches.length} of ${withNumbers.length} jobs show a figure that does not reconcile`);
  const bySource: Record<string, { n: number; amount: number }> = {};
  for (const m of mismatches) {
    const b = (bySource[m.source] ??= { n: 0, amount: 0 });
    b.n++;
    b.amount += (m.shown ?? 0) - m.list;
  }
  for (const [k, v] of Object.entries(bySource)) {
    console.log(`    ${String(v.n).padStart(3)} ${k.padEnd(18)} ${usd(v.amount).padStart(16)}`);
  }

  // The contributing rows for the worst offender: part / PO / cost / posted / left /
  // date / included, so a mismatch is traceable rather than re-derived by hand.
  const worstShown = mismatches.sort((a, b) => Math.abs((b.shown ?? 0) - b.list) - Math.abs((a.shown ?? 0) - a.list))[0];
  if (worstShown) {
    console.log("");
    console.log(
      `  worst: job ${worstShown.job} ${worstShown.name} — shows ${usd(worstShown.shown ?? 0)} (${worstShown.source}), Parts List ${usd(worstShown.list)}`,
    );
    const ls = byJob.get(worstShown.job) ?? [];
    const x = explainLeftToInvoice(ls, { asOf: monthEndCutoff(month) });
    console.log(`    ${x.linesIncluded} lines included, ${x.linesExcluded} excluded by the cutoff, raw ${usd(x.raw)}`);
    console.log(
      `    ${"part".padEnd(20)}${"PO".padEnd(12)}${"total".padStart(13)}${"posted".padStart(13)}${"left".padStart(13)}  purchased   invoiced`,
    );
    for (const l of ls
      .slice()
      .sort((a, b) => Math.abs(b.totalPrice - b.actualAmount) - Math.abs(a.totalPrice - a.actualAmount))
      .slice(0, 12)) {
      const purchased = day(l.purchaseDate);
      const included = purchased === null || purchased <= END;
      console.log(
        `    ${(l.partNumber ?? "-").slice(0, 19).padEnd(20)}${(l.poNumber ?? "-").slice(0, 11).padEnd(12)}` +
          `${usd(l.totalPrice).padStart(13)}${usd(l.actualAmount).padStart(13)}${usd(l.totalPrice - l.actualAmount).padStart(13)}` +
          `  ${(purchased ?? "-").padEnd(12)}${(day(l.invoicedDate) ?? "-").padEnd(11)}${included ? "" : "EXCLUDED (after cutoff)"}`,
      );
    }
  }

  const gap = totals.etcToday - totals.purchaseCutoff;
  console.log(`\n  etcToday − purchaseCutoff = ${usd(gap)}`);
  console.log(`  of which purchased after ${END}: ${usd(totals.purchasedAfter)}`);
  console.log(`  lines with no purchase date at all: ${usd(totals.droppedNoPurchaseDate)}`);
  console.log(`  actual posted after ${END} on lines purchased before it: ${usd(totals.postedAfter)}`);
  console.log(`  floor effect (etcToday − etcUnfloored): ${usd(totals.etcToday - totals.etcUnfloored)}`);
  console.log(`  basis effect (billed − GL-posted): ${usd(totals.billedBasis - totals.etcUnfloored)}`);

  const moved = rows
    .map((r) => ({ ...r, d: r.vals.etcToday - r.vals.purchaseCutoff }))
    .filter((r) => Math.abs(r.d) > 0.005)
    .sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
  console.log(`\n${moved.length} of ${rows.length} jobs move. Largest 15:\n`);
  console.log(
    "  JOB   LINES  " + "etcToday".padStart(14) + "purchaseCut".padStart(15) + "asOfSnapshot".padStart(15) + "diff".padStart(14) + "  NAME",
  );
  for (const r of moved.slice(0, 15)) {
    console.log(
      `  ${r.job.padEnd(6)}${String(r.lines).padStart(5)}  ${usd(r.vals.etcToday).padStart(14)}${usd(r.vals.purchaseCutoff).padStart(15)}${usd(r.vals.asOfSnapshot).padStart(15)}${usd(r.d).padStart(14)}  ${r.name}`,
    );
  }

  // The offending rows themselves, for the worst job — so a mismatch names lines.
  const worst = moved[0];
  if (worst) {
    const ls = byJob.get(worst.job) ?? [];
    const bad = ls.filter((l) => day(l.purchaseDate) === null || day(l.purchaseDate)! > END);
    console.log(`\nJob ${worst.job}: ${bad.length} line(s) excluded by the ${END} purchase cutoff\n`);
    for (const l of bad.slice(0, 12)) {
      console.log(
        `  PO ${String(l.poNumber ?? "—").padEnd(12)} ${String(l.partNumber ?? "—").padEnd(22)} purch=${String(day(l.purchaseDate) ?? "(none)").padEnd(12)} inv=${String(day(l.invoicedDate) ?? "(none)").padEnd(12)} total=${usd(l.totalPrice).padStart(13)} actual=${usd(l.actualAmount).padStart(13)}`,
      );
    }
  }
  console.log();
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
