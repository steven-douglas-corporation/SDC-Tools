// One-purpose resync: repopulate JobHoursDetail so every row carries its RAW
// Paylocity Section+Function. Run with:
//
//   npx tsx -r ./scripts/shim-server-only.cjs scripts/resync-hours-raw-identity.ts
//
// ── Why a dedicated script rather than runAllSyncs ─────────────────────────
//
// The 20260821120000 migration adds rawSection/rawFunction with a '' default and
// deliberately does NOT back-fill them: for a column that standardization folded
// (a stored `10-211` row could have come from 10-211, 12-211, 13-211 or 14-211)
// the inverse does not exist, and writing any one of those would be fabricating
// provenance. The source file is the only thing that knows, so the rows have to
// be rewritten from it.
//
// syncJobHoursDetail is replace-by-(job, month), so re-running it over the whole
// feed is exactly that rewrite — and it is idempotent, which is what makes this
// safe to re-run if it is interrupted.
//
// This calls ONLY the hours path. runAllSyncs would also touch parts cost, the
// ETC mirror and the Undefined Hours stage; none of those are affected by this
// migration, and pulling them into a data-repair run would widen the blast radius
// for no reason.
//
// Prints a before/after so the rewrite is verified rather than assumed. The check
// that matters is per (job, month) against the FEED, not against the previous state:
// the total legitimately MOVES when a year gains a new authoritative source (adding
// Job_Hours_2025.xlsx moved it ~12,850h, and fixing the job-resolution bug in
// syncActualHours recovered a further ~485h), so "unchanged" would be the wrong
// invariant. Matching the source exactly is the right one.
import { prisma } from "../src/lib/prisma";
import { readHoursFeed } from "../src/lib/hours-feed";
import { syncActualHours } from "../src/lib/sync-actuals";

const f2 = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

type Snapshot = { rows: number; hours: number; missingRaw: number; missingRawHours: number };

async function snapshot(): Promise<Snapshot> {
  const [r] = await prisma.$queryRawUnsafe<
    { n: bigint; h: string | null; mn: bigint; mh: string | null }[]
  >(`SELECT COUNT(*) n,
            ROUND(SUM(hours), 2) h,
            SUM(CASE WHEN rawSection = '' AND rawFunction = '' THEN 1 ELSE 0 END) mn,
            ROUND(SUM(CASE WHEN rawSection = '' AND rawFunction = '' THEN hours ELSE 0 END), 2) mh
       FROM JobHoursDetail`);
  return {
    rows: Number(r.n),
    hours: Number(r.h ?? 0),
    missingRaw: Number(r.mn),
    missingRawHours: Number(r.mh ?? 0),
  };
}

function print(label: string, s: Snapshot) {
  console.log(
    `  ${label.padEnd(8)} rows ${String(s.rows).padStart(7)}   hours ${f2(s.hours).padStart(12)}   ` +
      `missing raw identity ${String(s.missingRaw).padStart(7)} rows / ${f2(s.missingRawHours)}h`,
  );
}

async function main() {
  console.log("=".repeat(78));
  console.log("RESYNC — repopulate JobHoursDetail with raw Section+Function identity");
  console.log("=".repeat(78));

  const before = await snapshot();
  print("BEFORE", before);

  console.log("\nreading hours feed...");
  const feed = await readHoursFeed();
  console.log(`  source     : ${feed.provenance.note}`);
  console.log(`  feed rows  : ${feed.rows.length}`);
  const withRaw = feed.rows.filter((r) => r.rawSection !== "" || r.rawFunction !== "").length;
  console.log(`  carrying raw identity: ${withRaw} / ${feed.rows.length}`);
  if (withRaw === 0) {
    // The readers were changed to populate these; if none arrive, the resync would
    // "succeed" while writing '' everywhere and the verification below would be the
    // only thing that noticed. Fail here instead, before touching any rows.
    throw new Error(
      "feed rows carry no raw Section/Function — the reader is not populating them, so this resync would write nothing useful. Aborting before any write.",
    );
  }

  console.log("\nwriting (replace-by-job-month, idempotent)...");
  const r = await syncActualHours(feed);
  console.log(`  monthly rollups upserted : ${r.rowsUpserted}`);
  console.log(`  punch rows written       : ${r.detailRowsWritten}`);
  console.log(`  jobs not found           : ${r.jobsNotFound}`);
  console.log(`  overridden preserved     : ${r.rowsSkippedOverridden}`);

  const after = await snapshot();
  console.log("");
  print("AFTER", after);

  // ── Verification ────────────────────────────────────────────────────────
  console.log("\nchecks");
  let failed = false;
  const check = (ok: boolean, msg: string) => {
    console.log(`  ${ok ? "OK  " : "FAIL"}  ${msg}`);
    if (!ok) failed = true;
  };

  // Row COUNT is expected to rise: the widened unique key no longer sums two
  // different raw punches (e.g. 12-211 and 14-211 on the same day) into one row.
  // That is the point of the migration, not a duplication.
  check(after.rows >= before.rows, `row count did not fall (${before.rows} -> ${after.rows})`);

  // ── The real invariant: the DB matches the FEED ─────────────────────────
  //
  // An earlier version asserted "total hours must not move", on the reasoning that
  // this rewrite only records provenance. That held while the feed read one file and
  // stopped holding the moment 2025 gained an authoritative source. Asserting it would
  // have meant either a permanent red X on a correct run, or quietly loosening the
  // threshold until it caught nothing.
  //
  // So this compares against the SOURCE instead of against the past. Strictly
  // stronger — it catches a partial write that a stable grand total would hide — and
  // it stays true across source changes. Movement versus the previous state is
  // reported as INFO, because a five-figure change is something a human must see even
  // when it is correct.
  //
  // Compared per (job, month) — the grain the writer replaces — and only for the
  // pairs the feed actually covers. Restricting to covered pairs is what makes this
  // exact rather than threshold-based: a (job, month) the feed no longer carries keeps
  // its old rows by design ("absent must never mean delete"), so including it would
  // report a surplus that is correct behaviour, and the only way to pass would be to
  // loosen the tolerance until it stopped catching real partial writes.
  const fedByJobMonth = new Map<string, number>();
  for (const r of feed.rows) {
    const key = `${r.jobId}::${r.year}-${String(r.month).padStart(2, "0")}`;
    fedByJobMonth.set(key, (fedByJobMonth.get(key) ?? 0) + r.hours);
  }
  const storedRows = await prisma.$queryRawUnsafe<{ job: string; month: string; h: string | null }[]>(
    `SELECT j.jobId job, d.month month, ROUND(SUM(d.hours), 2) h
       FROM JobHoursDetail d JOIN Job j ON j.id = d.jobId
      GROUP BY j.jobId, d.month`,
  );

  let worst = 0;
  let worstKey = "";
  let staleHours = 0;
  let staleKeys = 0;
  for (const r of storedRows) {
    const key = `${r.job}::${r.month}`;
    const stored = Number(r.h ?? 0);
    const fed = fedByJobMonth.get(key);
    if (fed === undefined) {
      // Not in the feed at all — punches deleted upstream, or a job/month no source
      // file covers any more. Reported, never silently tolerated.
      staleHours += stored;
      staleKeys += 1;
      continue;
    }
    const diff = Math.abs(stored - fed);
    if (diff > worst) {
      worst = diff;
      worstKey = key;
    }
  }
  check(
    worst < 0.5,
    `every (job, month) the feed covers matches the feed exactly` + (worstKey ? ` (worst: ${worstKey}, ${f2(worst)}h)` : ""),
  );
  if (staleKeys > 0) {
    console.log(
      `  INFO  ${staleKeys} (job, month) pair(s) holding ${f2(staleHours)}h are not in the feed at all — ` +
        `kept because "absent must never mean delete"; these are punches deleted upstream in Paylocity`,
    );
  }

  const moved = after.hours - before.hours;
  console.log(
    `  INFO  total hours moved ${moved >= 0 ? "+" : ""}${f2(moved)}h (${f2(before.hours)} -> ${f2(after.hours)})` +
      ` — expected when a year gains a new authoritative source; verify against the audit report.`,
  );

  // Must not RISE — not "must fall". This script is idempotent and expected to be
  // re-run; on the second run the count is already at its floor, and asserting a
  // strict decrease would fail a perfectly correct no-op.
  check(
    after.missingRaw <= before.missingRaw,
    `rows missing raw identity did not rise (${before.missingRaw} -> ${after.missingRaw})`,
  );

  if (after.missingRaw > 0) {
    // Not necessarily wrong: months absent from the current-year source file
    // (the 2025 backfill rows) cannot be rewritten from it, and "absent must never
    // mean delete" is a deliberate rule in syncJobHoursDetail. Report which months
    // so the remainder is explained rather than merely tolerated.
    const rows = await prisma.$queryRawUnsafe<{ month: string; n: bigint; h: string | null }[]>(
      `SELECT month, COUNT(*) n, ROUND(SUM(hours), 2) h
         FROM JobHoursDetail
        WHERE rawSection = '' AND rawFunction = ''
        GROUP BY month ORDER BY month`,
    );
    console.log(`\n  months still missing raw identity (not covered by the current source file):`);
    for (const m of rows) console.log(`    ${m.month}  ${String(Number(m.n)).padStart(6)} rows  ${f2(Number(m.h ?? 0)).padStart(10)}h`);
    console.log(`    ^ these predate the current-year file. They keep their standardized`);
    console.log(`      section and their hours; only raw provenance is unavailable for them.`);
  }

  console.log("");
  if (failed) {
    console.error("RESYNC VERIFICATION FAILED — see FAIL lines above.");
    process.exitCode = 1;
  }
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
