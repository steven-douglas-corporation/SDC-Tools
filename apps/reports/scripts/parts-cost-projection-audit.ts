import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import {
  getPartsActualByJob,
  getPartsCostSpentByJob,
  getPartsCostBookedByJob,
  getJobPartsCost,
} from "../src/lib/sync-totaleto";
import { computePartsBudgetProjection, purchasedTotal, actualTotal } from "../src/lib/parts-budget-projection";
import { monthWindowUtc } from "../src/lib/etc";
import { PARTS_COST_SECTION } from "../src/lib/sections";
import { writeFileSync } from "node:fs";

// ── Audit: Parts Cost Projection Formula Across All Projects (2026-08-15) ────
//
// Live, per-job reconciliation of
//   Projection = Invoiced + max(Left to be Invoiced, ETC)
// against Budget (Job.costQuoted), for every TotalETO-tracked job. Left to be
// Invoiced and ETC are never BOTH summed on top of Invoiced — see the
// 2026-08-17 fix in parts-budget-projection.ts's header for why summing both
// (this audit's own original formula, until that date) double-counts money
// already sitting, undrawn-down, inside ETC — but as of 2026-08-19, whichever
// of the two is LARGER is what's used, so Projection can never read below
// Total Parts Cost Spent (Invoiced + Left to be Invoiced) the way it did on
// job 1119 (Karl Storz) when ETC hadn't caught up to an open PO.
// Re-derives each job through getPartsCostFinancials's own building blocks
// (not the aggregate function itself, so this stays an independent check
// rather than a test that a function agrees with itself) and cross-checks
// against THREE separately-queried sources:
//
//   - getPartsActualByJob()      whole-DB GL-posted actual, one query
//   - getPartsCostSpentByJob()   whole-DB lifetime committed ("Purchased"), one query
//   - getPartsCostBookedByJob()  a FRESH re-query of this month's AP-document
//                                 activity, compared against the EtcEntry row's
//                                 STORED `hoursWorked` for the same month — a
//                                 stale hoursWorked is the one mechanism that
//                                 could let money sit in BOTH "Left to be
//                                 invoiced" (a live snapshot) and ETC (a stale
//                                 estimate that hasn't drawn down against it) —
//                                 see DOUBLE COUNT SUSPECTED below.
//
// Sequential by design, not parallel: getJobPartsCost / getPartsCostBookedByJob
// etc. all call mssql's sql.connect(), which hands back one GLOBAL pool that
// each function closes when it returns (see parts-actual-recon.ts's own
// warning) — running them concurrently would close the pool out from under a
// sibling call still using it. One job at a time avoids that.
//
// Usage:  npx tsx -r ./scripts/shim-server-only.cjs scripts/parts-cost-projection-audit.ts
//         npx tsx -r ./scripts/shim-server-only.cjs scripts/parts-cost-projection-audit.ts --job 1160
//         npx tsx -r ./scripts/shim-server-only.cjs scripts/parts-cost-projection-audit.ts --flagged-only
//         npx tsx -r ./scripts/shim-server-only.cjs scripts/parts-cost-projection-audit.ts --csv > audit.csv

const CENT = 0.01;

const money = (n: number | null) =>
  n == null ? "" : (n < 0 ? "-" : "") + "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

type Row = {
  jobId: string;
  jobName: string | null;
  budget: number | null;
  invoiced: number;
  leftToInvoice: number;
  etc: number | null;
  totalSpent: number;
  projection: number;
  varianceUsd: number | null;
  variancePct: number | null;
  flags: string[];
};

async function main() {
  const args = process.argv.slice(2);
  const onlyJob = args.includes("--job") ? args[args.indexOf("--job") + 1] : null;
  const flaggedOnly = args.includes("--flagged-only");
  const asCsv = args.includes("--csv");

  const log = asCsv ? () => {} : (s: string = "") => console.log(s);

  log("=== Parts Cost Projection audit: live, per job ===\n");

  // ── Whole-DB sources, ONE query each, run before anything per-job ─────────
  log("Fetching whole-database cross-check sources (getPartsActualByJob, getPartsCostSpentByJob)...");
  const sourceActual = await getPartsActualByJob();
  const sourcePurchased = await getPartsCostSpentByJob();

  const jobs = await prisma.job.findMany({
    where: { type: { not: null }, ...(onlyJob ? { jobId: onlyJob } : {}) },
    select: { id: true, jobId: true, jobName: true, costQuoted: true },
    orderBy: { jobId: "asc" },
  });

  // Latest ETC month per job — same query getPartsCostFinancials's own
  // resolveEtcMonth runs (jobId in [id], orderBy month desc), one at a time so
  // as not to issue 200 individual round-trips for what's really one shape of
  // question; batched here as one findMany per job's id via a single query.
  const latestEntries = await prisma.etcEntry.findMany({
    where: { jobId: { in: jobs.map((j) => j.id) } },
    select: { jobId: true, month: true },
    orderBy: { month: "desc" },
  });
  const latestMonthByJob = new Map<number, string>();
  for (const e of latestEntries) if (!latestMonthByJob.has(e.jobId)) latestMonthByJob.set(e.jobId, e.month);

  // The stored Parts Cost EtcEntry row for each job's resolved month, to
  // check hoursWorked staleness (DOUBLE COUNT SUSPECTED) below.
  const partsEntries = await prisma.etcEntry.findMany({
    where: { jobId: { in: jobs.map((j) => j.id) }, section: PARTS_COST_SECTION },
    select: { jobId: true, month: true, hoursWorked: true, priorEtc: true, newEtc: true, newEtcDraft: true, needsReview: true },
  });
  const partsEntryByJobMonth = new Map<string, (typeof partsEntries)[number]>();
  for (const e of partsEntries) partsEntryByJobMonth.set(`${e.jobId}::${e.month}`, e);

  // A FRESH getPartsCostBookedByJob for every distinct resolved month in play
  // — one query per distinct month, not per job.
  const distinctMonths = [...new Set(jobs.map((j) => latestMonthByJob.get(j.id)).filter((m): m is string => !!m))];
  const freshBookedByMonth = new Map<string, Map<string, number>>();
  for (const m of distinctMonths) {
    log(`Fetching fresh getPartsCostBookedByJob for ${m}...`);
    const { start, endExclusive } = monthWindowUtc(m);
    const booked = await getPartsCostBookedByJob(start, endExclusive);
    freshBookedByMonth.set(m, booked.net);
  }

  const rows: Row[] = [];
  let i = 0;
  for (const j of jobs) {
    i++;
    log(`[${i}/${jobs.length}] ${j.jobId} — ${j.jobName ?? ""}`);
    const flags: string[] = [];

    // ── Re-derive Invoiced / Left to be invoiced / ETC / Projection, from the
    // same building blocks getPartsCostFinancials uses, independently called
    // here rather than through that function — so this audit isn't just
    // "does the function agree with itself". ─────────────────────────────────
    const parts = await getJobPartsCost(j.jobId).catch(() => null);
    if (!parts) {
      rows.push({
        jobId: j.jobId, jobName: j.jobName, budget: j.costQuoted != null ? Number(j.costQuoted) : null,
        invoiced: 0, leftToInvoice: 0, etc: null, totalSpent: 0, projection: 0, varianceUsd: null, variancePct: null,
        flags: ["MISSING SOURCE — TotalETO unreachable for this job"],
      });
      continue;
    }
    const lines = parts.lines;
    const invoiced = actualTotal(lines);
    const purchased = purchasedTotal(lines);
    const month = latestMonthByJob.get(j.id) ?? null;
    const projection = month ? await computePartsBudgetProjection([j.id], lines, month).catch(() => null) : null;
    const leftToInvoice = projection ? projection.committedNotPosted : Math.max(0, purchased - invoiced);
    const etc = projection ? projection.estimateToPurchase : null;
    const totalSpent = invoiced + leftToInvoice;
    const projectionTotal = projection ? projection.total : totalSpent;
    const budget = j.costQuoted != null && Number(j.costQuoted) > 0 ? Number(j.costQuoted) : null;
    const varianceUsd = budget != null ? projectionTotal - budget : null;
    const variancePct = budget != null && budget !== 0 ? (varianceUsd! / budget) * 100 : null;

    // ── NEGATIVE COMPONENT ────────────────────────────────────────────────
    if (invoiced < -CENT || leftToInvoice < -CENT || (etc ?? 0) < -CENT || totalSpent < -CENT || projectionTotal < -CENT) {
      flags.push("NEGATIVE COMPONENT");
    }

    // ── MISSING SOURCE ────────────────────────────────────────────────────
    if (budget == null && totalSpent > CENT) {
      flags.push("MISSING SOURCE — parts spend exists with no quote/budget on file");
    }
    if (month == null && totalSpent > CENT) {
      flags.push("MISSING SOURCE — no ETC month on file despite parts spend");
    }

    // ── PROJECTION FORMULA MISMATCH — the defining identity itself ────────
    // Left to be Invoiced and ETC are never BOTH summed on top of Invoiced
    // (2026-08-17 fix) — but as of 2026-08-19, whichever of the two is LARGER
    // is what rides on top, not always `etc` — see parts-budget-projection.ts's
    // `projectionResidual` and its header.
    const expectedProjection = invoiced + Math.max(leftToInvoice, etc ?? 0);
    if (Math.abs(projectionTotal - expectedProjection) > CENT) {
      flags.push(`PROJECTION FORMULA MISMATCH — projection ${money(projectionTotal)} != invoiced+max(leftToInvoice,etc) ${money(expectedProjection)}`);
    }

    // ── PROJECTION BELOW SPENT — the business rule this audit exists to
    // guarantee (2026-08-19, job 1119 Karl Storz): a projected FINAL cost may
    // never read below money already spent or committed for the same scope.
    if (projectionTotal < totalSpent - CENT) {
      flags.push(`PROJECTION BELOW SPENT — projection ${money(projectionTotal)} < total spent ${money(totalSpent)}`);
    }

    // ── ROUNDING DIFFERENCE — same check the UI now fixes with
    // reconcilePartsCostRounding; reported here so the audit itself proves
    // the fix was needed, per job. ─────────────────────────────────────────
    const naiveSum = Math.round(invoiced) + Math.round(etc ?? 0);
    if (naiveSum !== Math.round(projectionTotal)) {
      flags.push(`ROUNDING DIFFERENCE — independently-rounded segments sum to ${naiveSum}, projection rounds to ${Math.round(projectionTotal)}`);
    }

    // ── SOURCE MISMATCH — this job's live single-job query vs the two
    // independent whole-DB batch queries. ─────────────────────────────────
    const srcActual = sourceActual.get(j.jobId) ?? 0;
    if (Math.abs(invoiced - srcActual) > 1) {
      flags.push(`SOURCE MISMATCH — Invoiced ${money(invoiced)} vs getPartsActualByJob ${money(srcActual)}`);
    }
    const srcPurchased = sourcePurchased.get(j.jobId) ?? 0;
    if (Math.abs(purchased - srcPurchased) > 1) {
      flags.push(`SOURCE MISMATCH — Purchased ${money(purchased)} vs getPartsCostSpentByJob ${money(srcPurchased)}`);
    }

    // ── STALE ETC DRAWDOWN SUSPECTED — an ESTIMATE-FRESHNESS signal, not a
    // projection defect (2026-08-19: PROJECTION BELOW SPENT above now
    // guarantees the defect itself can't happen — ETC lagging can no longer
    // drag Projection below Total Parts Cost Spent, see projectionResidual).
    // What this still catches: if the EtcEntry row's STORED hoursWorked (this
    // month's booked-AP drawdown, which is what shrinks ETC) is stale against
    // a FRESH re-query of the same month, ETC hasn't drawn down by what was
    // actually booked yet — an outdated New ETC worth a manager's look, even
    // though it can no longer corrupt the Projection figure itself. ────────
    if (month) {
      const stored = partsEntryByJobMonth.get(`${j.id}::${month}`);
      const fresh = freshBookedByMonth.get(month)?.get(j.jobId) ?? 0;
      if (stored) {
        const storedHoursWorked = Number(stored.hoursWorked);
        if (Math.abs(storedHoursWorked - fresh) > 1) {
          flags.push(
            `DOUBLE COUNT SUSPECTED — stored Parts hoursWorked ${money(storedHoursWorked)} for ${month} is stale vs a fresh re-query ${money(fresh)}; ` +
              `ETC may not have drawn down by what's actually been booked/committed this month`,
          );
        }
      }
    }

    rows.push({
      jobId: j.jobId, jobName: j.jobName, budget, invoiced, leftToInvoice, etc, totalSpent,
      projection: projectionTotal, varianceUsd, variancePct, flags,
    });
  }

  // ── Output ────────────────────────────────────────────────────────────────
  const toShow = flaggedOnly ? rows.filter((r) => r.flags.length > 0) : rows;

  if (asCsv) {
    console.log("Job,Job Name,Budget,Invoiced,Left to be Invoiced,ETC,Total Spent,Projection,Variance $,Variance %,Flags");
    for (const r of toShow) {
      console.log(
        [
          r.jobId,
          JSON.stringify(r.jobName ?? ""),
          r.budget ?? "",
          r.invoiced.toFixed(2),
          r.leftToInvoice.toFixed(2),
          r.etc != null ? r.etc.toFixed(2) : "",
          r.totalSpent.toFixed(2),
          r.projection.toFixed(2),
          r.varianceUsd != null ? r.varianceUsd.toFixed(2) : "",
          r.variancePct != null ? r.variancePct.toFixed(2) : "",
          JSON.stringify(r.flags.join(" | ")),
        ].join(","),
      );
    }
  } else {
    log("\n" + "=".repeat(150));
    log(
      "Job".padEnd(7) + "Budget".padStart(14) + "Invoiced".padStart(14) + "LeftToInv".padStart(14) +
      "ETC".padStart(14) + "Projection".padStart(14) + "Variance$".padStart(14) + "Var%".padStart(9) + "  Flags",
    );
    log("-".repeat(150));
    for (const r of toShow) {
      log(
        r.jobId.padEnd(7) + money(r.budget).padStart(14) + money(r.invoiced).padStart(14) + money(r.leftToInvoice).padStart(14) +
        money(r.etc).padStart(14) + money(r.projection).padStart(14) + money(r.varianceUsd).padStart(14) +
        (r.variancePct != null ? r.variancePct.toFixed(1) + "%" : "").padStart(9) +
        (r.flags.length ? "  " + r.flags.join(" ; ") : ""),
      );
    }
    log("-".repeat(150));
    log(`\nJobs audited: ${rows.length}`);
    const withFlags = rows.filter((r) => r.flags.length > 0);
    log(`Jobs with at least one flag: ${withFlags.length}`);
    const byType = new Map<string, number>();
    for (const r of rows) for (const f of r.flags) {
      const key = f.split(" — ")[0];
      byType.set(key, (byType.get(key) ?? 0) + 1);
    }
    for (const [k, n] of [...byType.entries()].sort((a, b) => b[1] - a[1])) log(`  ${k}: ${n}`);
  }

  // Always also write a full CSV to disk, regardless of console mode, so a
  // --flagged-only or plain console run still leaves the complete table
  // somewhere retrievable.
  const csvLines = ["Job,Job Name,Budget,Invoiced,Left to be Invoiced,ETC,Total Spent,Projection,Variance $,Variance %,Flags"];
  for (const r of rows) {
    csvLines.push(
      [
        r.jobId, JSON.stringify(r.jobName ?? ""), r.budget ?? "", r.invoiced.toFixed(2), r.leftToInvoice.toFixed(2),
        r.etc != null ? r.etc.toFixed(2) : "", r.totalSpent.toFixed(2), r.projection.toFixed(2),
        r.varianceUsd != null ? r.varianceUsd.toFixed(2) : "", r.variancePct != null ? r.variancePct.toFixed(2) : "",
        JSON.stringify(r.flags.join(" | ")),
      ].join(","),
    );
  }
  const outPath = "parts-cost-projection-audit.csv";
  writeFileSync(outPath, csvLines.join("\n") + "\n");
  if (!asCsv) log(`\nFull CSV written to ${outPath}`);
}

main()
  .catch(async (e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
