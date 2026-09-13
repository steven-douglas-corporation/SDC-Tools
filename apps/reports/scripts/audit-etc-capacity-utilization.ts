/**
 * scripts/audit-etc-capacity-utilization.ts
 *
 * Verifies the Dashboard's "Engineering & Shop Utilization" card against the
 * live roster and punch data:
 *
 *   1. Mechanical Engineering, Controls Engineering, Mechanical Build and
 *      Electrical Build are all present
 *   2. Wire is counted (inside Electrical Build, not as a sixth row)
 *   3. the row order is the ETC tab's column order
 *   4. Finance / Sales / Executive Leadership / Growth / Operations / No
 *      department are excluded
 *   5. expanded employee rows follow the same department mapping
 *   6. the foot totals sum exactly the rows shown — headcount and every hour column
 *   7. per-row measures are unchanged by the filter
 *   8. the peer Employee Utilization panel still sees every department
 *
 *   npx tsx -r ./scripts/shim-server-only.cjs scripts/audit-etc-capacity-utilization.ts
 *
 * Exits non-zero if any check fails.
 */
import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { getDepartmentUtilization } from "../src/lib/department-utilization";
import { dashboardMonth } from "../src/lib/dashboard-overview";
import {
  ETC_CAPACITY_DEPARTMENTS,
  ETC_CAPACITY_CARD_KEYS,
  isEtcCapacityCardKey,
  etcCapacityOrderRank,
  etcCapacityBillingGroup,
} from "../src/lib/etc-capacity-departments";

let failures = 0;
function check(ok: boolean, label: string, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const pct = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(1)}%`);

async function main() {
  const month = dashboardMonth(undefined);
  const u = await getDepartmentUtilization(month);

  console.log(`\n=== ETC department structure (from the ETC grid's own columns) ===\n`);
  for (const d of ETC_CAPACITY_DEPARTMENTS) {
    console.log(`  ${d.billingGroup.padEnd(12)} ${d.name.padEnd(24)} [${d.cardKey}]  sections ${d.sectionCodes.join(", ")}`);
  }

  console.log(`\n=== Engineering & Shop Utilization — ${month} (${u.workingDays} working days) ===\n`);
  console.log("  #  group        department                     emp   theo    actual   avail%   util%");
  u.departments.forEach((d, i) => {
    console.log(
      `  ${String(i + 1).padStart(2)}  ${(etcCapacityBillingGroup(d.key) ?? "?").padEnd(12)} ${d.title.padEnd(28)} ` +
        `${String(d.employees).padStart(3)} ${String(d.theoreticalHours).padStart(6)} ${d.actualHours.toFixed(2).padStart(9)} ` +
        `${pct(d.availablePct).padStart(7)} ${pct(d.utilizationPct).padStart(7)}`,
    );
  });
  console.log(
    `      ${"".padEnd(12)} ${"TOTAL".padEnd(28)} ${String(u.total.employees).padStart(3)} ${String(u.total.theoreticalHours).padStart(6)} ` +
      `${u.total.actualHours.toFixed(2).padStart(9)} ${pct(u.total.availablePct).padStart(7)} ${pct(u.total.utilizationPct).padStart(7)}`,
  );

  console.log("\n=== Checks ===\n");

  // 1. The four the request names explicitly.
  for (const [key, name] of [
    ["mech", "Mechanical Engineering"],
    ["controls", "Controls Engineering"],
    ["build", "Mechanical Build"],
    ["wire", "Electrical Build"],
  ] as const) {
    const row = u.departments.find((d) => d.key === key);
    check(!!row, `${name} is present`, row ? `${row.employees} employees, ${row.actualHours}h` : "MISSING");
  }

  // 2. Wire is inside Electrical Build rather than a row of its own.
  check(
    !u.departments.some((d) => d.title === "Wire" || d.title === "Machine Wiring"),
    "Wire is not a separate row (its people are inside Electrical Build)",
  );

  // 3. Order.
  const ranks = u.departments.map((d) => etcCapacityOrderRank(d.key));
  check(
    ranks.every((v, i) => i === 0 || ranks[i - 1] <= v),
    "rows are in the ETC tab's column order",
    u.departments.map((d) => d.title).join(" -> "),
  );
  const expected = ETC_CAPACITY_CARD_KEYS.filter((k) => u.departments.some((d) => d.key === k));
  check(
    JSON.stringify(u.departments.map((d) => d.key)) === JSON.stringify(expected),
    "order matches ETC_CAPACITY_CARD_KEYS exactly",
    `${u.departments.map((d) => d.key).join(",")} vs ${expected.join(",")}`,
  );
  const groups = u.departments.map((d) => etcCapacityBillingGroup(d.key));
  check(
    groups.lastIndexOf("Engineering") < groups.indexOf("Shop"),
    "the Engineering block comes before the Shop block",
    groups.join(","),
  );
  const alpha = u.departments.map((d) => d.title).sort((a, b) => a.localeCompare(b));
  check(
    JSON.stringify(u.departments.map((d) => d.title)) !== JSON.stringify(alpha),
    "the order is NOT alphabetical",
    alpha.join(" -> "),
  );

  // 4. Exclusions.
  const mustBeAbsent = ["exec", "finance", "growth", "sales", "operations", "No department", "other", "pm", "mfgops", "service"];
  const present = mustBeAbsent.filter((k) => u.departments.some((d) => d.key === k));
  check(present.length === 0, "administrative and non-ETC departments are excluded", present.join(", "));
  const stray = u.departments.filter((d) => !isEtcCapacityCardKey(d.key));
  check(stray.length === 0, "every row is an ETC department", stray.map((d) => d.title).join(", "));

  // 5. Employee expansion.
  const strayEmployees = u.departments.flatMap((d) =>
    d.employeeRows.filter((e) => !isEtcCapacityCardKey(e.departmentKey)).map((e) => `${e.name} (${e.departmentTitle})`),
  );
  check(strayEmployees.length === 0, "expanded employee rows contain only ETC-department employees", strayEmployees.join(", "));
  const misfiled = u.departments.flatMap((d) => d.employeeRows.filter((e) => e.departmentKey !== d.key).map((e) => `${e.name} in ${d.title}`));
  check(misfiled.length === 0, "every employee row sits under its own department", misfiled.join(", "));

  // 6. The foot sums the rows shown.
  const sum = (f: (d: (typeof u.departments)[number]) => number) => r2(u.departments.reduce((s, d) => s + f(d), 0));
  const fields: [string, (d: (typeof u.departments)[number]) => number, number][] = [
    ["Employees", (d) => d.employees, u.total.employees],
    ["Theoretical", (d) => d.theoreticalHours, u.total.theoreticalHours],
    ["Actual", (d) => d.actualHours, u.total.actualHours],
    ["Billable", (d) => d.billableTotal, u.total.billableTotal],
    ["Active", (d) => d.billableActive, u.total.billableActive],
    ["Warranty", (d) => d.warranty, u.total.warranty],
    ["Service", (d) => d.billableService, u.total.billableService],
    ["Spare parts", (d) => d.billableSpareParts, u.total.billableSpareParts],
    ["Bellco", (d) => d.bellco, u.total.bellco],
    ["Non-billable", (d) => d.nonBillable, u.total.nonBillable],
    ["Overtime", (d) => d.overtimeHours, u.total.overtimeHours],
  ];
  for (const [name, get, total] of fields) {
    const rows = sum(get);
    check(Math.abs(rows - total) < 0.02 + 0.01 * u.departments.length, `foot ${name} equals the sum of the rows`, `rows ${rows} vs total ${total}`);
  }
  const headcount = u.departments.reduce((s, d) => s + d.employeeRows.length, 0);
  check(headcount === u.total.employees, "foot headcount equals the expanded rows", `${headcount} vs ${u.total.employees}`);
  check(
    u.total.theoreticalHours === u.total.employees * u.workingDays * 8,
    "foot theoretical hours = headcount x working days x 8",
    `${u.total.theoreticalHours} vs ${u.total.employees * u.workingDays * 8}`,
  );
  const utilFromFoot = u.total.actualHours > 0 ? u.total.billableTotal / u.total.actualHours : null;
  check(
    (utilFromFoot === null) === (u.total.utilizationPct === null) &&
      (utilFromFoot === null || Math.abs(utilFromFoot - (u.total.utilizationPct ?? 0)) < 1e-9),
    "foot Utilization % = foot billable / foot actual",
    `${pct(u.total.utilizationPct)}`,
  );

  // 7. Per-row measures untouched.
  const badRatio = u.departments.filter((d) => {
    const avail = d.theoreticalHours > 0 ? d.actualHours / d.theoreticalHours : null;
    if ((avail === null) !== (d.availablePct === null)) return true;
    if (avail !== null && d.availablePct !== null && Math.abs(avail - d.availablePct) > 1e-9) return true;
    const util = d.inUtilizationScope && d.actualHours > 0 ? d.billableTotal / d.actualHours : null;
    if ((util === null) !== (d.utilizationPct === null)) return true;
    return util !== null && d.utilizationPct !== null && Math.abs(util - d.utilizationPct) > 1e-9;
  });
  check(badRatio.length === 0, "each row's Available % and Utilization % still follow its own figures", badRatio.map((d) => d.title).join(", "));
  const badFoot = u.departments.filter((d) => Math.abs(d.billableTotal + d.nonBillable + d.bellco - d.actualHours) > 0.05);
  check(badFoot.length === 0, "Billable + Non-Billable + Bellco = Actual on every row", badFoot.map((d) => d.title).join(", "));

  // 8. The peer panel.
  const employeeDepts = [...new Set(u.employees.map((e) => e.departmentTitle))].sort();
  check(
    u.employees.some((e) => !isEtcCapacityCardKey(e.departmentKey)),
    "`employees` is still unfiltered, so the Employee Utilization panel is unaffected",
    `${employeeDepts.length} departments`,
  );
  console.log(`      Employee panel departments: ${employeeDepts.join(", ")}`);

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}\n`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
