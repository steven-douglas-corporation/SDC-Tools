/**
 * Gives a name to a Paylocity employee id that appears in punch history but has
 * no Employee row — so historical hours show a person instead of "#100601".
 *
 * Run:  npx tsx -r ./scripts/shim-server-only.cjs scripts/add-missing-employee-names.ts
 *       (add --dry to see what it would do)
 *
 * ── Why a script and not a hardcoded map ────────────────────────────────────
 *
 * Name resolution across the app is a JOIN on Employee.paylocityId — the punch
 * drill, Job Hour Details, T&M's hours drills, the Hours explorer, Department
 * Utilization and the data-quality panel all do it, and NONE of them filters on
 * `active`. So an inactive employee already resolves everywhere; the only thing
 * a former employee needs is a row. Adding one fixes every surface at once, and
 * adding a lookup table in code would have created a second naming path that
 * only some of those surfaces consulted.
 *
 * Rows are created with active = false: these people have left, and the app
 * already holds 46 other inactive employees, so it is a normal state rather than
 * a special case.
 *
 * ── Department is DERIVED, never guessed from the name ──────────────────────
 *
 * From the canonical FUNCTION -> department map the whole app uses
 * (paylocity-canonical.ts), applied to the functions the person actually punched.
 * 100601's hours are entirely function 211 (-> Mechanical Engineering); 100157's
 * are 311/312/313 (-> Controls Engineering). Leaving it null would put them in
 * Department Utilization's "Other" bucket, which is strictly worse than the
 * answer their own timecards give.
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (!m) continue;
  let v = m[2].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  if (!process.env[m[1]]) process.env[m[1]] = v;
}

import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { canonicalDepartmentFor } from "@/lib/paylocity-canonical";

/**
 * Former employees whose names were supplied but who had no Employee row.
 * Add to this map and re-run; it is idempotent and never overwrites a row that
 * already exists.
 */
const NAMES: Record<string, string> = {
  "100601": "Denys Biloochenko",
  "100157": "Brian Mack",
};

/** The department their own punches imply, via the app's canonical function map. */
async function deriveDepartment(paylocityId: string): Promise<{ department: string | null; basis: string }> {
  const grouped = await prisma.jobHoursDetail.groupBy({
    by: ["rawFunction"],
    where: { employeeId: paylocityId },
    _sum: { hours: true },
  });
  const byDept = new Map<string, number>();
  for (const g of grouped) {
    const dept = canonicalDepartmentFor(g.rawFunction);
    if (!dept) continue;
    byDept.set(dept, (byDept.get(dept) ?? 0) + Number(g._sum.hours ?? 0));
  }
  const ranked = [...byDept].sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) return { department: null, basis: "no punched function maps to a department" };
  const total = ranked.reduce((s, [, h]) => s + h, 0);
  const [dept, hours] = ranked[0];
  return {
    department: dept,
    basis: `${((hours / total) * 100).toFixed(0)}% of ${total.toFixed(2)}h punched (${ranked.map(([d, h]) => `${d} ${h.toFixed(2)}h`).join(", ")})`,
  };
}

async function main() {
  const dry = process.argv.includes("--dry");

  for (const [paylocityId, name] of Object.entries(NAMES)) {
    const existing = await prisma.employee.findUnique({
      where: { paylocityId },
      select: { id: true, name: true, active: true, department: true },
    });
    const punches = await prisma.jobHoursDetail.aggregate({
      where: { employeeId: paylocityId },
      _sum: { hours: true },
      _count: { _all: true },
    });
    const hours = Number(punches._sum.hours ?? 0);
    const { department, basis } = await deriveDepartment(paylocityId);

    console.log(`\n${paylocityId} -> ${name}`);
    console.log(`  punch history : ${hours.toFixed(2)}h over ${punches._count._all} rows`);
    console.log(`  department    : ${department ?? "(none)"} — ${basis}`);

    if (existing) {
      // Never clobber a row somebody has already curated.
      console.log(`  SKIPPED — an Employee row already exists ("${existing.name}", active=${existing.active}).`);
      continue;
    }
    if (dry) {
      console.log("  would CREATE (active=false)");
      continue;
    }

    const created = await prisma.employee.create({
      data: { paylocityId, name, department, active: false },
      select: { id: true },
    });
    // The app's own audit mechanism, not a parallel one. logAudit falls back to
    // "system@auto-sync" when there is no request scope, which is the case here.
    await logAudit({
      action: "employee.create",
      entityType: "Employee",
      entityId: created.id,
      summary: `Added former employee ${name} (Paylocity ${paylocityId}) so ${hours.toFixed(2)}h of historical punches show a name instead of an id`,
      metadata: { paylocityId, name, department, active: false, historicalHours: hours, source: "manual name mapping" },
    });
    console.log(`  CREATED Employee id=${created.id}, active=false`);
  }

  // Whatever is STILL unnamed, so the next gap is visible rather than waiting to
  // be noticed on a screen.
  const ids = await prisma.jobHoursDetail.findMany({ select: { employeeId: true }, distinct: ["employeeId"] });
  const known = new Set(
    (await prisma.employee.findMany({ where: { paylocityId: { not: null } }, select: { paylocityId: true } })).map(
      (e) => e.paylocityId,
    ),
  );
  const orphans = ids.map((i) => i.employeeId).filter((i) => i && !known.has(i));
  console.log(`\n── Punch employee ids with STILL no Employee row: ${orphans.length} ──`);
  for (const o of orphans) {
    const g = await prisma.jobHoursDetail.aggregate({ where: { employeeId: o }, _sum: { hours: true }, _count: { _all: true } });
    console.log(`   ${String(o).padEnd(10)} ${Number(g._sum.hours ?? 0).toFixed(2)}h / ${g._count._all} rows — no name available`);
  }
  if (orphans.length === 0) console.log("   (none — every punch in the app resolves to a named person)");
}

main().finally(() => prisma.$disconnect());
