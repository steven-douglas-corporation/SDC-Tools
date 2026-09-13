// Purge ORPHANED derived hours rows — rows whose source punch no longer exists in any
// authoritative Paylocity workbook.
//
//   npx tsx -r ./scripts/shim-server-only.cjs scripts/purge-stale-hours-rows.ts          # dry run (default)
//   npx tsx -r ./scripts/shim-server-only.cjs scripts/purge-stale-hours-rows.ts --apply  # actually delete
//
// ── What makes a row safe to delete, and why this needs a script at all ────
//
// syncJobHoursDetail is replace-by-(job, month) and deliberately leaves months the feed
// does not cover alone: "absent must never mean delete" protects history against a
// failed or partial read. The cost of that rule is that a punch DELETED upstream in
// Paylocity lingers forever, because the resync never revisits its (job, month).
//
// Such a row is identified by two conditions together, and both are required:
//
//   1. It carries no raw identity (rawSection = rawFunction = ''), so it predates the
//      raw-identity migration and has never been rewritten from a source file.
//   2. Its (job, month) is absent from the CURRENT feed entirely — no source workbook
//      describes it.
//
// Condition 1 alone is not enough: a punch with a genuinely blank MachineSec cell also
// stores '' and is a real, current punch. Condition 2 alone is not enough either: a
// month the feed simply does not reach (2024 and earlier, which has no punch-grain
// source at all) must be preserved, not purged.
//
// JobHoursDetail is DERIVED data — rebuilt from the workbooks on every sync — so
// removing an orphan loses nothing that the source can still produce. Nothing
// user-entered is touched: ETC drafts, overrides, quoted hours and submissions all live
// in other tables and are not referenced here.
//
// Dry run is the default, and the row list is printed either way, because this deletes
// production rows and the operator should see exactly what goes.
import { prisma } from "../src/lib/prisma";
import { readHoursFeed } from "../src/lib/hours-feed";

const f2 = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

async function main() {
  const apply = process.argv.includes("--apply");

  console.log("=".repeat(84));
  console.log(`PURGE STALE DERIVED HOURS ROWS — ${apply ? "APPLY (rows will be deleted)" : "DRY RUN (nothing will change)"}`);
  console.log("=".repeat(84));

  const feed = await readHoursFeed();
  console.log(`feed: ${feed.provenance.note}`);

  // Every (job, month) the feed can currently describe.
  const covered = new Set(feed.rows.map((r) => `${r.jobId}::${r.year}-${String(r.month).padStart(2, "0")}`));
  console.log(`(job, month) pairs the feed covers: ${covered.size}`);

  const candidates = await prisma.jobHoursDetail.findMany({
    where: { rawSection: "", rawFunction: "" },
    select: { id: true, jobId: true, month: true, workDate: true, employeeId: true, section: true, hours: true, job: { select: { jobId: true } } },
    orderBy: [{ month: "asc" }],
  });
  console.log(`rows with no raw identity: ${candidates.length}`);

  const orphans = candidates.filter((r) => !covered.has(`${r.job.jobId}::${r.month}`));
  const preserved = candidates.filter((r) => covered.has(`${r.job.jobId}::${r.month}`));

  if (preserved.length > 0) {
    // These share condition 1 but not condition 2 — the feed DOES cover their
    // (job, month), so they are current punches whose Section/Function cell is blank.
    // Real data. Named here so their survival is deliberate and visible.
    console.log(`\nPRESERVED (${preserved.length} rows, ${f2(preserved.reduce((s, r) => s + Number(r.hours), 0))}h) — blank Section/Function cell on a punch the feed still carries:`);
    for (const r of preserved.slice(0, 20)) {
      console.log(`  job ${r.job.jobId.padEnd(8)} ${r.workDate.toISOString().slice(0, 10)}  emp ${r.employeeId.padEnd(10)} ${r.section.padEnd(10)} ${f2(Number(r.hours)).padStart(8)}h`);
    }
    if (preserved.length > 20) console.log(`  ... and ${preserved.length - 20} more`);
  }

  if (orphans.length === 0) {
    console.log("\nNo orphaned rows. Nothing to do.");
    await prisma.$disconnect();
    return;
  }

  const orphanHours = orphans.reduce((s, r) => s + Number(r.hours), 0);
  console.log(`\nORPHANED (${orphans.length} rows, ${f2(orphanHours)}h) — no source workbook describes their (job, month):`);
  for (const r of orphans) {
    console.log(
      `  job ${r.job.jobId.padEnd(8)} ${r.workDate.toISOString().slice(0, 10)}  emp ${r.employeeId.padEnd(10)} ${r.section.padEnd(10)} ${f2(Number(r.hours)).padStart(8)}h  (id ${r.id})`,
    );
  }

  if (!apply) {
    console.log(`\nDRY RUN — nothing deleted. Re-run with --apply to delete these ${orphans.length} row(s).`);
    await prisma.$disconnect();
    return;
  }

  const before = Number((await prisma.jobHoursDetail.aggregate({ _sum: { hours: true } }))._sum.hours ?? 0);
  const result = await prisma.jobHoursDetail.deleteMany({ where: { id: { in: orphans.map((r) => r.id) } } });
  const after = Number((await prisma.jobHoursDetail.aggregate({ _sum: { hours: true } }))._sum.hours ?? 0);

  // ── The refresh's per-bucket digests have to be told (2026-08-25) ─────────
  //
  // syncJobHoursDetail skips rewriting a (job, month) bucket whose stored digest still
  // matches what it would write. Deleting rows here without clearing those digests
  // would leave the cache asserting a state the table is no longer in.
  //
  // The refresh would in fact still heal it — it cross-checks every skipped bucket's row
  // count and hours total against the table and rewrites on any disagreement — but that
  // presents as unexplained drift, with a warning logged per bucket. Clearing the
  // digests here says "this was us, deliberately", and the next pass just rewrites.
  const { invalidateJobHoursDigests } = await import("../src/lib/sync-actuals");
  const dropped = await invalidateJobHoursDigests([...new Set(orphans.map((r) => r.jobId))]);

  console.log(`\ndeleted ${result.count} row(s)`);
  console.log(`  cleared ${dropped} punch-bucket digest(s) so the next refresh rewrites them`);
  console.log(`  total hours ${f2(before)} -> ${f2(after)} (removed ${f2(before - after)}h)`);
  const expected = Math.abs(before - after - orphanHours) < 0.01;
  console.log(`  ${expected ? "OK  " : "FAIL"}  removed exactly the orphaned hours (expected ${f2(orphanHours)}h)`);
  if (!expected) process.exitCode = 1;

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
