// CLI entry point for the historical ETC sync — the same logic the "Sync
// History" button on /etc runs (src/lib/sync-etc-history.ts, see that file
// for the measure mapping and the app-owned/PBI-owned ownership rule).
// Originally the one-off backfill that recovered 2025-09..2026-05; now just
// a thin wrapper, safe to re-run any time.
import "dotenv/config";
import { syncEtcHistoryFromPowerBi } from "../src/lib/sync-etc-history";
import { logAuditFor } from "../src/lib/audit";

async function main() {
  const result = await syncEtcHistoryFromPowerBi();
  console.log(`Months refreshed from Power BI: ${result.monthsRefreshed.join(", ") || "(none)"}`);
  console.log(`Months skipped (app-owned): ${result.monthsSkippedAppOwned.join(", ") || "(none)"}`);
  console.log(`EtcEntry rows written: ${result.entriesWritten}`);
  console.log(`Never-submitted cells filled with the app's own suggestion: ${result.unsubmittedFilled}`);
  console.log(`Category-pool months refreshed: ${result.poolMonthsRefreshed.join(", ") || "(none)"} (${result.poolRowsWritten} rows)`);

  await logAuditFor(null, "backfill-etc-history-script", {
    action: "etc.syncEtcHistory",
    entityType: "EtcMonth",
    summary: `Refreshed ${result.monthsRefreshed.length} historical ETC months from Power BI (${result.entriesWritten} rows) via CLI`,
    metadata: result,
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
