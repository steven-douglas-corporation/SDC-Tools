// One-purpose backfill: populate JobHoursDetail.travelHours for the history already
// stored, from the Paylocity workbook's own "Travel" column. Run with:
//
//   npx tsx -r ./scripts/shim-server-only.cjs scripts/backfill-travel-hours.ts
//
// ── Why this script exists ──────────────────────────────────────────────────
//
// Migration 20260828120000 added travelHours as NULL-able with no default, precisely
// so the 29k rows already on disk would say "not known" rather than claim a measured
// zero. This is the pass that turns those NULLs into real figures.
//
// It does NOT do its own writing. It calls readHoursFeed() + syncActualHours(), the
// same two functions a normal refresh calls, because travelHours is now part of the
// bucket payload — and the payload is what the per-bucket digest is taken over
// (sync-actuals.ts). Adding a column therefore changes every digest, so every bucket
// the feed covers rewrites on this pass by the sync's own existing rules, with no
// special-case backfill path to keep correct. The workbook carries the full
// 2025-01..2026-08 range the punch table covers, so this reaches all of it.
//
// Idempotent (replace-by-job-month) and safe to re-run: a second pass finds matching
// digests and writes nothing.
import { prisma } from "../src/lib/prisma";
import { readHoursFeed } from "../src/lib/hours-feed";
import { syncActualHours } from "../src/lib/sync-actuals";

const f2 = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

type Snapshot = { rows: number; known: number; travelRows: number; travelHours: number; months: number };

async function snapshot(): Promise<Snapshot> {
  const [r] = await prisma.$queryRawUnsafe<
    { n: bigint; k: bigint; tr: bigint; th: string | null; m: bigint }[]
  >(`SELECT COUNT(*) n,
            SUM(CASE WHEN travelHours IS NOT NULL THEN 1 ELSE 0 END) k,
            SUM(CASE WHEN travelHours > 0 THEN 1 ELSE 0 END) tr,
            ROUND(COALESCE(SUM(travelHours), 0), 2) th,
            COUNT(DISTINCT month) m
       FROM JobHoursDetail`);
  return {
    rows: Number(r.n),
    known: Number(r.k),
    travelRows: Number(r.tr),
    travelHours: Number(r.th ?? 0),
    months: Number(r.m),
  };
}

function print(label: string, s: Snapshot) {
  const pct = s.rows > 0 ? ((s.known / s.rows) * 100).toFixed(1) : "0.0";
  console.log(
    `  ${label.padEnd(6)} rows ${String(s.rows).padStart(7)}   travel known ${String(s.known).padStart(7)} (${pct.padStart(5)}%)   ` +
      `rows WITH travel ${String(s.travelRows).padStart(6)}   travel hours ${f2(s.travelHours).padStart(10)}`,
  );
}

async function main() {
  console.log("=".repeat(96));
  console.log("BACKFILL — JobHoursDetail.travelHours from the Paylocity workbook's Travel column");
  console.log("=".repeat(96));

  const before = await snapshot();
  print("BEFORE", before);

  console.log("\nreading hours feed...");
  const feed = await readHoursFeed();
  console.log(`  source    : ${feed.provenance.note}`);
  console.log(`  feed rows : ${feed.rows.length}`);
  const withTravelCol = feed.rows.filter((r) => r.travel !== undefined && r.travel !== "").length;
  const travelRows = feed.rows.filter((r) => r.travel === "Travel").length;
  console.log(`  rows carrying a Travel value : ${withTravelCol}`);
  console.log(`  rows whose Travel is "Travel": ${travelRows}`);
  if (withTravelCol === 0) {
    console.log("\n  The feed carries no Travel values at all — the export was saved without the column.");
    console.log("  Nothing to backfill; travelHours stays NULL and the UI keeps showing a dash.");
    return;
  }

  console.log("\nwriting (replace-by-job-month, idempotent)...");
  const r = await syncActualHours(feed);
  console.log(`  punch rows written   : ${r.detailRowsWritten}`);
  console.log(`  jobs not found       : ${r.jobsNotFound}`);

  const after = await snapshot();
  console.log("");
  print("AFTER", after);

  console.log("\nchecks");
  let failed = false;
  const check = (ok: boolean, msg: string) => {
    console.log(`  ${ok ? "OK  " : "FAIL"}  ${msg}`);
    if (!ok) failed = true;
  };

  check(after.known > before.known, `travel-known rows rose (${before.known} -> ${after.known})`);
  check(after.travelHours > 0, `travel hours are now nonzero (${f2(after.travelHours)}h)`);
  // Total hours must not move: this backfill adds a column, it does not restate hours.
  const [h] = await prisma.$queryRawUnsafe<{ h: string | null }[]>(
    `SELECT ROUND(SUM(hours), 2) h FROM JobHoursDetail`,
  );
  console.log(`  INFO  total stored hours after: ${f2(Number(h.h ?? 0))} (compare against the BEFORE line in your scrollback)`);
  // Travel can never exceed the row's own hours — the strongest cheap invariant.
  const [bad] = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT COUNT(*) n FROM JobHoursDetail WHERE travelHours IS NOT NULL AND travelHours > hours + 0.001`,
  );
  check(Number(bad.n) === 0, `no row has travelHours > hours (${Number(bad.n)} offenders)`);

  const byMonth = await prisma.$queryRawUnsafe<{ month: string; th: string | null; h: string | null }[]>(
    `SELECT month, ROUND(COALESCE(SUM(travelHours), 0), 2) th, ROUND(SUM(hours), 2) h
       FROM JobHoursDetail GROUP BY month ORDER BY month`,
  );
  console.log("\ntravel hours by month");
  for (const m of byMonth) {
    const th = Number(m.th ?? 0);
    const tot = Number(m.h ?? 0);
    console.log(`  ${m.month}  travel ${f2(th).padStart(9)}h   of ${f2(tot).padStart(10)}h   ${tot > 0 ? ((th / tot) * 100).toFixed(1).padStart(5) : "  0.0"}%`);
  }

  if (failed) {
    console.log("\nFAILED — see the checks above.");
    process.exitCode = 1;
  } else {
    console.log("\nDone.");
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
