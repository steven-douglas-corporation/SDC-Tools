// Purge ORPHANED derived hours rows — rows whose source punch no longer exists in any
// authoritative Paylocity workbook.
//
//   npx tsx -r ./scripts/shim-server-only.cjs scripts/purge-stale-hours-rows.ts          # dry run (default)
//   npx tsx -r ./scripts/shim-server-only.cjs scripts/purge-stale-hours-rows.ts --apply  # actually delete
//
// Two kinds of orphan are reported, and both are deleted on --apply:
//
// ── A. Rows with no raw identity, in a (job, month) the feed does not describe ─────
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
// ── B. Departed (job, month) buckets — the feed covers the MONTH but not the pair ──
//
// Added 2026-09-14, alongside the sync fix that now removes these itself. A (job, month)
// whose punches ALL moved away upstream (every July punch on 1104 recoded to 1145) had
// zero rows in the new feed, so the replace-by-(job, month) write never visited it and
// its stored punches, its JobHoursBucket digest AND its JobMonthlyActualHours rollup all
// persisted — both jobs carried the hours. syncJobHoursDetail/syncActualHours now judge
// every stored pair inside the months the feed carries rows for (monthsAccountedFor) and
// remove/zero the departed ones on each pass. This script reports the same set BEFORE the
// next sync runs, so the operator can inspect exactly what will go. Overridden rollups
// are listed but never touched, same as the sync.
//
// JobHoursDetail and JobHoursBucket are DERIVED data — rebuilt from the workbooks on every
// sync — so removing an orphan loses nothing that the source can still produce. Nothing
// user-entered is touched: ETC drafts, overrides, quoted hours and submissions all live
// in other tables and are not referenced here.
//
// Dry run is the default, and the row list is printed either way, because this deletes
// production rows and the operator should see exactly what goes.
import { prisma } from "../src/lib/prisma";
import { readHoursFeed } from "../src/lib/hours-feed";
import { monthsAccountedFor, departedJobMonths } from "../src/lib/sync-actuals";

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

  // ── A. Raw-identity orphans ───────────────────────────────────────────────
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

  const orphanHours = orphans.reduce((s, r) => s + Number(r.hours), 0);
  if (orphans.length === 0) {
    console.log("\nA. No raw-identity orphans.");
  } else {
    console.log(`\nA. ORPHANED (${orphans.length} rows, ${f2(orphanHours)}h) — no source workbook describes their (job, month):`);
    for (const r of orphans) {
      console.log(
        `  job ${r.job.jobId.padEnd(8)} ${r.workDate.toISOString().slice(0, 10)}  emp ${r.employeeId.padEnd(10)} ${r.section.padEnd(10)} ${f2(Number(r.hours)).padStart(8)}h  (id ${r.id})`,
      );
    }
  }

  // ── B. Departed (job, month) buckets — the same set the next sync will remove ──
  const months = monthsAccountedFor(feed.rows);
  const jobs = await prisma.job.findMany({ where: { jobId: { in: [...new Set(feed.rows.map((r) => r.jobId))] } }, select: { id: true, jobId: true } });
  const pkByJobId = new Map(jobs.map((j) => [j.jobId, j.id]));
  const presentInFeed = new Set<string>();
  for (const key of covered) {
    const [jobId, month] = key.split("::");
    const pk = pkByJobId.get(jobId);
    if (pk != null) presentInFeed.add(`${pk}::${month}`);
  }

  const bucketAgg = await prisma.jobHoursDetail.groupBy({
    by: ["jobId", "month"],
    where: { month: { in: [...months] } },
    _count: true,
    _sum: { hours: true },
  });
  const digestRows = await prisma.jobHoursBucket.findMany({ where: { month: { in: [...months] } }, select: { jobId: true, month: true } });
  const storedBuckets = new Map<string, { jobPk: number; month: string; rows: number; hours: number }>();
  for (const a of bucketAgg) storedBuckets.set(`${a.jobId}::${a.month}`, { jobPk: a.jobId, month: a.month, rows: a._count, hours: Number(a._sum.hours ?? 0) });
  for (const d of digestRows) {
    const key = `${d.jobId}::${d.month}`;
    if (!storedBuckets.has(key)) storedBuckets.set(key, { jobPk: d.jobId, month: d.month, rows: 0, hours: 0 });
  }
  const departedBuckets = departedJobMonths([...storedBuckets.values()], presentInFeed, months);

  const rollups = await prisma.jobMonthlyActualHours.findMany({
    where: { month: { in: [...months] }, actualHours: { not: 0 } },
    select: { id: true, jobId: true, month: true, actualHours: true, overridden: true },
  });
  const departedRollups = departedJobMonths(
    rollups.map((r) => ({ jobPk: r.jobId, month: r.month, id: r.id, actualHours: Number(r.actualHours), overridden: r.overridden })),
    presentInFeed,
    months,
  );

  const jobLabel = new Map((await prisma.job.findMany({ where: { id: { in: [...new Set([...departedBuckets, ...departedRollups].map((d) => d.jobPk))] } }, select: { id: true, jobId: true } })).map((j) => [j.id, j.jobId]));
  const departedHours = departedBuckets.reduce((s, d) => s + d.hours, 0);
  if (departedBuckets.length === 0 && departedRollups.length === 0) {
    console.log(`\nB. No departed (job, month) buckets across the ${months.size} month(s) the feed accounts for.`);
  } else {
    console.log(`\nB. DEPARTED punch buckets (${departedBuckets.length}, ${departedHours > 0 ? `${f2(departedHours)}h` : "digest only"}) — the feed covers the month but no longer carries the (job, month):`);
    for (const d of departedBuckets) {
      console.log(`  job ${(jobLabel.get(d.jobPk) ?? `pk ${d.jobPk}`).padEnd(8)} ${d.month}  ${String(d.rows).padStart(4)} rows ${f2(d.hours).padStart(9)}h`);
    }
    const zeroable = departedRollups.filter((r) => !r.overridden);
    const kept = departedRollups.filter((r) => r.overridden);
    console.log(`\n   DEPARTED rollups (JobMonthlyActualHours): ${zeroable.length} to zero${kept.length ? `, ${kept.length} overridden and left alone` : ""}:`);
    for (const r of departedRollups) {
      console.log(`  job ${(jobLabel.get(r.jobPk) ?? `pk ${r.jobPk}`).padEnd(8)} ${r.month}  ${f2(r.actualHours).padStart(9)}h${r.overridden ? "  (OVERRIDDEN — preserved)" : ""}`);
    }
  }

  const nothingToDo = orphans.length === 0 && departedBuckets.length === 0 && departedRollups.every((r) => r.overridden);
  if (nothingToDo) {
    console.log("\nNothing to do.");
    await prisma.$disconnect();
    return;
  }

  if (!apply) {
    console.log(`\nDRY RUN — nothing deleted. Re-run with --apply to remove the rows above (the next hours sync would remove section B on its own).`);
    await prisma.$disconnect();
    return;
  }

  const before = Number((await prisma.jobHoursDetail.aggregate({ _sum: { hours: true } }))._sum.hours ?? 0);

  // A. Raw-identity orphans, then clear their jobs' digests.
  //
  // syncJobHoursDetail skips rewriting a (job, month) bucket whose stored digest still
  // matches what it would write. Deleting rows here without clearing those digests
  // would leave the cache asserting a state the table is no longer in. The refresh would
  // in fact still heal it — it cross-checks every skipped bucket's row count and hours
  // total against the table and rewrites on any disagreement — but that presents as
  // unexplained drift, with a warning logged per bucket. Clearing the digests here says
  // "this was us, deliberately", and the next pass just rewrites.
  let deletedA = 0;
  if (orphans.length > 0) {
    deletedA = (await prisma.jobHoursDetail.deleteMany({ where: { id: { in: orphans.map((r) => r.id) } } })).count;
    const { invalidateJobHoursDigests } = await import("../src/lib/sync-actuals");
    const dropped = await invalidateJobHoursDigests([...new Set(orphans.map((r) => r.jobId))]);
    console.log(`\nA. deleted ${deletedA} row(s); cleared ${dropped} punch-bucket digest(s) so the next refresh rewrites them`);
  }

  // B. Departed buckets: rows and digest together, exactly as the sync does it.
  let deletedB = 0;
  for (let i = 0; i < departedBuckets.length; i += 200) {
    const where = { OR: departedBuckets.slice(i, i + 200).map((d) => ({ jobId: d.jobPk, month: d.month })) };
    const [rows] = await prisma.$transaction([prisma.jobHoursDetail.deleteMany({ where }), prisma.jobHoursBucket.deleteMany({ where })]);
    deletedB += rows.count;
  }
  const zeroable = departedRollups.filter((r) => !r.overridden);
  const zeroed = zeroable.length > 0
    ? (await prisma.jobMonthlyActualHours.updateMany({ where: { id: { in: zeroable.map((r) => r.id) } }, data: { actualHours: 0, syncedAt: new Date(), source: "paylocity_excel" } })).count
    : 0;
  console.log(`B. removed ${departedBuckets.length} departed bucket(s) (${deletedB} row(s)) with their digests; zeroed ${zeroed} rollup(s)`);

  const after = Number((await prisma.jobHoursDetail.aggregate({ _sum: { hours: true } }))._sum.hours ?? 0);
  const expectedRemoved = orphanHours + departedHours;
  console.log(`\n  total hours ${f2(before)} -> ${f2(after)} (removed ${f2(before - after)}h)`);
  const expected = Math.abs(before - after - expectedRemoved) < 0.01;
  console.log(`  ${expected ? "OK  " : "FAIL"}  removed exactly the listed hours (expected ${f2(expectedRemoved)}h)`);
  if (!expected) process.exitCode = 1;

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
