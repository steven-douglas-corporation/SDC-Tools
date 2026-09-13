// Reconciliation audit for the Dashboard (redesigned 2026-08-27): does every
// figure on the page still agree with the data it claims to come from?
//
//   npx tsx -r ./scripts/shim-server-only.cjs scripts/audit-dashboard-reconciliation.ts [YYYY-MM]
//
// ── What this is guarding against ───────────────────────────────────────────
//
// The Dashboard reports the same population three ways at once — one Active Jobs
// total, five project-type rows, and one card per customer — plus FAT counts from
// a SECOND database (the Scheduler's MySQL) and hours from a third classification
// (JobHoursDetail.standardDepartment). Every one of those is a chance for the
// page to state two numbers that cannot both be true.
//
// getDashboardOverview() is built so they cannot disagree: the three job views
// are computed from one array read once, and the type list is the same
// VALID_JOB_TYPES the query filtered on. This script demonstrates that rather
// than asserting it, and re-derives each figure INDEPENDENTLY — a second count
// query, a second read of the raw Scheduler rows, a second walk of the employee
// department mapping — so it can actually fail if the composition ever drifts.
//
// Deliberately not a unit test: every check here needs both live databases, and
// tests/ is unit-only by design (see docs/TESTING.md).
import { getDashboardOverview } from "@/lib/dashboard-overview";
import { prisma } from "@/lib/prisma";
import { validJobTypeFilter } from "@/lib/job-filters";
import { fetchSchedulerFatEvents } from "@/lib/scheduler-db";
import { resolveEmployeeGroup } from "@/lib/employee-card-theme";
import { workforceGroupForCardKey, rollupGroup } from "@/lib/employee-workforce-groups";

const fails: string[] = [];

function check(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
  if (!ok) fails.push(name);
}

async function main() {
  const month = process.argv[2] ?? new Date().toISOString().slice(0, 7);
  console.log(`Reconciling the Dashboard for ${month}\n`);
  const d = await getDashboardOverview(month);

  // 1. Active total against an independent count query.
  const activeCount = await prisma.job.count({ where: { status: "Active", ...validJobTypeFilter } });
  check("1 active total", d.activeTotal === activeCount, `dashboard ${d.activeTotal} vs prisma.count ${activeCount}`);

  // 2. Type counts partition the active population exactly. This is the check
  // that would catch a job whose type is outside VALID_JOB_TYPES leaking into
  // the total without appearing in any bar.
  const typeSum = d.byType.reduce((s, t) => s + t.count, 0);
  check(
    "2 type counts sum to active total",
    typeSum === d.activeTotal,
    `${d.byType.map((t) => `${t.type}=${t.count}`).join(" ")} sum=${typeSum} vs ${d.activeTotal}`,
  );
  const pctSum = Math.round(d.byType.reduce((s, t) => s + t.pct, 0));
  check("2b percentages sum to ~100", d.activeTotal === 0 || Math.abs(pctSum - 100) <= 1, `sum ${pctSum}%`);

  // 3. Customer cards cover the same jobs, once each. Both the counts AND the
  // job ids, because equal totals could still be the wrong jobs.
  const custSum = d.customers.reduce((s, c) => s + c.activeCount, 0);
  const custJobIds = new Set(d.customers.flatMap((c) => c.jobIds));
  check("3 customer counts sum to active total", custSum === d.activeTotal, `${custSum} vs ${d.activeTotal} across ${d.customers.length} customers`);
  check("3b customer job ids are distinct and complete", custJobIds.size === d.activeTotal, `${custJobIds.size} distinct ids vs ${d.activeTotal}`);
  const custTypeSum = d.customers.reduce((s, c) => s + c.byType.reduce((t, x) => t + x.count, 0), 0);
  check("3c per-customer type mixes sum to active total", custTypeSum === d.activeTotal, `${custTypeSum} vs ${d.activeTotal}`);

  // 4. FAT dates and counts against the raw Scheduler rows, deduped the same way
  // the dashboard does (one event per job per date) and gated to the same live
  // job population.
  const raw = (await fetchSchedulerFatEvents()) ?? [];
  const liveJobIds = new Set(
    (await prisma.job.findMany({ where: { status: { in: ["Active", "HeadStart"] }, ...validJobTypeFilter }, select: { jobId: true } })).map(
      (j) => j.jobId,
    ),
  );
  const rawMonth = raw.filter((e) => e.date.startsWith(`${month}-`) && liveJobIds.has(e.jobNumber));
  const rawFatKeys = new Set(rawMonth.filter((e) => e.kind === "fat").map((e) => `${e.jobNumber}|${e.date}`));
  const rawPreKeys = new Set(rawMonth.filter((e) => e.kind === "pre").map((e) => `${e.jobNumber}|${e.date}`));
  check("4 FAT count matches Scheduler", d.fats.monthTotal === rawFatKeys.size, `dashboard ${d.fats.monthTotal} vs distinct (job,date) in Scheduler ${rawFatKeys.size}`);
  check("4b pre-FAT count matches Scheduler", d.fats.monthPreFats === rawPreKeys.size, `${d.fats.monthPreFats} vs ${rawPreKeys.size}`);
  // Checks 4c/4d and the whole of 5 (ME/CE bounds, placeholder seats, unstaffed
  // FATs) were removed on 2026-08-31 along with the data they verified: the FAT
  // summary cards beside the Execution Calendar were dropped by request, and with
  // them `fats.monthRows`, `fats.upcoming` and the ME/CE/unstaffed counts. 4 and
  // 4b above survive and still do the important job — they check the two figures
  // the KPI strip shows against the raw Scheduler feed, which is also what
  // validates the simpler count path that replaced the FatRow[] build.

  // 6. Hours against JobHoursDetail — the punch classification, not Power BI.
  const hours = await prisma.jobHoursDetail.groupBy({ by: ["standardDepartment"], where: { month }, _sum: { hours: true } });
  for (const key of ["engineering", "shop"] as const) {
    const w = d.workforce.find((x) => x.key === key)!;
    const label = key === "engineering" ? "Engineering" : "Shop";
    const expected = hours.length === 0 ? null : Math.round(Number(hours.find((h) => h.standardDepartment === label)?._sum.hours ?? 0));
    check(`6 ${key} booked hours`, w.bookedHours === expected, `dashboard ${w.bookedHours} vs JobHoursDetail ${expected}`);
  }

  // 7. Headcount against a second walk of the same department mapping.
  const emps = await prisma.employee.findMany({ where: { active: true }, select: { team: true, department: true, discipline: true } });
  const expectCounts: Record<string, number> = {};
  for (const e of emps) {
    const g = resolveEmployeeGroup(e);
    if (!g) continue;
    const k = rollupGroup(workforceGroupForCardKey(g.key));
    expectCounts[k] = (expectCounts[k] ?? 0) + 1;
  }
  for (const key of ["engineering", "shop"] as const) {
    const w = d.workforce.find((x) => x.key === key)!;
    check(
      `7 ${key} headcount uses the department mapping`,
      w.headcount === (expectCounts[key] ?? 0),
      `dashboard ${w.headcount} vs mapping ${expectCounts[key] ?? 0} · ${w.teams.map((t) => `${t.name}=${t.count}`).join(", ")}`,
    );
  }

  // 8. Head Start, which is a STATUS and must not be mixed into the type bars.
  const hs = await prisma.job.count({ where: { status: "HeadStart", ...validJobTypeFilter } });
  check("8 head start count", d.headStartTotal === hs, `dashboard ${d.headStartTotal} vs prisma.count ${hs}`);

  // 9. One month control moves every monthly figure, and Active Jobs — which has
  // no historical model — deliberately does not move with it.
  const prev = await getDashboardOverview(prevMonthOf(month));
  check(
    "9 monthly figures move with the month, active jobs do not",
    prev.month === prevMonthOf(month) && prev.activeTotal === d.activeTotal,
    `${prevMonthOf(month)}: FATs ${prev.fats.monthTotal} (+${prev.fats.monthPreFats} pre) eng ${prev.workforce[0].bookedHours} shop ${prev.workforce[1].bookedHours} · ` +
      `${month}: FATs ${d.fats.monthTotal} (+${d.fats.monthPreFats} pre) eng ${d.workforce[0].bookedHours} shop ${d.workforce[1].bookedHours} · active unchanged at ${d.activeTotal}`,
  );

  // 9b. No fake zeros: a month nobody has booked hours in reports null, not 0.
  const future = await getDashboardOverview(`${new Date().getFullYear() + 1}-03`);
  check(
    "9b a month with no punch rows reports null, not 0",
    future.workforce.every((w) => w.bookedHours === null),
    `booked ${JSON.stringify(future.workforce.map((w) => w.bookedHours))} · capacity ${JSON.stringify(future.workforce.map((w) => w.capacityHours))} (capacity is null outside the years with a holiday calendar, and the card says so)`,
  );

  // 9c. Customer Visits stay behind their declared boundary until a source exists.
  check("9c customer visits gated behind the data-source boundary", d.visits.configured === false, `configured=${d.visits.configured}`);

  console.log(fails.length === 0 ? "\nALL CHECKS PASSED" : `\n${fails.length} FAILED: ${fails.join(", ")}`);
  await prisma.$disconnect();
  // The Scheduler's MySQL pool keeps the event loop alive, so exit explicitly
  // rather than leaving the script hanging after its last line.
  process.exit(fails.length === 0 ? 0 : 1);
}

function prevMonthOf(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

void main();
