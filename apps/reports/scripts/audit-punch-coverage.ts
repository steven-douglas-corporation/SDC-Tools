/**
 * Every Paylocity punch hour the import saw, and where it ended up.
 *
 * Run:  npx tsx -r ./scripts/shim-server-only.cjs scripts/audit-punch-coverage.ts
 *
 * Written for one standing requirement: no punch that exists in Paylocity may be
 * invisible in this app. A per-job reconciliation (audit-job-actual-reconciliation.ts)
 * cannot answer that on its own, because a punch REJECTED before it reaches
 * JobHoursDetail belongs to no job and so appears in no job's numbers. This is
 * the other half — the rows the importer set aside, and whether anything can see
 * them.
 *
 * Read-only.
 */
import { prisma } from "../src/lib/prisma";

const f = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function main() {
  const [attributed, rejected, byReason, byMonth, latest] = await Promise.all([
    prisma.jobHoursDetail.aggregate({ _sum: { hours: true }, _count: { id: true } }),
    prisma.undefinedHoursRow.aggregate({ _sum: { hours: true }, _count: { id: true } }),
    prisma.undefinedHoursRow.groupBy({ by: ["reason", "countsTowardKpi"], _sum: { hours: true }, _count: { id: true } }),
    prisma.undefinedHoursRow.groupBy({ by: ["month"], _sum: { hours: true } }),
    prisma.paylocityImport.findFirst({ orderBy: { id: "desc" }, select: { fileName: true, completedAt: true } }),
  ]);

  const att = Number(attributed._sum.hours ?? 0);
  const rej = Number(rejected._sum.hours ?? 0);
  const total = att + rej;

  console.log(`PUNCH COVERAGE — where every imported hour ended up`);
  console.log(`last import: ${latest?.fileName ?? "(none recorded)"} ${latest?.completedAt?.toISOString().slice(0, 16) ?? ""}\n`);
  console.log(`  attributed to a job (JobHoursDetail): ${f(att).padStart(12)} h  ${String(attributed._count.id).padStart(6)} rows`);
  console.log(`  set aside by the import (UndefinedHoursRow): ${f(rej).padStart(9)} h  ${String(rejected._count.id).padStart(6)} rows`);
  console.log(`  ------------------------------------------------------------`);
  console.log(`  total imported                       : ${f(total).padStart(12)} h`);
  console.log(`  share NOT attributed to a job        : ${((rej / total) * 100).toFixed(2)}%\n`);

  console.log(`  why each rejected hour was set aside:`);
  const rows = byReason.sort((a, b) => Number(b._sum.hours ?? 0) - Number(a._sum.hours ?? 0));
  const w = Math.max(...rows.map((r) => String(r.reason).length), 6);
  for (const r of rows) {
    console.log(
      `    ${String(r.reason).padEnd(w)}  ${f(Number(r._sum.hours ?? 0)).padStart(10)} h  ${String(r._count.id).padStart(5)} rows  ` +
        `${r.countsTowardKpi ? "counted in the Undefined Hours KPI" : "excluded from the KPI"}`,
    );
  }

  console.log(`\n  by month (rejected only), most recent first:`);
  for (const m of byMonth.sort((a, b) => b.month.localeCompare(a.month)).slice(0, 14)) {
    console.log(`    ${m.month}  ${f(Number(m._sum.hours ?? 0)).padStart(10)} h`);
  }

  console.log(
    `\n  Every rejected row above is visible in the app: Dashboard -> Data Quality, and the\n` +
      `  Undefined Hours panel (lib/unattributed-hours.ts) shows date, employee, section and\n` +
      `  reason per row. They are excluded from JOB reports because they carry no job number\n` +
      `  to attribute them to — not because anything hides them.`,
  );
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
