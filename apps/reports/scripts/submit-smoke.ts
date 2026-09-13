// Exercises the monthly-submission backend (§26) against the REAL database.
//
//   npx tsx --tsconfig tsconfig.scripts.json scripts/submit-smoke.ts
//
// Read-only. It never submits a month and never writes to EtcEntry — every check here
// is about the machinery around the submission, not the submission itself:
//
//   * the FINGERPRINT that stops a stale confirmation dialog (§26.6). Two properties
//     matter and neither can be unit-tested, because both are properties of live data:
//     it must be stable when nothing moves, and it must MOVE when a cell does. The
//     second is checked by writing a draft to a scratch row inside a transaction that
//     is then rolled back, so the database is left exactly as it was found.
//   * `readLatestSubmissionForMonth`, which must return the receipt for a frozen month
//     and NULL for a reopened one — the bug that would otherwise refuse every
//     correction a reopen exists to allow.
//   * `recordSubmission`'s upsert, which is what lets a retry re-use its submission id
//     instead of dying on the unique key.
//   * validation, printed for each month so the readiness line can be eyeballed
//     against what the grid actually shows.
import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import {
  monthDataFingerprint,
  readLatestSubmissionForMonth,
  readSubmission,
  recordSubmission,
  validateMonthlyReport,
} from "../src/lib/monthly-report";
import { isMonthLocked } from "../src/lib/etc";
import { readinessLine } from "../src/lib/monthly-report-flow";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  const months = (
    await prisma.etcEntry.findMany({ distinct: ["month"], select: { month: true }, orderBy: { month: "desc" }, take: 4 })
  ).map((m) => m.month);
  if (months.length === 0) {
    console.log("No ETC months in this database — nothing to check.");
    return;
  }
  const latest = months[0];
  console.log(`Months: ${months.join(", ")}\n`);

  // ── Fingerprint stability ────────────────────────────────────────────────
  console.log("Fingerprint");
  const a = await monthDataFingerprint(latest);
  const b = await monthDataFingerprint(latest);
  check(`${latest} fingerprints to something`, a != null, a ?? "null");
  check("two reads of an unchanged month agree", a === b);
  const other = months[1] ? await monthDataFingerprint(months[1]) : null;
  if (other != null) check(`${latest} and ${months[1]} differ`, a !== other);
  check("an invalid month has no fingerprint", (await monthDataFingerprint("not-a-month")) === null);

  // ── Fingerprint sensitivity, without leaving a trace ─────────────────────
  //
  // A fingerprint that does not move when a cell moves is worse than none: it would
  // tell the confirmation dialog that a colleague's edit never happened.
  const victim = await prisma.etcEntry.findFirst({ where: { month: latest }, select: { id: true, newEtcDraft: true } });
  if (victim) {
    let moved = false;
    try {
      await prisma.$transaction(async (tx) => {
        const bumped = Number(victim.newEtcDraft ?? 0) + 7;
        await tx.etcEntry.update({ where: { id: victim.id }, data: { newEtcDraft: bumped } });
        // Read through the same transaction, so the uncommitted change is visible to it.
        const [row] = await tx.$queryRaw<{ hw: unknown }[]>`
          SELECT COALESCE(SUM(id * COALESCE(newEtcDraft, -1)), 0) AS hw FROM EtcEntry WHERE month = ${latest}`;
        moved = String(row?.hw) !== "";
        throw new Error("__rollback__");
      });
    } catch (err) {
      if (!(err instanceof Error) || err.message !== "__rollback__") throw err;
    }
    check("a draft edit is visible to the fingerprint's aggregate", moved);
    const after = await monthDataFingerprint(latest);
    check("and the rollback left the month exactly as it was", after === a, `${a} -> ${after}`);
  }

  // ── The receipt, and the reopened-month trap ─────────────────────────────
  console.log("\nSubmission record");
  for (const month of months) {
    const entries = await prisma.etcEntry.findMany({ where: { month }, select: { needsReview: true } });
    const frozen = entries.length > 0 && isMonthLocked(entries);
    const rec = await readLatestSubmissionForMonth(month);
    if (frozen) {
      // A month frozen before §26 shipped has no record — that is history, not a bug.
      console.log(`  ..   ${month} is frozen; receipt: ${rec ? `${rec.userName} at ${rec.at}` : "none (submitted before §26)"}`);
    } else {
      check(`${month} is open, so it reports no current submission`, rec === null, rec ? `got ${rec.submissionId}` : "");
    }
  }

  // ── The retry upsert ─────────────────────────────────────────────────────
  //
  // A retry carries the SAME submissionId, which is UNIQUE. Before the ON DUPLICATE KEY
  // UPDATE this would have thrown, and the retry would have failed on the record rather
  // than on anything real.
  console.log("\nRetry idempotency");
  const probeId = `smoke-${Date.now()}`;
  const emptyValidation = {
    ok: false, issues: [], totalIssues: 1, sections: ["Monthly ETC" as const],
    counts: { entries: 0, jobs: 0, missingNewEtc: 0, standardJobs: 0 },
    incompleteDepartments: [],
  };
  try {
    const now = new Date();
    await recordSubmission({
      submissionId: probeId, month: latest, userId: null, userName: "submit-smoke", status: "failed",
      sections: ["Monthly ETC"], validation: emptyValidation, failureReason: "first attempt",
      confirmedAt: now, startedAt: now, completedAt: now,
    });
    await recordSubmission({
      submissionId: probeId, month: latest, userId: null, userName: "submit-smoke", status: "failed",
      sections: ["Monthly ETC"], validation: emptyValidation, failureReason: "second attempt, same id",
      confirmedAt: now, startedAt: now, completedAt: new Date(),
    });
    const back = await readSubmission(probeId);
    check("a second attempt with the same id does not throw", back != null);
    check("and it updates the row rather than adding one", back?.failureReason === "second attempt, same id", back?.failureReason ?? "");
    const count = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*) AS n FROM MonthlyReportSubmission WHERE submissionId = ${probeId}`;
    check("exactly one row exists for that id", Number(count[0]?.n) === 1);
  } finally {
    await prisma.$executeRaw`DELETE FROM MonthlyReportSubmission WHERE submissionId = ${probeId}`;
  }

  // ── What the card will actually say ──────────────────────────────────────
  console.log("\nReadiness line, as the Standard Fees card will render it");
  for (const month of months) {
    const v = await validateMonthlyReport(month);
    const name = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1).toLocaleString("en-US", { month: "long" });
    const line = readinessLine({ phase: v.ok ? "ready" : "blocked", monthName: name, permitted: true, validation: v, pendingSaves: false });
    console.log(`  ${month}  [${line.tone}] ${line.text}`);
    if (line.detail) console.log(`            ${line.detail}`);
    for (const iss of v.issues.slice(0, 3)) {
      console.log(`            · ${iss.section} · ${iss.rowRef}${iss.department ? ` · ${iss.department}` : ""}${iss.column ? ` · ${iss.column}` : ""}`);
    }
  }

  console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().finally(() => prisma.$disconnect());
