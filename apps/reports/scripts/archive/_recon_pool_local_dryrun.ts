// Dry run of the new local pool computation — no writes.
//
// Checks three things before anything touches the live ledger:
//  1) poolCategoryForPunch actually buckets punches (PM and both Warranty pools
//     had NO hours at all before, because those codes never got imported).
//  2) The computed Hours Worked is in line with the archived months' stored
//     figures, which came from Power BI's [Hours Actual by ETC Period].
//  3) What the live month's four blocks would become.
//
// Run: npx tsx scripts/_recon_pool_local_dryrun.ts
import "dotenv/config";
import { prisma } from "@/lib/prisma";
import { fetchJobHoursRowsWithIssues } from "@/lib/job-hours-source";
import { POOL_CATEGORIES, POOL_QUOTED_SECTION, type PoolCategory } from "@/lib/sections";
import { VALID_JOB_TYPES } from "@/lib/job-filters";
import { round2 } from "@/lib/etc";

// Mirrors standard-pool-local.ts's quotedHoursEnteringMonth. Duplicated rather
// than imported because that module is "server-only" and a plain tsx script
// cannot load it.
async function quotedHoursEnteringMonth(month: string): Promise<Record<PoolCategory, number>> {
  const jobs = await prisma.job.findMany({
    where: { type: { in: [...VALID_JOB_TYPES] }, startDate: { not: null } },
    select: { id: true, startDate: true },
  });
  const monthOf = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  const entering = jobs.filter((j) => j.startDate && monthOf(j.startDate) === month).map((j) => j.id);
  const out = Object.fromEntries(POOL_CATEGORIES.map((c) => [c, 0])) as Record<PoolCategory, number>;
  if (entering.length === 0) return out;
  const est = await prisma.estimatedHours.findMany({
    where: { jobId: { in: entering }, section: { in: Object.values(POOL_QUOTED_SECTION) } },
    select: { section: true, quotedHours: true },
  });
  for (const c of POOL_CATEGORIES) {
    out[c] = round2(est.filter((e) => e.section === POOL_QUOTED_SECTION[c]).reduce((s, e) => s + Number(e.quotedHours), 0));
  }
  return out;
}

const LIVE_MONTH = "2026-07";

async function main() {
  const { poolHours } = await fetchJobHoursRowsWithIssues();

  console.log("\n=== 1) Punch hours per pool, by month (was: only SHOP_MANUFACTURING existed) ===");
  const months = [...new Set([...poolHours.keys()].map((k) => k.split("::")[0]))].sort();
  console.log("month     " + POOL_CATEGORIES.map((c) => c.padStart(21)).join(""));
  for (const m of months) {
    console.log(
      `${m}   ` + POOL_CATEGORIES.map((c) => (poolHours.get(`${m}::${c}`) ?? 0).toFixed(2).padStart(21)).join(""),
    );
  }

  console.log("\n=== 2) Computed Hours Worked vs the stored (Power BI) figure ===");
  const pools = await prisma.categoryPool.findMany({ orderBy: [{ month: "asc" }, { category: "asc" }] });
  console.log("month    category                 stored   computed     delta");
  for (const p of pools) {
    const computed = round2(poolHours.get(`${p.month}::${p.category}`) ?? 0);
    const stored = Number(p.hoursWorkedThisMonth);
    console.log(
      `${p.month}  ${p.category.padEnd(22)} ${stored.toFixed(2).padStart(8)} ${computed.toFixed(2).padStart(10)} ${(computed - stored).toFixed(2).padStart(9)}`,
    );
  }

  console.log(`\n=== 3) What ${LIVE_MONTH} would become ===`);
  const prior = await prisma.categoryPool.findMany({ where: { month: "2026-06" } });
  const priorBy = new Map(prior.map((p) => [p.category, p]));
  const newAdded = await quotedHoursEnteringMonth(LIVE_MONTH);
  const existing = await prisma.categoryPool.findMany({ where: { month: LIVE_MONTH } });
  const existingBy = new Map(existing.map((p) => [p.category, p]));

  console.log("category                prevPulled  newAdded  available   worked   pulled    newEtc     rate         fee");
  let grand = 0;
  for (const c of POOL_CATEGORIES) {
    const pr = priorBy.get(c);
    const prevPulled = pr ? Number(pr.newEtcHours) : 0;
    const added = newAdded[c];
    const available = round2(prevPulled + added);
    const worked = round2(poolHours.get(`${LIVE_MONTH}::${c}`) ?? 0);
    const ex = existingBy.get(c);
    const pulled = ex ? Number(ex.hoursPulledThisMonth) : c === "ENGINEERING_PM" ? 450 : worked;
    const rate = ex ? Number(ex.rate) : pr ? Number(pr.rate) : c.startsWith("ENGINEERING") ? 170 : 140;
    const newEtc = round2(available - pulled);
    const fee = round2(newEtc * rate);
    grand += fee;
    console.log(
      `${c.padEnd(22)} ${prevPulled.toFixed(2).padStart(10)} ${added.toFixed(2).padStart(9)} ${available.toFixed(2).padStart(10)} ` +
        `${worked.toFixed(2).padStart(8)} ${pulled.toFixed(2).padStart(8)} ${newEtc.toFixed(2).padStart(9)} ${rate.toFixed(2).padStart(8)} ${fee.toFixed(2).padStart(11)}`,
    );
  }
  console.log(`${"GRAND TOTAL".padEnd(22)} ${grand.toFixed(2).padStart(80)}`);
  console.log(`\n(existing ${LIVE_MONTH} rows: ${existing.length} — manual pulled/rate would be preserved from these)`);
}

main()
  .catch((e) => { console.error("FAILED:", e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
