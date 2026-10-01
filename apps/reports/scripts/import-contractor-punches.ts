/**
 * Imports transcribed temp/contractor timecards from a CSV into ManualContractorPunch.
 *
 * Paylocity's dynamic punch reports cannot carry temp employees, so their hours
 * only reach the app through this table (merged into the hours feed by
 * lib/manual-contractor-hours.ts). The file format, and why hours are derived
 * rather than typed, is in lib/manual-contractor-import.ts. Template:
 * scripts/contractor-punches/TEMPLATE.csv.
 *
 * Run:  npx tsx -r ./scripts/shim-server-only.cjs scripts/import-contractor-punches.ts <file.csv>
 *         dry run (the default): validates, checks jobs/employees against the
 *         database, and prints per-employee, per-month totals. Writes nothing.
 *       ... --run       write (insert-or-update on the segment key — re-running is safe)
 *       ... --replace   with --run: inside every card's pay period, deactivate any
 *                       existing segment the file does not list (to correct a
 *                       mistyped time without leaving the old segment counted).
 *
 * After a --run, press Refresh Data so the open month's Hours Worked picks it up.
 * A locked month only changes once it is reopened and refreshed.
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (!m) continue;
  let v = m[2].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  if (!process.env[m[1]]) process.env[m[1]] = v;
}

import { prisma } from "@/lib/prisma";
import { parseContractorCsv, parsePayPeriod, payPeriodsOverlap, type ImportRow } from "@/lib/manual-contractor-import";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const run = args.includes("--run");
const replace = args.includes("--replace");

const segKey = (r: { paylocityId: string; workDate: string; startTime: string; endTime: string; jobNumber: string; machineSec: string; functionId: string }) =>
  [r.paylocityId, r.workDate, r.startTime, r.endTime, r.jobNumber, r.machineSec, r.functionId].join("|");

async function main() {
  if (!file) {
    console.error("Usage: scripts/import-contractor-punches.ts <file.csv> [--run] [--replace]");
    process.exit(2);
  }
  if (replace && !run) console.log("(--replace only takes effect with --run)\n");

  const { rows, errors, warnings } = parseContractorCsv(readFileSync(file, "utf8"));

  // ── Against the database: jobs, employees, what is already there ──────────
  const jobNumbers = [...new Set(rows.map((r) => r.jobNumber))];
  const knownJobs = new Set(
    (await prisma.job.findMany({ where: { jobId: { in: jobNumbers } }, select: { jobId: true } })).map((j) => j.jobId),
  );
  for (const j of jobNumbers) {
    if (!knownJobs.has(j)) {
      const first = rows.find((r) => r.jobNumber === j)!;
      errors.push({ line: first.line, message: `Job ${j} is not in the app — its hours would be dropped (check the transfer "${first.transferRaw}")` });
    }
  }

  // The merge resolves the employee BY NAME through the Employee table. A name it
  // cannot find still counts (under the seeded id), but the drill and department
  // mapping are only right when the roster has the person.
  const names = [...new Set(rows.map((r) => r.employeeName))];
  const roster = await prisma.$queryRaw<{ name: string; paylocityId: string | null; active: boolean }[]>`
    SELECT name, paylocityId, active FROM Employee WHERE paylocityId IS NOT NULL
  `;
  for (const n of names) {
    const hits = roster.filter((e) => e.name.toLowerCase() === n.toLowerCase());
    const line = rows.find((r) => r.employeeName === n)!.line;
    if (hits.length === 0) warnings.push({ line, message: `"${n}" is not on the Employee roster — hours will count, but under no department` });
    else if (hits.filter((h) => h.active).length > 1) {
      errors.push({ line, message: `"${n}" matches ${hits.length} roster rows — the merge rejects ambiguous names to Undefined Hours. Fix the roster first.` });
    }
  }

  // ── Against what is already in the table, over the cards' whole date ranges ──
  //
  // Not just the days the file has punches on: a card says what the employee did
  // for EVERY day of its pay period, so an existing active segment anywhere inside
  // that range that the file does not list is either a stale typo or a double
  // count. Matched by id OR name, so a temp seeded earlier under a placeholder id
  // is still caught.
  type Existing = { id: number; employeeName: string; paylocityId: string; workDate: Date; startTime: string; endTime: string; jobNumber: string; machineSec: string; functionId: string; payPeriod: string; active: number | boolean };
  const dates = [...new Set(rows.map((r) => r.workDate))];
  const ids = [...new Set(rows.map((r) => r.paylocityId))];
  const periods = rows.map((r) => parsePayPeriod(r.payPeriod)).filter((p): p is NonNullable<typeof p> => p != null);
  const existing =
    rows.length === 0 || periods.length === 0
      ? []
      : await prisma.$queryRawUnsafe<Existing[]>(
          `SELECT id, employeeName, paylocityId, workDate, startTime, endTime, jobNumber, machineSec, functionId, payPeriod, active
             FROM ManualContractorPunch
            WHERE (paylocityId IN (${ids.map(() => "?").join(",")}) OR LOWER(employeeName) IN (${names.map(() => "?").join(",")}))
              AND workDate BETWEEN ? AND ?`,
          ...ids,
          ...names.map((n) => n.toLowerCase()),
          periods.reduce((a, p) => (p.start < a ? p.start : a), periods[0].start),
          periods.reduce((a, p) => (p.end > a ? p.end : a), periods[0].end),
        );
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  // Which file card (if any) covers this employee on this date.
  const fileCards = new Map<string, { name: string; id: string; start: string; end: string }[]>();
  for (const r of rows) {
    const p = parsePayPeriod(r.payPeriod);
    if (!p) continue;
    const list = fileCards.get(r.paylocityId) ?? [];
    if (!list.some((c) => c.start === p.start && c.end === p.end)) list.push({ name: r.employeeName.toLowerCase(), id: r.paylocityId, ...p });
    fileCards.set(r.paylocityId, list);
  }
  const coveringCard = (e: Existing) =>
    [...fileCards.values()].flat().find((c) => (c.id === e.paylocityId || c.name === e.employeeName.toLowerCase()) && iso(e.workDate) >= c.start && iso(e.workDate) <= c.end);
  const inRange = existing.filter((e) => coveringCard(e));

  for (const e of inRange) {
    const c = coveringCard(e)!;
    if (e.paylocityId !== c.id) {
      errors.push({ line: 0, message: `"${e.employeeName}" already has segments under id ${e.paylocityId}; this file uses ${c.id}. Use one id or every hour counts twice.` });
      break;
    }
  }
  const fileKeys = new Set(rows.map(segKey));
  const existingByKey = new Map(inRange.map((e) => [segKey({ ...e, workDate: iso(e.workDate) }), e]));
  const stale = inRange.filter((e) => Boolean(e.active) && !fileKeys.has(segKey({ ...e, workDate: iso(e.workDate) })));
  const fresh = rows.filter((r) => !existingByKey.has(segKey(r)));
  const overlappingLabels = [...new Set(inRange.filter((e) => Boolean(e.active)).map((e) => e.payPeriod))].filter((l) => !rows.some((r) => r.payPeriod === l));
  for (const l of overlappingLabels) {
    const p = parsePayPeriod(l);
    if (p && periods.some((q) => payPeriodsOverlap(p, q))) {
      warnings.push({ line: 0, message: `The table already holds a card labelled ${l}, which overlaps this file's pay periods — its segments are listed below` });
    }
  }

  // ── Report ────────────────────────────────────────────────────────────────
  const totals = new Map<string, number>();
  for (const r of rows) {
    const k = `${r.employeeName} (${r.employeeRef}, ${r.paylocityId})  ${r.workDate.slice(0, 7)}`;
    totals.set(k, (totals.get(k) ?? 0) + r.hours);
  }
  console.log(`${file}: ${rows.length} segments, ${dates.length} work dates, ${names.length} employee(s)\n`);
  for (const [k, h] of [...totals].sort()) console.log(`  ${k}   ${h.toFixed(2)}h`);
  const byJob = new Map<string, number>();
  for (const r of rows) byJob.set(`${r.jobNumber} ${r.machineSec}-${r.functionId}`, (byJob.get(`${r.jobNumber} ${r.machineSec}-${r.functionId}`) ?? 0) + r.hours);
  console.log("\n  by job / section:");
  for (const [k, h] of [...byJob].sort()) console.log(`    ${k}   ${h.toFixed(2)}h`);

  console.log(`\n  new segments: ${fresh.length}   already in the table: ${rows.length - fresh.length}`);
  if (stale.length) {
    console.log(`  ${stale.length} existing active segment(s) inside these cards' pay periods are NOT in the file${replace ? " — will be deactivated" : " (re-run with --replace to deactivate them)"}:`);
    for (const e of stale) console.log(`    ${e.paylocityId} ${e.workDate.toISOString().slice(0, 10)} ${e.startTime}-${e.endTime} job ${e.jobNumber} ${e.machineSec}-${e.functionId}`);
  }
  for (const w of warnings) console.log(`  WARN  line ${w.line}: ${w.message}`);
  for (const e of errors) console.log(`  ERROR line ${e.line}: ${e.message}`);

  if (errors.length) {
    console.log(`\n${errors.length} error(s) — nothing written. Fix the file and re-run.`);
    process.exitCode = 1;
    return;
  }
  if (!run) {
    console.log("\nDry run — nothing written. Re-run with --run to import.");
    return;
  }

  // ── Write: all or nothing ─────────────────────────────────────────────────
  await prisma.$transaction(async (tx) => {
    for (const r of rows as ImportRow[]) {
      await tx.$executeRaw`
        INSERT INTO ManualContractorPunch
          (employeeName, employeeRef, paylocityId, workDate, transferRaw, jobNumber, machineSec, functionId,
           location, startTime, endTime, hours, source, payPeriod, note, active, createdByEmail, createdAt)
        VALUES
          (${r.employeeName}, ${r.employeeRef}, ${r.paylocityId}, ${r.workDate}, ${r.transferRaw}, ${r.jobNumber},
           ${r.machineSec}, ${r.functionId}, ${r.location}, ${r.startTime}, ${r.endTime}, ${r.hours},
           'manual_contractor_timecard', ${r.payPeriod}, ${r.note}, true, ${process.env.IMPORT_BY_EMAIL ?? null}, NOW(3))
        ON DUPLICATE KEY UPDATE
          hours = VALUES(hours), transferRaw = VALUES(transferRaw), payPeriod = VALUES(payPeriod),
          location = VALUES(location), employeeName = VALUES(employeeName), employeeRef = VALUES(employeeRef),
          note = VALUES(note), active = true
      `;
    }
    if (replace) {
      for (const e of stale) await tx.$executeRaw`UPDATE ManualContractorPunch SET active = false WHERE id = ${e.id}`;
    }
  }, { timeout: 120_000 });

  console.log(`\nWrote ${rows.length} segments${replace && stale.length ? `, deactivated ${stale.length}` : ""}. Press Refresh Data in the app to pick them up.`);
}

main().finally(() => prisma.$disconnect());
