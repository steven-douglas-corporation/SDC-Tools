/**
 * scripts/audit-etc-capacity-utilization.ts
 *
 * Verifies the Dashboard's "Engineering & Shop Utilization" card against the
 * live roster and punch data:
 *
 *   1. Mechanical Engineering, Controls Engineering, Service Engineering,
 *      Mechanical Build and Electrical Build are all present
 *   2. Wire is counted (inside Electrical Build, not as a separate row)
 *   3. the row order is the ETC tab's column order, with Service Engineering at
 *      the end of the Engineering block
 *   4. Finance / Sales / Executive Leadership / Growth / Operations / No
 *      department / PM / Manufacturing Operations are excluded
 *   5. expanded employee rows follow the same department mapping
 *   6. each foot (Engineering, Shop) sums exactly the rows of its group —
 *      headcount and every hour column
 *   7. per-row measures are unchanged by the filter
 *   8. the peer Employee Utilization panel still sees every department
 *
 *   npx tsx -r ./scripts/shim-server-only.cjs scripts/audit-etc-capacity-utilization.ts
 *
 * Exits non-zero if any check fails.
 */
import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { getDepartmentUtilization, utilizationCardGroup, UTILIZATION_CARD_KEYS } from "../src/lib/department-utilization";
import { dashboardMonth } from "../src/lib/dashboard-overview";
import { ETC_CAPACITY_DEPARTMENTS } from "../src/lib/etc-capacity-departments";

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
      `  ${String(i + 1).padStart(2)}  ${(utilizationCardGroup(d.key) ?? "?").padEnd(12)} ${d.title.padEnd(28)} ` +
        `${String(d.employees).padStart(3)} ${String(d.theoreticalHours).padStart(6)} ${d.actualHours.toFixed(2).padStart(9)} ` +
        `${pct(d.availablePct).padStart(7)} ${pct(d.utilizationPct).padStart(7)}`,
    );
  });
  for (const t of u.totals) {
    console.log(
      `      ${"".padEnd(12)} ${`${t.group.toUpperCase()} TOTAL`.padEnd(28)} ${String(t.employees).padStart(3)} ${String(t.theoreticalHours).padStart(6)} ` +
        `${t.actualHours.toFixed(2).padStart(9)} ${pct(t.availablePct).padStart(7)} ${pct(t.utilizationPct).padStart(7)}`,
    );
  }

  console.log("\n=== Checks ===\n");

  // 1. The rows the requests name explicitly.
  for (const [key, name] of [
    ["mech", "Mechanical Engineering"],
    ["controls", "Controls Engineering"],
    ["service", "Service Engineering"],
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
  const expected = UTILIZATION_CARD_KEYS.filter((k) => u.departments.some((d) => d.key === k));
  check(
    JSON.stringify(u.departments.map((d) => d.key)) === JSON.stringify(expected),
    "order matches UTILIZATION_CARD_KEYS exactly",
    `${u.departments.map((d) => d.key).join(",")} vs ${expected.join(",")}`,
  );
  const groups = u.departments.map((d) => utilizationCardGroup(d.key));
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
  const mustBeAbsent = ["exec", "finance", "growth", "sales", "operations", "No department", "other", "pm", "mfgops"];
  const present = mustBeAbsent.filter((k) => u.departments.some((d) => d.key === k));
  check(present.length === 0, "administrative and non-card departments are excluded", present.join(", "));
  const stray = u.departments.filter((d) => utilizationCardGroup(d.key) === null);
  check(stray.length === 0, "every row is a card department", stray.map((d) => d.title).join(", "));

  // 5. Employee expansion.
  const strayEmployees = u.departments.flatMap((d) =>
    d.employeeRows.filter((e) => utilizationCardGroup(e.departmentKey) === null).map((e) => `${e.name} (${e.departmentTitle})`),
  );
  check(strayEmployees.length === 0, "expanded employee rows contain only card-department employees", strayEmployees.join(", "));
  const misfiled = u.departments.flatMap((d) => d.employeeRows.filter((e) => e.departmentKey !== d.key).map((e) => `${e.name} in ${d.title}`));
  check(misfiled.length === 0, "every employee row sits under its own department", misfiled.join(", "));

  // 6. Each foot sums the rows of its group.
  for (const t of u.totals) {
    const rowsOf = u.departments.filter((d) => utilizationCardGroup(d.key) === t.group);
    const sum = (f: (d: (typeof u.departments)[number]) => number) => r2(rowsOf.reduce((s, d) => s + f(d), 0));
    const fields: [string, (d: (typeof u.departments)[number]) => number, number][] = [
      ["Employees", (d) => d.employees, t.employees],
      ["Theoretical", (d) => d.theoreticalHours, t.theoreticalHours],
      ["Actual", (d) => d.actualHours, t.actualHours],
      ["Billable", (d) => d.billableTotal, t.billableTotal],
      ["Active", (d) => d.billableActive, t.billableActive],
      ["Warranty", (d) => d.warranty, t.warranty],
      ["Service", (d) => d.billableService, t.billableService],
      ["Spare parts", (d) => d.billableSpareParts, t.billableSpareParts],
      ["Bellco", (d) => d.bellco, t.bellco],
      ["Non-billable", (d) => d.nonBillable, t.nonBillable],
      ["Overtime", (d) => d.overtimeHours, t.overtimeHours],
    ];
    for (const [name, get, total] of fields) {
      const rows = sum(get);
      check(Math.abs(rows - total) < 0.02 + 0.01 * rowsOf.length, `${t.group} foot ${name} equals the sum of its rows`, `rows ${rows} vs total ${total}`);
    }
    const headcount = rowsOf.reduce((s, d) => s + d.employeeRows.length, 0);
    check(headcount === t.employees, `${t.group} foot headcount equals the expanded rows`, `${headcount} vs ${t.employees}`);
    check(
      t.theoreticalHours === t.employees * u.workingDays * 8,
      `${t.group} foot theoretical hours = headcount x working days x 8`,
      `${t.theoreticalHours} vs ${t.employees * u.workingDays * 8}`,
    );
    const utilFromFoot = t.actualHours > 0 ? t.billableTotal / t.actualHours : null;
    check(
      (utilFromFoot === null) === (t.utilizationPct === null) &&
        (utilFromFoot === null || Math.abs(utilFromFoot - (t.utilizationPct ?? 0)) < 1e-9),
      `${t.group} foot Utilization % = foot billable / foot actual`,
      `${pct(t.utilizationPct)}`,
    );
  }

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
    u.employees.some((e) => utilizationCardGroup(e.departmentKey) === null),
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
