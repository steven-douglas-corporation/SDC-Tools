// Does the audit INSERT actually accept what the new callers send it?
//
// ── Why this script exists ──────────────────────────────────────────────────
//
// recordChanges() writes through `$executeRaw` (prisma generate cannot run while the
// production process holds the client — see lib/change-log.ts), so the nine cell-change
// columns are NOT type-checked at build time. A caller passing the wrong shape compiles,
// typechecks, lints, and then fails at runtime into a console.error that nobody reads —
// and because the publish is in a separate try block, realtime keeps working while the
// audit trail silently loses rows. That is the worst possible failure mode for an audit
// log, and it is invisible to every other check in this repo.
//
// On 2026-08-04 the number of recordChanges call sites went from 3 to 14 (§33.1), each
// with its own value shapes: composite string entityIds, numeric entityIds, nulls for
// cleared cells, and long generated column names. This exercises one representative
// payload per new call site against the real table.
//
//   npx tsx --tsconfig tsconfig.scripts.json scripts/change-log-smoke.ts
//
// ── Why it rolls back, and does NOT call recordChanges ──────────────────────
//
// Two deliberate constraints:
//   * Every insert happens inside an interactive transaction that throws at the end, so
//     no test rows are left in a production audit log.
//   * It calls the raw INSERT directly rather than recordChanges(), because
//     recordChanges also PUBLISHES to the realtime hub — running it here would put
//     fabricated change banners ("Automatic sync changed New ETC…") in front of whoever
//     is signed in right now.
import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { APP_VERSION } from "../src/lib/app-version";
import { describeChange, classifyChange, type CellChange } from "../src/lib/change-log";

const SUMMARY_MAX = 191; // VARCHAR(191), same as lib/change-log.ts

// One payload per NEW call site, in the exact shapes those callers build.
const cases: { label: string; change: CellChange }[] = [
  {
    label: "quoted-actions · hours cell (composite string entityId)",
    change: {
      tab: "Projects",
      rowRef: "Job 1165",
      columnName: "Design & Drawings Quoted Hours",
      previousValue: "40",
      newValue: "72",
      changeType: classifyChange("40", "72", { emptyIsBlank: true }),
      entityType: "EstimatedHours",
      entityId: "47::10-312",
      cellKey: "quoted__47__10-312",
    },
  },
  {
    label: "quoted-actions · hours cell CLEARED to zero (removal)",
    change: {
      tab: "Projects",
      rowRef: "Job 1165",
      columnName: "Software Quoted Hours",
      previousValue: "120",
      newValue: "0",
      changeType: classifyChange("120", "0", { emptyIsBlank: true }),
      entityType: "EstimatedHours",
      entityId: "47::10-313",
      cellKey: "quoted__47__10-313",
    },
  },
  {
    label: "quoted-actions · job field with a NULL previous value",
    change: {
      tab: "Projects",
      rowRef: "Job 1105",
      columnName: "Customer",
      previousValue: null,
      newValue: "FIRST SOLAR, INC.",
      changeType: classifyChange(null, "FIRST SOLAR, INC."),
      entityType: "Job",
      entityId: 47,
      cellKey: "jobField__47__customer",
    },
  },
  {
    label: "quoted-actions · REFUSED write (rejected)",
    change: {
      tab: "Projects",
      rowRef: "Job 1165",
      columnName: "Design & Drawings Quoted Hours",
      previousValue: "72",
      newValue: "40",
      changeType: "rejected",
      entityType: "EstimatedHours",
      entityId: "47::10-312",
    },
  },
  {
    label: "execution-rate-actions · global rate, numeric entityId, no cellKey",
    change: {
      tab: "Monthly ETC",
      rowRef: "ETC Rates (all jobs)",
      columnName: "Engineering Rate",
      previousValue: "170",
      newValue: "185",
      changeType: classifyChange("170", "185"),
      entityType: "StandardSheetSetting",
      entityId: 1,
    },
  },
  {
    label: "standard-sheet-actions · pool cell",
    change: {
      tab: "Monthly ETC",
      rowRef: "Engineering PM pool (2026-07)",
      columnName: "Hours Pulled",
      previousValue: "320",
      newValue: "410",
      changeType: classifyChange("320", "410"),
      entityType: "CategoryPool",
      entityId: 12,
      cellKey: "pulled__ENGINEERING_PM",
    },
  },
  {
    label: "standard-sheet-actions · notes cleared to NULL",
    change: {
      tab: "Monthly ETC",
      rowRef: "Job 1165",
      columnName: "Notes",
      previousValue: "Waiting on customer sign-off",
      newValue: null,
      changeType: classifyChange("Waiting on customer sign-off", null),
      entityType: "ExecutionRate",
      entityId: 47,
      cellKey: "jobNotes__47",
    },
  },
  {
    label: "employee-actions · field change, rowRef is a person",
    change: {
      tab: "Employees",
      rowRef: "Abhi Kamuju",
      columnName: "Discipline",
      previousValue: "mech",
      newValue: "pm",
      changeType: classifyChange("mech", "pm"),
      entityType: "Employee",
      entityId: 64,
    },
  },
  {
    label: "jobtask-actions · deletion, generated column name",
    change: {
      tab: "Job Details",
      rowRef: "Job 1165",
      columnName: "Task 3",
      previousValue: "Fixture design (120h)",
      newValue: null,
      changeType: "removed",
      entityType: "JobTask",
      entityId: 918,
    },
  },
  {
    label: "worst case · a summary that must be TRUNCATED to fit VARCHAR(191)",
    change: {
      tab: "Projects",
      rowRef: "Job 1165",
      columnName: "Cost Actual (Historical)",
      // Long on both sides, so describeChange's output comfortably exceeds 191 and the
      // truncation in recordChanges is the only thing keeping the insert legal.
      previousValue: "x".repeat(140),
      newValue: "y".repeat(140),
      changeType: "edited",
      entityType: "Job",
      entityId: 47,
    },
  },
];

async function main() {
  // 1. Read-only: the marker /api/realtime/version serves. Proves the query runs and
  //    that the bigint comes back narrowable to a Number.
  const rows = await prisma.$queryRaw<{ v: bigint | number | null }[]>`SELECT MAX(id) AS v FROM AuditLog`;
  const raw = rows[0]?.v;
  const version = raw === null || raw === undefined ? null : Number(raw);
  console.log(`change marker  MAX(AuditLog.id) = ${version}  (typeof raw: ${typeof raw})`);
  if (version !== null && !Number.isSafeInteger(version)) {
    throw new Error(`MAX(id) did not narrow to a safe integer: ${String(raw)}`);
  }

  // 2. Every payload, through the real INSERT, then rolled back.
  let inserted = 0;
  const ROLLBACK = "__change_log_smoke_rollback__";
  try {
    await prisma.$transaction(async (tx) => {
      for (const { label, change: c } of cases) {
        const summaryRaw = describeChange(c, "Smoke Test");
        const summary = summaryRaw.length > SUMMARY_MAX ? `${summaryRaw.slice(0, SUMMARY_MAX - 1)}…` : summaryRaw;
        await tx.$executeRaw`
          INSERT INTO AuditLog
            (userId, userEmail, userName, action, entityType, entityId, summary, metadata, createdAt,
             tab, rowRef, columnName, previousValue, newValue, changeType, appVersion, changeId)
          VALUES
            (${null}, ${"smoke@test"}, ${"Smoke Test"}, ${"smoke.changeLog"},
             ${c.entityType ?? null}, ${c.entityId !== undefined ? String(c.entityId) : null},
             ${summary}, NULL, NOW(),
             ${c.tab}, ${c.rowRef}, ${c.columnName}, ${c.previousValue}, ${c.newValue},
             ${c.changeType}, ${APP_VERSION}, ${"smoke-" + inserted})`;
        inserted++;
        console.log(`  ok  ${label}`);
        console.log(`      ${c.changeType.padEnd(12)} summary ${summary.length}ch  "${summary.slice(0, 96)}${summary.length > 96 ? "…" : ""}"`);
      }
      // Deliberate: unwinds every insert above. An audit log is append-only in
      // production and must not carry this script's rows.
      throw new Error(ROLLBACK);
    });
  } catch (err) {
    if (!(err instanceof Error) || err.message !== ROLLBACK) throw err;
  }

  // 3. Prove the rollback actually took: the marker must not have moved.
  const after = await prisma.$queryRaw<{ v: bigint | number | null }[]>`SELECT MAX(id) AS v FROM AuditLog`;
  const afterV = after[0]?.v === null || after[0]?.v === undefined ? null : Number(after[0].v);
  console.log(`\n${inserted}/${cases.length} payloads accepted by the real table`);
  console.log(`marker after rollback = ${afterV}  ${afterV === version ? "(unchanged — nothing persisted)" : "!! ROWS LEAKED !!"}`);
  if (afterV !== version) throw new Error("Smoke rows were committed — the audit log now contains test data.");
}

main()
  .catch((e) => {
    console.error("\nFAILED:", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
