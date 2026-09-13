// Cross-page audit: do the Hours page, the Job Hour Details panel and the Monthly
// ETC drill all report the same hours for the same job, from the same records?
// And does the raw Function total still reconcile against the Paylocity workbook?
//
//   npx tsx -r ./scripts/shim-server-only.cjs scripts/audit-cross-page-hours.ts 1119
//
// ── What this is guarding against ───────────────────────────────────────────
//
// Three pages read JobHoursDetail through three different query modules. They are
// SUPPOSED to differ in scope — Monthly ETC deliberately shows only the 17 codes its
// grid has columns for — but they must never differ in the hours they attribute to a
// punch, nor in how they name or classify it. Every one of them now projects its rows
// through the single `punchIdentity()` in hours-filters.ts, and this script is what
// demonstrates that rather than asserting it.
//
// Order matters and follows the requested sequence: raw totals must reconcile against
// Paylocity FIRST, and only then is standardized grouping evaluated. A standardized
// total that agrees while the raw totals disagree means the mapping is compensating
// for an ingestion error, which is the worst of the failure modes because it looks
// correct.
import { readFileSync } from "fs";
import * as XLSX from "xlsx";
import { prisma } from "../src/lib/prisma";
import { punchSources } from "../src/lib/paylocity-sources";
import { queryHoursRows, queryHoursSummary, queryHoursGrouped, queryStandardBuckets } from "../src/lib/hours-explorer";
import { getJobHoursDetail, getEtcMonthHoursDetail } from "../src/lib/job-hours-detail";
import { classifyPunch, normalizeSectionId, totalOf, RECONCILIATION_BUCKETS } from "../src/lib/paylocity-standard-rules";
import { normalizeFunctionId } from "../src/lib/paylocity-canonical";
import { ETC_TRACKED_CODES, mapPunchToColumns } from "../src/lib/sections";

const f2 = (n: number) => (Math.round(n * 100) / 100).toFixed(2);
const pad = (n: number, w = 12) => f2(n).padStart(w);
const normJob = (v: unknown) => String(v ?? "").trim().replace(/^0+/, "");

let failed = false;
function check(ok: boolean, msg: string) {
  console.log(`  ${ok ? "OK  " : "FAIL"}  ${msg}`);
  if (!ok) failed = true;
}

/** Raw (section, function) -> hours for one job, straight from the authoritative workbooks. */
function paylocityRawPairs(job: string) {
  const byPair = new Map<string, number>();
  const byFunction = new Map<string, number>();
  for (const source of punchSources()) {
    const wb = XLSX.read(readFileSync(source.path), { cellDates: true });
    const sheet = wb.Sheets["Report"];
    if (!sheet) continue;
    for (const r of XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { raw: true, defval: null })) {
      if (normJob(r["Jobs"]) !== job) continue;
      const d = r["Work Date"];
      const date = d instanceof Date ? d.toISOString().slice(0, 10) : String(d ?? "");
      // The same year-ownership gate ingestion applies, so overlapping workbooks
      // cannot double-count here either.
      if (!source.ownsYear(Number(date.slice(0, 4)))) continue;
      const sec = normalizeSectionId(r["MachineSec"] as string);
      const fn = normalizeFunctionId(r["Function"] as string | number);
      const hours = Number(r["Total Hours Worked"]) || 0;
      byPair.set(`${sec}-${fn}`, (byPair.get(`${sec}-${fn}`) ?? 0) + hours);
      byFunction.set(fn, (byFunction.get(fn) ?? 0) + hours);
    }
  }
  return { byPair, byFunction };
}

async function main() {
  const job = normJob(process.argv[2] ?? "1119");
  console.log("=".repeat(96));
  console.log(`CROSS-PAGE HOURS AUDIT — job ${job}`);
  console.log("=".repeat(96));

  const jobRow = await prisma.job.findFirst({ where: { jobId: { in: [job, `0${job}`, `00${job}`] } }, select: { id: true, jobId: true, jobName: true } });
  if (!jobRow) throw new Error(`job ${job} not found`);
  console.log(`${jobRow.jobId} — ${jobRow.jobName}`);

  const filters = { jobIds: [jobRow.jobId] };

  // ── STEP 1: raw Function totals vs Paylocity ────────────────────────────
  //
  // Before any standardized grouping is looked at, per the requested order.
  const { byPair: srcPairs, byFunction: srcFunctions } = paylocityRawPairs(job);
  const dbPairRows = await prisma.jobHoursDetail.groupBy({
    by: ["rawSection", "rawFunction"],
    where: { jobId: jobRow.id },
    _sum: { hours: true },
  });
  const dbPairs = new Map(dbPairRows.map((r) => [`${r.rawSection}-${r.rawFunction}`, Number(r._sum.hours ?? 0)]));
  const dbFunctions = new Map<string, number>();
  for (const r of dbPairRows) dbFunctions.set(r.rawFunction, (dbFunctions.get(r.rawFunction) ?? 0) + Number(r._sum.hours ?? 0));

  console.log(`\n--- STEP 1: RAW FUNCTION TOTALS vs PAYLOCITY (before standardization) ---`);
  console.log(`  ${"Function".padEnd(10)} ${"Paylocity".padStart(12)} ${"App Raw".padStart(12)} ${"Diff".padStart(10)}`);
  let worstFn = 0;
  for (const fn of [...new Set([...srcFunctions.keys(), ...dbFunctions.keys()])].sort()) {
    const src = srcFunctions.get(fn) ?? 0;
    const db = dbFunctions.get(fn) ?? 0;
    worstFn = Math.max(worstFn, Math.abs(db - src));
    console.log(`  ${(fn || "(blank)").padEnd(10)} ${pad(src)} ${pad(db)} ${pad(db - src, 10)}`);
  }
  check(worstFn < 1.0, `raw Function totals reconcile against Paylocity (worst ${f2(worstFn)}h)`);

  // ── STEP 2: the requested audit table, per raw pair ─────────────────────
  console.log(`\n--- STEP 2: RAW PAIR AUDIT TABLE ---`);
  console.log(
    `  ${"RawSec".padEnd(7)} ${"RawFn".padEnd(6)} ${"Paylocity".padStart(11)} ${"App Raw".padStart(11)} ${"Status".padEnd(10)} Standard Destination`,
  );
  for (const key of [...new Set([...srcPairs.keys(), ...dbPairs.keys()])].sort()) {
    const [sec, fn] = key.split("-");
    const c = classifyPunch(sec, fn);
    const dest = c.mappingStatus === "Mapped" ? `${c.department} / ${c.taskDescription}` : `Undefined (${c.undefinedReason})`;
    console.log(
      `  ${(sec || "—").padEnd(7)} ${(fn || "—").padEnd(6)} ${pad(srcPairs.get(key) ?? 0, 11)} ${pad(dbPairs.get(key) ?? 0, 11)} ${c.mappingStatus.padEnd(10)} ${dest}`,
    );
  }

  // ── STEP 3: standardized buckets, only now ──────────────────────────────
  const buckets = await queryStandardBuckets(filters);
  console.log(`\n--- STEP 3: STANDARDIZED BUCKETS ---`);
  for (const b of RECONCILIATION_BUCKETS) console.log(`  ${b.padEnd(12)} ${pad(buckets[b])}`);
  console.log(`  ${"TOTAL".padEnd(12)} ${pad(totalOf(buckets))}`);

  // ── STEP 4: the three pages, side by side ───────────────────────────────
  const [summary, hoursPage, jobDetail] = await Promise.all([
    queryHoursSummary(filters),
    queryHoursRows(filters, { pageSize: 5000 }),
    getJobHoursDetail([jobRow.id]),
  ]);
  const storedTotal = Number(
    (await prisma.jobHoursDetail.aggregate({ where: { jobId: jobRow.id }, _sum: { hours: true } }))._sum.hours ?? 0,
  );

  console.log(`\n--- STEP 4: THE THREE PAGES ---`);
  console.log(`  stored in JobHoursDetail                  ${pad(storedTotal)}`);
  console.log(`  Hours page (queryHoursSummary)            ${pad(summary.totalHours)}`);
  console.log(`  Hours page (queryHoursRows, summed)       ${pad(hoursPage.rows.reduce((s, r) => s + r.hours, 0))}`);
  console.log(`  Job Hour Details (getJobHoursDetail)      ${pad(jobDetail.total)}`);
  check(Math.abs(summary.totalHours - storedTotal) < 0.01, `Hours page total equals stored hours`);
  check(Math.abs(jobDetail.total - storedTotal) < 0.01, `Job Hour Details total equals stored hours`);
  check(Math.abs(totalOf(buckets) - storedTotal) < 0.01, `PM+Engineering+Shop+Undefined equals stored hours`);

  // Monthly ETC is deliberately SCOPED to the 17 grid codes — a subset, not a
  // disagreement. Verified as exactly that subset rather than waved through.
  const months = [...new Set(jobDetail.rows.map((r) => r.date.slice(0, 7)))].sort();
  let etcTotal = 0;
  for (const m of months) etcTotal += (await getEtcMonthHoursDetail(m, [jobRow.id])).total;
  // `r.section` is now the RAW pair — checking it against ETC_TRACKED_CODES literally
  // would miss every folded/split raw pair (10-311, 10-414, 12/13/14-211, ...), which
  // is the exact bug this whole change fixes. Fold each raw row through
  // mapPunchToColumns first, matching what getEtcMonthHoursDetail itself does.
  const trackedTotal = jobDetail.rows
    .flatMap((r) => mapPunchToColumns(r.section, r.hours))
    .filter((col) => ETC_TRACKED_CODES.has(col.section))
    .reduce((s, col) => s + col.hours, 0);
  console.log(`  Monthly ETC drill (${months.length} months, ETC-tracked codes only)   ${pad(etcTotal)}`);
  console.log(`  ^ expected subset: rows on the 17 ETC grid codes  ${pad(trackedTotal)}`);
  check(Math.abs(etcTotal - trackedTotal) < 0.51, `Monthly ETC drill equals exactly the ETC-tracked subset of the same records`);

  // ── STEP 5: the pages agree on IDENTITY, not just totals ────────────────
  //
  // Totals agreeing is necessary but not sufficient: two pages can sum the same
  // hours while disagreeing about which Section/Function a punch belongs to, which is
  // precisely what a combined "Function / Section" column used to hide.
  console.log(`\n--- STEP 5: PER-PUNCH IDENTITY AGREEMENT ---`);
  const keyOf = (r: { date: string; employee: string; rawSection: string; rawFunction: string; hours: number }) =>
    `${r.date}|${r.employee}|${r.rawSection}|${r.rawFunction}|${f2(r.hours)}`;
  const hoursKeys = new Map(hoursPage.rows.map((r) => [keyOf(r), r]));
  let identityMismatch = 0;
  let compared = 0;
  for (const r of jobDetail.rows) {
    const match = hoursKeys.get(keyOf(r));
    if (!match) continue;
    compared += 1;
    if (
      match.rawSectionName !== r.rawSectionName ||
      match.rawFunctionName !== r.rawFunctionName ||
      match.standardTaskDescription !== r.standardTaskDescription ||
      match.mappingStatus !== r.mappingStatus ||
      match.standardDepartment !== r.standardDepartment
    ) {
      identityMismatch += 1;
    }
  }
  check(compared > 0, `matched punches across the two pages to compare (${compared})`);
  check(
    identityMismatch === 0,
    `every matched punch carries identical Section/Function names, mapping status and department on both pages (${identityMismatch} mismatches)`,
  );

  // ── STEP 6: presentation cannot change the total ────────────────────────
  console.log(`\n--- STEP 6: GROUPING DOES NOT CHANGE THE TOTAL ---`);
  for (const dim of ["sectionNumber", "functionId", "mappingStatus", "standardDepartment", "sectionName", "functionGroup", "taskDescription", "department"] as const) {
    const g = await queryHoursGrouped(filters, dim);
    const sum = g.reduce((s, r) => s + r.hours, 0);
    const ok = Math.abs(sum - storedTotal) < 0.01;
    if (!ok) failed = true;
    console.log(`  ${ok ? "OK  " : "FAIL"}  group by ${dim.padEnd(20)} ${g.length} rows, ${pad(sum)}`);
  }

  console.log("");
  if (failed) {
    console.error("CROSS-PAGE AUDIT FAILED — see FAIL lines above.");
    process.exitCode = 1;
  } else {
    console.log("All pages agree, on totals and on per-punch identity.");
  }
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
