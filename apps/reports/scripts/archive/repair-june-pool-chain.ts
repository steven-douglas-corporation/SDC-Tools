import "dotenv/config";
import { writeFileSync } from "fs";
import { prisma } from "@/lib/prisma";
import { computeCategoryPoolsLocally, newProjectsEnteringMonth } from "@/lib/standard-pool-local";
import { round2 } from "@/lib/etc";

// June 2026's pools were frozen on 2026-07-08 from Power BI's archive, with
// New Hours Added of 726h. Jobs 1161/1162 have since been re-quoted and now
// contribute 762h. June's hoursAvailable -> newEtcHours is therefore 36h light,
// and July's Previous Month Pulled Hours carries that understatement forward.
//
// This reopens June's Standard Sheet (deletes its snapshot rows, which is what
// the UI's "Reopen Month" does), recomputes June's pools from live job data,
// then recomputes July's so the corrected balance flows forward.
//
// It does NOT re-freeze June — the report submission needs a signed-in
// session and the unlock cookie, and the freeze should carry the real user in
// its audit trail. Re-lock June from the UI afterwards.
//
//   npx tsx scripts/repair-june-pool-chain.ts            (dry run)
//   npx tsx scripts/repair-june-pool-chain.ts --apply
const APPLY = process.argv.includes("--apply");
const MONTHS = ["2026-06", "2026-07"] as const;

const fmt = (n: unknown) => String(round2(Number(n))).padStart(10);

async function show(label: string) {
  console.log(`\n--- ${label} ---`);
  for (const m of MONTHS) {
    const pools = await prisma.categoryPool.findMany({ where: { month: m }, orderBy: { category: "asc" } });
    console.log(`  ${m}   prevPulled  newAdded  available    pulled  newEtcHrs   stdFee   source`);
    for (const p of pools) {
      console.log(
        `    ${p.category.padEnd(21)}${fmt(p.previousMonthPulledHours)}${fmt(p.newHoursAddedThisMonth)}${fmt(p.hoursAvailable)}${fmt(p.hoursPulledThisMonth)}${fmt(p.newEtcHours)}${fmt(p.standardFee)}   ${p.source}`,
      );
    }
    const total = pools.reduce((s, p) => s + Number(p.standardFee), 0);
    console.log(`    ${"GRAND TOTAL".padEnd(21)}${" ".repeat(60)}$${Math.round(total).toLocaleString()}`);
  }
}

async function main() {
  const projects = await newProjectsEnteringMonth("2026-06");
  console.log("Jobs starting 2026-06 (the live source of June's New Hours Added):");
  for (const p of projects) console.log(`  ${p.jobId}  ${p.total}h  ${JSON.stringify(p.hours)}`);

  await show("BEFORE");

  const snaps = await prisma.standardSheetSnapshot.findMany({ where: { month: "2026-06" } });
  console.log(`\nJune StandardSheetSnapshot rows to delete (reopen): ${snaps.length}`);

  if (!APPLY) {
    console.log("\nDRY RUN — pass --apply to write.");
    return void (await prisma.$disconnect());
  }

  // Rollback dump BEFORE deleting anything.
  const backup = `scripts/_backup_june_snapshots_${Date.now()}.json`;
  writeFileSync(backup, JSON.stringify(snaps, (_k, v) => (typeof v === "bigint" ? String(v) : v), 2));
  console.log(`Backed up to ${backup}`);

  await prisma.standardSheetSnapshot.deleteMany({ where: { month: "2026-06" } });
  console.log("June reopened (snapshots deleted).");

  // Order matters: June first, then July reads June's corrected newEtcHours as
  // its opening balance.
  for (const m of MONTHS) {
    const r = await computeCategoryPoolsLocally(m);
    console.log(`Recomputed ${m}: ${r.poolsUpserted} pools${r.noPunchData ? " (no punch data)" : ""}`);
  }

  await show("AFTER");
  console.log("\nJune is now REOPENED. Re-lock it from the UI: Standard Fees panel -> Submit & Lock Standard Sheet.");
  await prisma.$disconnect();
}
main();
