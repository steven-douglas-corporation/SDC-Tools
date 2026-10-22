import "server-only";

import { prisma } from "@/lib/prisma";
import { warehouseConfigured } from "@/lib/data-warehouse";
import {
  readPaylocityWorkbook,
  readWarehousePunches,
  worksheetFromPunches,
  WorkbookError,
  type RejectedPunch,
  type WorkbookIdentity,
} from "@/lib/paylocity-workbook";
import type { JobHoursRow, PoolHoursByMonth } from "@/lib/job-hours-source";
import { resolveTempPunches, type AppPerson, type TempPersonSummary, type TypedInId } from "@/lib/temp-punch-people";

// ── Temp and contractor punches, read apart from the Job Hours files (2026-10-22) ──
//
// Paylocity's Job Hours report cannot carry temp employees, so their hours come from a
// second report (PunchDetail for the TEMPS group) that the warehouse loads as
// SourceReport 'temp_punches' (tools/data-warehouse). This is its reader.
//
// ── Why it is its own read, not a third entry in paylocity-sources.ts ────────
//
// That list is "exactly one file owns each punch year", validated at load so an overlap
// can never double-count. The temp report is the opposite kind of thing: additive, for the
// same years, about different people. Forcing it into the list would mean weakening the
// guarantee the list exists to give. So it is read here, with its own file identity, its
// own freshness, and its own failure — and merged into the feed by hours-feed.ts.
//
// ── A failed temp read never fails the hours (mvest, 2026-10-22) ─────────────
//
// readTempPunches does not throw. A report that cannot be read comes back as
// status "failed" with the reason, the hours feed goes on without it, and the refresh
// records the temp source as failed (its own row on Data Management → Data sources). The
// price is stated: the app rewrites a job-month whole, so for that pass the temp punches
// are absent from the figures, and they return on the next pass that can read them. The
// alternative — aborting every hours figure because eight people's report broke — was
// rejected. A report that has simply not arrived yet is not a failure.
//
// ── Then everything the hours reader does applies unchanged ──────────────────
//
// Names are turned into ids (lib/temp-punch-people.ts) and the punches go through the SAME
// readPaylocityWorkbook as every other hours file, so a punch with no job, no phase or an
// unknown job is rejected with the same reason and reaches Undefined Hours the same way.
// Fixing those is a Paylocity correction (the report is HR's), not something kept here.

export const TEMP_REPORT_KEY = "temp_punches";
/** Beyond this the newest file is called stale: the load keeps serving the last file it loaded if the report stops arriving. */
export const TEMP_STALE_DAYS = 2;
const DAY_MS = 86_400_000;

export type TempFeedStatus =
  /** No warehouse is configured, so there is no temp feed. The typed-in timecards stand alone. */
  | "off"
  /** The warehouse has no temp punches yet. Not a fault. */
  | "not_arrived"
  | "ok"
  | "failed";

export type TempFeed = {
  status: TempFeedStatus;
  rows: JobHoursRow[];
  rejected: RejectedPunch[];
  poolHours: PoolHoursByMonth;
  identity: WorkbookIdentity | null;
  monthsCovered: string[];
  lastWorkDate: Date | null;
  /** Punches in the file, before any rejection (zero-hour rows are not in the warehouse fact). */
  punchesRead: number;
  /** Who each name resolved to: the list behind "names without an id". */
  people: TempPersonSummary[];
  ageDays: number | null;
  stale: boolean;
  error: string | null;
};

export const EMPTY_TEMP_FEED: TempFeed = {
  status: "off",
  rows: [],
  rejected: [],
  poolHours: new Map(),
  identity: null,
  monthsCovered: [],
  lastWorkDate: null,
  punchesRead: 0,
  people: [],
  ageDays: null,
  stale: false,
  error: null,
};

/** The Employee rows with a Paylocity id: the same read the typed-in timecards match names against. */
export async function loadAppPeople(): Promise<AppPerson[]> {
  return prisma.$queryRaw<AppPerson[]>`SELECT name, paylocityId, active FROM Employee WHERE paylocityId IS NOT NULL`;
}

/**
 * The id each still-active typed-in timecard gives each name. Empty when the table is not
 * there (a database that never had the contractor migration): this is only a bridge while
 * both sources run, never a requirement.
 */
export async function loadTypedInIds(): Promise<TypedInId[]> {
  try {
    return await prisma.$queryRaw<TypedInId[]>`
      SELECT DISTINCT employeeName AS name, paylocityId FROM ManualContractorPunch WHERE active = true`;
  } catch {
    return [];
  }
}

export function tempFileAge(identity: WorkbookIdentity, now: Date): { ageDays: number; stale: boolean } {
  const ageDays = Math.max(0, (now.getTime() - identity.modifiedAt.getTime()) / DAY_MS);
  return { ageDays, stale: ageDays > TEMP_STALE_DAYS };
}

/**
 * Reads the temp punches. Never throws: every outcome, including a failure, is a status.
 *
 * @param knownJobNumbers / jobIdByLabel the job master, exactly as readHoursFeed passes it
 *        to the Job Hours files, so a punch's job is judged by one rule everywhere.
 */
export async function readTempPunches(opts: {
  knownJobNumbers: ReadonlySet<string>;
  jobIdByLabel: ReadonlyMap<string, string>;
  onlyMonth?: string;
  now?: Date;
}): Promise<TempFeed> {
  if (!warehouseConfigured()) return { ...EMPTY_TEMP_FEED, status: "off" };
  const now = opts.now ?? new Date();

  try {
    const { identity, punches } = await readWarehousePunches(TEMP_REPORT_KEY, { withNames: true });
    const [people, typedIn] = await Promise.all([loadAppPeople(), loadTypedInIds()]);
    const resolved = resolveTempPunches(punches, people, typedIn);
    const { ageDays, stale } = tempFileAge(identity, now);

    // Punches whose name matches more than one person are not guessed at: rejected the way
    // the typed-in timecards reject them, so the Undefined Hours drill shows them.
    const ambiguous: RejectedPunch[] = resolved.ambiguous
      .filter(({ punch }) => !opts.onlyMonth || punch.workDate.slice(0, 7) === opts.onlyMonth)
      .map(({ punch }) => ({
        month: punch.workDate.slice(0, 7),
        reason: "EMPLOYEE_NOT_MAPPED" as const,
        label: punch.employeeName ?? "(no name)",
        workDate: new Date(`${punch.workDate}T00:00:00.000Z`),
        employeeId: "",
        section: `${punch.section ?? ""}-${punch.fn ?? ""}`,
        hours: punch.hours,
        sourceRow: punch.sheetRow,
        // The KPI's definition is job-number faults; a name that needs choosing is not one.
        countsTowardKpi: false,
      }));

    let read: Awaited<ReturnType<typeof readPaylocityWorkbook>> | null = null;
    try {
      read = await readPaylocityWorkbook({
        prebuilt: { identity, ws: worksheetFromPunches(resolved.punches) },
        knownJobNumbers: opts.knownJobNumbers,
        jobIdByLabel: opts.jobIdByLabel,
        onlyMonth: opts.onlyMonth,
      });
    } catch (err) {
      // A sheet with nothing usable in it (every punch ambiguous or zero-hour) is an
      // empty result, not a broken report.
      if (!(err instanceof WorkbookError && (err.stage === "no_valid_rows" || err.stage === "no_data_rows"))) throw err;
    }

    return {
      status: "ok",
      rows: read?.rows ?? [],
      rejected: [...(read?.rejected ?? []), ...ambiguous],
      poolHours: read?.poolHours ?? new Map(),
      identity,
      monthsCovered: read?.monthsCovered ?? [],
      lastWorkDate: read?.lastWorkDate ?? null,
      punchesRead: punches.length,
      people: resolved.people,
      ageDays,
      stale,
      error: null,
    };
  } catch (err) {
    // The report simply is not in the warehouse yet: say so, do not call it broken.
    if (err instanceof WorkbookError && err.stage === "file_missing") return { ...EMPTY_TEMP_FEED, status: "not_arrived" };
    console.error("[temp-punches] could not read the temp punches:", err);
    return { ...EMPTY_TEMP_FEED, status: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}

/** One sentence for the refresh log and the hours provenance line. */
export function describeTempFeed(feed: TempFeed, hoursResolved: number): string {
  const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "—");
  switch (feed.status) {
    case "off":
      return "";
    case "not_arrived":
      return " Temp punches: no report in the warehouse yet.";
    case "failed":
      return ` Temp punches could NOT be read (${feed.error ?? "unknown error"}) — hours were refreshed without them, and they return on the next pass that can read them.`;
    case "ok": {
      const unfixed = feed.rejected.reduce((s, r) => s + r.hours, 0);
      return (
        ` Temp punches: ${feed.identity?.fileName ?? "report"} — ${feed.rows.length.toLocaleString()} punches, ${hoursResolved.toFixed(2)}h, through ${iso(feed.lastWorkDate)}.` +
        (feed.rejected.length > 0
          ? ` ${feed.rejected.length} punch(es), ${unfixed.toFixed(2)}h, reached no job (no job or phase in Paylocity, or an unrecognised job) and are listed under Undefined Hours and on Data Management.`
          : "") +
        (feed.stale ? ` The file is ${Math.floor(feed.ageDays ?? 0)} days old.` : "")
      );
    }
  }
}
