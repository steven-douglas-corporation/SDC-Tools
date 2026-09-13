// READ-ONLY verification that submission actually froze past months and that their
// New ETC really became the next month's Prior ETC.
//
//   npx tsx --tsconfig tsconfig.scripts.json scripts/_verify_carryforward.ts
//
// Uses ONLY findMany/count. It never writes, never submits, and never opens a
// transaction — safe to run against production at any time.
import "dotenv/config";
import { prisma } from "@/lib/prisma";
import { round2, suggestNewEtc } from "@/lib/etc";

const n = (v: unknown) => round2(Number(v));

async function main() {
  const months = (
    await prisma.etcEntry.findMany({ distinct: ["month"], select: { month: true }, orderBy: { month: "asc" } })
  ).map((m) => m.month);

  console.log(`\nMonths in the database: ${months.join(", ")}\n`);

  // ── 1. Did submission actually FREEZE the months it claims to have frozen? ──
  // `newEtc` is a non-nullable Decimal, so "has a newEtc" is not a question worth
  // asking — every row has one. What distinguishes a SUBMITTED row is needsReview=false
  // plus a submittedAt stamp, which is exactly what submitEtcEntriesInTx writes.
  console.log("1. Frozen state per month  (a submitted entry must have needsReview=false AND a submittedAt)");
  for (const m of months) {
    const total = await prisma.etcEntry.count({ where: { month: m } });
    const pending = await prisma.etcEntry.count({ where: { month: m, needsReview: true } });
    const withStamp = await prisma.etcEntry.count({ where: { month: m, submittedAt: { not: null } } });
    const state = pending === 0 ? "FROZEN " : "open   ";
    const ok = pending === 0 ? (withStamp === total ? "OK — all rows stamped" : `!! only ${withStamp}/${total} stamped`) : "-";
    console.log(
      `   ${m}  ${state} entries=${String(total).padStart(4)} pending=${String(pending).padStart(4)}` +
        ` submittedAt=${String(withStamp).padStart(4)}  ${ok}`,
    );
  }

  // ── 2. Did each frozen month's New ETC become the next month's Prior ETC? ───
  //
  // That is the carry-forward contract: derivePriorEtcForMonth sets priorEtc from the
  // LATEST prior month's newEtc for the same (job, section). Jobs that start in the later
  // month use their quote instead, so those are reported separately rather than as errors.
  console.log("\n2. Carry-forward:  newEtc(month N)  ->  priorEtc(month N+1)   per (job, section)");
  for (let i = 0; i < months.length - 1; i++) {
    const from = months[i];
    const to = months[i + 1];
    const [prev, next] = await Promise.all([
      prisma.etcEntry.findMany({ where: { month: from }, select: { jobId: true, section: true, newEtc: true } }),
      prisma.etcEntry.findMany({
        where: { month: to },
        select: { jobId: true, section: true, priorEtc: true, job: { select: { jobId: true, startDate: true } } },
      }),
    ]);
    const prevBy = new Map(prev.map((e) => [`${e.jobId}-${e.section}`, e.newEtc]));
    const monthOf = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

    let matched = 0;
    let startsThisMonth = 0;
    let noPredecessor = 0;
    const mismatches: string[] = [];
    for (const e of next) {
      const carried = prevBy.get(`${e.jobId}-${e.section}`);
      if (carried == null) {
        noPredecessor++;
        continue;
      }
      if (e.job.startDate && monthOf(e.job.startDate) === to) {
        startsThisMonth++; // uses the quote, not the carry — by design
        continue;
      }
      if (n(carried) === n(e.priorEtc)) matched++;
      else if (mismatches.length < 8) {
        mismatches.push(`job ${e.job.jobId} ${e.section}: newEtc=${n(carried)} but priorEtc=${n(e.priorEtc)}`);
      } else mismatches.push("");
    }
    const bad = mismatches.filter(Boolean).length + Math.max(0, mismatches.length - 8);
    console.log(
      `   ${from} -> ${to}:  carried EXACTLY ${matched}` +
        `   starts-this-month(uses quote) ${startsThisMonth}   no predecessor ${noPredecessor}` +
        `   MISMATCHED ${mismatches.length}`,
    );
    for (const msg of mismatches.filter(Boolean)) console.log(`        ! ${msg}`);
    if (bad === 0) console.log(`        => every carried figure matches to the cent`);
  }

  // ── 3. What WOULD submitting the open month write? (computed, not written) ──
  //
  // submitEtcEntriesInTx writes, per pending entry: newEtc = draft ?? suggestNewEtc(prior,
  // worked). Reproduced here so the figures can be eyeballed against the grid BEFORE
  // anyone commits to freezing them.
  const openMonth = (
    await prisma.etcEntry.groupBy({ by: ["month"], where: { needsReview: true }, _count: { _all: true } })
  ).map((g) => g.month).sort().pop();
  if (!openMonth) {
    console.log("\n3. No open month — nothing pending to submit.");
  } else {
    const pending = await prisma.etcEntry.findMany({
      where: { month: openMonth, needsReview: true },
      select: { section: true, priorEtc: true, hoursWorked: true, newEtcDraft: true, job: { select: { jobId: true } } },
    });
    let fromDraft = 0;
    let fromSuggestion = 0;
    let sum = 0;
    for (const e of pending) {
      const draft = e.newEtcDraft != null ? n(e.newEtcDraft) : null;
      const value = draft ?? n(suggestNewEtc(Number(e.priorEtc), Number(e.hoursWorked)));
      if (draft != null) fromDraft++;
      else fromSuggestion++;
      sum += value;
    }
    console.log(`\n3. If ${openMonth} were submitted now (COMPUTED — nothing written):`);
    console.log(`   pending entries that would be frozen : ${pending.length}`);
    console.log(`   ...taking the manager's typed draft  : ${fromDraft}`);
    console.log(`   ...taking the auto suggestion        : ${fromSuggestion}   (prior − worked, floored at 0)`);
    console.log(`   sum of New ETC that would be written : ${sum.toLocaleString()}`);
    console.log(`   a few rows, to compare against the grid:`);
    for (const e of pending.slice(0, 6)) {
      const draft = e.newEtcDraft != null ? n(e.newEtcDraft) : null;
      const value = draft ?? n(suggestNewEtc(Number(e.priorEtc), Number(e.hoursWorked)));
      console.log(
        `      job ${String(e.job.jobId).padEnd(6)} ${e.section.padEnd(11)} prior=${String(n(e.priorEtc)).padStart(8)}` +
          ` worked=${String(n(e.hoursWorked)).padStart(8)} -> newEtc=${String(value).padStart(8)}` +
          `  (${draft != null ? "typed draft" : "suggestion"})`,
      );
    }
  }
  // ── 4. Did the submission leave its RECEIPT and its Standard snapshot? ──────
  //
  // A submission has two halves. `MonthlyReportSubmission` is the receipt the §26 flow
  // writes (who submitted, when, under which id); `StandardSheetSnapshot` is the frozen
  // Standard Fees side. A month with frozen ETC entries but no snapshot only half landed.
  const receipts = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
    "SELECT month, status, userName, startedAt, completedAt FROM MonthlyReportSubmission ORDER BY startedAt DESC LIMIT 10",
  );
  console.log(`\n4. Submission receipts (MonthlyReportSubmission): ${receipts.length} row(s)`);
  if (receipts.length === 0) {
    console.log("   NONE — no submission has been recorded through the current (§26) flow.");
    console.log("   Frozen months below therefore predate the receipt, or were imported/backfilled.");
  }
  for (const r of receipts) {
    console.log(
      `   ${String(r.month)}  ${String(r.status).padEnd(9)} by=${String(r.userName ?? "-").padEnd(16)}` +
        ` started=${String(r.startedAt)} completed=${String(r.completedAt ?? "-")}`,
    );
  }
  const snaps = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
    "SELECT month, COUNT(*) AS r FROM StandardSheetSnapshot GROUP BY month ORDER BY month DESC LIMIT 12",
  );
  console.log(`   StandardSheetSnapshot (the Standard Fees half):`);
  for (const s of snaps) console.log(`      ${String(s.month)}  ${String(s.r)} rows`);

  console.log("");
  await prisma.$disconnect();
  process.exit(0);
}

main();
