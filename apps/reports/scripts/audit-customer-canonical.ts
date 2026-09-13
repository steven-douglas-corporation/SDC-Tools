/**
 * scripts/audit-customer-canonical.ts
 *
 * The raw-customer -> canonical-customer reconciliation for the Dashboard's
 * "Active Jobs by Customer" chart, run against the live book.
 *
 * Answers, with numbers rather than assurances:
 *
 *   1. every raw customer name -> the canonical customer it counts under
 *   2. every active job belongs to EXACTLY ONE canonical customer
 *   3. no job is lost and none is double-counted
 *   4. the canonical totals sum back to the Active Jobs KPI
 *   5. the project-type segments sum to the same figure
 *   6. the Top 10 / Top 15 ranking is by COMBINED total
 *   7. the drill-through for each canonical customer returns exactly the bar's count
 *   8. the resolver is stable: running it twice gives identical assignments
 *
 *   npx tsx -r ./scripts/shim-server-only.cjs scripts/audit-customer-canonical.ts
 *
 * Exits non-zero if any check fails, so it can gate a deploy.
 */
import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { getDashboardOverview, dashboardMonth } from "../src/lib/dashboard-overview";
import { fetchActiveJobDrill } from "../src/lib/dashboard-job-drill";
import { canonicalCustomerKey, customerAliasFindings } from "../src/lib/customer-canonical";
import { ACTIVE_JOB_WHERE, VALID_JOB_TYPES } from "../src/lib/job-filters";

let failures = 0;
function check(ok: boolean, label: string, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}

async function main() {
  const overview = await getDashboardOverview(dashboardMonth(undefined));
  const activeJobs = await prisma.job.findMany({
    where: ACTIVE_JOB_WHERE,
    select: {
      jobId: true,
      customer: true,
      type: true,
      totEtoCompanyId: true,
      totEtoAccountId: true,
      customerManuallyEdited: true,
    },
  });

  console.log(`\n=== Raw customer → canonical customer (${activeJobs.length} active jobs) ===\n`);
  const byCanonical = new Map<string, { label: string; raw: Map<string, string[]> }>();
  for (const j of activeJobs) {
    const key = canonicalCustomerKey(j);
    const label =
      key.registryName ?? overview.customers.find((c) => c.canonicalCustomerId === key.canonicalCustomerId)?.name ?? "?";
    const group = byCanonical.get(key.canonicalCustomerId) ?? { label, raw: new Map<string, string[]>() };
    const raw = (j.customer ?? "").trim() || "(none)";
    group.raw.set(raw, [...(group.raw.get(raw) ?? []), j.jobId]);
    byCanonical.set(key.canonicalCustomerId, group);
  }
  const ordered = [...byCanonical.entries()].sort(
    (a, b) =>
      [...b[1].raw.values()].flat().length - [...a[1].raw.values()].flat().length ||
      a[1].label.localeCompare(b[1].label),
  );
  for (const [id, g] of ordered) {
    const total = [...g.raw.values()].flat().length;
    console.log(`${String(total).padStart(3)}  ${g.label}   [${id}]`);
    if (g.raw.size > 1) {
      for (const [raw, ids] of [...g.raw.entries()].sort((a, b) => b[1].length - a[1].length)) {
        console.log(`       ${String(ids.length).padStart(3)} x  ${raw}   (${ids.join(", ")})`);
      }
    }
  }

  console.log("\n=== Checks ===\n");

  // 2 + 3. Exactly one canonical customer per job, nothing lost, nothing doubled.
  const assignments = activeJobs.map((j) => ({ jobId: j.jobId, id: canonicalCustomerKey(j).canonicalCustomerId }));
  check(
    assignments.every((a) => a.id !== "" && a.id != null),
    "every active job resolves to a canonical customer",
  );
  const jobsInChart = overview.customers.flatMap((c) => c.jobIds);
  check(
    jobsInChart.length === new Set(jobsInChart).size,
    "no job appears in two chart rows",
    `${jobsInChart.length} rows, ${new Set(jobsInChart).size} distinct`,
  );
  const missing = activeJobs.filter((j) => !jobsInChart.includes(j.jobId)).map((j) => j.jobId);
  check(missing.length === 0, "no active job is missing from the chart", missing.join(", "));

  // 4. Canonical totals sum back to the Active Jobs KPI.
  const summed = overview.customers.reduce((s, c) => s + c.activeCount, 0);
  check(
    summed === overview.activeTotal && summed === activeJobs.length,
    "canonical customer totals sum to the active job count",
    `${summed} vs KPI ${overview.activeTotal} vs query ${activeJobs.length}`,
  );

  // 5. The type segments reconcile, both per row and overall.
  const segTotal = overview.customers.reduce((s, c) => s + c.byType.reduce((t, x) => t + x.count, 0), 0);
  check(segTotal === activeJobs.length, "project-type segments sum to the active job count", `${segTotal}`);
  const badRow = overview.customers.find((c) => c.byType.reduce((t, x) => t + x.count, 0) !== c.activeCount);
  check(!badRow, "every row's segments sum to that row's total", badRow ? badRow.name : "");
  const byTypeStrip = VALID_JOB_TYPES.map((type) => {
    const fromCustomers = overview.customers.reduce(
      (s, c) => s + (c.byType.find((t) => t.type === type)?.count ?? 0),
      0,
    );
    const fromStrip = overview.byType.find((t) => t.type === type)?.count ?? 0;
    return { type, fromCustomers, fromStrip };
  });
  const typeMismatch = byTypeStrip.filter((t) => t.fromCustomers !== t.fromStrip);
  check(
    typeMismatch.length === 0,
    "the customer chart and the project-type chart agree per type",
    typeMismatch.map((t) => `${t.type}: ${t.fromCustomers} vs ${t.fromStrip}`).join("; "),
  );

  // 6. Ranking is on the combined total.
  const counts = overview.customers.map((c) => c.activeCount);
  check(
    counts.every((n, i) => i === 0 || counts[i - 1] >= n),
    "rows are ordered by combined total, descending",
    counts.join(","),
  );
  console.log(
    `      Top 10 = ${overview.customers.slice(0, 10).map((c) => `${c.name} (${c.activeCount})`).join(", ")}`,
  );

  // 7. Drill-through equals the bar, for EVERY canonical customer.
  let drillMismatch = 0;
  for (const c of overview.customers) {
    const drill = await fetchActiveJobDrill({ kind: "customer", value: c.canonicalCustomerId });
    if (drill.rows.length !== c.activeCount) {
      drillMismatch++;
      console.log(`      MISMATCH ${c.name}: bar ${c.activeCount}, drill ${drill.rows.length}`);
    }
    const drillIds = drill.rows.map((r) => r.jobId).sort();
    if (JSON.stringify(drillIds) !== JSON.stringify([...c.jobIds].sort())) {
      drillMismatch++;
      console.log(`      MISMATCH ${c.name}: different job ids`);
    }
  }
  check(drillMismatch === 0, `drill-through matches the bar for all ${overview.customers.length} canonical customers`);

  const drillTotal = (
    await Promise.all(
      overview.customers.map((c) => fetchActiveJobDrill({ kind: "customer", value: c.canonicalCustomerId })),
    )
  ).reduce((s, d) => s + d.rows.length, 0);
  check(
    drillTotal === activeJobs.length,
    "every drill-through added together returns each active job exactly once",
    `${drillTotal} rows for ${activeJobs.length} jobs`,
  );

  // 8. Stability. The resolver is pure, so a second pass must be identical.
  const again = activeJobs.map((j) => ({ jobId: j.jobId, id: canonicalCustomerKey(j).canonicalCustomerId }));
  check(JSON.stringify(assignments) === JSON.stringify(again), "canonical assignments are stable across passes");
  const second = await getDashboardOverview(dashboardMonth(undefined));
  check(
    JSON.stringify(second.customers.map((c) => [c.canonicalCustomerId, c.name, c.activeCount])) ===
      JSON.stringify(overview.customers.map((c) => [c.canonicalCustomerId, c.name, c.activeCount])),
    "a refresh produces identical canonical customers, labels and counts",
  );

  // The Data Quality finding, shown so the naming problem is on the record here too.
  const allJobs = await prisma.job.findMany({
    select: {
      jobId: true,
      customer: true,
      totEtoCompanyId: true,
      totEtoAccountId: true,
      customerManuallyEdited: true,
    },
  });
  const naming = customerAliasFindings(allJobs);
  console.log(`\n=== Data Quality: customers stored under >1 name (whole book, ${allJobs.length} jobs) ===\n`);
  for (const g of naming.groups) {
    console.log(`${String(g.jobCount).padStart(3)}  ${g.canonicalCustomerName}  — ${g.evidence}`);
    for (const n of g.storedNames) console.log(`       ${String(n.jobCount).padStart(3)} x  ${n.name}`);
  }

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}\n`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
