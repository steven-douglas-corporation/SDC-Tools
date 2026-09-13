// Recon part 4 — the decisive test.
//
// Part 3 was inconclusive: a bulk sync on 2026-07-30 rewrote every
// EstimatedHours.updatedAt, so "was this row edited since?" is unanswerable
// from the row itself.
//
// This asks Power BI instead. Its [Hours Quoted by ETC Period] is computed from
// CURRENT upstream quoted data, so:
//   • live PBI == local computation, but != stored CategoryPool
//        -> the stored archive is a stale snapshot; the local definition is right.
//   • live PBI == stored CategoryPool, but != local
//        -> the local definition genuinely disagrees; do not ship it as-is.
//
// Run: npx tsx scripts/_recon_pool_pbi_live.ts
import "dotenv/config";
import { runDax } from "@/lib/powerbi-client";
import { prisma } from "@/lib/prisma";

// Local copy of sync-actuals.ts's (unexported) monthToEtcName.
const MONTH_NUM_TO_NAME = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function monthToEtcName(month: string): string {
  const [year, monthNum] = month.split("-").map(Number);
  return `${MONTH_NUM_TO_NAME[monthNum - 1]} ${year}`;
}

const POOL_SECTION: Record<string, string> = {
  ENGINEERING_PM: "10-111",
  ENGINEERING_WARRANTY: "70-211",
  SHOP_MANUFACTURING: "10-413",
  SHOP_WARRANTY: "70-411",
};
const POOL_CATEGORY: Record<string, string> = {
  "Engineering|PM": "ENGINEERING_PM",
  "Engineering|Warranty": "ENGINEERING_WARRANTY",
  "Shop|Manufacturing": "SHOP_MANUFACTURING",
  "Shop|Warranty": "SHOP_WARRANTY",
};
const CATS = Object.keys(POOL_SECTION);

function monthOf(d: Date | null): string | null {
  return d ? `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}` : null;
}

async function main() {
  const pools = await prisma.categoryPool.findMany({ orderBy: [{ month: "asc" }] });
  const stored = new Map<string, number>();
  for (const p of pools) stored.set(`${p.month}::${p.category}`, Number(p.newHoursAddedThisMonth));
  const months = [...new Set(pools.map((p) => p.month))].sort();

  const jobs = await prisma.job.findMany({ select: { id: true, startDate: true } });
  const est = await prisma.estimatedHours.findMany({
    where: { section: { in: Object.values(POOL_SECTION) } },
    select: { jobId: true, section: true, quotedHours: true },
  });
  const quoted = new Map<string, number>();
  for (const e of est) quoted.set(`${e.jobId}::${e.section}`, Number(e.quotedHours));

  const localFor = (m: string, cat: string) =>
    jobs
      .filter((j) => monthOf(j.startDate) === m)
      .reduce((s, j) => s + (quoted.get(`${j.id}::${POOL_SECTION[cat]}`) ?? 0), 0);

  console.log("month    category               stored     livePBI      local    verdict");
  let agreeLocal = 0, agreeStored = 0, agreeBoth = 0, cells = 0, noPeriod = 0;

  for (const m of months) {
    const etcName = monthToEtcName(m);
    const dax = `
      EVALUATE
      SUMMARIZECOLUMNS(
        'Standard Fees'[Billing Group],
        'Standard Fees'[Department],
        FILTER(ALL('Estimated to Complete Period'), 'Estimated to Complete Period'[ETC Name] = "${etcName}"),
        "HoursQuoted", [Standard Fees - Monthly Process - Hours Quoted by ETC Period]
      )
    `;
    let rows: Record<string, unknown>[] = [];
    try {
      rows = (await runDax(dax)) as Record<string, unknown>[];
    } catch (e) {
      console.log(`${m}  !! DAX failed: ${(e as Error).message.slice(0, 80)}`);
      continue;
    }
    if (rows.length === 0) { console.log(`${m}  (no ETC period upstream)`); noPeriod++; continue; }

    const live = new Map<string, number>();
    for (const r of rows) {
      const cat = POOL_CATEGORY[`${r["Standard Fees[Billing Group]"]}|${r["Standard Fees[Department]"]}`];
      if (cat) live.set(cat, Number(r.HoursQuoted ?? 0));
    }

    for (const cat of CATS) {
      const s = stored.get(`${m}::${cat}`) ?? 0;
      const l = live.get(cat) ?? 0;
      const loc = localFor(m, cat);
      const eqLocal = Math.abs(l - loc) < 0.005;
      const eqStored = Math.abs(l - s) < 0.005;
      cells++;
      if (eqLocal && eqStored) agreeBoth++;
      else if (eqLocal) agreeLocal++;
      else if (eqStored) agreeStored++;
      const verdict = eqLocal && eqStored ? "all agree" : eqLocal ? "LIVE==LOCAL (archive stale)" : eqStored ? "LIVE==STORED (local wrong)" : "all three differ";
      console.log(
        `${m}  ${cat.padEnd(22)} ${s.toFixed(2).padStart(8)} ${l.toFixed(2).padStart(11)} ${loc.toFixed(2).padStart(9)}    ${verdict}`,
      );
    }
  }

  console.log(`\n=== Verdict over ${cells} comparable cells (${noPeriod} months had no upstream period) ===`);
  console.log(`all three agree:              ${agreeBoth}`);
  console.log(`live PBI == LOCAL only:       ${agreeLocal}   (archive stale, local definition right)`);
  console.log(`live PBI == STORED only:      ${agreeStored}   (local definition wrong)`);
  console.log(`all three differ:             ${cells - agreeBoth - agreeLocal - agreeStored}`);
}

main()
  .catch((e) => { console.error("FAILED:", e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
