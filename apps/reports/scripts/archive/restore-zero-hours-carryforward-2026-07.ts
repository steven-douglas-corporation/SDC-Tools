// One-off repair: restore the zero-hours carry-forward on the 11 cells that a single
// Save batch zeroed on 2026-08-03.
//
// "If no hours were worked this month, New ETC carries Prior ETC forward" is the oldest
// rule in this app. It is a DEFAULT, not a lock — an explicit draft wins, including an
// explicit 0, so a manager can zero a cancelled scope. That override is what these 11
// cells are using, and it is why the app's own arithmetic is not at fault: of July's 262
// zero-hours cells, 0 break the suggestion path.
//
// But all 11 were written in ONE transaction at 2026-08-03T11:02:44.537Z, every one
// `from null -> 0`, across 5 jobs and 8 sections. One batch writing 11 zeros across 5
// jobs is not 11 individual judgements; it is collateral from that morning's churn on
// the New ETC seeding rules, when the boxes briefly rendered a literal "0". Left alone
// they suppress the carry-forward and 230 hours of balance submit as zero.
//
// ── Why it is anchored on the AUDIT BATCH, not on a value match ──────────────
// Selecting "draft = 0 and prior > 0" would also catch deliberate zeros. Two exist and
// must survive: job 52 / 50-211 (changed 20 -> 0 on its own at 15:50) and job 31 /
// 10-211 (prior 0, draft 55). Reading the entry ids out of that one audit row's metadata
// is the only selector that means "the cells that batch touched" rather than "cells that
// look like it".
//
// Restoring = setting newEtcDraft back to NULL, which is what it was before the batch
// (`from: null`). The cell then falls back to the suggestion, which for zero hours worked
// IS the prior. Nothing is invented.
//
// Idempotent and safe to re-run: dry-run unless --apply, and it skips any cell whose
// draft is no longer 0, so a value entered since is never overwritten.
import { prisma } from "@/lib/prisma";
import { round2, suggestNewEtc } from "@/lib/etc";
import { PARTS_COST_SECTION } from "@/lib/sections";

const BATCH_AT = "2026-08-03T11:02:44.537Z";
const MONTH = "2026-07";
const APPLY = process.argv.includes("--apply");

type Change = { entryId: number; from: number | null; to: number | null };

async function main() {
  const audit = await prisma.auditLog.findFirst({
    where: { action: { contains: "saveAllNewEtcDrafts" }, entityId: MONTH, createdAt: new Date(BATCH_AT) },
    select: { createdAt: true, summary: true, metadata: true },
  });
  if (!audit) throw new Error(`No saveAllNewEtcDrafts audit row at ${BATCH_AT} — cannot identify the batch.`);
  console.log(`batch ${audit.createdAt.toISOString()}: ${audit.summary}`);

  const changes = ((audit.metadata as { changes?: Change[] } | null)?.changes ?? []).filter((c) => c.to === 0 && c.from === null);
  console.log(`  writes in that batch that set 0 over nothing: ${changes.length}`);

  const rows = await prisma.etcEntry.findMany({
    where: { id: { in: changes.map((c) => c.entryId) } },
    select: { id: true, jobId: true, section: true, month: true, priorEtc: true, hoursWorked: true, newEtcDraft: true, needsReview: true },
  });

  const targets: { id: number; jobId: number; section: string; prior: number; restoresTo: number }[] = [];
  let skipped = 0;
  for (const r of rows) {
    const prior = round2(Number(r.priorEtc));
    const worked = round2(Number(r.hoursWorked));
    const draft = r.newEtcDraft != null ? round2(Number(r.newEtcDraft)) : null;
    // PARTS_COST stores DOLLARS in these same columns. The first dry run of this script
    // caught 3 of them (a $636,234 cell among them) — restoring those would have moved
    // money forecasts, and Parts Cost is deliberately out of scope: its New ETC must
    // always show a figure, so an explicit $0 there is a decision, not collateral.
    if (r.section === PARTS_COST_SECTION) { skipped++; continue; }
    // Only still-zero, still-unsubmitted, still-zero-hours cells with a real prior.
    if (draft !== 0 || !r.needsReview || worked !== 0 || prior <= 0) { skipped++; continue; }
    targets.push({ id: r.id, jobId: r.jobId, section: r.section, prior, restoresTo: round2(suggestNewEtc(prior, 0)) });
  }

  const hours = targets.reduce((s, t) => s + t.restoresTo, 0);
  console.log(`\nto restore: ${targets.length}   skipped (touched since / not eligible): ${skipped}`);
  for (const t of targets) console.log(`  job=${t.jobId} ${t.section} draft 0 -> null, carries forward ${t.restoresTo}h`);
  console.log(`\ntotal hours returned to the forecast: ${hours}`);

  if (!APPLY) {
    console.log("\nDRY RUN — nothing written. Re-run with --apply.");
    await prisma.$disconnect();
    return;
  }

  await prisma.etcEntry.updateMany({ where: { id: { in: targets.map((t) => t.id) } }, data: { newEtcDraft: null } });
  console.log(`\nRestored ${targets.length} cells (${hours}h) to the zero-hours carry-forward.`);
  await prisma.$disconnect();
}

main();
