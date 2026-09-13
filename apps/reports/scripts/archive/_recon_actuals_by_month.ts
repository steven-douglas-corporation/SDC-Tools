// Part 3: WHEN the missing hours were booked.
//
// actual-hours.ts stacks three eras. Which one is at fault decides the fix:
//   era 1  EstimatedHours.actualHistoricalHours — the Excel migration snapshot,
//          pre-ETC work, carries NO month.
//   era 2  EtcEntry.hoursWorked for months the punch import doesn't cover.
//   era 3  JobHoursDetail punches — 2026-01..2026-07 today.
//
// PBI's 'Hours Actual' starts 2025-01-31, so it is NOT a superset of the app: it
// cannot know pre-2025 work. If the gap sits in 2025 (era 2), PBI is the right
// authority there. If it sits in 2026 (era 3), the punch feed itself is short and
// PBI wouldn't be the fix.
//
// Read-only. Writes nothing.
//
// Run: npx tsx scripts/_recon_actuals_by_month.ts
import "dotenv/config";
import { runDax } from "@/lib/powerbi-client";
import { prisma } from "@/lib/prisma";
import { SECTIONS } from "@/lib/sections";

type Row = { "Date[Date]": string | null; "Function Hierarchy[Section-Function Code]": string | null; Hours: number | null };

const APP_CODES = new Set(SECTIONS.map((s) => s.code));

async function main() {
  // Per month, restricted to the 17 codes the app models — the population the
  // grid is actually expected to account for.
  const rows = (await runDax(`
EVALUATE
FILTER(
  SUMMARIZECOLUMNS(
    'Date'[Date],
    'Function Hierarchy'[Section-Function Code],
    "Hours", SUM('Hours Actual'[Hours Actual])
  ),
  [Hours] <> 0
)`)) as Row[];

  const pbiByMonth = new Map<string, number>();
  for (const r of rows) {
    const section = (r["Function Hierarchy[Section-Function Code]"] ?? "").trim();
    if (!APP_CODES.has(section)) continue;
    const d = (r["Date[Date]"] ?? "").slice(0, 7); // "2026-07-01T00:00:00" -> "2026-07"
    if (!/^\d{4}-\d{2}$/.test(d)) continue;
    pbiByMonth.set(d, (pbiByMonth.get(d) ?? 0) + Number(r.Hours ?? 0));
  }

  const covered = (await prisma.jobHoursDetail.groupBy({ by: ["month"] })).map((r) => r.month);
  const coveredSet = new Set(covered);

  const punches = await prisma.jobHoursDetail.groupBy({ by: ["month"], _sum: { hours: true } });
  const punchByMonth = new Map(punches.map((p) => [p.month, Number(p._sum.hours ?? 0)]));

  // era 2: frozen ETC hours, only counted for months the punch feed misses
  const etc = await prisma.etcEntry.groupBy({
    by: ["month"],
    where: { section: { not: "PARTS_COST" } },
    _sum: { hoursWorked: true },
  });
  const etcByMonth = new Map(etc.map((e) => [e.month, Number(e._sum.hoursWorked ?? 0)]));

  const months = [...new Set([...pbiByMonth.keys(), ...punchByMonth.keys(), ...etcByMonth.keys()])].sort();

  console.log("month     covered      PBI    app-used   (punches)   (etc)      gap    era");
  let gap2025 = 0;
  let gap2026 = 0;
  for (const m of months) {
    const pbi = pbiByMonth.get(m) ?? 0;
    const punch = punchByMonth.get(m) ?? 0;
    const etcH = etcByMonth.get(m) ?? 0;
    const isCovered = coveredSet.has(m);
    // What actual-hours.ts actually counts for this month.
    const used = isCovered ? punch : etcH;
    const gap = pbi - used;
    if (pbi === 0 && used === 0) continue;
    const era = isCovered ? "3 punches" : "2 frozen ETC";
    console.log(
      m.padEnd(10) +
        (isCovered ? "yes" : "no").padEnd(9) +
        pbi.toFixed(0).padStart(8) +
        used.toFixed(0).padStart(11) +
        punch.toFixed(0).padStart(12) +
        etcH.toFixed(0).padStart(9) +
        gap.toFixed(0).padStart(9) +
        "    " +
        era
    );
    if (m < "2026-01") gap2025 += gap;
    else gap2026 += gap;
  }

  console.log(`\ngap in months the punch import does NOT cover (era 2): ${gap2025.toFixed(0)}h`);
  console.log(`gap in months it DOES cover (era 3, same Paylocity feed):  ${gap2026.toFixed(0)}h`);
  console.log(`\nPBI 'Hours Actual' earliest month: ${months[0]} — anything before that is era 1 only (Excel snapshot).`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
