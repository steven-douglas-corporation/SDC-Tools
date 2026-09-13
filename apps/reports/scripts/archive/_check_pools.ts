import "dotenv/config";
import { prisma } from "@/lib/prisma";

async function main() {
  const rows = await prisma.categoryPool.findMany({
    where: { month: { in: ["2026-06", "2026-07"] } },
    orderBy: [{ month: "asc" }, { category: "asc" }],
  });
  for (const p of rows) {
    console.log(
      `${p.month} ${p.category.padEnd(22)} prev=${p.previousMonthPulledHours} new=${p.newHoursAddedThisMonth} ` +
        `avail=${p.hoursAvailable} worked=${p.hoursWorkedThisMonth} pulled=${p.hoursPulledThisMonth} ` +
        `newEtc=${p.newEtcHours} rate=${p.rate} fee=${p.standardFee} [${p.source}]`,
    );
  }
  const july = rows.filter((r) => r.month === "2026-07");
  console.log(`\n2026-07 grand total fee: $${july.reduce((s, p) => s + Number(p.standardFee), 0).toLocaleString()}`);
}

main()
  .catch((e) => { console.error("FAILED:", e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
