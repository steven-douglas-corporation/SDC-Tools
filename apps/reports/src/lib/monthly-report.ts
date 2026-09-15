import { prisma } from "@/lib/prisma";
import { showsPartsBreakout } from "@/lib/parts-breakout-scope";
import { readPartsEtcBreakout } from "@/lib/parts-etc-breakout";
import { resolveLeftToInvoice, partsNewEtc } from "@/lib/left-to-invoice";
import { APP_VERSION } from "@/lib/app-version";
import { createHash, randomUUID } from "crypto";
import {
  calcHoursLeft,
  confirmedNewEtc,
  isMonthLocked,
  isValidMonth,
  newEtcForSubmission,
  newEtcSeedText,
  partsCostCellState,
  partsCostEffectiveNewEtc,
  round2,
  type NewEtcCellState,
  type PartsCostLive,
} from "@/lib/etc";
import { PARTS_COST_SECTION, SECTIONS } from "@/lib/sections";
import { usd, hours as fmtHours } from "@/components/ui/format";
import { getEtcMonthJobIds, getEtcMonthJobWhere, type EtcDb } from "@/lib/etc-month-jobs";
import { getExecutionEtcByJob, isInStandardFeesAllocation } from "@/lib/execution-etc";
import { loadEffectivePools } from "@/lib/standard-sheet-actions";
import {
  calcTotalEtcDollars,
  calcPercentOfTotal,
  calcStandardFeeEngineering,
  calcStandardFeeShop,
  calcTotalStandardFees,
} from "@/lib/standard-fees";

// ── ONE monthly submission ──────────────────────────────────────────────────
//
// Until 2026-08-04 the month was finalised by TWO independent buttons: "Submit ETC"
// (froze EtcEntry) and "Submit Standard Sheet" (froze StandardSheetSnapshot). Nothing
// tied them together, so the normal state of a month was half-submitted — July 2026
// was exactly that when somebody asked why there were two buttons. The ETC figures
// could be locked while the fees derived FROM them were still live and moving, which
// makes "what did we sign off for July" a question with two answers.
//
// This module is the one answer. `Submit {Month} Report` validates the whole package,
// writes every section inside ONE transaction, and records what it did.
//
// Three properties it exists to guarantee:
//   * ATOMIC — every section or none. A failure anywhere leaves the month exactly as
//     it was, rather than ETC-locked-but-fees-open.
//   * VALIDATED FIRST, in detail. "Submission failed" is not an acceptable answer to
//     a manager with 450 cells; every issue names the section, the job, the
//     department and the column, and says what is wrong with it.
//   * IDEMPOTENT. The client generates a submission id; a retry (or a double-click
//     that beat the disabled state) carries the same id and returns the first
//     result instead of submitting twice.
//
// The whole package is read from the DATABASE, never from the posted form. That is
// the other half of the fix: the old path read ~450 `hoursWorked__<id>` fields out of
// the DOM, so a stale tab could freeze its own snapshot over colleagues' saved work,
// and a Columns filter — which removes those inputs — made the month unsubmittable.
// Autosave already persists every edit (DEVLOG §16/§17), so the freshest truth is in
// MySQL and that is what gets frozen.

// The validation TYPES live in lib/monthly-report-flow.ts, not here. They cross the
// server/client boundary in both directions — the readiness line in the Standard Fees
// card is computed from them (§26.4) and so is the dialog's blocked list — and that
// module is dependency-free, so a client component importing them cannot drag Prisma
// into the browser bundle. Re-exported so every existing importer is unaffected.
export type { ReportSection, ValidationIssue, MonthlyReportValidation } from "@/lib/monthly-report-flow";
import type { ReportSection, ValidationIssue, MonthlyReportValidation } from "@/lib/monthly-report-flow";
import { MAX_REPORTED_ISSUES, entriesInSubmissionScope } from "@/lib/monthly-report-flow";
import { departmentIssues } from "@/lib/etc-departments";
import { readIncompleteDepartments } from "@/lib/etc-department-status";

const sectionLabel = (code: string) =>
  code === PARTS_COST_SECTION ? "Parts Cost" : (SECTIONS.find((s) => s.code === code)?.name ?? code);

// ── Validation ──────────────────────────────────────────────────────────────
//
// Reads only. Safe to call from a render (the button asks for it before enabling
// itself) and called again inside the submission for real.
export async function validateMonthlyReport(month: string): Promise<MonthlyReportValidation> {
  const empty: MonthlyReportValidation = {
    ok: false,
    issues: [],
    totalIssues: 0,
    sections: [],
    counts: { entries: 0, jobs: 0, missingNewEtc: 0, standardJobs: 0 },
    incompleteDepartments: [],
  };
  if (!isValidMonth(month)) {
    return { ...empty, issues: [{ section: "Monthly ETC", rowRef: month, reason: `"${month}" is not a valid month.` }], totalIssues: 1 };
  }

  const issues: ValidationIssue[] = [];
  const entries = await prisma.etcEntry.findMany({
    where: { month },
    select: {
      id: true, section: true, priorEtc: true, hoursWorked: true, newEtc: true, newEtcDraft: true,
      newEtcClearedAt: true, needsReview: true, submittedAt: true,
      // The two Parts Cost halves, for the one Parts rule below.
      leftToInvoice: true, leftToPurchase: true,
      job: { select: { id: true, jobId: true, jobName: true } },
    },
  });

  if (entries.length === 0) {
    return {
      ...empty,
      issues: [{ section: "Monthly ETC", rowRef: month, reason: `${month} has not been started — run "Refresh Data" for it first.` }],
      totalIssues: 1,
    };
  }
  if (isMonthLocked(entries)) {
    return {
      ...empty,
      issues: [{ section: "Monthly ETC", rowRef: month, reason: `${month} is already submitted and locked. Reopen it first if a correction is needed.` }],
      totalIssues: 1,
    };
  }

  // ── The job universe readiness applies to (§68) ───────────────────────────
  //
  // getEtcMonthJobWhere is the single source of truth for "which jobs belong to this
  // ETC month" — the grid renders from it, and the Standard rows below are built from
  // it. Reading it HERE, once, and scoping the checks below to it is what stops
  // validation demanding a New ETC for a job the grid does not show: an entry left
  // behind by a job that went non-billable, HeadStart or Complete after the month was
  // seeded. Those are the "Hours off the grid" rows, and nobody can fill in a cell
  // that is not on screen.
  //
  // `entries` above stays the FULL month deliberately — the started/locked checks and
  // `counts` below are facts about the month, and submitEtcEntriesInTx freezes every
  // row it contains. Only the two checks that BLOCK submission are scoped.
  //
  // The SAME `where` getEtcMonthJobIds evaluates for the freeze (2026-09-14), so the
  // set validated here is the set frozen there — see etc-month-jobs.ts for the
  // mid-month-completion case that used to slip between the two.
  const eligibleJobs = await prisma.job.findMany({
    where: (await getEtcMonthJobWhere(month)).where,
    select: { id: true, executionRate: true, billable: true, excludedFromStandardFees: true },
  });
  const eligibleJobIds = new Set(eligibleJobs.map((j) => j.id));
  const gridEntries = entriesInSubmissionScope(entries, eligibleJobIds);

  // ── The Parts Cost live halves, ONLY where the rule can read them ──────────
  //
  // A Parts row's New ETC follows the one Parts rule (partsCostCellState): on an
  // OPEN, otherwise-undecided row the live Left to Invoice + Left to Purchase stands
  // in for the answer. That is the single state in which validation would need the
  // upstream figure — a row with a stored Left to Purchase and neither a draft, a
  // clear nor a confirmed figure. It is rare (the save writes the halves' sum into
  // the draft), and this function runs on every realtime event, so the Total ETO
  // read is made only when such a row exists, and only for those jobs. Every other
  // row resolves from its own columns, exactly as the grid does.
  const partsLiveSums = new Map<number, number | null>();
  if (showsPartsBreakout(month)) {
    const needsLive = gridEntries.filter(
      (e) =>
        e.section === PARTS_COST_SECTION &&
        e.needsReview &&
        e.newEtcDraft == null &&
        e.newEtcClearedAt == null &&
        confirmedNewEtc(e) === null &&
        e.leftToPurchase != null,
    );
    if (needsLive.length > 0) {
      const jobRows = await prisma.job.findMany({
        where: { id: { in: [...new Set(needsLive.map((e) => e.job.id))] } },
        select: { id: true, jobId: true },
      });
      const breakout = await readPartsEtcBreakout(
        jobRows.filter((j) => j.jobId).map((j) => ({ pk: j.id, jobNumber: j.jobId as string })),
        month,
      ).catch(() => null);
      for (const e of needsLive) {
        const b = breakout?.byJobPk.get(e.job.id);
        const invoice = resolveLeftToInvoice({
          computed: b?.rawLeftToInvoice == null ? null : round2(b.rawLeftToInvoice),
          stored: e.leftToInvoice != null ? round2(Number(e.leftToInvoice)) : null,
        }).value;
        partsLiveSums.set(e.job.id, partsNewEtc(invoice, round2(Number(e.leftToPurchase))));
      }
    }
  }

  // ── The manager-entered New ETC values the month is waiting on ────────────
  //
  // "Required" is exactly what the grid paints yellow: hours (or money) were booked
  // to this cell this month, so the next figure is a judgement call, and the box is
  // empty. The rule comes from lib/etc.ts so the checklist on screen and the thing
  // blocking submission can never be two different sets — a manager who has cleared
  // every yellow cell must be able to submit, and one who has not must be told
  // precisely which cells are left.
  //
  // A DELIBERATELY cleared cell counts as missing too. It is blank and hours were
  // booked; "I removed the old number" is not the same as "I have decided", and the
  // reason says so rather than pretending the cell was never touched.
  let missingNewEtc = 0;
  for (const e of gridEntries) {
    if (!e.needsReview) continue; // already confirmed (a partially-submitted month)
    const worked = round2(Number(e.hoursWorked));
    // `confirmed` is confirmedNewEtc — the one predicate the grid seeds by and the
    // freeze keeps by (isConfirmedEntry). Parts Cost builds its state through the
    // one Parts rule, so a pre-breakout typed draft, a confirmed figure and the live
    // halves are weighed here exactly as the grid weighs them.
    const state: NewEtcCellState =
      e.section === PARTS_COST_SECTION
        ? partsCostCellState(
            e,
            { breakoutInScope: showsPartsBreakout(month), breakoutSum: partsLiveSums.get(e.job.id) ?? null },
            { locked: false, monthComplete: true },
          )
        : {
            priorEtc: Number(e.priorEtc),
            hoursWorked: worked,
            draft: e.newEtcDraft != null ? Number(e.newEtcDraft) : null,
            confirmed: confirmedNewEtc(e),
            cleared: e.newEtcClearedAt != null,
            locked: false,
            monthComplete: true,
            precision: "whole",
          };
    // Same expression the cell uses for its background: blank + a decision required.
    if (worked === 0) continue;
    if (newEtcSeedText(state).trim() !== "") continue;
    missingNewEtc++;
    if (issues.length < MAX_REPORTED_ISSUES) {
      issues.push({
        section: "Monthly ETC",
        rowRef: `${e.job.jobId} — ${e.job.jobName}`,
        department: sectionLabel(e.section),
        column: "New ETC",
        reason:
          e.newEtcClearedAt != null
            ? `Cleared and not re-entered. ${e.section === PARTS_COST_SECTION ? "Money was spent" : "Hours were booked"} here this month, so a New ETC figure is required.`
            : `No New ETC entered. ${e.section === PARTS_COST_SECTION ? `${usd(Number(e.hoursWorked))} was spent` : `${fmtHours(worked)} hours were booked`} here this month, so a figure is required.`,
      });
    }
  }

  // Hours can never be negative; PARTS_COST stores MONEY in the same column and
  // genuinely can (a credit note, a returned part) — the same asymmetry submitMonth
  // has always had, which is why 2026-06 was once unsubmittable over one credit.
  //
  // Scoped to the grid's jobs for the same reason as the loop above (§68): the fix for
  // a bad stored figure is "Run Refresh Data", and Refresh PRUNES an off-grid job's
  // unsubmitted rows rather than repairing them — so blocking on one asks for an action
  // that deletes the row instead of fixing it.
  for (const e of gridEntries) {
    const value = Number(e.hoursWorked);
    if (!Number.isFinite(value) || (value < 0 && e.section !== PARTS_COST_SECTION)) {
      if (issues.length < MAX_REPORTED_ISSUES) {
        issues.push({
          section: "Monthly ETC",
          rowRef: `${e.job.jobId} — ${e.job.jobName}`,
          department: sectionLabel(e.section),
          column: "Hours Worked Month",
          reason: `Stored Hours Worked is "${String(e.hoursWorked)}", which is not a valid number of hours. Run "Refresh Data" to re-pull it.`,
        });
      }
    }
  }

  // ── Standard Sheet / Standard Card ────────────────────────────────────────
  //
  // The fees are computed from this month's pools, so a month whose pools were never
  // refreshed would freeze LAST month's balances as if they were this month's — the
  // check the old Standard-Sheet submission already made, now stated as a validation issue on
  // the one submission instead of an exception from a second button.
  // Same universe the ETC checks above were scoped to — one read, one definition
  // (§68). This used to issue its own identical getEtcMonthJobWhere + job.findMany
  // pair, which was where "eligible" quietly had two implementations in one function.
  const jobsForStandard = eligibleJobs.filter(isInStandardFeesAllocation);
  const pools = await loadEffectivePools(month);
  if (pools.pools.length === 0) {
    issues.push({
      section: "Standard Card",
      rowRef: month,
      column: "Department pools",
      // Named for the ONE refresh control (§26.11): the Standard Fees panel's own
      // "Refresh" button was removed because the application-wide "Refresh Data" runs
      // the identical pool computation (auto-sync.ts's standard_pools step). Telling a
      // manager to click a button that no longer exists is worse than not telling them.
      reason: `No department pools exist for ${month}. Click "Refresh Data" in the toolbar before submitting.`,
    });
  } else if (pools.carriedFrom) {
    issues.push({
      section: "Standard Card",
      rowRef: month,
      column: "Department pools",
      reason: `The pools on screen are ${pools.carriedFrom}'s, shown as an estimate because ${month} was never refreshed. Click "Refresh Data" in the toolbar so the submission freezes ${month}'s real balances.`,
    });
  }

  // ── Department sign-off (§50) ─────────────────────────────────────────────
  //
  // Six checkboxes above the KPI card; the month cannot be submitted until all six are
  // ticked. Added as real validation issues so the confirmation dialog's blocked list
  // shows them beside the missing cells rather than in a second place with its own rules.
  //
  // §50 is explicit that this is an ADDITIONAL gate, not a substitute: "do not treat the
  // checkbox alone as proof that all cells are valid. Continue validating required ETC
  // cells, formulas, pending saves, and conflicts." Nothing above this line changed — a
  // month with all six ticked and a missing New ETC is still refused, by the same rule
  // it always was.
  //
  // Two lines, and both halves are tested without a database: readIncompleteDepartments
  // over the real table, and departmentIssues as a pure function. This function itself
  // can only run inside Next, so keeping the judgement out of it is what makes the
  // judgement checkable.
  const incompleteDepartments = await readIncompleteDepartments(month);
  issues.push(...departmentIssues(month, incompleteDepartments));

  const totalIssues =
    missingNewEtc +
    issues.filter((i) => i.column !== "New ETC").length;

  return {
    ok: issues.length === 0,
    issues,
    totalIssues,
    sections: ["Monthly ETC", "Standard Sheet", "Standard Card"],
    counts: {
      entries: entries.length,
      jobs: new Set(entries.map((e) => e.job.id)).size,
      missingNewEtc,
      standardJobs: jobsForStandard.length,
    },
    // Carried out separately as well as being issues, because `issues` is capped at
    // MAX_REPORTED_ISSUES — see the note on the field. The readiness line names these
    // even on a month with 200 unfilled cells.
    incompleteDepartments,
  };
}

// ── "Has anything moved since the dialog opened?" (§26.6, §26.13) ───────────
//
// The confirmation dialog can sit open indefinitely, and this app is genuinely
// multi-user — a colleague's autosave, a Refresh Data pass, or an ETC Rates change
// can all land underneath it. Freezing the month against figures the user last saw
// ten minutes ago is exactly the "stale confirmation submits outdated data" failure
// §26.16 #16 forbids.
//
// So the readiness check hands the browser a fingerprint of the month, and the
// browser hands it back when the user confirms. A different fingerprint stops the
// submission and asks them to look again.
//
// Deliberately ONE aggregate query, not a read of 450 rows: this runs on every
// realtime change event, for every tab with the panel open. The weighted sums
// (`id * value`) are what make two offsetting edits in different rows — one cell
// +5, another −5 — change the digest, which plain SUMs would not.
//
// It is a courtesy check, not the safety property. What actually makes a stale
// submission impossible is that submitMonthlyReport re-validates and re-reads the
// month inside its own transaction, and submitEtcEntriesInTx refuses a month that
// is already locked. This just turns "your submission was refused" into "look at
// this first".
export async function monthDataFingerprint(month: string): Promise<string | null> {
  if (!isValidMonth(month)) return null;
  try {
    // leftToInvoice / leftToPurchase (2026-09-14): the two halves a breakout month's
    // Parts Cost New ETC is made of. An edit to either moves what the freeze writes,
    // and neither was in the digest — so the dialog could sit open across a Left to
    // Purchase edit and freeze without noticing.
    const [etc] = await prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT COUNT(*) AS n,
             COALESCE(SUM(id * hoursWorked), 0)  AS hw,
             COALESCE(SUM(id * priorEtc), 0)     AS pe,
             COALESCE(SUM(id * newEtc), 0)       AS ne,
             COALESCE(SUM(id * COALESCE(newEtcDraft, -1)), 0) AS nd,
             COALESCE(SUM(CASE WHEN needsReview THEN id ELSE 0 END), 0)          AS nr,
             COALESCE(SUM(CASE WHEN newEtcClearedAt IS NULL THEN 0 ELSE id END), 0) AS cl,
             COALESCE(SUM(id * COALESCE(leftToInvoice, -1)), 0)  AS li,
             COALESCE(SUM(id * COALESCE(leftToPurchase, -1)), 0) AS lp
      FROM EtcEntry WHERE month = ${month}`;
    // Per-job Contingency (ExecutionRate.contingencyAmount) is a direct input to
    // every fee row's Total Standard Fees and was not fingerprinted either.
    const [contingency] = await prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT COUNT(*) AS n, COALESCE(SUM(jobId * contingencyAmount), 0) AS ca FROM ExecutionRate`;
    const [pool] = await prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT COUNT(*) AS n,
             COALESCE(SUM(id * hoursPulledThisMonth), 0) AS hp,
             COALESCE(SUM(id * hoursAvailable), 0)       AS ha,
             COALESCE(SUM(id * hoursWorkedThisMonth), 0) AS hw,
             COALESCE(SUM(id * rate), 0)                 AS rt,
             COALESCE(SUM(id * standardFee), 0)          AS sf
      FROM CategoryPool WHERE month = ${month}`;
    // The global rates multiply every fee row, so a change to them changes what the
    // submission would freeze without touching a single ETC or pool row.
    const setting = await prisma.standardSheetSetting.findUnique({ where: { id: 1 } });
    // A frozen month must fingerprint differently from the same month unfrozen.
    const [snap] = await prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT COUNT(*) AS n FROM StandardSheetSnapshot WHERE month = ${month}`;

    const parts = [
      month,
      ...Object.values(etc ?? {}).map(String),
      ...Object.values(pool ?? {}).map(String),
      ...Object.values(contingency ?? {}).map(String),
      ...Object.values(snap ?? {}).map(String),
      String(setting?.engrRate ?? ""),
      String(setting?.shopRate ?? ""),
      String(setting?.partsMarkup ?? ""),
      String(setting?.contingencyRate ?? ""),
    ];
    return createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 16);
  } catch (err) {
    // Unreadable is NOT "unchanged". Returning null makes isMonthDataStale() treat
    // the confirmation as stale, which costs a click; pretending it matched would
    // cost a wrong submission.
    console.error("[monthly-report] could not fingerprint", month, err);
    return null;
  }
}

// ── The submission record ───────────────────────────────────────────────────
//
// Raw SQL rather than the generated Prisma client, for the same reason lib/change-log.ts
// writes its audit rows that way: `prisma generate` cannot run while a server process
// holds node_modules/.prisma open (EPERM), so a new model would otherwise block on a
// deploy window. The table is in schema.prisma and has a migration; only the ACCESS is
// raw. Values go through Prisma's tagged template, which parameterises them.
export type SubmissionStatus = "submitted" | "failed";

export type SubmissionRecord = {
  submissionId: string;
  month: string;
  year: number;
  status: SubmissionStatus;
  userName: string;
  at: string;
  sections: ReportSection[];
  failureReason: string | null;
};

function toRecord(r: Record<string, unknown>): SubmissionRecord {
  return {
    submissionId: String(r.submissionId),
    month: String(r.month),
    year: Number(r.year),
    status: String(r.status) as SubmissionStatus,
    userName: String(r.userName ?? ""),
    at: ((r.completedAt as Date | null) ?? (r.createdAt as Date)).toISOString(),
    sections: JSON.parse(String(r.sections ?? "[]")) as ReportSection[],
    failureReason: r.failureReason == null ? null : String(r.failureReason),
  };
}

const SUBMISSION_COLUMNS = `submissionId, month, year, status, userName, createdAt, completedAt, sections, failureReason`;

export async function readSubmission(submissionId: string): Promise<SubmissionRecord | null> {
  const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT ${SUBMISSION_COLUMNS} FROM MonthlyReportSubmission WHERE submissionId = ? LIMIT 1`,
    submissionId,
  );
  return rows[0] ? toRecord(rows[0]) : null;
}

// The submission this month is CURRENTLY frozen under, if any. Two callers, both §26:
//
//   * the Standard Fees card, so a frozen month shows the receipt — who submitted
//     it, when, and under which id — instead of a dead button (§26.8);
//   * the submission itself, so a month somebody else finalised while this dialog
//     was open fails as "already submitted" with their name on it, rather than as
//     an opaque transaction error (§26.6, §26.13).
//
// The lock check is the load-bearing half. A REOPENED month still has its old
// `status = 'submitted'` row — that row is history and must stay — so keying off the
// record alone would refuse every correction the reopen exists to allow, which is
// precisely the workflow DEVLOG §13 was about. What makes a month closed is that its
// entries are frozen; the record only says who closed it.
export async function readLatestSubmissionForMonth(month: string): Promise<SubmissionRecord | null> {
  if (!isValidMonth(month)) return null;
  const entries = await prisma.etcEntry.findMany({ where: { month }, select: { needsReview: true } });
  if (entries.length === 0 || !isMonthLocked(entries)) return null;
  const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT ${SUBMISSION_COLUMNS} FROM MonthlyReportSubmission
      WHERE month = ? AND status = 'submitted' ORDER BY id DESC LIMIT 1`,
    month,
  );
  return rows[0] ? toRecord(rows[0]) : null;
}

export async function recordSubmission(input: {
  submissionId: string;
  month: string;
  userId: number | null;
  userName: string;
  status: SubmissionStatus;
  sections: ReportSection[];
  validation: MonthlyReportValidation;
  failureReason: string | null;
  // The three moments §26.15 asks to be recorded. `confirmedAt` comes from the
  // browser — it is when the user pressed "Yes, Submit Report", which is the only
  // clock that can answer "how long did they sit on the dialog"; the other two are
  // measured here. All nullable, because a record written before the columns
  // existed (or by a caller that does not time itself) is still a valid record.
  confirmedAt?: Date | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
}): Promise<void> {
  const [year, monthNumber] = input.month.split("-").map(Number);
  // The validation result is stored WITH the attempt, successful or not: "why was
  // this refused at 4pm" is the question the record exists to answer, and it cannot
  // be reconstructed later once the data has moved on.
  const validation = JSON.stringify({
    ok: input.validation.ok,
    totalIssues: input.validation.totalIssues,
    counts: input.validation.counts,
    issues: input.validation.issues.slice(0, MAX_REPORTED_ISSUES),
  });
  // A retried attempt carries the SAME submissionId, which is UNIQUE — that is what
  // makes the retry idempotent. Its record has to be updated rather than inserted, or
  // the second attempt would die on a duplicate-key error before it did any work.
  await prisma.$executeRaw`
    INSERT INTO MonthlyReportSubmission
      (submissionId, month, year, monthNumber, userId, userName, status, appVersion, sections, validation,
       failureReason, confirmedAt, startedAt, completedAt, createdAt)
    VALUES
      (${input.submissionId}, ${input.month}, ${year}, ${monthNumber}, ${input.userId}, ${input.userName},
       ${input.status}, ${APP_VERSION}, ${JSON.stringify(input.sections)}, ${validation}, ${input.failureReason},
       ${input.confirmedAt ?? null}, ${input.startedAt ?? null}, ${input.completedAt ?? null}, ${new Date()})
    ON DUPLICATE KEY UPDATE
      status = VALUES(status), validation = VALUES(validation), failureReason = VALUES(failureReason),
      appVersion = VALUES(appVersion), sections = VALUES(sections), userId = VALUES(userId),
      userName = VALUES(userName), confirmedAt = VALUES(confirmedAt), startedAt = VALUES(startedAt),
      completedAt = VALUES(completedAt)`;
}

export function newSubmissionId(): string {
  return randomUUID();
}

// ── The writes, both sections, one transaction ───────────────────────────────
//
// Split out of the action so the transaction body is readable and so each section's
// rules stay where they were rather than being reinvented inline.

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

// EtcEntry: freeze Hours Worked + New ETC for every entry the month contains.
//
// Reads the month INSIDE the transaction, and takes the New ETC from the stored draft
// (falling back to the suggestion for a cell with no draft — the documented rule for
// an unplanned section, unchanged). A cell that was already confirmed keeps its value:
// that is what makes a partially-submitted month finish correctly rather than being
// recomputed from scratch.
export async function submitEtcEntriesInTx(tx: Tx, month: string, userId: number | null): Promise<number> {
  const entries = await tx.etcEntry.findMany({ where: { month } });

  // ── Parts Cost New ETC is the SUM of two halves, one of them computed ─────
  //
  // 2026-09-04: Left to Invoice is the Parts List figure at this month's cutoff, read
  // only. New ETC = that + Left to Purchase, which is what the grid renders.
  //
  // The submission has to derive it the same way or a signed-off month would disagree
  // with the screen it was signed off on. It cannot rely on `newEtcDraft` alone: the
  // save only writes that field when somebody actually edits a half, so a row where
  // nobody typed anything has a null draft and would otherwise be confirmed at the
  // carry-forward suggestion instead of the figure on screen.
  //
  // And it FREEZES the invoice half into `leftToInvoice`, which is what stops a closed
  // month rewriting itself: that figure keeps moving as later invoices post (the Parts
  // List moves with it), so history has to be a snapshot rather than a live read.
  //
  // One batched upstream query, once a month, before the transaction's writes.
  const partsInvoice = new Map<number, number | null>();
  if (showsPartsBreakout(month)) {
    const partsJobIds = [...new Set(entries.filter((e) => e.section === PARTS_COST_SECTION).map((e) => e.jobId))];
    const jobRows = await tx.job.findMany({
      where: { id: { in: partsJobIds } },
      select: { id: true, jobId: true },
    });
    const breakout = await readPartsEtcBreakout(
      jobRows.filter((j) => j.jobId).map((j) => ({ pk: j.id, jobNumber: j.jobId as string })),
      month,
    ).catch((e) => {
      // Not fatal: a row falls back to its stored draft below, exactly as it did before
      // these columns existed. Submitting a month must not depend on Total ETO being up.
      console.error(`[monthly-report] ${month}: Left to Invoice unavailable at submission:`, e);
      return null;
    });
    if (breakout) {
      for (const [pk, b] of breakout.byJobPk) {
        partsInvoice.set(pk, b.rawLeftToInvoice == null ? null : round2(b.rawLeftToInvoice));
      }
    }
  }
  if (entries.length === 0) throw new Error(`${month} has no entries to submit.`);
  if (isMonthLocked(entries)) throw new Error(`${month} is already submitted and locked.`);

  // ── Only the month's OWN jobs are frozen ──────────────────────────────────
  //
  // 2026-08-10: this used to freeze every row the month contained, including rows
  // left behind by jobs that are not ETC projects at all — 7 non-billable jobs held
  // 20 pending July rows when this was written (SDC Showroom, 4000 Non-Billable, 7000
  // Team Initiatives, 1155, 7001 and both Spare Parts buckets, carrying $29,465 of
  // PARTS_COST between them). Freezing those is what made a month's scope change at
  // submission: the rows became permanent history (needsReview=false is never
  // pruned), so the totals a manager signed off could not be reproduced afterwards.
  //
  // 2026-09-14: the set is now getEtcMonthJobIds — the SAME query the grid renders
  // from and validateMonthlyReport scopes its checks to. It used to be
  // etcEligibleJobFilter here, etcActiveJobFilter in Refresh Data's prune and
  // getEtcMonthJobWhere on the grid: a job that COMPLETED mid-month with hours
  // booked was hidden by the grid, skipped by validation, and then frozen here at
  // its unreviewed suggestion — after which the locked grid showed it again. Rows
  // nobody had seen became signed-off history. One `where`, evaluated inside this
  // transaction, closes that gap.
  //
  // Out-of-scope pending rows are DELETED rather than frozen, which is not a new
  // judgement about them — Refresh Data's pruneStaleEntries deletes the same set
  // from the same query. Doing it here makes the submitted month self-consistent at
  // the moment it closes instead of one refresh later, and it is what keeps
  // `isMonthLocked` true: leaving them pending would mean the month could never lock.
  //
  // Deliberately scoped to `needsReview: true`. An out-of-scope job's ALREADY-frozen
  // rows from an earlier submission are real history and are left exactly alone; the
  // grid simply no longer renders them (getEtcMonthJobWhere). Nothing here touches
  // JobHoursDetail, so every one of these hours stays visible in "Hours off the
  // grid", the punch drill and data-quality review — the exclusion must not hide them.
  const { ids: eligibleIds } = await getEtcMonthJobIds(month, tx);
  // Zero jobs in scope means something is wrong upstream (empty Job table, broken
  // filter) — `notIn: []` would delete every pending row in the month. Same guard
  // pruneStaleEntries makes, for the same reason.
  if (eligibleIds.size === 0) throw new Error(`${month} cannot be submitted: no eligible ETC jobs were found.`);
  await tx.etcEntry.deleteMany({
    where: { month, needsReview: true, jobId: { notIn: [...eligibleIds] } },
  });

  const breakoutInScope = showsPartsBreakout(month);
  let written = 0;
  for (const entry of entries) {
    // Pruned above — never frozen, and never counted as submitted.
    if (!eligibleIds.has(entry.jobId)) continue;
    const priorEtc = Number(entry.priorEtc);
    const hoursWorked = Number(entry.hoursWorked);
    // An already-confirmed row is history; leave it exactly as it is.
    if (!entry.needsReview) continue;
    // ── ONE rule, for both kinds of row (2026-09-11, 2026-09-14) ─────────────
    //
    // Hours: newEtcForSubmission — draft, else the figure the row was CONFIRMED at
    // before a reopen, else the suggestion. This read `draft ?? suggestion` until
    // 2026-09-11: the first submission nulls every draft and a reopen restores none,
    // so a re-submission with no new edits froze the SUGGESTION over what the grid
    // was showing — 161 hours cells of August 2026 (§69).
    //
    // Parts Cost: partsCostEffectiveNewEtc, the same rungs plus the live sum of the
    // two halves for an OPEN, otherwise-undecided row. This read `breakoutSum ??
    // …` until 2026-09-14 — the live figure FIRST — so a no-edit re-submission of a
    // reopened month replaced the manager's signed Parts figure with whatever Total
    // ETO's invoices had drifted to since. The confirmed figure is the manager's
    // answer and does not move with later invoices; the live sum stands in only
    // where nobody has answered. Same function the grid seeds from, the KPI card
    // sums and the fee snapshot stores, so what is frozen is what was on screen.
    //
    // `confirmed` is confirmedNewEtc — the one predicate every reader uses.
    let newEtc: number;
    if (entry.section === PARTS_COST_SECTION) {
      const resolvedInvoice =
        partsInvoice.size > 0
          ? resolveLeftToInvoice({
              computed: partsInvoice.get(entry.jobId) ?? null,
              stored: entry.leftToInvoice != null ? round2(Number(entry.leftToInvoice)) : null,
            }).value
          : null;
      const purchase = entry.leftToPurchase != null ? round2(Number(entry.leftToPurchase)) : null;
      const live: PartsCostLive = { breakoutInScope, breakoutSum: partsNewEtc(resolvedInvoice, purchase) };
      newEtc = partsCostEffectiveNewEtc(entry, live);
    } else {
      newEtc = newEtcForSubmission({
        draft: entry.newEtcDraft != null ? round2(Number(entry.newEtcDraft)) : null,
        confirmed: confirmedNewEtc(entry),
        cleared: entry.newEtcClearedAt != null,
        priorEtc,
        hoursWorked,
      });
    }
    await tx.etcEntry.update({
      where: { id: entry.id },
      data: {
        // ── NOT frozen into leftToInvoice (2026-09-04) ────────────────────────
        //
        // The read-only revision wrote the computed figure into that column at
        // submission, to stop a closed month drifting. It cannot any more: the column
        // means "the manager's override" and nothing else, so a frozen default there
        // would be indistinguishable from a deliberate adjustment the next time anyone
        // opened the row — and would light up the manually-adjusted highlight on rows
        // nobody had touched.
        //
        // `newEtc` below IS the frozen figure, as it always was. That is what the
        // export, next month's Prior ETC and every downstream reader use.
        hoursLeftCalc: round2(calcHoursLeft(priorEtc, hoursWorked)),
        newEtc,
        newEtcDraft: null, // consumed by the submission
        // The "deliberately blank" marker is spent: this cell now HAS a confirmed
        // value, so a later reopen should seed from it like any other.
        newEtcClearedAt: null,
        needsReview: false,
        submittedAt: new Date(),
        ...(userId ? { enteredById: userId } : {}),
      },
    });
    written++;
  }
  return written;
}

// StandardSheetSnapshot: freeze each job's fee row, computed exactly as the live
// Standard view computes it.
//
// ── Computed INSIDE the freeze transaction, AFTER the entries are frozen ─────
//
// Until 2026-09-14 the action read these rows BEFORE the transaction ("they are
// pure reads") and wrote them inside it. Two costs. The reads and the freeze saw
// different rows if anything moved in between (an autosave landing under the
// dialog — the fingerprint is a courtesy check, not the safety property). And the
// two halves of one click read the month by two functions: effectiveNewEtc here,
// newEtcForSubmission in submitEtcEntriesInTx, which disagreed on a reopened row
// (§69's read/freeze split) and stored the managers' figures in the entries beside
// carry-forward guesses in the snapshot.
//
// Passing `tx` and running this after submitEtcEntriesInTx removes the question:
// every row is frozen by then, effectiveNewEtc of a frozen row IS its stored
// newEtc, so the snapshot is built from exactly the figures that were written. The
// pool read (loadEffectivePools) still goes through the shared client — it takes no
// tx, and the pools are not written by this transaction.
export async function loadStandardSheetRows(month: string, db: EtcDb = prisma) {
  const jobs = (
    await db.job.findMany({
      where: (await getEtcMonthJobWhere(month, db)).where,
      select: { id: true, executionRate: true, billable: true, excludedFromStandardFees: true },
    })
  ).filter(isInStandardFeesAllocation);

  const [etcByJob, effective, setting] = await Promise.all([
    getExecutionEtcByJob(jobs.map((j) => j.id), month, { db }),
    loadEffectivePools(month),
    db.standardSheetSetting.findUnique({ where: { id: 1 } }),
  ]);
  if (effective.carriedFrom) {
    // Validation already refuses this; the guard stays because this function is the
    // thing that would silently freeze the wrong month's balances.
    throw new Error(`${month}'s department pools were never refreshed — refresh them before submitting.`);
  }
  const rate = {
    engrRate: setting ? Number(setting.engrRate) : 170,
    shopRate: setting ? Number(setting.shopRate) : 140,
    partsMarkup: setting ? Number(setting.partsMarkup) : 1.2,
  };
  const contingencyRate = setting ? Number(setting.contingencyRate) : 1.2;
  const poolTotals = {
    engineeringPM: Number(effective.pools.find((p) => p.category === "ENGINEERING_PM")?.standardFee ?? 0),
    engineeringWarranty: Number(effective.pools.find((p) => p.category === "ENGINEERING_WARRANTY")?.standardFee ?? 0),
    shopManufacturing: Number(effective.pools.find((p) => p.category === "SHOP_MANUFACTURING")?.standardFee ?? 0),
    shopWarranty: Number(effective.pools.find((p) => p.category === "SHOP_WARRANTY")?.standardFee ?? 0),
  };
  const rows = jobs.map((job) => {
    const etc = etcByJob.get(job.id) ?? { engineering: 0, shop: 0, parts: 0 };
    return { job, etc, totalEtcDollars: calcTotalEtcDollars(etc, rate) };
  });
  const grandTotal = rows.reduce((sum, r) => sum + r.totalEtcDollars, 0);

  return rows.map(({ job, etc, totalEtcDollars }) => {
    const percentOfTotal = calcPercentOfTotal(totalEtcDollars, grandTotal);
    const standardFeeEngineering = calcStandardFeeEngineering(percentOfTotal, poolTotals);
    const standardFeeShop = calcStandardFeeShop(percentOfTotal, poolTotals);
    const contingencyAmount = job.executionRate ? Number(job.executionRate.contingencyAmount) : 0;
    return {
      jobId: job.id,
      month,
      engrRate: rate.engrRate,
      shopRate: rate.shopRate,
      partsMarkup: rate.partsMarkup,
      etcEngineering: etc.engineering,
      etcShop: etc.shop,
      etcParts: etc.parts,
      totalEtcDollars,
      percentOfTotal,
      standardFeeEngineering,
      standardFeeShop,
      contingencyAmount,
      contingencyRate,
      totalStandardFees: calcTotalStandardFees(totalEtcDollars, standardFeeEngineering, standardFeeShop, contingencyAmount, contingencyRate),
      notes: job.executionRate?.notes ?? null,
    };
  });
}
