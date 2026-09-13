// Baseline the pool "Hours Worked" figures, and settle the period-name shift.
//
// Both questions resolve against the same independent anchor: the Paylocity
// punch export, which is dated by real calendar work date and owes nothing to
// Power BI's period naming.
//
//   Q1 (hours) — does the local punch tally per department reproduce PBI's
//       [Hours Actual by ETC Period]? Manufacturing was the weak spot (-18 /
//       -31.5 / -184.5 across 2026-02/05/06) and PM had no baseline at all,
//       because the stored figure was 0 for every month.
//
//   Q2 (shift) — PBI period "May 2026" carries ETC Begin Date 2026-06-01. If
//       [Hours Actual] for period name M lines up with punches in calendar
//       month M+1, the name really is a month behind, and every stored month
//       that was pulled by name is labelled one month off.
//
// Run: npx tsx scripts/_recon_pool_hours_baseline.ts
import "dotenv/config";
import { runDax } from "@/lib/powerbi-client";
import { prisma } from "@/lib/prisma";
import { fetchJobHoursRowsWithIssues } from "@/lib/job-hours-source";
import { POOL_CATEGORIES, type PoolCategory } from "@/lib/sections";
import { round2 } from "@/lib/etc";

const POOL_CATEGORY: Record<string, PoolCategory> = {
  "Engineering|PM": "ENGINEERING_PM",
  "Engineering|Warranty": "ENGINEERING_WARRANTY",
  "Shop|Manufacturing": "SHOP_MANUFACTURING",
  "Shop|Warranty": "SHOP_WARRANTY",
};
const MONTH_NUM_TO_NAME = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
function etcName(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${MONTH_NUM_TO_NAME[m - 1]} ${y}`;
}

async function actualByDept(name: string): Promise<Map<PoolCategory, number> | null> {
  const rows = (await runDax(`
    EVALUATE
    SUMMARIZECOLUMNS(
      'Standard Fees'[Billing Group],
      'Standard Fees'[Department],
      FILTER(ALL('Estimated to Complete Period'), 'Estimated to Complete Period'[ETC Name] = "${name}"),
      "HoursActual", [Standard Fees - Monthly Process - Hours Actual by ETC Period]
    )`)) as Record<string, unknown>[];
  if (rows.length === 0) return null;
  const out = new Map<PoolCategory, number>();
  for (const r of rows) {
    const cat = POOL_CATEGORY[`${r["Standard Fees[Billing Group]"]}|${r["Standard Fees[Department]"]}`];
    if (cat) out.set(cat, round2(Number(r.HoursActual ?? 0)));
  }
  return out;
}

async function main() {
  const { poolHours } = await fetchJobHoursRowsWithIssues();
  const punchMonths = [...new Set([...poolHours.keys()].map((k) => k.split("::")[0]))].sort();
  const local = (m: string, c: PoolCategory) => round2(poolHours.get(`${m}::${c}`) ?? 0);

  console.log(`Punch data covers: ${punchMonths.join(", ")}`);

  // ── Q2 first: which alignment does PBI's Hours Actual take? ───────────────
  // Scored over the months where BOTH a punch tally and a PBI period exist.
  console.log("\n=== Q2 — period alignment, scored against punches by calendar month ===");
  const scores: Record<string, { exact: number; near1: number; cells: number; absTotal: number }> = {};
  for (const offset of [0, -1]) {
    const s = { exact: 0, near1: 0, cells: 0, absTotal: 0 };
    for (const m of punchMonths) {
      const live = await actualByDept(etcName(shiftMonth(m, offset)));
      if (!live) continue;
      for (const c of POOL_CATEGORIES) {
        const d = Math.abs((live.get(c) ?? 0) - local(m, c));
        s.cells++;
        s.absTotal += d;
        if (d < 0.005) s.exact++;
        if (d < 1) s.near1++;
      }
    }
    scores[String(offset)] = s;
    const label = offset === 0 ? "name == calendar month (what the app assumes)" : "name == calendar month MINUS 1";
    console.log(`  ${label.padEnd(46)} exact ${s.exact}/${s.cells}   within 1h ${s.near1}/${s.cells}   total |Δ| ${s.absTotal.toFixed(2)}`);
  }
  const shifted = scores["-1"].exact > scores["0"].exact;
  const best = shifted ? -1 : 0;
  console.log(`\n  -> Hours Actual aligns with: ${shifted ? "name == month MINUS 1 (the shift is real)" : "name == month (no shift)"}`);

  // ── Q1: per-department baseline under the winning alignment ───────────────
  console.log(`\n=== Q1 — local punch tally vs PBI [Hours Actual by ETC Period] (best alignment) ===`);
  console.log("month    period      category                  pbi      local     delta");
  const perCat = new Map<PoolCategory, { n: number; exact: number; absTotal: number; worst: number }>();
  for (const c of POOL_CATEGORIES) perCat.set(c, { n: 0, exact: 0, absTotal: 0, worst: 0 });

  for (const m of punchMonths) {
    const name = etcName(shiftMonth(m, best));
    const live = await actualByDept(name);
    if (!live) { console.log(`${m}  ${name.padEnd(10)}  (no such period upstream)`); continue; }
    for (const c of POOL_CATEGORIES) {
      const p = live.get(c) ?? 0;
      const l = local(m, c);
      const d = l - p;
      const st = perCat.get(c)!;
      st.n++; st.absTotal += Math.abs(d); st.worst = Math.max(st.worst, Math.abs(d));
      if (Math.abs(d) < 0.005) st.exact++;
      console.log(
        `${m}  ${name.padEnd(10)}  ${c.padEnd(22)} ${p.toFixed(2).padStart(9)} ${l.toFixed(2).padStart(10)} ${d.toFixed(2).padStart(9)}`,
      );
    }
  }

  console.log("\n=== Per-department verdict ===");
  console.log("category                 months   exact   mean|Δ|   worst|Δ|");
  for (const c of POOL_CATEGORIES) {
    const s = perCat.get(c)!;
    console.log(
      `${c.padEnd(22)} ${String(s.n).padStart(7)} ${String(s.exact).padStart(7)} ` +
        `${(s.n ? s.absTotal / s.n : 0).toFixed(2).padStart(9)} ${s.worst.toFixed(2).padStart(10)}`,
    );
  }

  // ── Does the shift implicate the stored archive? ──────────────────────────
  if (shifted) {
    console.log("\n=== Stored CategoryPool.hoursWorkedThisMonth vs BOTH alignments ===");
    console.log("(if stored matches the calendar month, the archive is correctly labelled");
    console.log(" and only the NAME upstream moved; if it matches month+1, it is shifted)");
    const pools = await prisma.categoryPool.findMany({ orderBy: [{ month: "asc" }] });
    let sameMonth = 0, nextMonth = 0, neither = 0;
    for (const p of pools) {
      const c = p.category as PoolCategory;
      const stored = Number(p.hoursWorkedThisMonth);
      if (stored === 0) continue; // no signal
      const asIs = local(p.month, c);
      const asNext = local(shiftMonth(p.month, 1), c);
      const dA = Math.abs(stored - asIs), dN = Math.abs(stored - asNext);
      if (dA < 1 && dA <= dN) sameMonth++;
      else if (dN < 1) nextMonth++;
      else neither++;
    }
    console.log(`  stored matches punches in the SAME calendar month: ${sameMonth}`);
    console.log(`  stored matches punches in the NEXT calendar month: ${nextMonth}`);
    console.log(`  matches neither (older months have no punch data):  ${neither}`);
  }
}

main()
  .catch((e) => { console.error("FAILED:", e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
