// Repairs the 161 August 2026 hours cells that the second submission of 2026-09-11
// overwrote with the carry-forward suggestion (DEVLOG §69; lib/etc.ts newEtcForSubmission).
//
//   npx tsx -r ./scripts/shim-server-only.cjs --tsconfig tsconfig.scripts.json scripts/repair-2026-08-resubmit.ts
//   npx tsx -r ./scripts/shim-server-only.cjs --tsconfig tsconfig.scripts.json scripts/repair-2026-08-resubmit.ts --run
//
// Without --run it writes nothing: it lists every cell it would change and why.
//
// ── What it restores, and from where ────────────────────────────────────────
//
// For every unsubmitted hours row of the month, the manager's figure is the LAST
// value a draft save wrote for that row (AuditLog: etc.saveAllNewEtcDrafts, added /
// edited / removed). Every manager save writes such a row, and none of the paths that
// rewrite a draft silently (redrivenDraft) had touched these — proved by a second,
// independent source: `startMonth("2026-09")` ran between the two submissions and
// seeded each September row's `newEtc` from August's newEtc AT THAT MOMENT, i.e. the
// first submission's figure. The two sources agree on all 161 cells (checked before
// this was written, and re-checked per row below — a disagreement is reported and
// skipped, never guessed at).
//
// Both `newEtc` and `newEtcDraft` are restored. The month is open, so the grid shows
// the draft, and the next submission freezes it whichever build is running; `newEtc`
// is put back to what the first submission legitimately wrote so that September's
// Prior ETC — cascaded from the wrong figure by the second submission — can be
// re-derived right now rather than on the next August submission.
import "dotenv/config";
import { randomUUID } from "crypto";
import { writeFileSync } from "fs";
import { prisma } from "@/lib/prisma";
import { round2 } from "@/lib/etc";
import { PARTS_COST_SECTION, SECTIONS } from "@/lib/sections";
import { derivePriorEtcForMonth } from "@/lib/etc-prior-etc";
import { APP_VERSION } from "@/lib/app-version";

const MONTH = "2026-08";
const NEXT = "2026-09";
// The window in which the damage was done: first submission 19:09:35Z, second 19:25:39Z.
const FIRST_SUBMIT = new Date("2026-09-11T19:09:00Z");
const RUN = process.argv.includes("--run");
const backupArg = process.argv.indexOf("--backup");
const BACKUP = backupArg >= 0 ? process.argv[backupArg + 1] : `repair-2026-08-resubmit.backup.${Date.now()}.json`;

type LastSave = { entityId: string; newValue: string | null; changeType: string; userName: string | null; createdAt: Date };

async function main() {
  const entries = await prisma.etcEntry.findMany({
    where: { month: MONTH, needsReview: true, section: { not: PARTS_COST_SECTION } },
    include: { job: { select: { jobId: true, jobName: true } } },
  });
  const lastSaves = await prisma.$queryRaw<LastSave[]>`
    SELECT a.entityId, a.newValue, a.changeType, a.userName, a.createdAt
    FROM AuditLog a
    JOIN (
      SELECT entityId, MAX(id) AS mid
      FROM AuditLog
      WHERE entityType = 'EtcEntry' AND action = 'etc.saveAllNewEtcDrafts'
        AND changeType IN ('added','edited','removed')
      GROUP BY entityId
    ) l ON l.mid = a.id`;
  const lastByEntity = new Map(lastSaves.map((s) => [s.entityId, s]));
  const septRows = await prisma.etcEntry.findMany({
    where: { month: NEXT },
    select: { jobId: true, section: true, newEtc: true },
  });
  const septSeed = new Map(septRows.map((r) => [`${r.jobId}-${r.section}`, round2(Number(r.newEtc))]));

  const fixes: {
    id: number;
    job: string;
    section: string;
    from: number;
    to: number;
    draftBefore: number | null;
    by: string | null;
    savedAt: Date;
  }[] = [];
  const skipped: string[] = [];

  for (const e of entries) {
    const last = lastByEntity.get(String(e.id));
    if (!last) continue; // nobody ever typed here — the suggestion was right both times
    if (last.createdAt >= FIRST_SUBMIT) continue; // edited after the reopen — already what the manager wants
    if (last.changeType === "removed" || last.newValue == null || last.newValue.trim() === "") {
      // A deliberate clear: both submissions froze the suggestion, which is what a blank submits as.
      continue;
    }
    const target = round2(Number(last.newValue));
    if (!Number.isFinite(target)) {
      skipped.push(`${e.id} ${e.job.jobId} ${e.section}: unparseable audit value "${last.newValue}"`);
      continue;
    }
    const current = round2(Number(e.newEtc));
    if (current === target) continue; // undamaged
    const seed = septSeed.get(`${e.jobId}-${e.section}`);
    if (seed !== undefined && seed !== target) {
      skipped.push(`${e.id} ${e.job.jobId} ${e.section}: audit says ${target}, September seed says ${seed} — not guessing`);
      continue;
    }
    fixes.push({
      id: e.id,
      job: e.job.jobId ?? String(e.jobId),
      section: e.section,
      from: current,
      to: target,
      draftBefore: e.newEtcDraft != null ? round2(Number(e.newEtcDraft)) : null,
      by: last.userName,
      savedAt: last.createdAt,
    });
  }

  console.log(`${MONTH}: ${entries.length} open hours rows, ${fixes.length} to restore, ${skipped.length} skipped`);
  for (const s of skipped) console.log("  SKIP", s);
  console.table(fixes.map((f) => ({ id: f.id, job: f.job, section: f.section, from: f.from, to: f.to, by: f.by })));

  if (!RUN) {
    console.log("\nDry run — nothing written. Re-run with --run to apply.");
    return;
  }
  if (fixes.length === 0) return;

  writeFileSync(BACKUP, JSON.stringify({ month: MONTH, at: new Date().toISOString(), fixes }, null, 2));
  console.log(`Backup of before/after values written to ${BACKUP}`);

  const sectionName = (code: string) => SECTIONS.find((s) => s.code === code)?.name ?? code;
  const columnName = (code: string) => `New ETC (${sectionName(code)})`;
  const changeId = randomUUID();
  const now = new Date();
  await prisma.$transaction(
    async (tx) => {
      for (const f of fixes) {
        // Guarded on the value this run read, so a manager typing into the cell
        // between the dry run and now is never overwritten.
        //
        // Decimal values go in as fixed two-decimal STRINGS, not JS numbers. The first
        // --run aborted on entry 92998 (newEtc 69.15, untouched): a float passed for a
        // Decimal(10,2) column is converted engine-side and does not compare equal for
        // every value — 14.55 matched, 69.15 did not. A string is exact.
        const r = await tx.etcEntry.updateMany({
          where: { id: f.id, needsReview: true, newEtcDraft: null, newEtc: f.from.toFixed(2) },
          data: { newEtc: f.to.toFixed(2), newEtcDraft: f.to.toFixed(2), newEtcClearedAt: null },
        });
        if (r.count !== 1) throw new Error(`entry ${f.id} moved since the dry run — aborting, nothing written`);
        const summary =
          `${columnName(f.section)} for ${f.job} in Monthly ETC restored from ${f.from} to ${f.to} — ` +
          `the figure ${f.by ?? "a manager"} saved, overwritten by the 2026-09-11 re-submission`;
        await tx.$executeRaw`
          INSERT INTO AuditLog
            (userId, userEmail, userName, action, entityType, entityId, summary, metadata, createdAt,
             tab, rowRef, columnName, previousValue, newValue, changeType, appVersion, changeId)
          VALUES
            (NULL, 'akamuju@sdcautomation.com', 'Data repair', 'etc.repairResubmit', 'EtcEntry', ${String(f.id)},
             ${summary}, NULL, ${now},
             'Monthly ETC', ${f.job}, ${columnName(f.section)}, ${String(f.from)}, ${String(f.to)},
             'recalculated', ${APP_VERSION}, ${changeId})`;
      }
    },
    { timeout: 60000 },
  );
  console.log(`Restored ${fixes.length} cells (changeId ${changeId}).`);

  // September's Prior ETC was cascaded from the wrong August figures by the second
  // submission. Same writer the cascade uses; September is open, so it may touch it.
  const rederived = await derivePriorEtcForMonth(NEXT);
  console.log(`${NEXT}: ${rederived.entriesUpdated} Prior ETC re-derived from the restored figures.`);
  const monthSummary =
    `Restored ${fixes.length} August 2026 New ETC cells overwritten by the 2026-09-11 re-submission; ` +
    `${rederived.entriesUpdated} September Prior ETC re-derived`;
  await prisma.$executeRaw`
    INSERT INTO AuditLog (userId, userEmail, userName, action, entityType, entityId, summary, metadata, createdAt, changeId)
    VALUES (NULL, 'akamuju@sdcautomation.com', 'Data repair', 'etc.repairResubmit', 'EtcMonth', ${MONTH},
      ${monthSummary}, ${JSON.stringify({ fixes: fixes.length, rederived, backup: BACKUP })}, ${now}, ${changeId})`;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
