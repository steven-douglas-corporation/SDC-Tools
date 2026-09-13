import "dotenv/config";
import { getPartsCostBookedByJob, getJobPartsInvoicedInMonth, getApLineCountByJob } from "../src/lib/sync-totaleto";
import { getJobBom } from "../src/lib/job-bom";
import { attributeInvoicedWindow, normPn } from "../src/lib/parts-cost-window-attribution";

// ── Permanent reconciliation check: "monthly invoiced parts" agrees everywhere (§82) ──
//
// Reported: Monthly ETC's Parts Spent drill showed job 1122 at $12,167/47 lines for
// August 2026, while Job Hour Details -> Parts List (Invoiced, same month) showed a
// smaller total. Investigated live: getPartsCostBookedByJob (the Money Spent Month
// source) and getJobPartsInvoicedInMonth (the drill AND the Parts List window both
// call this one function) already agreed to the cent for that job/month — the two
// screens were not looking at two different queries, they were looking at the SAME
// query's output at two different moments/states. What WAS a real gap: that function
// had its own hand-typed copy of the AP-line-amount formula instead of referencing
// this file's one AP_LINE_AMOUNT constant every other AP-document query already
// shares — fixed alongside this script, so the four queries can no longer drift by
// someone editing one copy and not the others.
//
// This script is the permanent guard against that regressing, or a future query
// disagreeing for a job/month nobody happened to test by hand. It re-derives the job
// list from the live data itself (getPartsCostBookedByJob's own result), never from a
// hardcoded job or month, per the requirement that this hold for every job and every
// month.
//
// Usage:
//   npx tsx scripts/verify-parts-invoiced-reconciliation.ts                  # last 3 months, every job with parts activity
//   npx tsx scripts/verify-parts-invoiced-reconciliation.ts --months 6
//   npx tsx scripts/verify-parts-invoiced-reconciliation.ts --month 2026-08
//   npx tsx scripts/verify-parts-invoiced-reconciliation.ts --month 2026-08 --job 1122
//   npx tsx scripts/verify-parts-invoiced-reconciliation.ts --full           # also re-derives the Parts List attribution per job (fetches each job's live BOM — much slower)
//   npx tsx scripts/verify-parts-invoiced-reconciliation.ts --quiet          # print only mismatches and the summary

const money = (n: number) =>
  (n < 0 ? "-" : "") + "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const CENT = 0.01;

let checks = 0;
let failures = 0;
function check(ok: boolean, label: string, detail = "") {
  checks++;
  if (ok) {
    if (!quiet) console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// UTC month arithmetic only — same convention lib/etc.ts's monthWindowUtc uses, so a
// month computed here can never disagree with the one the app itself windows on.
function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
function monthWindow(month: string): { start: Date; endExclusive: Date } {
  const [y, m] = month.split("-").map(Number);
  return { start: new Date(Date.UTC(y, m - 1, 1)), endExclusive: new Date(Date.UTC(y, m, 1)) };
}
function priorMonths(n: number): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = 0; i < n; i++) {
    out.push(monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))));
  }
  return out;
}

let quiet = false;

async function verifyMonth(month: string, onlyJob: string | null, full: boolean) {
  const { start, endExclusive } = monthWindow(month);
  console.log(`\n${"═".repeat(78)}\n${month}\n${"═".repeat(78)}`);

  // The bulk query IS the job list — never a hardcoded roster. Every job this
  // reconciliation checks is a job that actually booked AP-document activity in
  // this exact month, straight from the same source Money Spent Month reads.
  const [booked, rawCounts] = await Promise.all([
    getPartsCostBookedByJob(start, endExclusive),
    getApLineCountByJob(start, endExclusive),
  ]);
  const jobs = [...booked.net.keys()].filter((j) => !onlyJob || j === onlyJob).sort((a, b) => Number(a) - Number(b));

  if (jobs.length === 0) {
    console.log(onlyJob ? `  (job ${onlyJob} had no booked AP activity this month — nothing to compare)` : "  (no jobs booked AP activity this month)");
    return;
  }

  for (const jobId of jobs) {
    const bookedNet = booked.net.get(jobId) ?? 0;
    const invoiced = await getJobPartsInvoicedInMonth(jobId, start, endExclusive);
    const rawTotal = invoiced.lines.reduce((s, l) => s + l.invoicedAmount, 0);

    // 1. Money Spent Month (getPartsCostBookedByJob) === the drill/Parts-List-window
    //    source (getJobPartsInvoicedInMonth), the reconciliation rule the task
    //    states outright: these are two different queries by necessity (one is a
    //    single bulk pass for the sync, one is per-job with line detail for a
    //    drill), so this is the check that actually catches them drifting apart.
    check(
      Math.abs(bookedNet - rawTotal) < CENT,
      `job ${jobId}: Money Spent Month === Parts Spent drill total`,
      `booked ${money(bookedNet)} vs drill ${money(rawTotal)} (${invoiced.lines.length} lines)`,
    );

    // 2. Line count never EXCEEDS the join-free baseline — catches a LEFT JOIN
    //    in getJobPartsInvoicedInMonth's enrichment chain (to the PO/item-
    //    master/category tables) fanning one real AP line out into several
    //    rows. Not equality: `invoiced.lines` already has exactly-zero-amount
    //    rows filtered out (see that function's own `meaningful` filter), so a
    //    job with a genuine $0 line legitimately reports fewer lines than the
    //    raw count — only MORE than it is impossible without a fan-out.
    //
    //    A naive "no two lines share the same PO+part+date+amount" check LOOKS
    //    like it would catch a fan-out and does not: two separate, legitimate
    //    AP documents can share every one of those fields (found live: job
    //    1142, 2026-08-01, two distinct invoices each for 64 x KQ2L04-M5A @
    //    $1.30, different APDocID/APDocDetailID), which made that check fail
    //    on real, correct data. Row count against a join-free query is the
    //    actual test for row-multiplying joins.
    const rawCount = rawCounts.get(jobId) ?? 0;
    check(
      invoiced.lines.length <= rawCount,
      `job ${jobId}: line count does not exceed the join-free AP-document baseline`,
      `${invoiced.lines.length} lines vs ${rawCount} raw AP-document rows`,
    );

    // 3. --full: the Parts List's own reconciliation — attach-by-part-number plus
    //    the unattached remainder must sum back to the exact same raw total. This
    //    is a mathematical property of attributeInvoicedWindow (every input line
    //    goes to exactly one bucket) rather than something that depends on the
    //    BOM's shape, but it's the one link in the chain that isn't exercised by
    //    checks 1-2, and it is what Job Hour Details -> Parts List actually shows
    //    on screen — so it is worth the extra live BOM fetch when asked for.
    if (full) {
      const bom = await getJobBom(jobId);
      const bomPartNumbers = new Set<string>();
      const walk = (node: (typeof bom.roots)[number]) => {
        for (const p of node.parts) bomPartNumbers.add(normPn(p.pn));
        for (const c of node.children) walk(c);
      };
      for (const section of bom.roots) {
        for (const p of section.parts) bomPartNumbers.add(normPn(p.pn));
        walk(section);
      }
      const attribution = attributeInvoicedWindow(invoiced.lines, bomPartNumbers);
      const attachedTotal = [...attribution.byPartNumber.values()].reduce((s, v) => s + v, 0);
      check(
        Math.abs(attachedTotal + attribution.unattachedAmount - rawTotal) < CENT,
        `job ${jobId}: Parts List attribution (attached + unattached) === drill total`,
        `attached ${money(attachedTotal)} + unattached ${money(attribution.unattachedAmount)} vs ${money(rawTotal)}`,
      );
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (name: string) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : null);
  const onlyMonth = arg("month");
  const onlyJob = arg("job");
  const full = args.includes("--full");
  quiet = args.includes("--quiet");
  const monthCount = onlyMonth ? 1 : Number(arg("months") ?? 3);

  const months = onlyMonth ? [onlyMonth] : priorMonths(monthCount);
  for (const month of months) await verifyMonth(month, onlyJob, full);

  console.log(`\n${checks} check(s), ${failures} failure(s)${full ? "" : " (pass --full to also re-check the Parts List attribution)"}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
