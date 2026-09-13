/**
 * Create the missing year-based Service jobs (2026-08-24).
 *
 * Why these rows are needed
 * ------------------------
 * Paylocity's job cell carries a NAME rather than a number for standing overhead
 * categories. lib/job-label.ts now resolves those names against the job master,
 * which recovered "2025 SERVICE" (781.75h) because jobId 10001 "2025 Service"
 * already existed. Three years have no Job row at all, so their punches have
 * nothing to attach to and stay JOB_NOT_FOUND:
 *
 *   "2023_SER"        9.73h
 *   "2024_SER"       17.17h
 *   "2026 SERVICE"   63.27h   <- the reported case (63.266664 in the source)
 *
 * Creating these rows is the whole remaining fix. No code changes with it: the
 * label index is rebuilt from the Job table on every read, so the next Refresh
 * Data attributes those punches automatically.
 *
 * This is NOT inserting hours or faking a dropdown entry. It creates the job
 * records the punches already reference, exactly as jobId 10001 was created for
 * 2025, and the hours then flow through the normal pipeline.
 *
 * Numbering
 * ---------
 * Follows the existing precedent: 10000 "StateLogic Diagrams" and 10001
 * "2025 Service" are app-created overhead jobs in a synthetic 10000-range, kept
 * clear of real TotalETO job numbers (four digits). 10002-10004 are free —
 * asserted below rather than assumed, so a collision stops the script instead of
 * writing over something.
 *
 * Field values are copied from jobId 10001, so these sit in every list and
 * calculation exactly as the 2025 job already does: customer SDC, type Custom,
 * source manual, billable 0, includeInTypeCalc 0, excludedFromStandardFees 0.
 *
 * Status is the one deliberate departure, and it is a judgement call worth
 * seeing: 2026 is the current year and gets Active like 10001, but 2023 and 2024
 * are closed years, so they are Complete. Marking them Active would add two dead
 * categories to the "Active" group in every job filter. Change the STATUS values
 * below if you would rather they match 10001 exactly.
 *
 * Run with:
 *   npx tsx -r ./scripts/shim-server-only.cjs scripts/create-service-jobs.ts
 *
 * Add --apply to write. Without it this is a dry run.
 * Safe to re-run: it skips any job that already exists.
 */

import { prisma } from "@/lib/prisma";
import { logAuditFor } from "@/lib/audit";
import { buildJobLabelIndex, resolveJobLabel } from "@/lib/job-label";

const ACTOR_EMAIL = "akamuju@sdcautomation.com";

/** The label each row must make resolvable, so the script can prove it worked. */
const TARGETS = [
  { jobId: "10002", jobName: "2023 Service", status: "Complete", sourceLabel: "2023_SER" },
  { jobId: "10003", jobName: "2024 Service", status: "Complete", sourceLabel: "2024_SER" },
  { jobId: "10004", jobName: "2026 Service", status: "Active", sourceLabel: "2026 SERVICE" },
];

async function main() {
  const apply = process.argv.includes("--apply");

  const existing = await prisma.job.findMany({
    where: { OR: [{ jobId: { in: TARGETS.map((t) => t.jobId) } }, { jobName: { in: TARGETS.map((t) => t.jobName) } }] },
    select: { jobId: true, jobName: true },
  });

  const todo: typeof TARGETS = [];
  for (const t of TARGETS) {
    const byId = existing.find((e) => e.jobId === t.jobId);
    const byName = existing.find((e) => e.jobName === t.jobName);
    if (byName) {
      console.log(`  skip  ${t.jobName} — already exists as jobId ${byName.jobId}`);
      continue;
    }
    if (byId) {
      // The number is taken by something else. Stop rather than pick another
      // silently: the numbering is deliberate and a surprise here means the job
      // master is not what this script was written against.
      throw new Error(`jobId ${t.jobId} is already "${byId.jobName}" — refusing to renumber. Pick a free number and update TARGETS.`);
    }
    todo.push(t);
  }

  if (todo.length === 0) {
    console.log("\nNothing to create — all three Service jobs already exist.");
    await report();
    await prisma.$disconnect();
    return;
  }

  console.log(`\n${apply ? "Creating" : "[DRY RUN] Would create"} ${todo.length} job(s):\n`);
  for (const t of todo) {
    console.log(`  jobId ${t.jobId}  "${t.jobName}"  status=${t.status}   (resolves Paylocity label "${t.sourceLabel}")`);
  }

  if (!apply) {
    console.log("\nDry run — nothing written. Re-run with --apply to create them.");
    await prisma.$disconnect();
    return;
  }

  const actor = await prisma.user.findUnique({ where: { email: ACTOR_EMAIL }, select: { id: true } });

  console.log("");
  for (const t of todo) {
    const created = await prisma.job.create({
      data: {
        jobId: t.jobId,
        jobName: t.jobName,
        status: t.status,
        // Mirrors jobId 10001 exactly — see the header.
        customer: "SDC",
        type: "Custom",
        source: "manual",
        billable: false,
        includeInTypeCalc: false,
        excludedFromStandardFees: false,
        costQuotedManuallyEdited: false,
        customerManuallyEdited: false,
      },
      select: { id: true, jobId: true, jobName: true },
    });
    await logAuditFor(actor?.id ?? null, ACTOR_EMAIL, {
      action: "job.createServiceCategory",
      entityType: "Job",
      entityId: created.id,
      summary:
        `Created ${created.jobId} "${created.jobName}" (${t.status}) so Paylocity label "${t.sourceLabel}" resolves — ` +
        `punches existed but had no job to attach to`,
      metadata: { jobId: created.jobId, jobName: created.jobName, status: t.status, paylocityLabel: t.sourceLabel },
    });
    console.log(`  created  ${created.jobId}  "${created.jobName}"`);
  }

  await report();
  console.log(`\nDone. Run Refresh Data in the app to attribute the punches — no code change needed.`);
  await prisma.$disconnect();
}

/** Prove the labels now resolve, using the same index the importer builds. */
async function report() {
  const jobs = await prisma.job.findMany({ select: { jobId: true, jobName: true } });
  const idx = buildJobLabelIndex(jobs);
  console.log("\nLabel resolution after this change:");
  for (const label of ["2023_SER", "2024_SER", "2025 SERVICE", "2026 SERVICE", "2026 Spare Parts", "Not Defined"]) {
    const hit = resolveJobLabel(label, idx);
    const name = hit ? jobs.find((j) => j.jobId === hit)?.jobName : null;
    console.log(`  "${label}"`.padEnd(22) + ` -> ${hit ? `jobId ${hit} "${name}"` : "unresolved"}`);
  }
}

main().catch(async (err) => {
  console.error("Failed:", err instanceof Error ? err.message : err);
  await prisma.$disconnect();
  process.exit(1);
});
