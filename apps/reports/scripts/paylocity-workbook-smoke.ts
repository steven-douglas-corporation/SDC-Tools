// Reads Lisa's Paylocity workbook the way the app now does and checks the properties
// a unit test cannot: that the real file opens, that its headers are where they should
// be, that the months it covers are the ones expected, and — the load-bearing one —
// that a SETTLED month reproduces the Power BI figures cell for cell.
//
//   npx tsx --tsconfig tsconfig.scripts.json scripts/paylocity-workbook-smoke.ts [checkMonth]
//
// Writes nothing. Exits non-zero if the settled-month cross-check fails, so it can be
// run before a deploy that touches the ingestion path.
//
// The cross-check is the whole argument for reading the file instead of the model:
// for a month that has settled, the two ARE the same data (2026-06: 0 differing cells,
// measured 2026-08-05). Where they differ is only ever the lag — the file is days
// ahead. If this check ever starts failing on a settled month, the equivalence has
// broken and the switch needs re-examining, not patching.
import "dotenv/config";
import { prisma } from "@/lib/prisma";
import { readPaylocityWorkbook, UNDEFINED_REASON_LABEL, type UndefinedReason } from "@/lib/paylocity-workbook";
import { buildColumnResolver, fetchJobHoursRowsWithIssues } from "@/lib/job-hours-source";
import { round2 } from "@/lib/etc";

// A month old enough that Power BI has certainly ingested all of it. Overridable,
// because "settled" moves with the calendar.
const DEFAULT_CHECK_MONTH = "2026-06";

function fail(msg: string): never {
  console.error(`\n  FAIL  ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
}

async function main() {
  const checkMonth = process.argv[2] ?? DEFAULT_CHECK_MONTH;

  let resolve: ((s: string) => string | null) | undefined;
  try {
    resolve = (await buildColumnResolver()).resolve;
  } catch {
    console.warn("  ! Function Hierarchy unavailable — falling back to SECTION_ALIASES.");
  }

  const jobs = await prisma.job.findMany({ select: { jobId: true } });
  const knownJobNumbers = new Set(jobs.map((j) => j.jobId));

  console.log("Reading the workbook…");
  const wbk = await readPaylocityWorkbook({ resolve, knownJobNumbers });

  console.log(`\n  file      ${wbk.identity.fileName}`);
  console.log(`  path      ${wbk.identity.path}`);
  console.log(`  size      ${wbk.identity.size.toLocaleString()} bytes`);
  console.log(`  modified  ${wbk.identity.modifiedAt.toISOString()}`);
  console.log(`  sha256    ${wbk.identity.sha256}`);
  console.log(`  sheet     "${wbk.sheet}"`);
  console.log(`  work dates ${wbk.firstWorkDate?.toISOString().slice(0, 10)} -> ${wbk.lastWorkDate?.toISOString().slice(0, 10)}`);
  console.log(`  months    ${wbk.monthsCovered.join(", ")}`);
  console.log(`  stats     ${JSON.stringify(wbk.stats)}`);

  console.log("\nRejections by reason:");
  const byReason = new Map<UndefinedReason, { rows: number; hours: number; kpi: number }>();
  for (const r of wbk.rejected) {
    const cur = byReason.get(r.reason) ?? { rows: 0, hours: 0, kpi: 0 };
    cur.rows++;
    cur.hours += r.hours;
    if (r.countsTowardKpi) cur.kpi += r.hours;
    byReason.set(r.reason, cur);
  }
  for (const [reason, v] of [...byReason.entries()].sort((a, b) => b[1].hours - a[1].hours)) {
    console.log(
      `  ${UNDEFINED_REASON_LABEL[reason].padEnd(24)} ${String(v.rows).padStart(5)} rows  ${v.hours.toFixed(2).padStart(10)}h` +
        `  (${v.kpi.toFixed(2)}h counts toward the KPI)`,
    );
  }

  const agg = (rows: { jobId: string; section: string; hours: number }[]) => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(`${r.jobId}::${r.section}`, (m.get(`${r.jobId}::${r.section}`) ?? 0) + r.hours);
    return m;
  };

  // ── Compare at the precision the database actually stores ─────────────────
  //
  // JobHoursDetail holds one row per (job, section, workDate, employee) and
  // syncJobHoursDetail rounds each to 2dp on the way in. So the stored month total is
  // the sum of ROUNDED rows, while the workbook's is the sum of raw ones — and the
  // 10-311 30/70 split produces values like 3.7166666 * 0.3 that round by a few
  // thousandths apiece.
  //
  // Comparing raw against rounded made 31-47 cells a month "differ" while every month
  // total agreed to within 0.07h on ~7,000h. That is the comparison being wrong, not
  // the data: the first run of this check reported six settled months as rewrites.
  // Replicating the merge and the rounding is what makes the two sides commensurable.
  const toStorageGrain = (rows: typeof wbk.rows) => {
    const merged = new Map<string, { jobId: string; section: string; hours: number }>();
    for (const r of rows) {
      const k = `${r.jobId}::${r.section}::${r.date.toISOString().slice(0, 10)}::${r.employeeId}`;
      const cur = merged.get(k);
      if (cur) cur.hours += r.hours;
      else merged.set(k, { jobId: r.jobId, section: r.section, hours: r.hours });
    }
    return [...merged.values()].map((m) => ({ ...m, hours: round2(m.hours) }));
  };
  const fileFor = (month: string) =>
    agg(toStorageGrain(wbk.rows.filter((r) => `${r.year}-${String(r.month).padStart(2, "0")}` === month)));

  // ── Cross-check 1: every OVERLAPPING month, workbook vs what is stored ────
  //
  // This is the safety check, not a nicety. Switching the source lets the workbook
  // overwrite months the database already holds. If it disagrees with a SETTLED month
  // it would silently rewrite history — so every month the two share is compared, and
  // any settled month that differs fails the run.
  //
  // The current month and the one before it are expected to differ: that is the
  // Power BI lag this change exists to correct, and it shows up as the file being
  // AHEAD (extra hours), never behind.
  const jobRows = await prisma.job.findMany({ select: { id: true, jobId: true } });
  const numById = new Map(jobRows.map((j) => [j.id, j.jobId]));

  const storedMonths = (
    await prisma.jobHoursDetail.groupBy({ by: ["month"], _count: { _all: true } })
  )
    .map((r) => r.month)
    .sort();
  const overlap = wbk.monthsCovered.filter((m) => storedMonths.includes(m));

  console.log(`\nCross-checking every overlapping month (workbook vs JobHoursDetail)…`);
  console.log(`  workbook covers ${wbk.monthsCovered[0]}..${wbk.monthsCovered.at(-1)}, database holds ${storedMonths[0]}..${storedMonths.at(-1)}`);
  console.log(`  months the database holds that the workbook does NOT reach (must stay untouched): ` +
    `${storedMonths.filter((m) => !wbk.monthsCovered.includes(m)).join(", ") || "none"}`);

  const settledFailures: string[] = [];
  console.log("\n  month     workbook        stored       delta   cells±   verdict");
  for (const m of overlap) {
    const stored = await prisma.jobHoursDetail.findMany({
      where: { month: m },
      select: { jobId: true, section: true, hours: true },
    });
    const dbAgg = agg(stored.map((s) => ({ jobId: numById.get(s.jobId) ?? String(s.jobId), section: s.section, hours: Number(s.hours) })));
    const fAgg = fileFor(m);
    const keys = new Set([...fAgg.keys(), ...dbAgg.keys()]);
    let differing = 0;
    let fileAhead = 0;
    let fileBehind = 0;
    const sample: string[] = [];
    for (const k of keys) {
      const f = fAgg.get(k) ?? 0;
      const d = dbAgg.get(k) ?? 0;
      if (Math.abs(f - d) <= 0.005) continue;
      differing++;
      if (f > d) fileAhead++;
      else fileBehind++;
      if (sample.length < 4) sample.push(`${k} file=${f.toFixed(4)} db=${d.toFixed(4)} Δ=${(f - d).toFixed(4)}`);
    }
    if (sample.length > 0) console.log(`      ${sample.join("\n      ")}`);
    const fT = [...fAgg.values()].reduce((a, b) => a + b, 0);
    const dT = [...dbAgg.values()].reduce((a, b) => a + b, 0);
    // "Settled" = not the last two months the workbook carries. Those are the ones
    // still receiving late punches, and the ones Power BI has not caught up on.
    const isSettled = m < (wbk.monthsCovered.at(-2) ?? "");
    let verdict: string;
    if (differing === 0) verdict = "exact";
    else if (!isSettled) verdict = `lag: file ahead on ${fileAhead}, behind on ${fileBehind}`;
    else {
      verdict = `SETTLED MONTH DIFFERS (${differing} cells)`;
      settledFailures.push(`${m} (${differing} cells, ${(fT - dT).toFixed(2)}h)`);
    }
    console.log(
      `  ${m}  ${fT.toFixed(2).padStart(10)}h ${dT.toFixed(2).padStart(11)}h ${(fT - dT).toFixed(2).padStart(11)}   ${String(differing).padStart(5)}   ${verdict}`,
    );
  }

  if (settledFailures.length > 0) {
    fail(
      `the workbook disagrees with stored data on settled month(s): ${settledFailures.join("; ")}. ` +
        `Switching the source would rewrite history — investigate before shipping.`,
    );
  }
  console.log(`\n  PASS  every settled overlapping month reproduces the stored data exactly.`);

  // ── Cross-check 2: one settled month straight against Power BI ────────────
  console.log(`\nCross-checking ${checkMonth} against Power BI directly…`);
  const { rows: pbiRows } = await fetchJobHoursRowsWithIssues({ onlyMonth: checkMonth });
  const pbiAgg = agg(pbiRows);
  const fileAgg = fileFor(checkMonth);
  const keys2 = new Set([...fileAgg.keys(), ...pbiAgg.keys()]);
  const diffs: { k: string; f: number; p: number }[] = [];
  for (const k of keys2) {
    const f = fileAgg.get(k) ?? 0;
    const p = pbiAgg.get(k) ?? 0;
    if (Math.abs(f - p) > 0.005) diffs.push({ k, f, p });
  }
  const fTotal = [...fileAgg.values()].reduce((a, b) => a + b, 0);
  const pTotal = [...pbiAgg.values()].reduce((a, b) => a + b, 0);
  console.log(`  workbook ${fTotal.toFixed(2)}h over ${fileAgg.size} cells`);
  console.log(`  power bi ${pTotal.toFixed(2)}h over ${pbiAgg.size} cells`);
  console.log(`  differing cells: ${diffs.length}`);
  for (const d of diffs.slice(0, 10)) {
    console.log(`    ${d.k.padEnd(22)} file ${d.f.toFixed(2).padStart(9)}  pbi ${d.p.toFixed(2).padStart(9)}`);
  }
  if (diffs.length > 0) {
    fail(`${checkMonth} is a settled month but the workbook and Power BI disagree on ${diffs.length} cell(s).`);
  }
  console.log(`  PASS  ${checkMonth} reproduces Power BI exactly (${fileAgg.size} cells, ${fTotal.toFixed(2)}h).`);

  // How far AHEAD the file is — the reason this module exists.
  const ahead = wbk.monthsCovered.filter((m) => !storedMonths.includes(m));
  console.log(`\n  Months in the file that the database does not have at all: ${ahead.join(", ") || "none"}`);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  if (!(e instanceof Error) || !e.message.includes("settled month")) console.error(e);
  await prisma.$disconnect();
  process.exit(process.exitCode ?? 1);
});
