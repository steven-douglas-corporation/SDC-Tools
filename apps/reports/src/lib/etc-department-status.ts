import { prisma } from "@/lib/prisma";
import {
  ETC_DEPARTMENTS,
  fillDepartments,
  incompleteDepartmentLabels,
  type DepartmentCompletion,
} from "@/lib/etc-departments";

// ── Reading and writing the department sign-offs (§50) ──────────────────────
//
// Split from lib/etc-departments.ts so that module can stay dependency-free: the
// checklist is a client component and the submission gate runs in the browser too, and
// neither may pull Prisma into the bundle. Everything here is server-only.
//
// ── Raw SQL, like MonthlyReportSubmission and RefreshRun ────────────────────
//
// `prisma generate` cannot run while a server process holds node_modules/.prisma open
// (EPERM on Windows), so a table added today would not be reachable through the typed
// client until the next deploy window. The two most recent tables in this schema are
// accessed this way for exactly that reason and it is a reasonable permanent shape for
// a five-column table: one explicit statement each, nothing that can fail because a
// generated type is stale.
//
// Values go through Prisma's tagged template, which parameterises them — nothing here
// is concatenated into the SQL string.

/** "2026-07" -> { year: 2026, monthNumber: 7 }. Callers have already validated the month. */
function splitMonth(month: string): { year: number; monthNumber: number } {
  return { year: Number(month.slice(0, 4)), monthNumber: Number(month.slice(5, 7)) };
}

type Row = {
  department: string;
  completed: number | boolean;
  completedByName: string | null;
  completedAt: Date | null;
};

function toCompletion(r: Row): DepartmentCompletion {
  return {
    code: r.department,
    // MySQL BOOLEAN is TINYINT(1) and comes back from $queryRaw as 0/1, not as a JS
    // boolean — which is truthy for BOTH values if you spread the row instead of
    // converting it, and would render every department as complete.
    completed: Boolean(r.completed),
    completedBy: r.completedByName,
    completedAt: r.completedAt ? r.completedAt.toISOString() : null,
  };
}

/**
 * Every department for a month, in checklist order, with a synthetic incomplete row for
 * the ones nobody has ticked yet — so the caller never has to distinguish "no row" from
 * "unticked". Those are the same thing, and a table that only has rows for departments
 * somebody touched is the point of `fillDepartments`.
 */
export async function readDepartmentCompletions(month: string): Promise<DepartmentCompletion[]> {
  try {
    const rows = await prisma.$queryRaw<Row[]>`
      SELECT department, completed, completedByName, completedAt
        FROM DepartmentEtcCompletion
       WHERE month = ${month}`;
    return fillDepartments(rows.map(toCompletion));
  } catch (err) {
    // A missing table (the migration has not been deployed yet) must not take down the
    // Monthly ETC page — the checklist simply shows unticked boxes, and the
    // submission gate below treats that as "nobody has signed off", which is true.
    console.error("[dept-etc] could not read completions for", month, err);
    return fillDepartments([]);
  }
}

/** The labels the submission blocker names. One query, no reasoning duplicated. */
export async function readIncompleteDepartments(month: string): Promise<string[]> {
  return incompleteDepartmentLabels(await readDepartmentCompletions(month));
}

export type WriteResult =
  | { ok: true; changed: boolean; status: DepartmentCompletion }
  | { ok: false; reason: "error"; message: string };

/**
 * Set one department's status to an ABSOLUTE value — never a toggle.
 *
 * That distinction is what makes the whole feature safe against the two multi-user
 * hazards §50 names. A toggle applied from a stale view produces the OPPOSITE of what
 * the user clicked (they saw unticked, somebody ticked it, their "tick" untick it); an
 * absolute write produces what they asked for whatever they were looking at. It also
 * makes a duplicated request a no-op rather than a second flip, which is the same
 * property `submissionId` buys the month submission.
 *
 * Returns `changed: false` when the stored value already matched. The caller uses that
 * to skip the audit row and the broadcast: a re-click that changes nothing is not an
 * event, and logging it would fill the history with noise that reads like real activity.
 */
export async function writeDepartmentCompletion(input: {
  month: string;
  department: string;
  completed: boolean;
  userId: number | null;
  userName: string;
}): Promise<WriteResult> {
  const { month, department, completed } = input;
  const { year, monthNumber } = splitMonth(month);
  try {
    const before = await prisma.$queryRaw<Row[]>`
      SELECT department, completed, completedByName, completedAt
        FROM DepartmentEtcCompletion
       WHERE month = ${month} AND department = ${department}`;
    const current = before[0] ? toCompletion(before[0]) : null;
    if (current && current.completed === completed) {
      return { ok: true, changed: false, status: current };
    }

    const now = new Date();
    // Who and when are cleared on an UNTICK rather than left behind. A row reading
    // "not complete — completed by Lisa at 2:35" is a contradiction on screen, and the
    // audit log is where the history of who-did-what lives; this column is the state.
    const by = completed ? input.userName : null;
    const byId = completed ? input.userId : null;
    const at = completed ? now : null;

    // ON DUPLICATE KEY against the UNIQUE (month, department): two managers ticking the
    // same box in the same instant both succeed and land on one row, rather than one of
    // them hitting a constraint error for having been a millisecond late.
    await prisma.$executeRaw`
      INSERT INTO DepartmentEtcCompletion
        (month, year, monthNumber, department, completed, completedById, completedByName, completedAt, updatedAt, createdAt)
      VALUES
        (${month}, ${year}, ${monthNumber}, ${department}, ${completed}, ${byId}, ${by}, ${at}, ${now}, ${now})
      ON DUPLICATE KEY UPDATE
        completed = VALUES(completed),
        completedById = VALUES(completedById),
        completedByName = VALUES(completedByName),
        completedAt = VALUES(completedAt),
        updatedAt = VALUES(updatedAt)`;

    return {
      ok: true,
      changed: true,
      status: { code: department, completed, completedBy: by, completedAt: at ? at.toISOString() : null },
    };
  } catch (err) {
    console.error("[dept-etc] could not write completion", month, department, err);
    return { ok: false, reason: "error", message: err instanceof Error ? err.message : "Could not save the status." };
  }
}

/** Used by the tests and by nothing else — the count of departments the app expects. */
export const DEPARTMENT_COUNT = ETC_DEPARTMENTS.length;
