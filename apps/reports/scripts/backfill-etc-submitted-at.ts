// Stamps `submittedAt` on every confirmed (needsReview:false) EtcEntry row that has
// none — the rows the Power BI history backfill and the Excel restores wrote before
// sync-etc-history.ts started stamping them (2026-09-14; lib/etc.ts isConfirmedEntry).
//
//   npx tsx -r ./scripts/shim-server-only.cjs --tsconfig tsconfig.scripts.json scripts/backfill-etc-submitted-at.ts
//   npx tsx -r ./scripts/shim-server-only.cjs --tsconfig tsconfig.scripts.json scripts/backfill-etc-submitted-at.ts --run
//
// Without --run it writes nothing: it lists, per month, how many rows it would stamp.
//
// ── Why ─────────────────────────────────────────────────────────────────────
//
// "Is this row's newEtc a confirmed figure" is one predicate now: a frozen row, or an
// open row with a submittedAt. While a backfilled month stays LOCKED nothing changes
// — a frozen row is confirmed by definition. The moment one is REOPENED its rows are
// open with no submittedAt, and the grid, validation and the freeze all — correctly,
// and in agreement — treat them as never confirmed: blank cells, N required values,
// zero-hour cells re-derived at priorEtc. The page used to paper over that by
// treating any historical month as confirmed, which the freeze did not, and that
// split is what this repair removes the need for.
//
// ── What it stamps, and why THAT instant ────────────────────────────────────
//
// historyConfirmedAt(month): the last millisecond of the row's month, UTC. The same
// instant sync-etc-history.ts stamps on the rows it writes now, chosen so that:
//   * it is deterministic — a re-run of the sync converges on identical rows;
//   * the sync can recognise it. The sync's ownership rule treats a real submittedAt
//     as "this month was closed in the app, never overwrite it"; this instant is
//     excluded from that rule (isHistoryConfirmedAt), so stamping a PBI-owned month
//     here does NOT stop the sync refreshing it later. Ownership is unchanged by
//     this script for every month, by construction: a row that HAD a submittedAt is
//     not touched, and the stamp written to the rest is the one the rule ignores.
//
// Guarded per row on `needsReview: false AND submittedAt IS NULL`, so a row reopened
// or submitted between the dry run and the --run is left alone. One audit row per
// month, action `etc.backfillSubmittedAt`, user "Data repair", and a JSON backup of
// the row ids stamped.
import "dotenv/config";
import { randomUUID } from "crypto";
import { writeFileSync } from "fs";
import { prisma } from "@/lib/prisma";
import { historyConfirmedAt, isValidMonth } from "@/lib/etc";
import { APP_VERSION } from "@/lib/app-version";

const RUN = process.argv.includes("--run");
const backupArg = process.argv.indexOf("--backup");
const BACKUP = backupArg >= 0 ? process.argv[backupArg + 1] : `backfill-etc-submitted-at.backup.${Date.now()}.json`;

async function main() {
  const rows = await prisma.etcEntry.findMany({
    where: { needsReview: false, submittedAt: null },
    select: { id: true, month: true, jobId: true, section: true, newEtc: true },
    orderBy: [{ month: "asc" }, { id: "asc" }],
  });

  const byMonth = new Map<string, typeof rows>();
  const skipped: string[] = [];
  for (const r of rows) {
    if (!isValidMonth(r.month)) {
      skipped.push(`${r.id} month ${JSON.stringify(r.month)} is not YYYY-MM`);
      continue;
    }
    if (!byMonth.has(r.month)) byMonth.set(r.month, []);
    byMonth.get(r.month)!.push(r);
  }

  console.log(`${rows.length} confirmed rows with no submittedAt across ${byMonth.size} month(s)`);
  for (const s of skipped) console.log("  SKIP", s);
  console.table([...byMonth.entries()].map(([month, list]) => ({ month, rows: list.length, stamp: historyConfirmedAt(month).toISOString() })));

  if (!RUN) {
    console.log("\nDry run — nothing written. Re-run with --run to apply.");
    return;
  }
  if (byMonth.size === 0) return;

  writeFileSync(
    BACKUP,
    JSON.stringify(
      {
        at: new Date().toISOString(),
        months: [...byMonth.entries()].map(([month, list]) => ({ month, stamp: historyConfirmedAt(month).toISOString(), ids: list.map((r) => r.id) })),
      },
      null,
      2,
    ),
  );
  console.log(`Backup of stamped row ids written to ${BACKUP}`);

  const changeId = randomUUID();
  const now = new Date();
  let stamped = 0;
  await prisma.$transaction(
    async (tx) => {
      for (const [month, list] of byMonth) {
        const stamp = historyConfirmedAt(month);
        // Guarded on the state the dry run read: a row reopened or freshly submitted
        // since is not this script's to stamp.
        const r = await tx.etcEntry.updateMany({
          where: { id: { in: list.map((x) => x.id) }, needsReview: false, submittedAt: null },
          data: { submittedAt: stamp },
        });
        stamped += r.count;
        const summary = `Stamped submittedAt = ${stamp.toISOString()} on ${r.count} confirmed ${month} ETC rows the history backfill left unstamped`;
        await tx.$executeRaw`
          INSERT INTO AuditLog (userId, userEmail, userName, action, entityType, entityId, summary, metadata, createdAt, appVersion, changeId)
          VALUES (NULL, 'akamuju@sdcautomation.com', 'Data repair', 'etc.backfillSubmittedAt', 'EtcMonth', ${month},
            ${summary}, ${JSON.stringify({ expected: list.length, stamped: r.count, backup: BACKUP })}, ${now}, ${APP_VERSION}, ${changeId})`;
        if (r.count !== list.length) console.log(`  ${month}: ${list.length - r.count} row(s) moved since the dry run and were left alone`);
      }
    },
    { timeout: 120000 },
  );
  console.log(`Stamped ${stamped} rows (changeId ${changeId}).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
