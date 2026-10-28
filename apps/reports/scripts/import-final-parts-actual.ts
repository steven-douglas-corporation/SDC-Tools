import "dotenv/config";
import XLSX from "xlsx";
import fs from "fs";
import path from "path";
import { prisma } from "../src/lib/prisma";
import { FINAL_PARTS_ACTUAL_BELOW_JOB, hasFinalPartsActual } from "../src/lib/parts-actual-final";

// ── Load the FINAL Parts Cost Actual for closed jobs below 1100 (2026-10-28) ─────────────────────
//
//   npx tsx -r ./scripts/shim-server-only.cjs scripts/import-final-parts-actual.ts "K:/New folder"            (dry run)
//   npx tsx -r ./scripts/shim-server-only.cjs scripts/import-final-parts-actual.ts "K:/New folder" --apply
//
// Source: the Sage "Jobs summarized by GL account" workbooks (sheet "Job Ledger"). Each job has one row with
// Phase ID = "Total"; its Net DR/CR is the job's final figure. Written to Job.costActualHistorical, which the
// Projects tab, Parts Cost vs Budget and the Job Cost Explorer's Parts Invoiced read. Jobs from 1100 up are
// never touched (they come from Total ETO), and syncPartsCostActual skips the jobs written here
// (lib/parts-actual-final.ts), so a later sync cannot undo this.
//
// Dry run by default: prints every change and writes nothing. --apply writes in one transaction, only rows
// whose value actually changes, so it is safe to re-run.

const dir = process.argv[2];
const apply = process.argv.includes("--apply");
const includeNotComplete = process.argv.includes("--include-not-complete");
if (!dir || dir.startsWith("--")) {
  console.error("Usage: import-final-parts-actual.ts <folder with the .xlsx files> [--apply]");
  process.exit(1);
}

const usd = (n: number | null) => (n == null ? "—" : (n < 0 ? "-" : "") + "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const round2 = (n: number) => Math.round(n * 100) / 100;

async function main() {
  const sheet = new Map<string, { value: number; file: string }>();
  const problems: string[] = [];

  for (const f of fs.readdirSync(dir).filter((x) => x.toLowerCase().endsWith(".xlsx") && !x.startsWith("~$"))) {
    const wb = XLSX.readFile(path.join(dir, f));
    const ws = wb.Sheets["Job Ledger"];
    if (!ws) { problems.push(`${f}: no "Job Ledger" sheet`); continue; }
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: null });
    for (const r of rows) {
      if (r[1] !== "Total" || r[0] == null) continue;
      const id = String(r[0]).trim();
      if (id === "Report") continue; // the workbook's grand total
      const value = Number(r[7]);
      if (!Number.isFinite(value)) { problems.push(`${f}: job ${id} has no numeric Net DR/CR`); continue; }
      const prev = sheet.get(id);
      if (prev && Math.abs(prev.value - value) > 0.005) { problems.push(`job ${id} appears in ${prev.file} and ${f} with different values`); continue; }
      sheet.set(id, { value: round2(value), file: f });
    }
  }

  const jobs = await prisma.job.findMany({ select: { id: true, jobId: true, status: true, costActualHistorical: true } });
  const byJobId = new Map(jobs.map((j) => [j.jobId, j]));

  const skippedNotComplete: string[] = [];
  const changes: { pk: number; jobId: string; from: number | null; to: number; status: string }[] = [];
  let unchanged = 0;
  const notInApp: string[] = [];
  const refused: string[] = [];
  for (const [id, { value }] of sheet) {
    if (!hasFinalPartsActual(id)) { refused.push(id); continue; }
    const job = byJobId.get(id);
    if (!job) { notInApp.push(id); continue; }
    const from = job.costActualHistorical == null ? null : Number(job.costActualHistorical);
    if (from != null && Math.abs(from - value) < 0.005) { unchanged++; continue; }
    // Every job below the cutoff is meant to be closed. One that is not (1083, a Total ETO clearing job, is
    // Active) contradicts that, so it is left alone unless --include-not-complete says otherwise.
    if (job.status !== "Complete" && !includeNotComplete) { skippedNotComplete.push(`${id} (${job.status})`); continue; }
    changes.push({ pk: job.id, jobId: id, from, to: value, status: job.status });
  }
  const frozenNotInSheet = jobs.filter((j) => hasFinalPartsActual(j.jobId) && !sheet.has(j.jobId)).map((j) => j.jobId);

  changes.sort((a, b) => Number(a.jobId) - Number(b.jobId));
  console.log(`\nJob ledger rows read: ${sheet.size} jobs (cutoff: below ${FINAL_PARTS_ACTUAL_BELOW_JOB})\n`);
  for (const c of changes) console.log(`${c.jobId.padStart(5)}  ${usd(c.from).padStart(16)}  ->  ${usd(c.to).padStart(16)}   ${c.status}`);
  const sumFrom = changes.reduce((a, c) => a + (c.from ?? 0), 0);
  const sumTo = changes.reduce((a, c) => a + c.to, 0);
  console.log(`\nWill change: ${changes.length} jobs (${usd(sumFrom)} -> ${usd(sumTo)}) · already equal: ${unchanged}`);
  console.log(`In the sheets but not in the app (nothing to update): ${notInApp.length}`);
  if (refused.length) console.log(`Refused — job id is not a number below ${FINAL_PARTS_ACTUAL_BELOW_JOB}: ${refused.join(", ")}`);
  console.log(`App jobs below ${FINAL_PARTS_ACTUAL_BELOW_JOB} not in the sheets (stay frozen at current value): ${frozenNotInSheet.join(", ") || "none"}`);
  if (skippedNotComplete.length) console.log(`Skipped — not "Complete" in the app (use --include-not-complete to load anyway): ${skippedNotComplete.join(", ")}`);
  for (const p of problems) console.log(`PROBLEM: ${p}`);

  if (problems.length) { console.error("\nRefusing to continue: fix the problems above."); process.exit(2); }
  if (!apply) { console.log("\nDry run — nothing written. Re-run with --apply to write."); return; }

  await prisma.$transaction(
    async (tx) => {
      for (const c of changes) await tx.job.update({ where: { id: c.pk }, data: { costActualHistorical: c.to } });
    },
    { timeout: 120_000 },
  );
  console.log(`\nWrote ${changes.length} jobs.`);
}

main().finally(() => prisma.$disconnect());
