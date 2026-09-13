import "server-only";

import { randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";
import { APP_VERSION } from "@/lib/app-version";
import { round2 } from "@/lib/etc";
import { readHoursFeed, aggregateUndefined, countsAsUndefined, type HoursFeed } from "@/lib/hours-feed";
import { WorkbookError, SHEET_NAME, type RejectedPunch } from "@/lib/paylocity-workbook";

// ── One Paylocity import, from file identity to audit row (§42.5, §42.20) ───
//
// Sits between the reader (paylocity-workbook.ts — "what does the file say") and the
// writers in sync-actuals.ts ("put it in the database"). What it owns is the part
// neither of those should: deciding whether this file version has been seen before,
// and recording what happened either way.
//
// The audit row is not decoration. §42.16 forbids reporting success when the latest
// file was not actually processed, and the only way to keep that promise is for
// something to know which version WAS processed. That is `sha256`.

export type ImportTrigger = "startup" | "interval" | "manual";

export type ImportContext = {
  importId: string;
  refreshId: string | null;
  trigger: ImportTrigger;
  userName: string | null;
  startedAt: Date;
};

export function newImportContext(input: {
  refreshId?: string | null;
  trigger: ImportTrigger;
  userName?: string | null;
}): ImportContext {
  return {
    importId: randomUUID(),
    refreshId: input.refreshId ?? null,
    trigger: input.trigger,
    userName: input.userName ?? null,
    startedAt: new Date(),
  };
}

export type ImportOutcome = {
  feed: HoursFeed;
  ctx: ImportContext;
  // False when this exact file version was already imported successfully. The import
  // still runs — see the note on `changed` below — but the refresh message says so
  // rather than implying new data arrived.
  changed: boolean;
  previousSha: string | null;
};

// The last file version that imported successfully. `status: "ok"` only — a failed
// attempt must not be able to make the next run think the file is already in.
async function lastSuccessfulSha(): Promise<string | null> {
  const rows = await prisma.paylocityImport.findMany({
    where: { status: "ok" },
    orderBy: { id: "desc" },
    take: 1,
    select: { sha256: true },
  });
  return rows[0]?.sha256 ?? null;
}

/**
 * Read the hours feed and open an audit record for it.
 *
 * ── Why an unchanged file is still imported (§42.5) ─────────────────────────
 *
 * The tempting optimisation is to skip the write when the hash matches. It is wrong,
 * because the file is not the only input: a job created since the last pass turns
 * rows that were JOB_NOT_FOUND into attributable hours, and a month reopened since
 * the last pass needs its hours written again. Skipping would leave those states
 * stranded until Lisa happened to save the file.
 *
 * So an unchanged file is re-imported, and idempotency comes from the write being
 * replace-by-(job, month) rather than from refusing to run. §42.5 asks that a
 * repeated refresh "produce the same result without duplicate records", which that
 * satisfies exactly. `changed` is reported so the UI can say "no new file" instead of
 * implying fresh data (§42.16).
 *
 * Throws {@link WorkbookError} when the file cannot be used. The audit row is written
 * as failed first, so the failure is recorded even though the caller aborts (§42.19).
 */
export async function beginPaylocityImport(
  ctx: ImportContext,
  opts?: { onlyMonth?: string },
): Promise<ImportOutcome> {
  const previousSha = await lastSuccessfulSha();

  let feed: HoursFeed;
  try {
    feed = await readHoursFeed(opts);
  } catch (err) {
    await recordFailure(ctx, err);
    throw err;
  }

  const sha = feed.provenance.workbook?.sha256 ?? null;
  return { feed, ctx, changed: sha == null || sha !== previousSha, previousSha };
}

// ── The undefined rows, written once for both readers (§42.9-42.12) ─────────
//
// THE fix for the KPI/drill divergence. Both tables come from one pass over one
// array, inside one transaction, so the card's number is the sum of the drill's rows
// by construction — not by two computations happening to agree.
//
// Replace-all rather than upsert, matching the rule HoursImportIssue already had: the
// source is the authority on its own faults, and a punch corrected upstream has to
// disappear from here too. An upsert-only pass would leave corrected rows behind
// forever, which is the failure mode that makes a data-quality list untrustworthy.
export async function recordUndefinedHours(
  rejected: RejectedPunch[],
  ctx: { importId: string; sourceFile: string },
): Promise<{ kpiRows: number; kpiHours: number; storedRows: number }> {
  // ── Round FIRST, then aggregate (§42.11) ──────────────────────────────────
  //
  // Both tables are Decimal(10,2). The rows are rounded individually on the way in,
  // so if the totals were summed from the RAW values the two would disagree by the
  // accumulated rounding — measured at +0.04h for 2026-06 and +0.01h for 2026-07 on
  // the first live run, which §42.11 defines as a calculation failure and which the
  // drill duly reported in red.
  //
  // Rounding once, up front, and deriving BOTH from the same rounded numbers is what
  // makes `KPI = sum of drill rows` exact rather than approximate. It is the same
  // aggregate-then-round vs round-then-aggregate trap that made a settled-month
  // comparison look like a history rewrite earlier the same day; worth recognising on
  // sight, because it always presents as "nearly right".
  const rounded = rejected.map((r) => ({ ...r, hours: round2(r.hours) }));

  const issues = aggregateUndefined(rounded);
  const kpiHours = issues.reduce((s, i) => s + i.hours, 0);
  const kpiRows = issues.reduce((s, i) => s + i.rows, 0);

  // Every rejection is stored, counted or not — §42.7 forbids silently dropping
  // unmatched rows, and "correctly excluded" is still an answer somebody may need.
  // Rows with no usable work date have no month to file under; they are kept with an
  // empty month so they still appear, rather than being the one category that
  // vanishes.
  const detail = rounded.map((r) => ({
    month: r.month,
    reason: r.reason,
    label: r.label.slice(0, 190),
    workDate: r.workDate,
    employeeId: r.employeeId.slice(0, 190),
    section: r.section.slice(0, 190),
    hours: r.hours,
    sourceRow: r.sourceRow,
    sourceFile: ctx.sourceFile.slice(0, 190),
    importId: ctx.importId,
    countsTowardKpi: countsAsUndefined(r),
  }));

  await prisma.$transaction([
    prisma.hoursImportIssue.deleteMany({}),
    prisma.hoursImportIssue.createMany({
      data: issues.map((i) => ({ month: i.month, label: i.label.slice(0, 190), rows: i.rows, hours: round2(i.hours) })),
    }),
    prisma.undefinedHoursRow.deleteMany({}),
    prisma.undefinedHoursRow.createMany({ data: detail }),
  ]);

  return { kpiRows, kpiHours: round2(kpiHours), storedRows: detail.length };
}

// ── Closing the record ──────────────────────────────────────────────────────

export type ImportTotals = {
  rowsInserted: number;
  rowsUpdated: number;
  rowsRemoved: number;
};

export async function completePaylocityImport(
  outcome: ImportOutcome,
  totals: ImportTotals,
  undefinedResult: { kpiRows: number; kpiHours: number },
): Promise<void> {
  const { ctx, feed, changed } = outcome;
  const wb = feed.provenance.workbook;
  const completedAt = new Date();
  try {
    await prisma.paylocityImport.create({
      data: {
        importId: ctx.importId,
        refreshId: ctx.refreshId,
        fileName: wb?.fileName ?? "(unknown)",
        filePath: wb?.path ?? "",
        fileSize: wb?.size ?? 0,
        fileModifiedAt: wb?.modifiedAt ?? completedAt,
        sha256: wb?.sha256 ?? "",
        sheet: SHEET_NAME,
        reportFrom: firstDate(feed),
        reportTo: feed.provenance.lastWorkDate,
        monthsCovered: JSON.stringify(feed.provenance.monthsCovered),
        rowsRead: feed.rows.length + feed.rejected.length,
        rowsInserted: totals.rowsInserted,
        rowsUpdated: totals.rowsUpdated,
        rowsRemoved: totals.rowsRemoved,
        segmentsMerged: 0,
        rowsInvalid: feed.rejected.filter((r) => r.reason === "INVALID_HOURS" || r.reason === "MISSING_WORK_DATE" || r.reason === "INVALID_LABOR_CODE").length,
        rowsUndefined: undefinedResult.kpiRows,
        undefinedHours: undefinedResult.kpiHours,
        startedAt: ctx.startedAt,
        completedAt,
        durationMs: completedAt.getTime() - ctx.startedAt.getTime(),
        trigger: ctx.trigger,
        userName: ctx.userName,
        // "unchanged" is a SUCCESS — the latest file was checked and processed, it
        // simply carried nothing new. Distinguished from "ok" so the completion
        // message can be honest about whether new data arrived (§42.16).
        status: changed ? "ok" : "unchanged",
        appVersion: APP_VERSION,
      },
    });
  } catch (err) {
    // The audit row failing must not fail the import — but it must be loud, because a
    // silent catch on exactly this kind of path is what hid the varchar(191) bug.
    console.error("[paylocity-import] could not write the import record:", err);
  }
}

async function recordFailure(ctx: ImportContext, err: unknown): Promise<void> {
  const stage = err instanceof WorkbookError ? err.stage : "unknown";
  const message = err instanceof Error ? err.message : String(err);
  const completedAt = new Date();
  try {
    await prisma.paylocityImport.create({
      data: {
        importId: ctx.importId,
        refreshId: ctx.refreshId,
        fileName: "(unread)",
        filePath: "",
        fileSize: 0,
        fileModifiedAt: completedAt,
        sha256: "",
        sheet: "",
        monthsCovered: "[]",
        startedAt: ctx.startedAt,
        completedAt,
        durationMs: completedAt.getTime() - ctx.startedAt.getTime(),
        trigger: ctx.trigger,
        userName: ctx.userName,
        status: "failed",
        failureStage: stage,
        failureDetail: message.slice(0, 2000),
        appVersion: APP_VERSION,
      },
    });
  } catch (writeErr) {
    console.error("[paylocity-import] could not write the FAILURE record:", writeErr);
  }
}

function firstDate(feed: HoursFeed): Date | null {
  let first: Date | null = null;
  for (const r of feed.rows) if (!first || r.date < first) first = r.date;
  return first;
}

// The most recent import, for the ETC header and the refresh panel — so "which file
// am I looking at" is answerable on screen rather than only in a log.
export type LatestImport = {
  importId: string;
  fileName: string;
  fileModifiedAt: Date;
  sha256: string;
  status: string;
  startedAt: Date;
  completedAt: Date | null;
  reportTo: Date | null;
  rowsUndefined: number;
  undefinedHours: number;
  failureStage: string | null;
  failureDetail: string | null;
  trigger: string;
  userName: string | null;
};

export async function latestPaylocityImport(): Promise<LatestImport | null> {
  const row = await prisma.paylocityImport.findFirst({ orderBy: { id: "desc" } });
  if (!row) return null;
  return {
    importId: row.importId,
    fileName: row.fileName,
    fileModifiedAt: row.fileModifiedAt,
    sha256: row.sha256,
    status: row.status,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    reportTo: row.reportTo,
    rowsUndefined: row.rowsUndefined,
    undefinedHours: Number(row.undefinedHours),
    failureStage: row.failureStage,
    failureDetail: row.failureDetail,
    trigger: row.trigger,
    userName: row.userName,
  };
}
