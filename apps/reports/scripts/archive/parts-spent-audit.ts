// Money Spent Month — where the app's figure comes from, and how it differs from every
// other defensible basis for the same month (§41.1).
//
// This exists because "the app does not match the Total ETO report" has at least four
// possible causes and they need separating BEFORE any formula is changed:
//
//   1. BASIS — the app windows on POH.PurchaseDate and sums the committed PO value
//      (Qty x Price x CurrRate). The invoiced-date basis sums [Total Price] on APDocDate.
//      Those are different measures, on purpose (§30).
//   2. SCOPE — the app's purchased figure EXCLUDES Extra Costs (shipping, fees, tariffs)
//      entirely, because vwCostingExtraCostsDetailed carries no purchase date to window
//      on. If the Total ETO report includes them, the app is systematically LOWER.
//   3. STALENESS — syncPartsCost refuses to write a locked month, so a stored figure can
//      predate the §30 change or any later correction.
//   4. JOB MAPPING — a purchase whose ProjectID does not resolve to an app job is in
//      neither total, and silently.
//
// Run: npx tsx --tsconfig tsconfig.scripts.json scripts/parts-spent-audit.ts [YYYY-MM]
//
// Prints a per-job table of: stored (what the grid shows) / purchased (the app's current
// formula, re-run live) / invoiced (the other basis) / extra costs, plus the unmatched
// records nobody is counting. It CHANGES NOTHING.

import "dotenv/config";
import { prisma } from "@/lib/prisma";
import { PARTS_COST_SECTION } from "@/lib/sections";
import { etcActiveJobFilter } from "@/lib/job-filters";
import {
  getPartsCostPurchasedByJob,
  // Archived 2026-08-07: getPartsCostSpentByJob itself lost its date window when the
  // NULL-invoiced-date exclusion bug it was reproducing here got fixed for real use.
  // This alias keeps the script's original monthly-window comparison meaningful.
  legacyPartsCostSpentByJobWindowed as getPartsCostSpentByJob,
} from "@/lib/sync-totaleto";
import { round2 } from "@/lib/etc";

const month = process.argv[2] ?? "2026-07";
const [year, monthNum] = month.split("-").map(Number);
const monthStart = new Date(Date.UTC(year, monthNum - 1, 1));
const monthEndExclusive = new Date(Date.UTC(year, monthNum, 1));

const usd = (n: number) =>
  (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function main() {
  console.log(`\n=== Money Spent Month audit — ${month} ===`);
  console.log(`window: PurchaseDate >= ${monthStart.toISOString().slice(0, 10)} and < ${monthEndExclusive.toISOString().slice(0, 10)}\n`);

  // 1. What the grid currently SHOWS: the stored EtcEntry.hoursWorked on the parts row.
  const stored = await prisma.etcEntry.findMany({
    where: { month, section: PARTS_COST_SECTION },
    select: { hoursWorked: true, needsReview: true, job: { select: { jobId: true, jobName: true } } },
  });
  const storedByJob = new Map<string, number>();
  for (const e of stored) storedByJob.set(String(Number(e.job.jobId)), Number(e.hoursWorked));
  const monthLocked = stored.length > 0 && stored.every((e) => !e.needsReview);
  console.log(`stored parts rows: ${stored.length}   month locked (sync would REFUSE to rewrite): ${monthLocked}`);

  // 2. The app's current formula, re-run live. A gap against `stored` is STALENESS, not
  //    a formula problem — a different root cause with a different fix.
  const purchased = await getPartsCostPurchasedByJob(monthStart, monthEndExclusive);
  // 3. The other basis, for size comparison.
  const invoiced = await getPartsCostSpentByJob(monthStart, monthEndExclusive);

  // Which job numbers the app is willing to show at all.
  const activeJobs = await prisma.job.findMany({ where: etcActiveJobFilter, select: { jobId: true, jobName: true } });
  const activeSet = new Set(activeJobs.map((j) => String(Number(j.jobId))));
  const nameByJob = new Map(activeJobs.map((j) => [String(Number(j.jobId)), j.jobName]));

  const allJobs = [...new Set([...storedByJob.keys(), ...purchased.keys(), ...invoiced.keys()])].sort(
    (a, b) => Number(a) - Number(b),
  );

  console.log(
    `\n${"Job".padEnd(8)}${"Stored (grid)".padStart(16)}${"Purchased live".padStart(16)}${"Invoiced".padStart(16)}${"stored-purch".padStart(14)}  Note`,
  );
  console.log("-".repeat(100));

  let tStored = 0, tPurch = 0, tInv = 0, offGridPurch = 0, offGridStored = 0;
  const stale: { job: string; name: string; stored: number; live: number; drift: number }[] = [];
  for (const j of allJobs) {
    const s = storedByJob.get(j);
    const p = purchased.get(j) ?? 0;
    const i = invoiced.get(j) ?? 0;
    const inApp = activeSet.has(j);
    // Totals are ETC-GRID SCOPE ONLY, all three columns, or the comparison is
    // meaningless: `stored` has rows for jobs the grid no longer shows (a job that went
    // Complete keeps its parts row), and counting those against a purchased total that
    // excludes them manufactured a $29k "drift" that was really a scope mismatch. The
    // first version of this script had exactly that bug.
    if (inApp) {
      tPurch += p;
      tInv += i;
      if (s != null) tStored += s;
    } else {
      offGridPurch += p;
      if (s != null) offGridStored += s;
    }

    const drift = s == null ? null : round2(s - p);
    const notes: string[] = [];
    if (!inApp) notes.push("NOT an ETC job (excluded from the grid)");
    else if (s == null) notes.push("no stored parts row");
    else if (drift !== null && Math.abs(drift) >= 0.01) notes.push("STORED != live formula (stale)");
    if (Math.abs(p) < 0.01 && Math.abs(i) >= 0.01) notes.push("invoiced-only: nothing PURCHASED this month");
    if (inApp && drift !== null && Math.abs(drift) >= 0.01) {
      stale.push({ job: j, name: nameByJob.get(j) ?? "", stored: round2(s as number), live: round2(p), drift });
    }

    if (Math.abs(s ?? 0) < 0.01 && Math.abs(p) < 0.01 && Math.abs(i) < 0.01) continue;
    console.log(
      j.padEnd(8) +
        (s == null ? "—" : usd(round2(s))).padStart(16) +
        usd(round2(p)).padStart(16) +
        usd(round2(i)).padStart(16) +
        (drift == null ? "—" : usd(drift)).padStart(14) +
        "  " + (notes.join("; ") || "") + (inApp ? ` [${(nameByJob.get(j) ?? "").slice(0, 30)}]` : ""),
    );
  }

  console.log("-".repeat(100));
  console.log(`${"TOTAL".padEnd(8)}${usd(round2(tStored)).padStart(16)}${usd(round2(tPurch)).padStart(16)}${usd(round2(tInv)).padStart(16)}${usd(round2(tStored - tPurch)).padStart(14)}`);
  console.log(`\nETC-grid scope only. Off-grid (jobs the grid excludes): purchased ${usd(round2(offGridPurch))}, stored ${usd(round2(offGridStored))}`);

  // ── The check that needs no external report ─────────────────────────────────
  // A stored figure that disagrees with the app's OWN live formula is stale data rather
  // than a formula dispute: syncPartsCost refuses to write a locked month, so a month
  // that was submitted (or synced before §30 changed the basis) keeps whatever it had.
  console.log(`\njobs whose STORED value disagrees with the app's own live formula: ${stale.length}`);
  if (stale.length) {
    console.log(`${"Job".padEnd(8)}${"Stored".padStart(15)}${"Live formula".padStart(15)}${"Drift".padStart(14)}  Job name`);
    for (const r of stale.sort((a, b) => Math.abs(b.drift) - Math.abs(a.drift))) {
      console.log(r.job.padEnd(8) + usd(r.stored).padStart(15) + usd(r.live).padStart(15) + usd(r.drift).padStart(14) + "  " + r.name.slice(0, 34));
    }
    console.log(`  net drift: ${usd(round2(stale.reduce((t, r) => t + r.drift, 0)))}`);
  } else {
    console.log("  -> the grid is showing exactly what the app's formula produces. Any");
    console.log("     disagreement with Total ETO is therefore a DEFINITION difference,");
    console.log("     not stale data and not an arithmetic error.");
  }
  console.log(`\nbasis gap for the month (purchased vs invoiced): ${usd(round2(tPurch - tInv))}`);
  console.log(
    `  -> these are DIFFERENT MEASURES by design (§30). If the Total ETO report agrees with\n` +
      `     the invoiced column, the report is on the invoiced basis and the disagreement is\n` +
      `     a definition difference, not an arithmetic error.`,
  );

  // 4. Extra Costs — the documented scope exclusion, sized. This is the single most
  //    likely cause of a systematic shortfall against a report that includes them.
  await reportExtraCosts();
  await prisma.$disconnect();
}

async function reportExtraCosts() {
  const sql = (await import("mssql")).default;
  // Same connection the app's own TotalETO helpers use (sync-totaleto.ts) — the
  // credentials live in .env as TOTALETO_DB_USER / TOTALETO_DB_PASSWORD.
  const conn = {
    server: "SERVER-APP1.stevendouglas.local",
    database: "SDC",
    user: process.env.TOTALETO_DB_USER,
    password: process.env.TOTALETO_DB_PASSWORD,
    options: { encrypt: false, trustServerCertificate: true },
    requestTimeout: 120000,
  };
  if (!conn.user) {
    console.log("\n[extra costs] TOTALETO_DB_USER not set in this environment — skipped.");
    return;
  }
  try {
    const pool = await sql.connect(conn as never);
    const r = await pool
      .request()
      .input("start", sql.DateTime, monthStart)
      .input("end", sql.DateTime, monthEndExclusive)
      .query(
        `SELECT COUNT(*) AS Lines, SUM(EC.decExtraCostingValue) AS Amount
           FROM vwCostingExtraCostsDetailed EC WITH(NOLOCK)
          WHERE EC.APDocDate >= @start AND EC.APDocDate < @end`,
      );
    const row = r.recordset[0] ?? {};
    console.log(
      `\n[extra costs] EXCLUDED from the app's Money Spent Month by design (§30 scope):\n` +
        `  ${Number(row.Lines ?? 0)} line(s), ${usd(round2(Number(row.Amount ?? 0)))} on APDocDate in this month.\n` +
        `  vwCostingExtraCostsDetailed has no purchase date, so there is nothing to window it on.\n` +
        `  If the Total ETO report INCLUDES shipping/fees/tariffs, the app is short by ~this much.`,
    );
    await pool.close();
  } catch (e) {
    console.log(`\n[extra costs] query failed: ${(e as Error).message}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
