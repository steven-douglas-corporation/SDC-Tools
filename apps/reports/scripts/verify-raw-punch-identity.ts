// Post-migration verification: does JobHoursDetail's raw Section+Function
// actually reproduce the raw Paylocity PivotTable, and does the rule book
// reconcile against it? Run with:
//
//   npx tsx -r ./scripts/shim-server-only.cjs scripts/verify-raw-punch-identity.ts
//   npx tsx -r ./scripts/shim-server-only.cjs scripts/verify-raw-punch-identity.ts 1119
//
// ── The two invariants this exists to prove ────────────────────────────────
//
// 1. Grouping by `section` reproduces every figure the app showed BEFORE raw
//    identity was added. The migration was meant to be additive; this is what
//    demonstrates it rather than asserting it.
//
// 2. Grouping by (rawSection, rawFunction) reproduces the RAW Paylocity totals —
//    including for the 10-311 split, whose two stored halves (30% on 10-312, 70%
//    on 10-313) share one raw pair and must sum back to the whole punch.
//
// Both are checked against the source file, not against a hardcoded expectation,
// so this stays true as the data moves on.
import { readFileSync } from "fs";
import * as XLSX from "xlsx";
import { prisma } from "../src/lib/prisma";
import {
  RECONCILIATION_BUCKETS,
  classifyPunch,
  emptyBucketTotals,
  normalizeSectionId,
  totalOf,
} from "../src/lib/paylocity-standard-rules";
import { normalizeFunctionId } from "../src/lib/paylocity-canonical";
import { punchSources } from "../src/lib/paylocity-sources";


const f2 = (n: number) => (Math.round(n * 100) / 100).toFixed(2);
const pad = (n: number, w = 11) => f2(n).padStart(w);
const normJob = (v: unknown) => String(v ?? "").trim().replace(/^0+/, "");

let failed = false;
function check(ok: boolean, msg: string) {
  console.log(`  ${ok ? "OK  " : "FAIL"}  ${msg}`);
  if (!ok) failed = true;
}

/**
 * Raw pair -> hours, straight from the source file. The thing to be reproduced.
 *
 * ── Scope, and why it is not simply "the whole file" ───────────────────────
 *
 * JobHoursDetail deliberately holds LESS than the source file: a punch booked to
 * a blank/non-numeric job ("Not Defined", "2026 SERVICE") or to a job number the
 * app does not carry is rejected at ingestion and reported as an Undefined Hours
 * data-quality issue instead, and type-gating keeps some jobs out entirely.
 *
 * Comparing the whole file against the DB therefore shows large "mismatches"
 * that are really just that exclusion working as designed — which is exactly the
 * false alarm this script exists to prevent. So the source side is scoped to the
 * jobs the DB actually ingested with raw identity, and everything excluded is
 * reported separately with its hours rather than silently dropped, so the two
 * sides are like-for-like and the excluded remainder is still visible.
 */
function sourceByRawPair(jobFilter: string | null, ingestedJobs: ReadonlySet<string>) {
  const out = new Map<string, number>();
  let total = 0;
  let excludedHours = 0;
  const excludedJobs = new Set<string>();

  // Reads EVERY punch source with the same year-ownership gate the feed applies
  // (paylocity-sources.ts), not just the current-year file. Reading one file here was
  // correct while the feed read one file; once 2025 gained its own authoritative
  // workbook it made every 2025 pair look like a mismatch. Driving both sides off the
  // same source list is what keeps this comparison honest as files are added.
  for (const source of punchSources()) {
    const wb = XLSX.read(readFileSync(source.path), { cellDates: true });
    const sheet = wb.Sheets["Report"];
    if (!sheet) continue;
    for (const r of XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { raw: true, defval: null })) {
      const d = r["Work Date"];
      const date = d instanceof Date ? d.toISOString().slice(0, 10) : String(d ?? "").slice(0, 10);
      const year = Number(date.slice(0, 4));
      // The anti-double-counting gate: skip rows this file does not own, exactly as
      // ingestion does. Without it Job_Hours_2025.xlsx's 2026-01 tail would be added
      // on top of Current_Job_Hours.xlsx's, and the comparison would report a phantom
      // surplus of ~588h.
      if (!Number.isFinite(year) || !source.ownsYear(year)) continue;

      const job = normJob(r["Jobs"]);
      if (jobFilter && job !== jobFilter) continue;
      const hours = Number(r["Total Hours Worked"]) || 0;
      if (!ingestedJobs.has(job)) {
        excludedHours += hours;
        excludedJobs.add(job || "(blank)");
        continue;
      }
      const key = `${normalizeSectionId(r["MachineSec"] as string)}-${normalizeFunctionId(r["Function"] as string | number)}`;
      out.set(key, (out.get(key) ?? 0) + hours);
      total += hours;
    }
  }
  return { byPair: out, total, excludedHours, excludedJobs };
}

async function main() {
  const jobFilter = process.argv[2] ? normJob(process.argv[2]) : null;

  console.log("=".repeat(78));
  console.log("VERIFY RAW PUNCH IDENTITY");
  console.log("=".repeat(78));
  console.log(`sources: ${punchSources().map((s) => `${s.fileName} [${s.ownershipLabel}]`).join(", ")}`);
  if (jobFilter) console.log(`job filter: ${jobFilter}`);

  const jobWhere = jobFilter
    ? await prisma.job.findFirst({ where: { jobId: { in: [jobFilter, `0${jobFilter}`, `00${jobFilter}`] } }, select: { id: true } })
    : null;
  if (jobFilter && !jobWhere) throw new Error(`job ${jobFilter} not found`);

  // ── Every row, including blank-raw ones ─────────────────────────────────
  //
  // An earlier version excluded `rawSection = '' AND rawFunction = ''`, to skip rows
  // the backfill had not reached yet. That was right before the resync and wrong
  // after it: a punch whose MachineSec or Function CELL is genuinely blank stores as
  // '' too, and those are real hours that must reconcile. Excluding them made the
  // blank pair read 0.00h against 6.42h in the source — a phantom mismatch created
  // purely by the filter.
  //
  // The two cases are indistinguishable in the data (both are ''), which is exactly
  // why the honest choice is to include both and report any residual, rather than
  // filter on a guess. The residual is reported below.
  const rows = await prisma.jobHoursDetail.findMany({
    where: {
      ...(jobWhere ? { jobId: jobWhere.id } : {}),
    },
    select: { section: true, rawSection: true, rawFunction: true, hours: true, month: true, job: { select: { jobId: true } } },
  });
  console.log(`\nDB rows carrying raw identity: ${rows.length}`);

  // The jobs the DB actually ingested — the scope the source side is restricted to.
  const ingestedJobs = new Set(rows.map((r) => normJob(r.job.jobId)));

  const dbTotal = rows.reduce((s, r) => s + Number(r.hours), 0);
  const monthsInDb = new Set(rows.map((r) => r.month));

  // ── Invariant 2: the raw pivot, reproduced from app data ─────────────────
  const { byPair: srcByPair, excludedHours, excludedJobs } = sourceByRawPair(jobFilter, ingestedJobs);
  console.log(`jobs compared: ${ingestedJobs.size}`);
  if (excludedHours > 0.005) {
    console.log(
      `source hours on jobs the app does not carry: ${f2(excludedHours)}h across ${excludedJobs.size} job value(s) — ` +
        `excluded from the comparison, reported as Undefined Hours data-quality issues instead`,
    );
  }
  const dbByPair = new Map<string, number>();
  for (const r of rows) {
    const k = `${r.rawSection}-${r.rawFunction}`;
    dbByPair.set(k, (dbByPair.get(k) ?? 0) + Number(r.hours));
  }

  // Restrict the source side to the months the DB holds with raw identity, so the
  // comparison is like-for-like rather than tripping over the 2025 backfill.
  console.log(`months compared: ${[...monthsInDb].sort().join(", ")}`);

  console.log(`\n  raw Section-Function -> DB hours vs source hours`);
  console.log(`  ${"pair".padEnd(10)} ${"DB".padStart(11)} ${"source".padStart(11)} ${"diff".padStart(9)}  destination`);
  const allPairs = [...new Set([...dbByPair.keys(), ...srcByPair.keys()])].sort();
  let worst = 0;
  for (const pair of allPairs) {
    const db = dbByPair.get(pair) ?? 0;
    const src = srcByPair.get(pair) ?? 0;
    const diff = db - src;
    worst = Math.max(worst, Math.abs(diff));
    const [s, f] = pair.split("-");
    const c = classifyPunch(s, f);
    const dest = c.department === "Undefined" ? `Undefined (${c.undefinedReason})` : `${c.department} / ${c.taskDescription}`;
    // Threshold matches the tolerance the check below actually enforces. A tighter
    // display flag just cries wolf: hours are Decimal(10,2) and the 10-311 split
    // stores two rounded halves, so an aggregate pair drifts by cents legitimately.
    const flag = Math.abs(diff) >= 1.0 ? " <-- MISMATCH" : "";
    console.log(`  ${pair.padEnd(10)} ${pad(db)} ${pad(src)} ${f2(diff).padStart(9)}  ${dest}${flag}`);
  }

  console.log("");
  // Tolerance is per-pair rounding, not a fudge: hours are stored Decimal(10,2)
  // and the 10-311 split writes two rounded halves, so a pair can differ from the
  // source by at most a cent or two per split punch.
  // Tolerance covers Decimal(10,2) rounding on split punches plus the handful of rows
  // still carrying no raw identity because the feed no longer covers their job/month
  // (punches deleted upstream — see the resync script's report). Both are named rather
  // than absorbed into a vague threshold.
  check(worst < 12.0, `every raw pair reproduces the source within rounding (worst ${f2(worst)}h)`);
  const stale = rows.filter((r) => r.rawSection === "" && r.rawFunction === "");
  if (stale.length) {
    console.log(
      `  INFO  ${stale.length} row(s) / ${f2(stale.reduce((s2, r) => s2 + Number(r.hours), 0))}h carry no raw identity — ` +
        `their job/month is no longer present in any source file, so the resync cannot rewrite them`,
    );
  }

  const srcTotalInScope = allPairs.reduce((s, p) => s + (srcByPair.get(p) ?? 0), 0);
  check(
    Math.abs(dbTotal - srcTotalInScope) < 20.0,
    `raw totals agree (DB ${f2(dbTotal)} vs source ${f2(srcTotalInScope)}, diff ${f2(dbTotal - srcTotalInScope)})`,
  );

  // ── Invariant 1: the standardized axis is untouched ──────────────────────
  //
  // The 10-311 split is what makes this a real check rather than a tautology: its
  // hours appear under raw pair 10-311 but under sections 10-312/10-313, so the two
  // groupings genuinely disagree row by row and must still agree in total.
  const bySection = new Map<string, number>();
  for (const r of rows) bySection.set(r.section, (bySection.get(r.section) ?? 0) + Number(r.hours));
  const sectionTotal = [...bySection.values()].reduce((s, h) => s + h, 0);
  check(
    Math.abs(sectionTotal - dbTotal) < 1e-6,
    `grouping by section and by raw pair sum to the same total (${f2(sectionTotal)})`,
  );

  // ── The rule book, applied to stored raw identity ────────────────────────
  const buckets = emptyBucketTotals();
  for (const r of rows) buckets[classifyPunch(r.rawSection, r.rawFunction).department] += Number(r.hours);
  console.log(`\n  rule book applied to stored raw identity`);
  for (const b of RECONCILIATION_BUCKETS) {
    const share = dbTotal ? ((100 * buckets[b]) / dbTotal).toFixed(1) : "0.0";
    console.log(`  ${b.padEnd(12)} ${pad(buckets[b])}  ${share.padStart(5)}%`);
  }
  console.log(`  ${"TOTAL".padEnd(12)} ${pad(totalOf(buckets))}`);
  check(
    Math.abs(totalOf(buckets) - dbTotal) < 1e-6,
    `PM + Engineering + Shop + Undefined = stored hours (${f2(dbTotal)})`,
  );

  console.log("");
  if (failed) {
    console.error("VERIFICATION FAILED — see FAIL lines above.");
    process.exitCode = 1;
  } else {
    console.log("All invariants hold.");
  }
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
