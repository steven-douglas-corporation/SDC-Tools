/**
 * Reconciles Job Hour Details' "Actual" bars, per job, back to the punch rows
 * they are supposed to be made of.
 *
 * Run:  npx tsx -r ./scripts/shim-server-only.cjs scripts/audit-job-actual-reconciliation.ts 1131
 *       (any number of job numbers; defaults to a spread chosen below)
 *
 * ── What this answers ──────────────────────────────────────────────────────
 *
 * The one equation the page must satisfy:
 *
 *     Σ punch hours for the job  ==  Σ Actual across every bar the chart draws
 *
 * and, when it does not, WHERE the difference went — which is why this walks the
 * pipeline in stages (raw rows -> punch grain -> raw section pair -> the chart's
 * own section list -> billing-group totals) and prints each one, rather than
 * printing a single verdict. A number that disagrees is only useful if you can
 * see which stage lost it.
 *
 * Read-only. It never writes, so it is safe to run against production.
 */
import { prisma } from "../src/lib/prisma";
import { getJobHoursDashboard } from "../src/lib/job-hours-dashboard";
import { coveredMonths } from "../src/lib/actual-hours";
import { SECTIONS, PARTS_COST_SECTION, RESTRICTED_SECTION_CODES, mapPunchToColumns } from "../src/lib/sections";

const DEFAULT_JOBS = ["1131"];

function h(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function table(rows: Record<string, string | number>[]): void {
  if (rows.length === 0) {
    console.log("   (none)");
    return;
  }
  const cols = Object.keys(rows[0]);
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)));
  const line = (cells: (string | number)[]) => "   " + cells.map((c, i) => String(c ?? "").padEnd(w[i])).join("  ");
  console.log(line(cols));
  console.log("   " + w.map((n) => "-".repeat(n)).join("  "));
  for (const r of rows) console.log(line(cols.map((c) => r[c])));
}

async function auditJob(jobNumber: string): Promise<void> {
  const job = await prisma.job.findFirst({ where: { jobId: jobNumber }, select: { id: true, jobId: true, jobName: true, status: true } });
  if (!job) {
    console.log(`\n### ${jobNumber} — NO SUCH JOB\n`);
    return;
  }

  console.log(`\n${"=".repeat(100)}`);
  console.log(`### ${job.jobId} — ${job.jobName}   (pk ${job.id}, ${job.status})`);
  console.log("=".repeat(100));

  // ── Stage 1: the raw punch rows ────────────────────────────────────────────
  const punches = await prisma.jobHoursDetail.findMany({
    where: { jobId: job.id },
    select: {
      id: true, section: true, rawSection: true, rawFunction: true, month: true, workDate: true,
      employeeId: true, hours: true, standardDepartment: true, standardTaskDescription: true,
      mappingStatus: true, source: true,
    },
  });
  const rawTotal = punches.reduce((s, p) => s + Number(p.hours), 0);

  // Duplicate detection at the declared punch grain. The unique index should make
  // this impossible; it is checked anyway, because "impossible" is what a
  // constraint added after the data arrived can quietly not be.
  const grain = new Map<string, number>();
  for (const p of punches) {
    const k = `${p.section}|${p.workDate.toISOString().slice(0, 10)}|${p.employeeId}`;
    grain.set(k, (grain.get(k) ?? 0) + 1);
  }
  const dupes = [...grain.entries()].filter(([, n]) => n > 1);

  const zeroRows = punches.filter((p) => Number(p.hours) === 0).length;
  const negative = punches.filter((p) => Number(p.hours) < 0);
  const sources = new Map<string, { rows: number; hours: number }>();
  for (const p of punches) {
    const s = sources.get(p.source) ?? { rows: 0, hours: 0 };
    s.rows += 1; s.hours += Number(p.hours);
    sources.set(p.source, s);
  }

  console.log(`\n1. RAW PUNCH ROWS (JobHoursDetail)`);
  console.log(`   rows                : ${punches.length}`);
  console.log(`   unique punch grain  : ${grain.size}   (job+section+date+employee)`);
  console.log(`   duplicate grain keys: ${dupes.length}`);
  console.log(`   zero-hour rows      : ${zeroRows}`);
  console.log(`   negative-hour rows  : ${negative.length}`);
  console.log(`   TOTAL RAW HOURS     : ${h(rawTotal)}`);
  console.log(`\n   by ingest source:`);
  table([...sources.entries()].map(([source, v]) => ({ source, rows: v.rows, hours: h(v.hours) })));

  // ── Stage 2: the other two eras the page adds to Actual ───────────────────
  //
  // Actual is deliberately NOT punches alone (see actual-hours.ts): it is a
  // migration snapshot, plus frozen ETC for months the punch feed does not
  // reach, plus punches for the months it does. Any reconciliation against
  // Paylocity has to know how much of the bar is not punch-derived.
  const covered = await coveredMonths();
  const coveredSet = new Set(covered);
  const punchMonths = [...new Set(punches.map((p) => p.month))].sort();
  const historical = await prisma.estimatedHours.findMany({
    where: { jobId: job.id },
    select: { section: true, actualHistoricalHours: true },
  });
  const historicalTotal = historical.reduce((s, r) => s + Number(r.actualHistoricalHours ?? 0), 0);
  const frozen = await prisma.etcEntry.groupBy({
    by: ["month", "section"],
    where: { jobId: job.id, section: { not: PARTS_COST_SECTION }, month: { notIn: covered } },
    _sum: { hoursWorked: true },
  });
  const frozenTotal = frozen.reduce((s, r) => s + Number(r._sum.hoursWorked ?? 0), 0);
  const punchesInCovered = punches.filter((p) => coveredSet.has(p.month)).reduce((s, p) => s + Number(p.hours), 0);
  const punchesOutsideCovered = rawTotal - punchesInCovered;

  console.log(`\n2. THE THREE ERAS Actual IS BUILT FROM (actual-hours.ts)`);
  console.log(`   punch-covered months (app-wide): ${covered.length} (${covered.slice().sort()[0]} … ${covered.slice().sort().at(-1)})`);
  console.log(`   this job's punch months        : ${punchMonths.join(", ") || "(none)"}`);
  console.log(`   era 1  migration snapshot      : ${h(historicalTotal)}`);
  console.log(`   era 2  frozen ETC, uncovered mo: ${h(frozenTotal)}  (${frozen.length} cells)`);
  console.log(`   era 3  punches in covered month: ${h(punchesInCovered)}`);
  console.log(`   punches in an UNCOVERED month  : ${h(punchesOutsideCovered)}  <- counted by neither era if > 0`);
  console.log(`   expected Actual total          : ${h(historicalTotal + frozenTotal + punchesInCovered)}`);

  // ── Stage 3: raw section pairs, and whether the chart has a home for each ──
  const byPair = new Map<string, { hours: number; rows: number; dept: string; task: string; status: string }>();
  for (const p of punches) {
    const cur = byPair.get(p.section) ?? { hours: 0, rows: 0, dept: p.standardDepartment, task: p.standardTaskDescription, status: p.mappingStatus };
    cur.hours += Number(p.hours); cur.rows += 1;
    byPair.set(p.section, cur);
  }
  const gridCodes = new Set(SECTIONS.map((s) => s.code));

  console.log(`\n3. RAW SECTION-FUNCTION PAIRS ON THIS JOB`);
  table(
    [...byPair.entries()]
      .sort((a, b) => b[1].hours - a[1].hours)
      .map(([pair, v]) => ({
        pair,
        hours: h(v.hours),
        rows: v.rows,
        standardDept: v.dept || "(blank)",
        standardTask: v.task || "(blank)",
        mapping: v.status || "(blank)",
        onChartGrid: gridCodes.has(pair) ? "yes" : "NO",
      })),
  );

  // ── Stage 4: what the page actually renders ────────────────────────────────
  const dash = await getJobHoursDashboard(job.id);
  if (!dash) {
    console.log("\n4. CHART: getJobHoursDashboard returned null");
    return;
  }
  const drawn = dash.sections.filter((s) => s.actual !== 0 || s.quoted !== 0 || s.etc !== 0);
  const chartActualTotal = dash.sections.reduce((s, x) => s + x.actual, 0);

  console.log(`\n4. WHAT THE CHART DRAWS (getJobHoursDashboard)`);
  table(
    drawn
      .filter((s) => s.actual !== 0)
      .sort((a, b) => b.actual - a.actual)
      .map((s) => ({ code: s.code, name: s.name, group: s.group, billingGroup: s.billingGroup, actual: h(s.actual) })),
  );
  console.log(`   Σ Actual across every bar : ${h(chartActualTotal)}`);
  console.log(`\n   billing-group totals as rendered:`);
  table(dash.billingGroups.map((b) => ({ group: b.group, quoted: h(b.quoted), etc: h(b.etc), actual: h(b.actual) })));

  // ── Stage 5: the reconciliation ────────────────────────────────────────────
  const bgSum = dash.billingGroups.reduce((s, b) => s + b.actual, 0);
  const perGroup = new Map<string, number>();
  for (const s of dash.sections) perGroup.set(s.billingGroup, (perGroup.get(s.billingGroup) ?? 0) + s.actual);

  // Which punch hours the chart has NO home for — asked of the FOLDED
  // destination, not the raw pair. A raw pair legitimately has no bar of its own
  // (40-311 folds into 40-211, 10-414 into 10-413); the question that matters is
  // whether the hours land somewhere after folding, which is what the page draws.
  const dropped: [string, number][] = [];
  for (const [pair, v] of byPair) {
    for (const col of mapPunchToColumns(pair, v.hours)) {
      if (!dash.sections.some((s) => s.code === col.section)) dropped.push([`${pair} -> ${col.section}`, col.hours]);
    }
  }
  const droppedHours = dropped.reduce((s, [, hrs]) => s + hrs, 0);

  // Standard Fees pools: PM, Manufacturing and both Warranty codes are planned
  // company-wide rather than quoted per job, and the chart draws them only for a
  // role holding the matching grant (2026-09-02 — before that it hid them from
  // everyone). This script has no session, so it reports them separately: a
  // reader with the grants sees the full `chart Σ Actual`, a reader without them
  // sees that figure minus this one.
  const pooled = dash.sections.filter((s) => RESTRICTED_SECTION_CODES.has(s.code) && s.actual !== 0);
  const pooledTotal = pooled.reduce((sum, s) => sum + s.actual, 0);

  console.log(`\n5. RECONCILIATION`);
  const expected = historicalTotal + frozenTotal + punchesInCovered;
  const rows = [
    { check: "raw punch hours", value: h(rawTotal) },
    { check: "expected Actual (3 eras)", value: h(expected) },
    { check: "chart Σ Actual", value: h(chartActualTotal) },
    { check: "difference (expected - chart)", value: h(expected - chartActualTotal) },
    { check: "Engineering + Shop totals", value: h(bgSum) },
    { check: "difference (chart Σ - E+S)", value: h(chartActualTotal - bgSum) },
    { check: "folded hours with NO chart bar", value: `${dropped.length} / ${h(droppedHours)} h` },
    { check: "Standard Fees pools (permission-gated)", value: h(pooledTotal) },
    { check: "rendered without the pool grants", value: h(chartActualTotal - pooledTotal) },
    { check: "RAW - rendered - pools  (== 0)", value: h(rawTotal - (chartActualTotal - pooledTotal) - pooledTotal) },
  ];
  table(rows);
  if (pooled.length > 0) {
    console.log(`\n   STANDARD FEES POOLS — in the payload, excluded from the rendered chart by design:`);
    table(pooled.map((s) => ({ code: s.code, name: s.name, actual: h(s.actual) })));
  }
  if (dropped.length > 0) {
    console.log(`\n   PUNCH HOURS THE CHART HAS NOWHERE TO PUT (after folding):`);
    table(dropped.sort((a, b) => b[1] - a[1]).map(([route, hrs]) => ({ route, hours: h(hrs) })));
  }
}

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const jobs = args.length > 0 ? args : DEFAULT_JOBS;
  console.log(`Job Hour Details — Actual vs punch reconciliation`);
  console.log(`jobs: ${jobs.join(", ")}`);
  for (const j of jobs) await auditJob(j);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
