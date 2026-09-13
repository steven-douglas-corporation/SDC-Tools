// Backend performance baseline: what each tab actually costs the database.
//
// Why a script rather than a profiler (2026-08-04): every page in this app is a
// dynamically-rendered server component, so "the API" for a tab IS its render, and
// the only way to see inside it from outside is the RSC response time — one number
// for a dozen queries. This runs the SAME queries the pages run, one at a time,
// against the real database, and prints where the time goes.
//
// It is deliberately re-runnable and committed: the numbers in DEVLOG §17 came from
// it, and a future change that regresses a tab should be provable with the same
// command rather than a fresh argument about whether it feels slower.
//
//   npx tsx scripts/perf-baseline.ts            # every tab
//   npx tsx scripts/perf-baseline.ts etc        # one tab
//   npx tsx scripts/perf-baseline.ts etc 2026-07
//
// Caveats, stated so the numbers are not over-read:
//   * Wall-clock against a live database on a live network — run it twice and take
//     the second, and don't compare across machines.
//   * It measures QUERIES, not React rendering. The ETC page's 4,150 cells are
//     measured in the browser (see DEVLOG §17), not here.
//   * WAVE boundaries are what matter as much as the totals: queries inside one
//     wave run concurrently in the page, so a wave costs its SLOWEST member, while
//     the waves themselves are serial. Reducing the number of waves is usually
//     worth more than shaving a query.
import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { etcActiveJobFilter, validJobTypeFilter } from "../src/lib/job-filters";
import { getEtcMonthJobWhere } from "../src/lib/etc-month-jobs";
import { getEtcMonthKpis } from "../src/lib/etc-month-kpis";
import { getExecutionEtcByJob } from "../src/lib/execution-etc";
import { loadActualHoursBySection } from "../src/lib/actual-hours";
import { getEtcMonthHoursDetail } from "../src/lib/job-hours-detail";

type Timing = { wave: number; label: string; ms: number; rows: number | string };

const timings: Timing[] = [];
let wave = 0;

async function q<T>(label: string, run: () => Promise<T>, count?: (r: T) => number | string): Promise<T> {
  const t0 = performance.now();
  const result = await run();
  const ms = performance.now() - t0;
  timings.push({
    wave,
    label,
    ms: Math.round(ms),
    rows: count ? count(result) : Array.isArray(result) ? result.length : typeof result === "object" && result !== null ? 1 : String(result),
  });
  return result;
}

// Everything inside one wave runs concurrently in the real page, so the wave costs
// its slowest member. Serial waves are the thing to count.
function nextWave() {
  wave += 1;
}

function report(tab: string) {
  const byWave = new Map<number, Timing[]>();
  for (const t of timings) {
    if (!byWave.has(t.wave)) byWave.set(t.wave, []);
    byWave.get(t.wave)!.push(t);
  }
  let critical = 0;
  console.log(`\n=== ${tab} ===`);
  for (const [w, ts] of [...byWave.entries()].sort((a, b) => a[0] - b[0])) {
    const slowest = Math.max(...ts.map((t) => t.ms));
    critical += slowest;
    console.log(`  wave ${w}  (${ts.length} quer${ts.length === 1 ? "y" : "ies"}, slowest ${slowest}ms)`);
    for (const t of ts.sort((a, b) => b.ms - a.ms)) {
      console.log(`    ${String(t.ms).padStart(6)}ms  ${String(t.rows).padStart(7)} rows  ${t.label}`);
    }
  }
  const total = timings.reduce((s, t) => s + t.ms, 0);
  console.log(`  ---`);
  console.log(`  queries:            ${timings.length}`);
  console.log(`  serial waves:       ${byWave.size}`);
  console.log(`  critical path:      ${critical}ms   <- what the page waits for`);
  console.log(`  summed query time:  ${total}ms   <- total database work`);
  timings.length = 0;
  wave = 0;
}

// ── Monthly ETC ─────────────────────────────────────────────────────────────
async function etc(month?: string) {
  const [distinctMonths] = await Promise.all([
    q("etcEntry.findMany distinct month", () => prisma.etcEntry.findMany({ distinct: ["month"], select: { month: true }, orderBy: { month: "desc" } })),
    q("etcEntry.groupBy needsReview", () => prisma.etcEntry.groupBy({ by: ["month"], where: { needsReview: true } })),
  ]);
  const m = month ?? distinctMonths[0]?.month;
  if (!m) return console.log("no ETC months exist");

  nextWave();
  const { where: monthJobWhere } = await q("getEtcMonthJobWhere", () => getEtcMonthJobWhere(m), (r) => (r.monthIsLocked ? "locked" : "open"));

  nextWave();
  const [jobs] = await Promise.all([
    q("job.findMany + etcEntries + executionRate (THE grid query)", () =>
      prisma.job.findMany({ where: monthJobWhere, include: { etcEntries: { where: { month: m } }, executionRate: true } }),
      (r) => `${r.length}j/${r.reduce((s, j) => s + j.etcEntries.length, 0)}e`),
    q("jobMonthlyActualHours.findFirst", () => prisma.jobMonthlyActualHours.findFirst({ orderBy: { syncedAt: "desc" }, select: { syncedAt: true } })),
    q("powerBiFreshness hours_actual", () => prisma.powerBiFreshness.findUnique({ where: { source: "hours_actual" } })),
    q("powerBiFreshness etc_hours_worked", () => prisma.powerBiFreshness.findUnique({ where: { source: "etc_hours_worked" } })),
    q("hoursImportIssue.findMany", () => prisma.hoursImportIssue.findMany({ where: { month: m }, orderBy: { hours: "desc" } })),
  ]);
  const renderedJobIds = jobs.map((j) => j.id);

  // ONE wave for four independent reads (2026-08-04) — these were four serial awaits.
  // The Scheduler lookup and the two cookie gates are in it too in the real page; only
  // the database ones are timed here.
  nextWave();
  await Promise.all([
    q("jobHoursDetail.findMany (hours on hidden jobs)", () =>
      prisma.jobHoursDetail.findMany({
        where: { month: m, hours: { gt: 0 }, jobId: { notIn: renderedJobIds }, job: { ...validJobTypeFilter, status: { not: "Complete" } } },
        select: { hours: true, section: true, job: { select: { jobId: true, jobName: true, status: true } } },
      })),
    q("job.findMany HeadStart", () => prisma.job.findMany({ where: { status: "HeadStart", ...validJobTypeFilter }, select: { id: true, jobId: true, jobName: true } })),
    // Pure summation over the etcEntries already loaded — no query of its own.
    q("getEtcMonthKpis (no query — sums loaded entries)", () => getEtcMonthKpis(m, jobs), () => "kpis"),
  ]);
  // getEtcMonthHoursDetail is NOT here any more: the punch drill-through is fetched
  // when the panel is opened (lib/hours-detail-actions.ts). It was the slowest query
  // on the page, for a panel that starts closed. Timed on its own below so the cost of
  // OPENING the drill is still on the record.

  nextWave();
  await q("standardSheetSnapshot.findFirst", () => prisma.standardSheetSnapshot.findFirst({ where: { month: m }, select: { id: true } }));

  nextWave();
  await Promise.all([
    q("getExecutionEtcByJob", () => getExecutionEtcByJob(renderedJobIds, m), (r) => r.size),
    q("categoryPool.findMany", () => prisma.categoryPool.findMany({ where: { month: m } })),
    q("standardSheetSetting.findUnique", () => prisma.standardSheetSetting.findUnique({ where: { id: 1 } })),
    q("job.findMany newProjects", () => prisma.job.findMany({ where: { ...validJobTypeFilter, status: "Active" }, select: { id: true, jobId: true } })),
  ]);

  nextWave();
  await q("powerBiFreshness pools", () => prisma.powerBiFreshness.findUnique({ where: { source: "standard_pool" } }));

  report(`Monthly ETC (${m})`);

  // On demand, not on load: what a manager pays only when they open the drill.
  await q("getEtcMonthHoursDetail (ON DEMAND — drill opened)", () => getEtcMonthHoursDetail(m, renderedJobIds), (r) => r.rows.length);
  report("Monthly ETC — opening the punch drill (was part of every page load)");
}

// ── Projects ────────────────────────────────────────────────────────────────
async function projects() {
  await Promise.all([
    q("job.findMany distinct customer", () => prisma.job.findMany({ where: validJobTypeFilter, distinct: ["customer"], select: { customer: true } })),
    q("job.findMany distinct status", () => prisma.job.findMany({ where: validJobTypeFilter, distinct: ["status"], select: { status: true } })),
    q("savedView.findMany (shared views)", () => prisma.savedView.findMany({ where: { scope: { in: ["shared", "default"] } }, orderBy: { name: "asc" } })),
  ]);

  nextWave();
  const jobs = await q("job.findMany + estimatedHours (THE grid query)", () =>
    prisma.job.findMany({ where: validJobTypeFilter, include: { estimatedHours: true } }),
    (r) => `${r.length}j/${r.reduce((s, j) => s + j.estimatedHours.length, 0)}h`);

  nextWave();
  await q("loadActualHoursBySection", () => loadActualHoursBySection(jobs.map((j) => j.id)), (r) => r.size);

  report("Projects");
}

// ── Employees ───────────────────────────────────────────────────────────────
async function employees() {
  await q("employee.findMany", () => prisma.employee.findMany({ orderBy: [{ active: "desc" }, { name: "asc" }] }));
  report("Employees");
}

// ── Audit Log ───────────────────────────────────────────────────────────────
async function auditLog() {
  await Promise.all([
    q("auditLog.findMany take 1000", () => prisma.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: 1000 })),
    q("auditLog.count", () => prisma.auditLog.count(), (r) => r),
  ]);
  report("Audit Log");
}

// ── Dashboard ───────────────────────────────────────────────────────────────
async function dashboard() {
  await Promise.all([
    q("job.count all", () => prisma.job.count({ where: validJobTypeFilter }), (r) => r),
    q("job.count active", () => prisma.job.count({ where: { status: "Active", ...validJobTypeFilter } }), (r) => r),
    q("employee.count active", () => prisma.employee.count({ where: { active: true } }), (r) => r),
    q("etcEntry.count needsReview", () => prisma.etcEntry.count({ where: { needsReview: true } }), (r) => r),
    q("job.findMany recent 8", () => prisma.job.findMany({ where: validJobTypeFilter, orderBy: { createdAt: "desc" }, take: 8 })),
    q("job.findFirst totEtoSyncedAt", () => prisma.job.findFirst({ where: { totEtoSyncedAt: { not: null } }, orderBy: { totEtoSyncedAt: "desc" }, select: { totEtoSyncedAt: true } })),
    q("jobMonthlyActualHours.findFirst", () => prisma.jobMonthlyActualHours.findFirst({ orderBy: { syncedAt: "desc" }, select: { syncedAt: true } })),
    q("estimatedHours.findFirst", () => prisma.estimatedHours.findFirst({ orderBy: { updatedAt: "desc" }, select: { updatedAt: true } })),
    q("powerBiFreshness.findMany", () => prisma.powerBiFreshness.findMany()),
  ]);
  report("Dashboard");
}

// ── The ETC active-job filter on its own ────────────────────────────────────
// Called by seeding, pruning, submission and the grid. Worth timing alone because
// it is the one predicate every ETC path shares.
async function filters() {
  await q("job.findMany etcActiveJobFilter", () => prisma.job.findMany({ where: etcActiveJobFilter, select: { id: true } }));
  report("Shared filters");
}

async function main() {
  const which = process.argv[2];
  const month = process.argv[3];
  const all = !which || which === "all";
  // Warm the connection pool first — the first query of the process pays for the
  // handshake and would otherwise be reported as the slowest thing on the page.
  await prisma.$queryRaw`SELECT 1`;
  if (all || which === "etc") await etc(month);
  if (all || which === "projects") await projects();
  if (all || which === "employees") await employees();
  if (all || which === "audit") await auditLog();
  if (all || which === "dashboard") await dashboard();
  if (all || which === "filters") await filters();
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
