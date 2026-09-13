import "server-only";

import type { HoursImportIssue, JobHoursRow, PoolHoursByMonth } from "@/lib/job-hours-source";
import {
  readPaylocityWorkbook,
  workbookPath,
  WorkbookError,
  type RejectedPunch,
  type WorkbookIdentity,
  type WorkbookReadResult,
} from "@/lib/paylocity-workbook";
import { punchSources, type PaylocitySource } from "@/lib/paylocity-sources";
import { aggregateUndefined, countsAsUndefined, type UndefinedReason } from "@/lib/undefined-hours-rules";
import { prisma } from "@/lib/prisma";
import { buildJobLabelIndex } from "@/lib/job-label";
import { mergeManualContractorHours, manualContractorPoolHours } from "@/lib/manual-contractor-hours";

// ── THE hours feed (§42.8, §42.14) ──────────────────────────────────────────
//
// One entry point for "what hours were worked". Everything downstream — the ETC
// grid's Hours Worked Month, the job rollups, the punch drill, the Standard Fees
// pools, the KPI cards, the exports, submission validation — reaches the source
// through here and nowhere else.
//
// That centralisation is the §42.8 requirement, and it is also the only way the
// §42.11 reconciliation can hold: the Undefined Hours KPI and its drill-through are
// now two views of ONE computation performed here, rather than two computations that
// happened to agree. They previously did not — the card read a stored table and the
// drill ran a live query, and unattributed-hours.ts documented the divergence as an
// accepted trade-off. It is no longer a trade-off anybody has to accept.
//
// ── Which source (2026-08-21: the Paylocity Excel files, and only those) ────
//
// Hours come exclusively from the Paylocity workbooks in the OneDrive folder, one
// authoritative file per punch year — see paylocity-sources.ts for the year rule and
// why overlapping files are gated rather than deduplicated.
//
// Power BI is not an hours source anywhere in the app any more, on either path: not
// as a feed, and not as the code->column resolver it used to supply on every read.
// See the note above readHoursFeed for what that resolver was silently doing to the
// numbers, and SECTION_ALIASES in sections.ts for where that mapping lives now.
//
// A failed read raises. There is no fallback, deliberately: the alternative sources
// all lag the file, so falling back would answer an hours question with stale
// figures while the provenance line claimed success. The sync step records the
// failure and the last valid dataset stays on screen untouched (§42.19).

// Only one source exists. Kept as a named type rather than collapsed away because
// `provenance.source` is persisted in refresh records that already hold the old
// value, and a reader of those records still needs a name for it.
export type HoursFeedSource = "paylocity_excel";

export type HoursProvenance = {
  source: HoursFeedSource;
  /** The current-year workbook. Never null — there is no fileless source any more. */
  workbook: WorkbookIdentity;
  // Months the source actually carried data for.
  monthsCovered: string[];
  // Latest work date seen — the "Hours Refreshed Thru" figure, and the number that
  // makes staleness visible instead of inferred.
  lastWorkDate: Date | null;
  // Why the chosen source was chosen, in words a refresh log can print.
  note: string;
  // Per-file detail when several workbooks were read (one per punch year — see
  // paylocity-sources.ts). Absent for the Power BI path, which has no files.
  // `workbook` above stays the CURRENT-year file, which is what that field has
  // always meant; this is the full picture, including how much overlapping data each
  // archive contributed and how much was excluded as another file's years.
  sources?: PaylocitySourceRead[];
};

export type PaylocitySourceRead = {
  fileName: string;
  /** "2026 and later", "2025" — the punch years this file is authoritative for. */
  ownershipLabel: string;
  identity: WorkbookIdentity;
  /** Bounds of the work dates present in the FILE, before year filtering. */
  firstWorkDate: Date | null;
  lastWorkDate: Date | null;
  rowsRead: number;
  rowsResolved: number;
  /** Rows dropped because another file is authoritative for their year. */
  rowsExcludedByYear: number;
  hoursExcludedByYear: number;
  excludedYears: number[];
};

export type HoursFeed = {
  rows: JobHoursRow[];
  // Per month/label totals — the aggregate the KPI card reads.
  issues: HoursImportIssue[];
  // Punch-level rejections with a reason each — what the drill-through shows.
  // DERIVED FROM THE SAME PASS as `issues`, which is what guarantees they foot.
  rejected: RejectedPunch[];
  poolHours: PoolHoursByMonth;
  provenance: HoursProvenance;
};

// ── Power BI is not an hours source (2026-08-21) ──────────────────────────
//
// `configuredSource()` and the HOURS_SOURCE=power_bi escape hatch are GONE, as is
// `readFromPowerBi`. Hours now come only from the Paylocity Excel files in the
// OneDrive folder (see paylocity-sources.ts).
//
// The escape hatch read like resilience and was the opposite. The Power BI model
// lags the file by days (July was short 150.53h, August entirely absent when
// measured), so the fallback's effect was to answer an hours question with stale
// numbers while the provenance line said only "Power BI" — a reader could not tell
// that the figures had moved backwards. Worse, the model was ALSO consulted on the
// happy path, for the code->column resolver, which meant a transient network
// failure silently changed how punches were bucketed (see SECTION_ALIASES in
// sections.ts, where that mapping now lives explicitly).
//
// A missing or unreadable workbook therefore raises, exactly as §42.19 requires,
// and the last valid dataset stays on screen untouched.

// The Undefined Hours rules come from lib/undefined-hours-rules.ts and are re-exported
// here so callers that already reach for the feed do not need a second import. There is
// one implementation; this is a doorway, not a copy.
export { countsAsUndefined, aggregateUndefined };

// The job numbers the app knows about, so a numerically-valid job it has never heard
// of is reported rather than silently dropped (§42.7). Read once per feed rather than
// per row.
async function jobMaster(): Promise<{ known: Set<string>; byLabel: Map<string, string> }> {
  const jobs = await prisma.job.findMany({ select: { jobId: true, jobName: true } });
  return {
    known: new Set(jobs.map((j) => j.jobId)),
    // Label -> jobId for the job cells that carry a NAME rather than a number.
    // Built from the job master itself, so creating a "2026 Service" job is all
    // it takes for those punches to start resolving — no code change, which is
    // the point (see lib/job-label.ts).
    byLabel: buildJobLabelIndex(jobs),
  };
}

/**
 * Read the hours feed.
 *
 * Throws a {@link WorkbookError} when the configured workbook cannot be used. That is
 * deliberate and is the §42.19 contract: the caller must abort and leave the last
 * valid dataset in place rather than write something partial.
 */
export async function readHoursFeed(opts?: { onlyMonth?: string }): Promise<HoursFeed> {
  const { known, byLabel } = await jobMaster();

  // ── One file per punch year (2026-08-21) ────────────────────────────────
  //
  // The folder holds overlapping workbooks — Job_Hours_2025.xlsx runs five days into
  // 2026 and repeats 587.20h of punches Current_Job_Hours.xlsx also carries. Each
  // year has exactly one authoritative file (paylocity-sources.ts), and each file is
  // read with an `ownsYear` gate that drops the rest BEFORE standardization. So the
  // rows are concatenated here only after each source has been reduced to the years
  // it owns — never "read everything, then deduplicate", which would require a punch
  // identity the export does not guarantee and would delete real hours to remove
  // imagined ones.
  const wanted = opts?.onlyMonth;
  const wantedYear = wanted ? Number(wanted.slice(0, 4)) : null;
  const sources = punchSources().filter((s) => wantedYear == null || s.ownsYear(wantedYear));

  const reads: { source: PaylocitySource; read: WorkbookReadResult }[] = [];
  for (const source of sources) {
    // Sequential rather than parallel: these are 0.8-1.2 MB OneDrive reads and
    // readStableBytes already retries around a file being rewritten under it.
    // Hammering the same synced folder concurrently makes that contention likelier
    // for no meaningful wall-clock gain on two files.
    reads.push({
      source,
      read: await readPaylocityWorkbook({
        path: source.path,
        knownJobNumbers: known,
        jobIdByLabel: byLabel,
        onlyMonth: wanted,
        ownsYear: source.ownsYear,
      }),
    });
  }
  if (reads.length === 0) {
    throw new WorkbookError("not_configured", `No Paylocity punch source owns ${wanted ?? "any year"}.`);
  }

  // The current-year file stays `provenance.workbook` — it is what "the workbook"
  // has always meant to every consumer of this field (freshness, the refresh banner,
  // the same-file-version check), and the archives are static. Per-source detail is
  // in `sources` for anything that wants the full picture.
  const primary = reads.find((r) => r.source.toYear == null) ?? reads[0];

  const officialRows = reads.flatMap((r) => r.read.rows);
  const rejected = reads.flatMap((r) => r.read.rejected);
  const poolHours = new Map<string, number>();
  for (const { read } of reads) {
    for (const [k, v] of read.poolHours) poolHours.set(k, (poolHours.get(k) ?? 0) + v);
  }

  // ── Manual contractor punches (TEMPORARY, 2026-09-01) ─────────────────────
  //
  // Paylocity's report is not carrying temp/contractor punches for July-August
  // 2026, so the supplied timecards are merged in HERE — the one doorway every
  // hours consumer already comes through, so Monthly ETC, the job rollups, the
  // punch drill, Projects, T&M, the pools and the exports all pick them up from
  // this single join. See lib/manual-contractor-hours.ts.
  //
  // `officialRows` is passed in so suppression is decided against the data being
  // merged, on every read: any (employee, work date) the official export already
  // covers drops its manual segments entirely. That is what makes a future
  // Paylocity fix safe without anyone having to delete rows in time.
  const manual = await mergeManualContractorHours({
    officialRows,
    knownJobNumbers: known,
    onlyMonth: wanted,
  });
  const rows = manual.rows.length > 0 ? [...officialRows, ...manual.rows] : officialRows;
  for (const [k, v] of manualContractorPoolHours(manual.rows)) {
    poolHours.set(k, (poolHours.get(k) ?? 0) + v);
  }

  const monthsCovered = [...new Set([...reads.flatMap((r) => r.read.monthsCovered), ...manual.rows.map((r) => `${r.year}-${String(r.month).padStart(2, "0")}`)])].sort();
  let lastWorkDate: Date | null = null;
  for (const { read } of reads) {
    if (read.lastWorkDate && (!lastWorkDate || read.lastWorkDate > lastWorkDate)) lastWorkDate = read.lastWorkDate;
  }
  // A manual punch later than anything in the workbook still moves "hours through".
  for (const r of manual.rows) if (!lastWorkDate || r.date > lastWorkDate) lastWorkDate = r.date;

  const excludedTotal = reads.reduce((s, r) => s + r.read.stats.hoursExcludedByYear, 0);
  const note =
    reads
      .map(
        ({ source, read }) =>
          `${read.identity.fileName} [owns ${source.ownershipLabel}] ` +
          `${read.stats.rowsResolved.toLocaleString()} rows` +
          (read.stats.rowsExcludedByYear > 0
            ? `, ${read.stats.rowsExcludedByYear.toLocaleString()} rows/${read.stats.hoursExcludedByYear.toFixed(2)}h excluded as another file's years`
            : ""),
      )
      .join("; ") +
    `. Hours through ${lastWorkDate?.toISOString().slice(0, 10) ?? "—"}.` +
    (excludedTotal > 0 ? ` ${excludedTotal.toFixed(2)}h of overlapping duplicate hours prevented.` : "") +
    // Stated, never silent: a figure that includes manually transcribed
    // timecards must say so wherever provenance is printed.
    (manual.totalHours > 0
      ? ` PLUS ${manual.totalHours.toFixed(2)}h from ${manual.rows.length} manually entered contractor timecard segments (Paylocity is not yet reporting them).`
      : "") +
    (manual.suppressed.length > 0
      ? ` ${manual.suppressed.reduce((s2, x) => s2 + x.hours, 0).toFixed(2)}h of manual contractor hours suppressed — Paylocity now covers those days.`
      : "") +
    (manual.unknownJobs.length > 0
      ? ` ${manual.unknownJobs.length} manual contractor segment(s) name a job the app does not know and were NOT counted.`
      : "");

  return {
    rows,
    issues: aggregateUndefined(rejected),
    rejected,
    poolHours,
    provenance: {
      source: "paylocity_excel",
      workbook: primary.read.identity,
      monthsCovered,
      lastWorkDate,
      note,
      sources: reads.map(({ source, read }) => ({
        fileName: read.identity.fileName,
        ownershipLabel: source.ownershipLabel,
        identity: read.identity,
        firstWorkDate: read.firstWorkDate,
        lastWorkDate: read.lastWorkDate,
        rowsRead: read.stats.rowsRead,
        rowsResolved: read.stats.rowsResolved,
        rowsExcludedByYear: read.stats.rowsExcludedByYear,
        hoursExcludedByYear: read.stats.hoursExcludedByYear,
        excludedYears: read.stats.excludedYears,
      })),
    },
  };
}

// A one-line description of where hours came from and how current they are, for the
// refresh record and the ETC header. Stated rather than inferred, because "the number
// looks plausible" is how staleness survives.
export function describeProvenance(p: HoursProvenance): string {
  const thru = p.lastWorkDate ? p.lastWorkDate.toISOString().slice(0, 10) : "unknown";
  return `Paylocity Excel — hours through ${thru}`;
}

export { WorkbookError, workbookPath };
export type { RejectedPunch, UndefinedReason, WorkbookIdentity };
