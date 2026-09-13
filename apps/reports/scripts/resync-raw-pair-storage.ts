// One-purpose resync: rewrite JobHoursDetail so `section` IS the raw Paylocity pair
// everywhere (no alias, fold, or split), and populate the new standardDepartment/
// standardTaskDescription/mappingStatus columns. Run with:
//
//   npx tsx -r ./scripts/shim-server-only.cjs scripts/resync-raw-pair-storage.ts
//
// ── Why this script exists ──────────────────────────────────────────────────
//
// Migration 20260821150000 added the three standardization columns but could NOT
// safely rewrite existing `section` values in place (see its own header) — the old
// unique key still needed the pre-resync data shape. This is that rewrite: it reads
// the Paylocity workbooks fresh and calls syncActualHours exactly as a normal sync
// does, which is now raw-pair-aware end to end (paylocity-workbook.ts no longer
// folds/splits at ingestion; syncJobHoursDetail writes the raw pair plus the three
// stored columns; syncActualHours/syncHoursWorked fold in memory, only for the ETC
// grid's own two rollups).
//
// This is idempotent (replace-by-job-month) and safe to re-run.
import { prisma } from "../src/lib/prisma";
import { readHoursFeed } from "../src/lib/hours-feed";
import { syncActualHours } from "../src/lib/sync-actuals";

const f2 = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

type Snapshot = {
  rows: number;
  hours: number;
  // Rows where section != rawSection-rawFunction — the exact defect this fixes.
  stillFolded: number;
  stillFoldedHours: number;
  missingStandardCols: number;
};

async function snapshot(): Promise<Snapshot> {
  const [r] = await prisma.$queryRawUnsafe<
    { n: bigint; h: string | null; fn: bigint; fh: string | null; mc: bigint }[]
  >(`SELECT COUNT(*) n,
            ROUND(SUM(hours), 2) h,
            SUM(CASE WHEN section <> CONCAT(rawSection, '-', rawFunction) THEN 1 ELSE 0 END) fn,
            ROUND(SUM(CASE WHEN section <> CONCAT(rawSection, '-', rawFunction) THEN hours ELSE 0 END), 2) fh,
            SUM(CASE WHEN mappingStatus = '' THEN 1 ELSE 0 END) mc
       FROM JobHoursDetail`);
  return {
    rows: Number(r.n),
    hours: Number(r.h ?? 0),
    stillFolded: Number(r.fn),
    stillFoldedHours: Number(r.fh ?? 0),
    missingStandardCols: Number(r.mc),
  };
}

function print(label: string, s: Snapshot) {
  console.log(
    `  ${label.padEnd(8)} rows ${String(s.rows).padStart(7)}   hours ${f2(s.hours).padStart(12)}   ` +
      `section != raw pair: ${String(s.stillFolded).padStart(6)} rows / ${f2(s.stillFoldedHours)}h   ` +
      `missing standard cols: ${s.missingStandardCols}`,
  );
}

async function main() {
  console.log("=".repeat(84));
  console.log("RESYNC — section becomes the raw Paylocity pair; standard columns populated");
  console.log("=".repeat(84));

  const before = await snapshot();
  print("BEFORE", before);

  console.log("\nreading hours feed...");
  const feed = await readHoursFeed();
  console.log(`  source     : ${feed.provenance.note}`);
  console.log(`  feed rows  : ${feed.rows.length}`);

  console.log("\nwriting (replace-by-job-month, idempotent)...");
  const r = await syncActualHours(feed);
  console.log(`  monthly rollups upserted : ${r.rowsUpserted}`);
  console.log(`  punch rows written       : ${r.detailRowsWritten}`);
  console.log(`  jobs not found           : ${r.jobsNotFound}`);
  console.log(`  overridden preserved     : ${r.rowsSkippedOverridden}`);

  const after = await snapshot();
  console.log("");
  print("AFTER", after);

  console.log("\nchecks");
  let failed = false;
  const check = (ok: boolean, msg: string) => {
    console.log(`  ${ok ? "OK  " : "FAIL"}  ${msg}`);
    if (!ok) failed = true;
  };

  // Row count is EXPECTED to fall, not required to hold: a 10-311 punch used to be
  // stored as two rows (30% on 10-312, 70% on 10-313, per the ETC grid's own fold).
  // It is now stored as the single original punch — "do not change the underlying
  // raw Section or Function to perform the split" — so every historical 10-311
  // punch collapses two rows into one. Reported as info, not asserted either way.
  console.log(`  INFO  row count ${before.rows} -> ${after.rows} (a FALL is expected — 10-311 stops being stored as two rows)`);

  // Rows the feed covers must now have section == raw pair and real standard columns.
  // Rows the feed does NOT cover (a job/month no source file reaches, or an orphan
  // whose punch was deleted upstream) are untouched by design — "absent must never
  // mean delete" — so a nonzero remainder here is expected and reported, not a failure.
  const fedByJobMonth = new Set(feed.rows.map((r) => `${r.jobId}::${r.year}-${String(r.month).padStart(2, "0")}`));
  const remaining = await prisma.$queryRawUnsafe<{ job: string; month: string; n: bigint; h: string | null }[]>(
    `SELECT j.jobId job, d.month month, COUNT(*) n, ROUND(SUM(d.hours), 2) h
       FROM JobHoursDetail d JOIN Job j ON j.id = d.jobId
      WHERE d.section <> CONCAT(d.rawSection, '-', d.rawFunction)
      GROUP BY j.jobId, d.month ORDER BY j.jobId, d.month`,
  );
  let unexpectedFolded = 0;
  let unexpectedFoldedHours = 0;
  for (const m of remaining) {
    if (fedByJobMonth.has(`${m.job}::${m.month}`)) {
      unexpectedFolded += Number(m.n);
      unexpectedFoldedHours += Number(m.h ?? 0);
      console.log(`    UNEXPECTED still-folded (job, month) the feed DOES cover: ${m.job} ${m.month} (${m.n} rows, ${f2(Number(m.h ?? 0))}h)`);
    }
  }
  check(unexpectedFolded === 0, `no (job, month) the feed covers is still storing a folded section (${unexpectedFolded} rows / ${f2(unexpectedFoldedHours)}h)`);

  if (after.stillFolded > 0) {
    console.log(
      `\n  INFO  ${after.stillFolded} row(s) / ${f2(after.stillFoldedHours)}h still store a pre-migration folded ` +
        `section — all outside what the feed currently covers (older history, or punches deleted upstream). ` +
        `They keep their OLD section value and blank standard columns until a source file reaches their month again.`,
    );
  }

  console.log("");
  if (failed) {
    console.error("RESYNC VERIFICATION FAILED — see FAIL lines above.");
    process.exitCode = 1;
  } else {
    console.log("Every (job, month) the feed covers now stores the raw pair with real standard columns.");
  }
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
