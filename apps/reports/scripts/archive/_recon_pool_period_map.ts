// Recon part 5: two things at once.
//
// 1) Enumerate 'Estimated to Complete Period' as it exists upstream TODAY —
//    name vs begin date — because part 4's live PBI column came back shifted one
//    month against the app's monthToEtcName mapping. If that shift is real it is
//    a live bug well beyond this feature: syncCategoryPoolsFromPowerBi and the
//    ETC history sync both key off that mapping.
//
// 2) Re-score the local "New Hours Added" definition against live PBI under the
//    shifted mapping (app month M <-> ETC Name of M minus one month).
//
// Run: npx tsx scripts/_recon_pool_period_map.ts
import "dotenv/config";
import { runDax } from "@/lib/powerbi-client";
import { prisma } from "@/lib/prisma";

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
const MONTH_NUM_TO_NAME = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function monthToEtcName(month: string, offset = 0): string {
  const [year, monthNum] = month.split("-").map(Number);
  const d = new Date(Date.UTC(year, monthNum - 1 + offset, 1));
  return `${MONTH_NUM_TO_NAME[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
function monthOf(d: Date | null): string | null {
  return d ? `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}` : null;
}

async function main() {
  console.log("=== 'Estimated to Complete Period' as it exists upstream today ===");
  const periods = (await runDax(
    `EVALUATE SUMMARIZECOLUMNS('Estimated to Complete Period'[ETC Name], 'Estimated to Complete Period'[ETC Begin Date])`,
  )) as Record<string, unknown>[];
  const named = periods
    .map((r) => ({
      name: String(r["Estimated to Complete Period[ETC Name]"] ?? ""),
      begin: String(r["Estimated to Complete Period[ETC Begin Date]"] ?? ""),
    }))
    .sort((a, b) => a.begin.localeCompare(b.begin));
  for (const p of named) console.log(`  name="${p.name}"  beginDate=${p.begin.slice(0, 10)}`);

  // ── Re-score local vs live PBI under both mappings ────────────────────────
  const pools = await prisma.categoryPool.findMany({ orderBy: [{ month: "asc" }] });
  const months = [...new Set(pools.map((p) => p.month))].sort();
  const jobs = await prisma.job.findMany({ select: { id: true, startDate: true } });
  const est = await prisma.estimatedHours.findMany({
    where: { section: { in: Object.values(POOL_SECTION) } },
    select: { jobId: true, section: true, quotedHours: true },
  });
  const quoted = new Map<string, number>();
  for (const e of est) quoted.set(`${e.jobId}::${e.section}`, Number(e.quotedHours));
  const localFor = (m: string, cat: string) =>
    jobs.filter((j) => monthOf(j.startDate) === m)
      .reduce((s, j) => s + (quoted.get(`${j.id}::${POOL_SECTION[cat]}`) ?? 0), 0);

  async function livePool(etcName: string): Promise<Map<string, number> | null> {
    const rows = (await runDax(`
      EVALUATE
      SUMMARIZECOLUMNS(
        'Standard Fees'[Billing Group],
        'Standard Fees'[Department],
        FILTER(ALL('Estimated to Complete Period'), 'Estimated to Complete Period'[ETC Name] = "${etcName}"),
        "HoursQuoted", [Standard Fees - Monthly Process - Hours Quoted by ETC Period]
      )`)) as Record<string, unknown>[];
    if (rows.length === 0) return null;
    const out = new Map<string, number>();
    for (const r of rows) {
      const cat = POOL_CATEGORY[`${r["Standard Fees[Billing Group]"]}|${r["Standard Fees[Department]"]}`];
      if (cat) out.set(cat, Number(r.HoursQuoted ?? 0));
    }
    return out;
  }

  for (const offset of [0, -1]) {
    console.log(`\n=== local vs live PBI, mapping: app month M -> ETC Name of M${offset ? " minus 1 month" : " (current app mapping)"} ===`);
    let exact = 0, cells = 0, missing = 0;
    const bad: string[] = [];
    for (const m of months) {
      const live = await livePool(monthToEtcName(m, offset));
      if (!live) { missing++; continue; }
      for (const cat of CATS) {
        cells++;
        const l = live.get(cat) ?? 0;
        const loc = localFor(m, cat);
        if (Math.abs(l - loc) < 0.005) exact++;
        else if (bad.length < 12) bad.push(`${m} ${cat}: live=${l} local=${loc} (Δ${(loc - l).toFixed(2)})`);
      }
    }
    console.log(`  exact: ${exact}/${cells} cells  (${missing} months had no matching period upstream)`);
    for (const b of bad) console.log(`    ✗ ${b}`);
  }
}

main()
  .catch((e) => { console.error("FAILED:", e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
