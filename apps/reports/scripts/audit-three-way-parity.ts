import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { getJobAnalysis } from "../src/lib/job-analysis";
import { checkPartsParity } from "../src/lib/parts-parity";

// Command-line version of the Analysis tab's "Verify against Parts List" button.
//   npx tsx -r ./scripts/shim-server-only.cjs scripts/audit-three-way-parity.ts 2026-10
// Read-only.

const month = process.argv[2] ?? "2026-10";
const [y, m] = month.split("-").map(Number);
const usd = (n: number) => (n < 0 ? "-" : "") + "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function main() {
  const A = await getJobAnalysis(new Date(y, m, 6)); // 6th of the next month → previousMonth() === month
  const sum = (f: (r: (typeof A.rows)[number]) => number | null) => A.rows.reduce((s, r) => s + (f(r) ?? 0), 0);
  console.log(`Month ${A.month} · ${A.rows.length} jobs · Left to Invoice ${usd(sum((r) => r.leftToInvoice))} · Money Spent ${usd(sum((r) => r.moneySpent))}`);
  const rep = await checkPartsParity(A);
  for (const x of rep.mismatches) console.log(`${x.jobId.padEnd(6)} ${x.figure.padEnd(15)} shared ${usd(x.shared).padStart(14)}  vs ${x.against}: ${usd(x.other)}`);
  if (rep.unchecked.length) console.log("UNCHECKED (Parts List could not be rebuilt):", rep.unchecked.join(", "));
  console.log(`${rep.checkedJobs} jobs checked, ${rep.mismatches.length} mismatch(es).`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
