import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { syncJobCostInventorySnapshots } from "../src/lib/job-cost-inventory-sync";
import { listInventorySnapshotDates, getInventorySnapshotForDate } from "../src/lib/job-cost-inventory-snapshot";

// Live, re-runnable proof for the Job Cost Explorer snapshot feature (2026-08-11).
// Run any time to confirm the real Finance-folder workbook still ingests correctly
// and that a specific historical month-end still resolves to the figures verified
// by hand while this feature was built (read directly off "SDC inventory 6.30.26",
// row 7/8, columns D and I):
//   job 1079, as of 2026-06-30: Sales $596,115, 100% complete
//   job 1101, as of 2026-06-30: Sales $2,692,160, 80.1% complete
async function main() {
  console.log("=== syncJobCostInventorySnapshots() against the real Finance folder ===");
  const result = await syncJobCostInventorySnapshots();
  console.log(result);

  console.log("\n=== listInventorySnapshotDates() ===");
  const dates = await listInventorySnapshotDates();
  console.log(`${dates.length} distinct month-end(s): ${dates.slice(0, 6).join(", ")}${dates.length > 6 ? ", …" : ""}`);

  console.log("\n=== getInventorySnapshotForDate('2026-06-30') ===");
  const snap = await getInventorySnapshotForDate("2026-06-30");
  console.log(`resolved asOfDate: ${snap.asOfDate}, ${snap.map.size} job(s)`);
  for (const jobId of ["1079", "1101"]) {
    console.log(`  job ${jobId}:`, snap.map.get(jobId));
  }

  console.log("\n=== getInventorySnapshotForDate(null) — Current ===");
  const current = await getInventorySnapshotForDate(null);
  console.log(`resolved asOfDate: ${current.asOfDate}, ${current.map.size} job(s)`);

  console.log("\n=== getInventorySnapshotForDate('2020-01-31') — before any known snapshot ===");
  const tooOld = await getInventorySnapshotForDate("2020-01-31");
  console.log(`resolved asOfDate: ${tooOld.asOfDate} (expect null), ${tooOld.map.size} job(s) (expect 0)`);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
