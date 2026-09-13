// Recon part 2: refine "New Hours Added this Month".
//
// Part 1 established the shape — sum quotedHours in the pool's section over
// jobs whose Job.startDate falls in the month (Candidate C), exact for all four
// categories in 2026-04 and 2026-05. The residuals elsewhere are the SAME shape
// across all four categories within a month, i.e. one or two jobs in/out of the
// set rather than a wrong formula. This lists the members so the membership
// rule can be pinned, and tries poStartDate as an alternative anchor.
//
// Run: npx tsx scripts/_recon_pool_newadded.ts
import "dotenv/config";
import { prisma } from "@/lib/prisma";

const POOL_SECTION: Record<string, string> = {
  ENGINEERING_PM: "10-111",
  ENGINEERING_WARRANTY: "70-211",
  SHOP_MANUFACTURING: "10-413",
  SHOP_WARRANTY: "70-411",
};
const CATS = Object.keys(POOL_SECTION);

function monthOf(d: Date | null): string | null {
  return d ? `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}` : null;
}

async function main() {
  const pools = await prisma.categoryPool.findMany({ orderBy: [{ month: "asc" }] });
  const pbi = new Map<string, number>();
  for (const p of pools) pbi.set(`${p.month}::${p.category}`, Number(p.newHoursAddedThisMonth));
  const months = [...new Set(pools.map((p) => p.month))].sort();

  // NOTE: no type gate here on purpose — part of what we're testing is whether
  // the upstream measure counts jobs the app's type gate would drop.
  const jobs = await prisma.job.findMany({
    select: {
      id: true, jobId: true, jobName: true, status: true, type: true, billable: true,
      excludedFromStandardFees: true, startDate: true, poStartDate: true, completeDate: true,
    },
  });
  const est = await prisma.estimatedHours.findMany({
    where: { section: { in: Object.values(POOL_SECTION) } },
    select: { jobId: true, section: true, quotedHours: true },
  });
  const quoted = new Map<string, number>();
  for (const e of est) quoted.set(`${e.jobId}::${e.section}`, Number(e.quotedHours));
  const q = (jobPk: number, cat: string) => quoted.get(`${jobPk}::${POOL_SECTION[cat]}`) ?? 0;

  // ── Membership listing per month, on the startDate anchor ─────────────────
  for (const m of months) {
    const members = jobs.filter((j) => monthOf(j.startDate) === m);
    const sums = Object.fromEntries(CATS.map((c) => [c, members.reduce((s, j) => s + q(j.id, c), 0)]));
    const deltas = CATS.map((c) => (sums[c] as number) - (pbi.get(`${m}::${c}`) ?? 0));
    const clean = deltas.every((d) => Math.abs(d) < 0.005);
    console.log(`\n── ${m} ${clean ? "✓ EXACT (all 4)" : "✗ delta " + deltas.map((d) => d.toFixed(2)).join(" / ")}`);
    if (!clean) {
      console.log("   members (startDate in month):");
      for (const j of members) {
        console.log(
          `     ${j.jobId.padEnd(6)} ${(j.jobName ?? "").slice(0, 28).padEnd(28)} ` +
            `type=${String(j.type).padEnd(9)} status=${String(j.status).padEnd(9)} ` +
            `bill=${j.billable ? "Y" : "N"} excl=${j.excludedFromStandardFees ? "Y" : "N"} ` +
            `po=${monthOf(j.poStartDate) ?? "-"}  ` +
            `q=[${CATS.map((c) => q(j.id, c)).join("/")}]`,
        );
      }
      console.log(`   pbi=[${CATS.map((c) => (pbi.get(`${m}::${c}`) ?? 0)).join("/")}]  local=[${CATS.map((c) => (sums[c] as number)).join("/")}]`);
    }
  }

  // ── Variant scoreboard ────────────────────────────────────────────────────
  type Variant = { name: string; anchor: "start" | "po"; pred: (j: (typeof jobs)[number]) => boolean };
  const VARIANTS: Variant[] = [
    { name: "startDate, all jobs", anchor: "start", pred: () => true },
    { name: "startDate, typed", anchor: "start", pred: (j) => !!j.type },
    { name: "startDate, typed+billable", anchor: "start", pred: (j) => !!j.type && j.billable },
    { name: "startDate, typed+!excluded", anchor: "start", pred: (j) => !!j.type && !j.excludedFromStandardFees },
    { name: "startDate, typed+billable+!excluded", anchor: "start", pred: (j) => !!j.type && j.billable && !j.excludedFromStandardFees },
    { name: "startDate, !Service", anchor: "start", pred: (j) => !!j.type && j.type !== "Service" },
    { name: "poStartDate, all jobs", anchor: "po", pred: () => true },
    { name: "poStartDate, typed", anchor: "po", pred: (j) => !!j.type },
    { name: "poStartDate, typed+billable", anchor: "po", pred: (j) => !!j.type && j.billable },
  ];

  console.log(`\n\n=== Variant scoreboard (${months.length} months x 4 categories = ${months.length * 4} cells) ===`);
  console.log("variant                                exact  |Δ|<1   |Δ|<10   totalAbsΔ");
  for (const v of VARIANTS) {
    let exact = 0, near1 = 0, near10 = 0, tot = 0;
    for (const m of months) {
      const members = jobs.filter((j) => monthOf(v.anchor === "start" ? j.startDate : j.poStartDate) === m && v.pred(j));
      for (const c of CATS) {
        const local = members.reduce((s, j) => s + q(j.id, c), 0);
        const d = Math.abs(local - (pbi.get(`${m}::${c}`) ?? 0));
        tot += d;
        if (d < 0.005) exact++;
        if (d < 1) near1++;
        if (d < 10.005) near10++;
      }
    }
    console.log(`${v.name.padEnd(38)} ${String(exact).padStart(5)} ${String(near1).padStart(6)} ${String(near10).padStart(7)} ${tot.toFixed(2).padStart(11)}`);
  }
}

main()
  .catch((e) => { console.error("FAILED:", e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
