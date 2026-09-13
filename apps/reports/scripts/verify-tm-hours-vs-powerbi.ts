/**
 * T&M audit harness — reconciles the page's own numbers three ways.
 *
 * ── Why this file no longer defines any logic of its own (2026-09-01) ────────
 *
 * It used to carry PRIVATE copies of resolveTmJobPks(), getTmHoursTotals() and
 * dateRangeWhere(), duplicating tm-hours.ts. Those copies had already drifted:
 * the local getTmHoursTotals filtered `section: { in: ALL_TM_HOURS_CODES }` in
 * SQL, against the RAW section pair — which tm-hours.ts's own comment explains
 * is wrong, because a raw pair has to be folded through mapPunchToColumns first
 * (10-311 -> 312/313, 70-311 -> 70-211, ...). So the "verification" was
 * comparing Power BI against something the app never computed, and would have
 * reported agreement that did not exist.
 *
 * A verification script that reimplements what it verifies checks nothing. It
 * imports the real functions now — the same ones the page and the drill call.
 *
 * Run:  npx tsx -r ./scripts/shim-server-only.cjs scripts/verify-tm-hours-vs-powerbi.ts
 */
import { readFileSync } from "node:fs";

// .env is loaded by Next in the app; a bare tsx run has to do it itself, and
// the Power BI client throws without PBI_WORKSPACE_ID/PBI_DATASET_ID.
for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (!m) continue;
  let v = m[2].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  if (!process.env[m[1]]) process.env[m[1]] = v;
}

import { prisma } from "@/lib/prisma";
import { getTmHoursTotals, getTmHoursDrillRows, resolveTmJobPks } from "@/lib/tm-hours";
import { TM_HOURS_KEYS, TM_HOURS_LABELS, type TmHoursDrillKey } from "@/lib/tm-hours-classify";
import { mapPunchToColumns } from "@/lib/sections";
import { validJobTypeFilter } from "@/lib/job-filters";

const F = (n: number) => n.toFixed(2).padStart(11);

/** Total hours actually punched in scope, classified or not — the reconciliation floor. */
async function rawPunchedHours(jobPks: number[], startDate: string, endDate: string): Promise<number> {
  if (jobPks.length === 0) return 0;
  const g = await prisma.jobHoursDetail.aggregate({
    where: {
      jobId: { in: jobPks },
      workDate: { gte: new Date(`${startDate}T00:00:00.000Z`), lte: new Date(`${endDate}T00:00:00.000Z`) },
    },
    _sum: { hours: true },
  });
  return Number(g._sum.hours ?? 0);
}

/**
 * Check 1 — do the five cards account for every hour punched?
 * Check 2 — does each card's own drill-through sum to its card total?
 */
async function auditScope(label: string, jobIds: string[], startDate: string, endDate: string): Promise<boolean> {
  const jobPks = await resolveTmJobPks(jobIds);
  const [totals, raw] = await Promise.all([
    getTmHoursTotals(jobPks, startDate, endDate),
    rawPunchedHours(jobPks, startDate, endDate),
  ]);

  console.log(`\n── ${label}  [${startDate} .. ${endDate}]  ${jobPks.length} job(s)`);
  let ok = true;

  const cardSum = TM_HOURS_KEYS.reduce((a, k) => a + totals[k], 0);
  for (const k of TM_HOURS_KEYS) console.log(`   ${TM_HOURS_LABELS[k].padEnd(22)}${F(totals[k])}`);
  console.log(`   ${"— sum of cards".padEnd(22)}${F(cardSum)}`);
  console.log(`   ${"— raw punched".padEnd(22)}${F(raw)}`);
  if (Math.abs(cardSum - raw) > 0.01) {
    console.log(`   ✗ PARTITION BROKEN: ${(raw - cardSum).toFixed(2)}h punched but in no card`);
    ok = false;
  } else {
    console.log(`   ✓ partition complete (every punched hour is in exactly one card)`);
  }

  for (const k of TM_HOURS_KEYS) {
    const { rows, truncated } = await getTmHoursDrillRows(jobPks, startDate, endDate, k as TmHoursDrillKey);
    const drillSum = rows.reduce((a, r) => a + r.hours, 0);
    const diff = totals[k] - drillSum;
    if (truncated) {
      console.log(`   ! ${TM_HOURS_LABELS[k]}: drill TRUNCATED — cannot reconcile`);
      ok = false;
    } else if (Math.abs(diff) > 0.01) {
      console.log(`   ✗ ${TM_HOURS_LABELS[k]}: card ${totals[k].toFixed(2)} vs drill ${drillSum.toFixed(2)} (diff ${diff.toFixed(2)})`);
      ok = false;
    }
  }
  if (ok) console.log(`   ✓ every card reconciles to its own drill-through`);
  return ok;
}

/** Check 3 — hand-calculation from raw punches, independent of the classifier. */
async function handCheck(jobId: string, startDate: string, endDate: string): Promise<void> {
  const jobPks = await resolveTmJobPks([jobId]);
  const detail = await prisma.jobHoursDetail.findMany({
    where: {
      jobId: { in: jobPks },
      workDate: { gte: new Date(`${startDate}T00:00:00.000Z`), lte: new Date(`${endDate}T00:00:00.000Z`) },
    },
    select: { section: true, hours: true },
  });
  const byFolded = new Map<string, number>();
  for (const d of detail) {
    const cols = mapPunchToColumns(d.section, Number(d.hours));
    const allocs = cols.length > 0 ? cols : [{ section: d.section, hours: Number(d.hours) }];
    for (const c of allocs) byFolded.set(c.section, (byFolded.get(c.section) ?? 0) + c.hours);
  }
  console.log(`\n── hand-check job ${jobId} [${startDate} .. ${endDate}] — ${detail.length} raw punches`);
  for (const [code, h] of [...byFolded].sort((a, b) => b[1] - a[1])) console.log(`   ${code.padEnd(10)}${F(h)}`);
}

async function main() {
  const START = "2026-05-31";
  const END = "2026-07-31";
  let allOk = true;

  // ── All Jobs, the selection from the bug report ───────────────────────────
  allOk = (await auditScope("ALL JOBS (reported selection)", [], START, END)) && allOk;

  // ── Several real jobs, one at a time ─────────────────────────────────────
  const busiest = await prisma.jobHoursDetail.groupBy({
    by: ["jobId"],
    where: { workDate: { gte: new Date(`${START}T00:00:00.000Z`), lte: new Date(`${END}T00:00:00.000Z`) } },
    _sum: { hours: true },
    orderBy: { _sum: { hours: "desc" } },
    take: 5,
  });
  const jobs = await prisma.job.findMany({ where: { id: { in: busiest.map((b) => b.jobId) }, ...validJobTypeFilter }, select: { jobId: true } });
  for (const j of jobs) allOk = (await auditScope(`JOB ${j.jobId}`, [j.jobId], START, END)) && allOk;

  // ── Date windows, aggressively ───────────────────────────────────────────
  const windows: [string, string, string][] = [
    ["one day", "2026-06-15", "2026-06-15"],
    ["start == end (boundary)", START, START],
    ["end boundary only", END, END],
    ["one week", "2026-06-08", "2026-06-14"],
    ["one month", "2026-06-01", "2026-06-30"],
    ["crosses month boundary", "2026-06-25", "2026-07-05"],
    ["crosses year boundary", "2025-12-20", "2026-01-10"],
    ["no matching data", "2019-01-01", "2019-01-31"],
  ];
  for (const [label, s, e] of windows) allOk = (await auditScope(`ALL JOBS — ${label}`, [], s, e)) && allOk;

  // Sum of per-job totals must equal the All-Jobs total: proves no join
  // multiplication and that aggregation composes.
  const allTotals = await getTmHoursTotals(await resolveTmJobPks([]), START, END);
  const everyJob = await prisma.job.findMany({ where: validJobTypeFilter, select: { id: true, jobId: true } });
  const perJobSum = TM_HOURS_KEYS.reduce((acc, k) => ({ ...acc, [k]: 0 }), {} as Record<TmHoursDrillKey, number>);
  for (const j of everyJob) {
    const t = await getTmHoursTotals([j.id], START, END);
    for (const k of TM_HOURS_KEYS) perJobSum[k] += t[k];
  }
  console.log(`\n── additivity: sum(per-job) vs All Jobs`);
  for (const k of TM_HOURS_KEYS) {
    const d = allTotals[k] - perJobSum[k];
    console.log(`   ${TM_HOURS_LABELS[k].padEnd(22)} all ${F(allTotals[k])}   sum ${F(perJobSum[k])}   diff ${d.toFixed(2)}`);
    if (Math.abs(d) > 0.01) allOk = false;
  }

  await handCheck(jobs[0]?.jobId ?? "1163", "2026-06-01", "2026-06-30");

  console.log(`\n${allOk ? "✓ ALL CHECKS PASSED" : "✗ FAILURES ABOVE"}`);
  if (!allOk) process.exitCode = 1;
}

main().finally(() => prisma.$disconnect());
