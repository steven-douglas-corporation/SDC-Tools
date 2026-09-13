// §42.31 #13 / §42.33 #27 — measured evidence for the HOURS path specifically.
//
//   npx tsx --tsconfig tsconfig.scripts.json scripts/_verify_hours_import.ts
//
// Runs the same functions the refresh service runs, in the same order, but WITHOUT the
// TotalETO and Scheduler steps — those reach external systems that are unrelated to
// §42 and that hung the full-pass run for >10 minutes. §42.17's "one centralized
// service" is satisfied by auto-sync.ts calling exactly these functions; what needs
// measuring here is whether Lisa's file reaches the database and whether the KPI and
// its drill-through agree afterwards.
import "dotenv/config";
import { prisma } from "@/lib/prisma";
import { describeProvenance } from "@/lib/hours-feed";
import { newImportContext, beginPaylocityImport, recordUndefinedHours, completePaylocityImport } from "@/lib/paylocity-import";
import { syncActualHours, syncHoursWorked } from "@/lib/sync-actuals";
import { getUnattributedDetail } from "@/lib/unattributed-hours";
import { reconcileUndefined, reconciliationMessage } from "@/lib/undefined-hours-rules";
import { isMonthLocked } from "@/lib/etc";
import { PARTS_COST_SECTION } from "@/lib/sections";

const MONTHS = ["2025-12", "2026-05", "2026-06", "2026-07", "2026-08"];

async function snapshot(tag: string) {
  const detail = await prisma.jobHoursDetail.groupBy({ by: ["month"], _sum: { hours: true }, _count: { _all: true } });
  const issues = await prisma.hoursImportIssue.groupBy({ by: ["month"], _sum: { hours: true } });
  // PARTS_COST is excluded: it is an EtcEntry row of the same shape that stores
  // DOLLARS in hoursWorked, so summing it in put $449k of parts spend into an hours
  // figure and read as 456,092h.
  const etc = await prisma.etcEntry.aggregate({
    where: { month: "2026-07", section: { not: PARTS_COST_SECTION } },
    _sum: { hoursWorked: true },
  });
  const get = <T extends { month: string }>(rows: T[], m: string) => rows.find((r) => r.month === m);

  console.log(`\n──── ${tag} ────`);
  console.log("  month      punch rows        punch h      undefined h");
  for (const m of MONTHS) {
    const d = get(detail, m);
    const i = get(issues, m);
    console.log(
      `  ${m}   ${String(d?._count._all ?? 0).padStart(10)} ${Number(d?._sum.hours ?? 0).toFixed(2).padStart(14)} ${Number(i?._sum.hours ?? 0).toFixed(2).padStart(16)}`,
    );
  }
  console.log(`  EtcEntry 2026-07 hoursWorked: ${Number(etc._sum.hoursWorked ?? 0).toFixed(2)}h`);
  return {
    detail: new Map(detail.map((d) => [d.month, Number(d._sum.hours ?? 0)])),
    rows: new Map(detail.map((d) => [d.month, d._count._all])),
    etc: Number(etc._sum.hoursWorked ?? 0),
  };
}

async function main() {
  const before = await snapshot("BEFORE");

  // The open month, resolved exactly as auto-sync resolves it.
  let month: string | null = null;
  const latest = await prisma.etcEntry.findFirst({ orderBy: { month: "desc" }, select: { month: true } });
  if (latest) {
    const entries = await prisma.etcEntry.findMany({ where: { month: latest.month }, select: { needsReview: true } });
    month = isMonthLocked(entries) ? null : latest.month;
  }
  console.log(`\n  open ETC month: ${month ?? "(none — latest is locked)"}`);

  console.log("\n──── IMPORT ────");
  const ctx = newImportContext({ trigger: "interval", refreshId: null, userName: null });
  const t0 = Date.now();
  const imported = await beginPaylocityImport(ctx);
  console.log(`  source     ${describeProvenance(imported.feed.provenance)}`);
  console.log(`  note       ${imported.feed.provenance.note}`);
  console.log(`  months     ${imported.feed.provenance.monthsCovered.join(", ")}`);
  console.log(`  changed    ${imported.changed ? "YES — new file version" : "no — same sha256 as the last import"}`);
  console.log(`  read in    ${Date.now() - t0}ms`);

  const t1 = Date.now();
  const actual = await syncActualHours(imported.feed);
  console.log(`  hours      ${actual.rowsUpserted} rollups, ${actual.detailRowsWritten} punch rows, ${actual.jobsNotFound} jobs not found (${Date.now() - t1}ms)`);

  const t2 = Date.now();
  const undef = await recordUndefinedHours(imported.feed.rejected, {
    importId: ctx.importId,
    sourceFile: imported.feed.provenance.workbook?.fileName ?? "power_bi",
  });
  console.log(`  undefined  ${undef.kpiHours.toFixed(2)}h across ${undef.kpiRows} entries counted; ${undef.storedRows} rows stored with reasons (${Date.now() - t2}ms)`);

  if (month) {
    const t3 = Date.now();
    const worked = await syncHoursWorked(month, imported.feed.rows);
    console.log(`  etc month  ${worked.rowsUpdated} updated, ${worked.rowsSkipped} skipped, ${worked.rowsZeroed} zeroed (${Date.now() - t3}ms)`);
  }

  await completePaylocityImport(imported, { rowsInserted: actual.detailRowsWritten, rowsUpdated: actual.rowsUpserted, rowsRemoved: 0 }, undef);

  const after = await snapshot("AFTER");

  console.log("\n──── DELTA ────");
  for (const m of MONTHS) {
    const b = before.detail.get(m) ?? 0;
    const a = after.detail.get(m) ?? 0;
    const br = before.rows.get(m) ?? 0;
    const ar = after.rows.get(m) ?? 0;
    const d = a - b;
    const flag = m === "2025-12" && d !== 0 ? "   <-- HISTORY CHANGED, must not happen" : "";
    console.log(`  ${m}  ${b.toFixed(2).padStart(11)}h -> ${a.toFixed(2).padStart(11)}h  ${(d >= 0 ? "+" : "")}${d.toFixed(2).padStart(9)}   rows ${br} -> ${ar}${flag}`);
    if (m === "2025-12" && Math.abs(d) > 0.005) process.exitCode = 1;
  }
  console.log(`  EtcEntry 2026-07  ${before.etc.toFixed(2)}h -> ${after.etc.toFixed(2)}h  ${(after.etc - before.etc >= 0 ? "+" : "")}${(after.etc - before.etc).toFixed(2)}`);

  console.log("\n──── KPI vs DRILL-THROUGH (§42.11 / §42.28) ────");
  for (const m of ["2026-06", "2026-07", "2026-08"]) {
    const d = await getUnattributedDetail(m);
    const { ok } = reconcileUndefined(d.total, d.storedTotal);
    console.log(`  ${m}  ${reconciliationMessage(d.total, d.storedTotal)}`);
    console.log(`           ${d.rows.length} counted rows · ${d.employeesAffected} employees · ${d.excluded.rows} excluded rows (${d.excluded.hours.toFixed(2)}h) listed separately`);
    if (d.groups.length) console.log(`           ${d.groups.map((g) => `${g.label} ${g.hours.toFixed(2)}h x${g.rows}`).join(" | ")}`);
    if (!ok) process.exitCode = 1;
  }

  const imp = await prisma.paylocityImport.findFirst({ orderBy: { id: "desc" } });
  console.log("\n──── IMPORT RECORD (§42.20) ────");
  if (!imp) {
    console.log("  NONE WRITTEN");
    process.exitCode = 1;
  } else {
    console.log(`  ${imp.fileName}  ${imp.fileSize.toLocaleString()}B  modified ${imp.fileModifiedAt.toISOString()}`);
    console.log(`  sha256 ${imp.sha256}`);
    console.log(`  range ${imp.reportFrom?.toISOString().slice(0, 10)} -> ${imp.reportTo?.toISOString().slice(0, 10)}  months ${imp.monthsCovered}`);
    console.log(`  rows read ${imp.rowsRead}, inserted ${imp.rowsInserted}, invalid ${imp.rowsInvalid}, undefined ${imp.rowsUndefined} (${Number(imp.undefinedHours).toFixed(2)}h)`);
    console.log(`  status ${imp.status}  trigger ${imp.trigger}  ${imp.durationMs}ms  v${imp.appVersion}`);
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
