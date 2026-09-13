// Confirms etc-period.ts resolves each upstream period to the app month whose
// data it actually holds, and that the app's live months resolve to a period
// (or to null, for months upstream hasn't published yet).
//
// Run: npx tsx scripts/_check_etc_period_map.ts
import "dotenv/config";
import { fetchEtcPeriods, resolveEtcPeriodName } from "@/lib/etc-period";

async function main() {
  const periods = await fetchEtcPeriods();
  console.log("\nETC Name      -> app month   (month the NAME alone would have implied)");
  for (const p of periods) {
    const drift = p.monthFromName && p.monthFromName !== p.month ? `  <- name implies ${p.monthFromName}` : "";
    console.log(`  ${p.name.padEnd(12)} -> ${p.month}${drift}`);
  }

  console.log("\nResolving the app's recent months:");
  for (const m of ["2026-03", "2026-04", "2026-05", "2026-06", "2026-07"]) {
    const name = await resolveEtcPeriodName(m);
    console.log(`  ${m} -> ${name ?? "(no period upstream yet)"}`);
  }
}

main().catch((e) => { console.error("FAILED:", e); process.exitCode = 1; });
