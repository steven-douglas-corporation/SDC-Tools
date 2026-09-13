import "server-only";

import { createHash } from "crypto";
import { readFile, stat } from "fs/promises";
import ExcelJS from "exceljs";
import {
  ETC_TRACKED_CODES,
  mapPunchToColumns,
  poolCategoryForPunch,
} from "@/lib/sections";
import { isTotalControlFunctionId, normalizeFunctionId } from "@/lib/paylocity-canonical";
import { normalizeSectionId } from "@/lib/paylocity-standard-rules";
import type { JobHoursRow } from "@/lib/job-hours-source";
import { resolveJobLabel, jobNumberFromMachineSuffix } from "@/lib/job-label";
import { normalizeJobNumber as normalizeJobId } from "@/lib/job-filters";
// The Undefined Hours definition, from the one module that owns it. Imported for use
// here AND re-exported below, so callers can reach it either way but there is still
// only one implementation.
import {
  KPI_COUNTED_REASONS as COUNTED,
  reportMonthForWorkDate,
  type UndefinedReason,
} from "@/lib/undefined-hours-rules";

// ── Lisa's Paylocity workbook, read straight from the OneDrive folder (§42) ──
//
// THE source of actual hours worked. Lisa drops (or replaces) Current_Job_Hours.xlsx
// in a OneDrive folder every day; this reads that file.
//
// ── Why this exists, measured rather than assumed (2026-08-05) ──────────────
//
// Hours were switched to Power BI's `Hours Actual` table on 2026-08-03, on the
// evidence that the two agreed on 1,127 of 1,127 job x section x month cells. That
// equivalence was real and still holds — for SETTLED months. What it could not show,
// because it was measured across closed months only, is the LAG:
//
//   scripts/_recon_workbook_vs_pbi_vs_db.ts, 2026-08-05
//     2026-06   file 7,357.98h   pbi 7,357.98h   db 7,358.01h    0 cells differ
//     2026-07   file 6,823.60h   pbi 6,673.07h   db 6,673.07h   46 cells differ
//     2026-08   file   293.50h   pbi     0.00h   db     0.00h   56 cells differ
//
// The workbook's latest work date was 2026-08-04; Power BI's was 2026-07-31. The
// model had not ingested August at all. So the app was showing figures that were
// days old however often anybody pressed Refresh Data — and no amount of cache
// invalidation or UI wiring could have fixed it, because the data was not there to
// fetch. That is the §42 report, and this module is the fix.
//
// June matching to the penny with ZERO differing cells is what makes the switch
// safe: for a month that has settled, this file and the model are the same data.
// This is not a new source of truth, it is the same one, four days earlier.
//
// ── What this module does NOT do ────────────────────────────────────────────
//
// It does not own history. The workbook reaches back only to 2026-01; Power BI
// holds 2025-02 onward. lib/hours-feed.ts owns that partition — this module
// answers only "what is in the file", and says honestly which months that covers.
// The last time a rolling-window file was treated as the whole truth, the Projects
// grid went short ~49,000h.

// ── Configuration ───────────────────────────────────────────────────────────
//
// JOB_HOURS_LOCAL_PATH already existed and already pointed here — it is the variable
// the pre-2026-08-03 reader used, left in .env when that reader was deleted. Reused
// rather than renamed so no deployment has to change to pick this up.
const DEFAULT_PATH =
  "C:/Users/akamuju/OneDrive - Steven Douglas Corp/SDC- Power BI Integration - Job Hours Report/Job Hours From Paylocity/Current_Job_Hours.xlsx";

export function workbookPath(): string {
  return process.env.JOB_HOURS_LOCAL_PATH?.trim() || DEFAULT_PATH;
}

// The sheet and columns this file actually has, confirmed by reading it
// (scripts/_probe_paylocity_workbook.ts, 2026-08-05): one visible sheet, 19,827
// rows, eight columns. Named here so a change upstream fails loudly at the header
// check rather than quietly producing zeros.
export const SHEET_NAME = "Report";
export const REQUIRED_HEADERS = [
  "Employee Id",
  "Work Date",
  "Jobs",
  "Jobs Name",
  "MachineSec",
  "Function",
  "Total Hours Worked",
] as const;
// Present in the file and NOT required: it carries a travel location ("TRAVEL",
// "Concord", "Not Defined"). Optional because it must stay optional — an export
// saved without the column has to keep importing rather than fail the whole
// refresh over one derived column. As of 2026-08-28 it is no longer discarded:
// it feeds the Dashboard's Department Utilization Travel / Travel % columns via
// normalizeTravel() below. A file missing the column yields "" on every row,
// which reads as "not known" (Travel renders as a dash), never as zero travel.
export const OPTIONAL_HEADERS = ["Travel"] as const;

// The Job Hours Report's Power Query does exactly two replacements on this column
// (expressions.tmdl: ReplaceValue "Not Defined"->"Concord", then "TRAVEL"->"Travel").
// Reproduced here so the app's Travel hours and the report's agree by construction
// rather than by coincidence. Anything else is passed through as-is: the column is
// a free-text site name and inventing a bucket for an unrecognised one would hide it.
export function normalizeTravel(raw: string): string {
  const v = raw.trim();
  if (v === "") return "";
  if (v.toUpperCase() === "TRAVEL") return "Travel";
  if (v === "Not Defined") return "Concord";
  return v;
}

// ── The file's identity (§42.2) ─────────────────────────────────────────────
//
// Filename is explicitly NOT part of it. Lisa replaces the file keeping the same
// name, which is the case §42.2 calls out: "Do not rely only on the filename".
// What identifies a VERSION is its content hash; size and mtime are carried for the
// audit record and for the cheap did-anything-change test.
export type WorkbookIdentity = {
  path: string;
  fileName: string;
  size: number;
  modifiedAt: Date;
  // sha256 of the bytes actually parsed — not of a second read. This is the value
  // that decides "same file or not", and it is recorded against the import.
  sha256: string;
};

export type WorkbookFailureStage =
  | "not_configured"
  | "file_missing"
  | "file_empty"
  | "file_unstable"
  | "file_unreadable"
  | "workbook_unreadable"
  | "sheet_missing"
  | "headers_missing"
  | "no_data_rows"
  | "no_valid_rows";

export class WorkbookError extends Error {
  constructor(
    readonly stage: WorkbookFailureStage,
    message: string,
    // Where exactly: the sheet, the row, the column, the offending value. §42.4
    // asks for "the exact workbook, sheet, row, or column issue", and a message
    // saying only "validation failed" is what sends somebody scrolling 19,000 rows.
    readonly where?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "WorkbookError";
  }
}

// ── Why a row reached no figure, and what counts (§42.9, §42.12) ────────────
//
// The vocabulary and the definition live in lib/undefined-hours-rules.ts — a module
// with no I/O at all, so the KPI, the drill, the export and the tests share one
// implementation without any of them reaching a database or a spreadsheet library.
// Re-exported here because this is where the rows are produced and callers look.
//
// ── One deliberate WIDENING, and what it costs (measured 2026-08-05) ────────
//
// JOB_NOT_FOUND now covers two things where the old rule covered one:
//
//   a. a job cell that is not a number — "Not Defined" (4,321.48h across the file),
//      "2026 SERVICE", "2023_SER". This is what the old rule counted.
//   b. a job cell that IS a number but that the app has no Job row for — 15 distinct
//      values, e.g. 2026 (141.75h, someone typing the year), 0964, 4263, 624.
//
// (b) used to be counted as `jobsNotFound` in syncActualHours and then dropped
// without appearing anywhere — precisely what §42.7 forbids, and §42.9 lists "hours
// with an unmapped Job ID" as an Undefined Hours category. So it is included.
//
// The cost is small and is stated here so nobody later finds an unexplained step in
// the KPI. Against the stored figures, per month:
//
//   2026-01..2026-03, 2026-05, 2026-06   identical (2.62 / 0.98 / 4.62 / 112.33 / 240.43)
//   2026-04    3.55 -> 3.68   (+0.13, from (b))
//   2026-07  179.13 -> 195.78 (+16.65: +10.04 is the Power BI LAG this whole change
//                              exists to fix, +6.61 is (b))
//   2026-08    0.00 -> 8.00   (entirely lag — the model held no August at all)
//
// Settled months are unchanged, which is the test that matters: the definition did
// not move under anybody's feet, it only stopped hiding two categories.
export {
  UNDEFINED_REASON_LABEL,
  UNDEFINED_REASON_FIX,
  KPI_COUNTED_REASONS,
  countsAsUndefined,
  aggregateUndefined,
  reconcileUndefined,
  reportMonthForWorkDate,
} from "@/lib/undefined-hours-rules";
export type { UndefinedReason } from "@/lib/undefined-hours-rules";

// One punch that reached no job figure.
export type RejectedPunch = {
  month: string; // "2026-07"
  reason: UndefinedReason;
  // The raw cell value that could not be used — "Not Defined", "", "2026 SERVICE".
  label: string;
  workDate: Date | null;
  employeeId: string;
  // Raw MachineSec-Function, e.g. "80-311".
  section: string;
  hours: number;
  // 1-based row in the sheet, so somebody can go and look at it.
  sourceRow: number;
  // True when this reason is inside the KPI's definition — see KPI_COUNTED_REASONS.
  countsTowardKpi: boolean;
};

// A punch that DID resolve, at the app's own grain. Same shape job-hours-source.ts
// returns, deliberately: five callers consume it and none should care which reader
// produced it.
//
// Now an ALIAS of that type rather than a second hand-maintained copy of it
// (2026-08-21). It was structurally identical by intent, but "identical by intent"
// is exactly what drifts: adding rawSection/rawFunction to one and not the other
// broke the assignment at three call sites and would have silently let this reader
// write rows without raw provenance. An alias makes the two literally the same
// type, so the next field cannot be added to only one of them.
export type WorkbookHoursRow = JobHoursRow;

export type WorkbookReadResult = {
  identity: WorkbookIdentity;
  sheet: string;
  rows: WorkbookHoursRow[];
  rejected: RejectedPunch[];
  // Company-wide Standard Fees pool tallies, `${YYYY-MM}::${category}` -> hours.
  poolHours: Map<string, number>;
  // Months the file actually carries data for, ascending. hours-feed.ts uses this to
  // decide which months this file is allowed to own.
  monthsCovered: string[];
  // Bounds of the work dates seen, for the audit record and the freshness figure.
  firstWorkDate: Date | null;
  lastWorkDate: Date | null;
  // Counts for the import audit (§42.20).
  stats: {
    rowsRead: number;
    rowsWithHours: number;
    rowsResolved: number;
    rowsRejected: number;
    // Rows beyond the first for a given storage-grain key — see the note on
    // `segmentsMerged` in the body. NOT duplicates.
    segmentsMerged: number;
    zeroHourRows: number;
    // Rows this file carries for a punch year another workbook is authoritative for,
    // dropped before standardization. The measure of how much double-counting the
    // year rule prevented — see the ownership gate in the body and
    // paylocity-sources.ts. Zero when no `ownsYear` was supplied.
    rowsExcludedByYear: number;
    hoursExcludedByYear: number;
    /** The years those excluded rows fell in, ascending. */
    excludedYears: number[];
  };
};

// ── Reading the file safely (§42.3) ─────────────────────────────────────────
//
// Three failure modes this has to survive, all of which are real for a OneDrive
// folder rather than theoretical:
//
//   1. A DEHYDRATED placeholder. The folder is pinned "Always keep on this device"
//      today (attribute 0x80000 confirmed 2026-08-05), but unpinning it turns every
//      file into a stub a service account cannot always hydrate. The read throws;
//      the message has to say what to do about it rather than "ENOENT".
//   2. A PARTIAL upload. .xlsx is a zip, so a half-written file fails to open — the
//      strongest completeness check available, and free.
//   3. A file REPLACED WHILE BEING READ. Lisa saving over it mid-parse would give a
//      hash that belongs to neither version.
//
// (3) is handled without sleeping or polling: stat, read, stat again. If size or
// mtime moved across the read, the bytes are not a coherent version and the caller
// retries. That is cheaper and more honest than waiting a fixed interval and hoping.
async function readStableBytes(path: string): Promise<{ buf: Buffer; size: number; modifiedAt: Date }> {
  let before;
  try {
    before = await stat(/* turbopackIgnore: true */ path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new WorkbookError("file_missing", `No Paylocity workbook at ${path}. Check that Lisa's upload landed and that the OneDrive folder is synced.`, { path });
    }
    throw new WorkbookError("file_unreadable", `Could not read ${path}: ${(err as Error).message}`, { path, code });
  }

  if (!before.isFile()) {
    throw new WorkbookError("file_missing", `${path} is not a file.`, { path });
  }
  if (before.size === 0) {
    throw new WorkbookError("file_empty", `The Paylocity workbook at ${path} is 0 bytes — the upload is incomplete or the file was cleared.`, { path });
  }

  let buf: Buffer;
  try {
    buf = await readFile(/* turbopackIgnore: true */ path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // A dehydrated OneDrive placeholder that cannot be fetched surfaces here.
    throw new WorkbookError(
      "file_unreadable",
      `Could not read the Paylocity workbook (${code ?? "unknown error"}). If the OneDrive folder is set to "Free up space", ` +
        `set it to "Always keep on this device" — a placeholder has no content on disk for the app to read.`,
      { path, code },
    );
  }

  const after = await stat(/* turbopackIgnore: true */ path);
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
    throw new WorkbookError(
      "file_unstable",
      `The Paylocity workbook changed while it was being read — it is probably still uploading. Nothing was imported; the next refresh will pick it up.`,
      { path, sizeBefore: before.size, sizeAfter: after.size },
    );
  }
  if (buf.byteLength !== after.size) {
    throw new WorkbookError("file_unstable", `Short read on the Paylocity workbook (${buf.byteLength} of ${after.size} bytes).`, { path });
  }

  return { buf, size: after.size, modifiedAt: after.mtime };
}

// Identity WITHOUT parsing — for the cheap "has anything changed since the last
// import?" test (§42.5). Hashes the bytes, because that is the only thing that
// actually answers it: Lisa replaces the file under the same name, and a same-size
// same-name replacement is exactly the case a filename or size check waves through.
export async function inspectWorkbook(path = workbookPath()): Promise<WorkbookIdentity> {
  const { buf, size, modifiedAt } = await readStableBytes(path);
  return {
    path,
    fileName: path.split(/[\\/]/).pop() ?? path,
    size,
    modifiedAt,
    sha256: createHash("sha256").update(buf).digest("hex"),
  };
}

// ── Cell coercion ───────────────────────────────────────────────────────────
//
// ExcelJS hands back a union: a primitive, a Date, a formula result object, a rich
// text object, a hyperlink. Every reader of this file needs the same answer to
// "what does this cell say", so it is one function.
function cellText(v: ExcelJS.CellValue): string {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    // Rich text before `text`: a rich-text cell has both, and the `text` property on
    // it is not the concatenated string.
    if ("richText" in v) {
      const parts = (v as { richText: { text: string }[] }).richText;
      if (Array.isArray(parts)) return parts.map((p) => p.text).join("").trim();
    }
    if ("text" in v && typeof (v as { text?: unknown }).text === "string") return (v as { text: string }).text.trim();
    if ("result" in v) return String((v as { result?: unknown }).result ?? "").trim();
  }
  return String(v).trim();
}

function cellNumber(v: ExcelJS.CellValue): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "object" && "result" in v) {
    const r = (v as { result?: unknown }).result;
    const n = Number(r);
    return Number.isFinite(n) ? n : null;
  }
  // Strings arrive from exports that quote their numbers; strip separators and the
  // currency-style formatting Excel sometimes writes into a text column.
  const s = String(v).replace(/[,\s]/g, "");
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// Excel dates arrive as Date objects when the column is date-typed, and as either a
// serial number or a string when it is not. All three appear in exports of this
// shape, so all three are handled.
//
// Normalised to UTC midnight: the reporting month is decided by the work date
// (§42.6) and a timezone-shifted date is how a 1st-of-the-month punch lands in the
// previous month.
function cellDate(v: ExcelJS.CellValue): Date | null {
  if (v == null || v === "") return null;
  if (v instanceof Date) {
    return new Date(Date.UTC(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate()));
  }
  if (typeof v === "number") {
    // Excel serial: days since 1899-12-30 (the 1900 leap-year bug is baked into the
    // epoch, which is why it is the 30th and not the 31st).
    const ms = Math.round((v - 25569) * 86400 * 1000);
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return null;
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  }
  const s = cellText(v);
  if (!s) return null;
  // ISO first, then the US format Paylocity exports sometimes carry.
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (us) return new Date(Date.UTC(Number(us[3]), Number(us[1]) - 1, Number(us[2])));
  const parsed = new Date(s);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()));
}

// Power BI zero-pads Job Id ("0114") and so does this export; the app stores it
// unpadded ("114"). Joining raw makes every older job look like it has no hours.
// The rule itself now lives in job-filters.ts, shared with job-hours-source.ts's
// normalizePbiJobId (this used to be a second, byte-identical copy of the same
// regex) -- this name is kept as the export every existing caller here uses.
export function normalizeJobNumber(raw: string): string {
  return normalizeJobId(raw);
}

// The reporting month is the WORK DATE's month and nothing else (§42.6). One
// implementation, in undefined-hours-rules.ts, so the rule has a test rather than
// being an inline getMonth() in whichever reader came first.
const monthKey = reportMonthForWorkDate;

// ── The read ────────────────────────────────────────────────────────────────
//
// `resolve` is the model-derived code->column map (buildColumnResolver in
// job-hours-source.ts). It is READ FROM POWER BI, and that is not a contradiction
// with moving hours off Power BI: the Function Hierarchy is static metadata about
// what a punch code means, not the hours themselves. It changes when somebody adds a
// code, not daily. SECTION_ALIASES remains the fallback when it cannot be fetched,
// exactly as before — so a Power BI outage costs the newest code mappings, never the
// hours.
//
// `knownJobNumbers` lets a numerically-valid job that the app has never heard of be
// reported as JOB_NOT_FOUND rather than silently attributed. Optional: omit it and
// the check is skipped rather than every row being called unknown.
export async function readPaylocityWorkbook(opts?: {
  path?: string;
  resolve?: (rawSection: string) => string | null;
  knownJobNumbers?: ReadonlySet<string>;
  // Label -> jobId for the job cells that are a NAME rather than a number
  // ("2025 SERVICE", "2023_SER"). Built from the Job table by the caller with
  // lib/job-label.ts's own normalizer, so both sides key identically. Omitted
  // means "do not attempt name matching" and the old numeric-only behaviour
  // stands.
  jobIdByLabel?: ReadonlyMap<string, string>;
  // Restrict to one month, for the callers that only ever touch one (the ETC page's
  // Refresh). The whole file is still parsed — it is one 746 KB read, ~1s — but
  // everything outside the month is discarded before it reaches the caller.
  onlyMonth?: string;
  // Which punch YEARS this file is authoritative for. Supplied by
  // paylocity-sources.ts; omitted means "this file owns everything in it", which is
  // the historical single-file behaviour every existing caller relies on.
  ownsYear?: (year: number) => boolean;
}): Promise<WorkbookReadResult> {
  const path = opts?.path ?? workbookPath();
  if (!path) {
    throw new WorkbookError("not_configured", "JOB_HOURS_LOCAL_PATH is not set and there is no default workbook path.");
  }

  const { buf, size, modifiedAt } = await readStableBytes(path);
  const identity: WorkbookIdentity = {
    path,
    fileName: path.split(/[\\/]/).pop() ?? path,
    size,
    modifiedAt,
    sha256: createHash("sha256").update(buf).digest("hex"),
  };

  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
  } catch (err) {
    // A partial upload lands here: .xlsx is a zip and a truncated zip will not open.
    throw new WorkbookError(
      "workbook_unreadable",
      `The Paylocity workbook could not be opened — it is corrupt or still uploading (${(err as Error).message}).`,
      { path, size },
    );
  }

  const ws = wb.getWorksheet(SHEET_NAME);
  if (!ws) {
    throw new WorkbookError(
      "sheet_missing",
      `The Paylocity workbook has no "${SHEET_NAME}" sheet. Found: ${wb.worksheets.map((w) => `"${w.name}"`).join(", ") || "none"}.`,
      { path, expected: SHEET_NAME, found: wb.worksheets.map((w) => w.name) },
    );
  }

  // ── Headers, by NAME not position ─────────────────────────────────────────
  // Reading by position is what turns "somebody inserted a column" into silently
  // wrong numbers instead of an error. The index is looked up per header.
  const headerRow = ws.getRow(1);
  const headerIndex = new Map<string, number>();
  headerRow.eachCell({ includeEmpty: false }, (cell, col) => {
    const name = cellText(cell.value);
    if (name && !headerIndex.has(name)) headerIndex.set(name, col);
  });

  const missing = REQUIRED_HEADERS.filter((h) => !headerIndex.has(h));
  if (missing.length > 0) {
    throw new WorkbookError(
      "headers_missing",
      `The "${SHEET_NAME}" sheet is missing required column(s): ${missing.join(", ")}. Found: ${[...headerIndex.keys()].join(", ")}.`,
      { path, sheet: SHEET_NAME, missing, found: [...headerIndex.keys()] },
    );
  }

  const COL = {
    employeeId: headerIndex.get("Employee Id")!,
    workDate: headerIndex.get("Work Date")!,
    jobs: headerIndex.get("Jobs")!,
    jobsName: headerIndex.get("Jobs Name")!,
    machineSec: headerIndex.get("MachineSec")!,
    fn: headerIndex.get("Function")!,
    hours: headerIndex.get("Total Hours Worked")!,
    // Optional — undefined when the export was saved without the column.
    travel: headerIndex.get("Travel"),
  };

  if (ws.rowCount < 2) {
    throw new WorkbookError("no_data_rows", `The "${SHEET_NAME}" sheet has headers but no data rows.`, { path, sheet: SHEET_NAME });
  }

  const resolve = opts?.resolve;
  const known = opts?.knownJobNumbers;
  const jobIdByLabel = opts?.jobIdByLabel;
  const wantMonth = opts?.onlyMonth;
  const ownsYear = opts?.ownsYear;

  const rows: WorkbookHoursRow[] = [];
  const rejected: RejectedPunch[] = [];
  const poolHours = new Map<string, number>();
  const months = new Set<string>();
  let firstWorkDate: Date | null = null;
  let lastWorkDate: Date | null = null;

  let rowsRead = 0;
  let rowsWithHours = 0;
  let zeroHourRows = 0;
  let segmentsMerged = 0;
  // Rows this file carries but does NOT own — another workbook is authoritative for
  // their year. Reported so the exclusion is auditable rather than invisible.
  let rowsExcludedByYear = 0;
  let hoursExcludedByYear = 0;
  const excludedYears = new Set<number>();

  // ── Why there is no row-level duplicate detection (§42.5, §42.12) ─────────
  //
  // The obvious design is to treat a repeated (employee, date, job, section) as a
  // duplicated source row. It is wrong for this export, and measurably so: 7,460 keys
  // repeat, and only 21 of them differ by any other column. The rest look like this
  // (scripts/_probe_dupes_and_kpi.ts, 2026-08-05):
  //
  //     100605 | 2026-02-25 | 0803 | 80-311   x2   hours [1.5, 7.5]
  //     100010 | 2026-01-14 | 0859 | 80-412   x2   hours [3.7166666, 3.5166666]
  //
  // Those are PUNCH SEGMENTS — one clock-in/clock-out pair each. Somebody who breaks
  // for lunch produces two rows for the same day and job. They must be summed, and a
  // detector that called them duplicates would have discarded 7,439 legitimate rows
  // and understated every month. (Flagging them and still counting them would have
  // been merely misleading rather than destructive, which is how this was caught: the
  // count looked absurd next to a June total that was nonetheless exact.)
  //
  // Two segments of genuinely equal length are also indistinguishable from a truly
  // duplicated row, so at this grain the file cannot answer the question at all.
  // Idempotency therefore does NOT rest on row-level dedup. It rests on two things
  // that do work: the content hash, which decides whether a file is new at all, and
  // the replace-by-(job, month) write, which makes re-importing the same data produce
  // the same table rather than a longer one. See lib/hours-feed.ts.
  //
  // What is counted here is only how many rows collapse into the storage grain, for
  // the audit record — DUPLICATE_RECORD is left in the reason vocabulary for the
  // writer, which CAN detect a true collision because it owns the unique key.
  const seen = new Set<string>();

  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    // A trailing blank row is not a fault.
    if (!row.hasValues) continue;
    rowsRead++;

    const employeeId = cellText(row.getCell(COL.employeeId).value);
    const workDate = cellDate(row.getCell(COL.workDate).value);
    const rawJob = cellText(row.getCell(COL.jobs).value);
    const machineSec = cellText(row.getCell(COL.machineSec).value);
    const fn = cellText(row.getCell(COL.fn).value);
    const hoursRaw = row.getCell(COL.hours).value;
    const hours = cellNumber(hoursRaw);
    const rawSection = `${machineSec}-${fn}`;

    const reject = (reason: UndefinedReason, label: string) => {
      rejected.push({
        month: workDate ? monthKey(workDate) : "",
        reason,
        label,
        workDate,
        employeeId,
        section: rawSection,
        hours: hours ?? 0,
        sourceRow: r,
        countsTowardKpi: COUNTED.has(reason) && wouldHaveCountedOnTheGrid(rawSection, resolve),
      });
    };

    // §42.4: date columns must contain valid dates. A row with no usable date cannot
    // be assigned to a reporting month at all (§42.6), so it is rejected rather than
    // guessed at.
    if (!workDate) {
      reject("MISSING_WORK_DATE", cellText(row.getCell(COL.workDate).value) || "(blank)");
      continue;
    }
    // §42.4: hours columns must contain valid numeric values. Non-numeric is a
    // fault; genuinely zero is not — a zero-hour row is normal in this export (the
    // file carries future-dated rows at 0h) and is simply nothing to import.
    if (hours == null) {
      reject("INVALID_HOURS", cellText(hoursRaw) || "(blank)");
      continue;
    }
    if (hours === 0) {
      zeroHourRows++;
      continue;
    }
    rowsWithHours++;

    if (!firstWorkDate || workDate < firstWorkDate) firstWorkDate = workDate;
    if (!lastWorkDate || workDate > lastWorkDate) lastWorkDate = workDate;
    const month = monthKey(workDate);
    months.add(month);

    // Negative hours are CORRECTIONS, not faults — Paylocity issues them to reverse a
    // mis-booked punch, and they must net off rather than be discarded. §42.32 asks
    // for a test of exactly this.
    // (No branch needed; they flow through as signed values. Noted so nobody "fixes"
    // it by clamping.)

    if (!machineSec || !fn) {
      reject("INVALID_LABOR_CODE", rawSection === "-" ? "(blank)" : rawSection);
      continue;
    }

    // Centralized Paylocity mapping (2026-08-20): 990/991/992/993/998 are Power BI
    // Function Hierarchy totals/control rows, never a real punch section — checked
    // ahead of every other gate below so one can never be misfiled as a job-number
    // problem or silently folded into the generic UNSUPPORTED_CATEGORY bucket.
    if (isTotalControlFunctionId(fn)) {
      reject("CONTROL_TOTAL_CODE", rawSection);
      continue;
    }

    // ── Year ownership: the anti-double-counting gate (2026-08-21) ──────────
    //
    // Several workbooks in the folder overlap — Job_Hours_2025.xlsx runs five days
    // into 2026 and repeats 587.20h of punches that Current_Job_Hours.xlsx also
    // carries. Exactly one file is authoritative per punch year (see
    // paylocity-sources.ts), and rows outside this file's owned years are dropped
    // HERE: before standardization, before the job checks, before the pool tally,
    // before aggregation. Nothing downstream ever sees them, so nothing downstream
    // can sum them twice.
    //
    // Placed after the file-level bookkeeping above, deliberately, so `monthsCovered`
    // and the work-date bounds keep describing the WHOLE file — the audit needs to
    // report each file's real span alongside what was excluded from it.
    //
    // Counted, not silently skipped: a rule that quietly discards hours is
    // indistinguishable from a bug that loses them, so the totals are reported.
    if (ownsYear && !ownsYear(workDate.getUTCFullYear())) {
      rowsExcludedByYear++;
      hoursExcludedByYear += hours;
      excludedYears.add(workDate.getUTCFullYear());
      continue;
    }

    // Everything below is scoped work; skip it for months the caller did not ask for,
    // but only AFTER the file-level bookkeeping above so the covered-months list and
    // the work-date bounds still describe the whole file.
    if (wantMonth && month !== wantMonth) continue;

    const grainKey = `${employeeId}::${workDate.toISOString().slice(0, 10)}::${rawJob}::${rawSection}`;
    if (seen.has(grainKey)) segmentsMerged++;
    else seen.add(grainKey);

    // §42.7: a job cell that is not a job number. "Not Defined", "2026 SERVICE", "".
    const jobNum = Number(rawJob);
    if (rawJob === "") {
      reject("MISSING_JOB_ID", "(blank)");
      continue;
    }
    // Two ways a cell names a job, converging on one `jobId`.
    let jobId: string;
    if (!Number.isFinite(jobNum)) {
      // A NAME, not a number. Paylocity carries standing overhead categories
      // ("2025 SERVICE", "2023_SER") that were never given a job number, and
      // every one used to be rejected right here — 871.92h of Service across four
      // years, including 781.75h whose Job row already existed (jobId 10001,
      // "2025 Service") and was simply never matched to its label.
      //
      // Resolved by NAME against the job master, never by numeric prefix: job 2026
      // IS "2026 Spare Parts", so keying on the leading 2026 would merge Service
      // hours into Spare Parts. See lib/job-label.ts.
      const byLabel = jobIdByLabel ? resolveJobLabel(rawJob, jobIdByLabel) : null;
      // A machine-suffixed number — "1037-02" is machine 02 of job 1037 — tried
      // only AFTER the name lookup, so a job genuinely named "1037-02" would
      // still win, and only when the base number is in the job master. See
      // jobNumberFromMachineSuffix for why this does not reintroduce the
      // prefix-matching hazard that rule warns about.
      const suffixBase = byLabel ? null : jobNumberFromMachineSuffix(rawJob);
      const bySuffix = suffixBase && known?.has(normalizeJobNumber(suffixBase)) ? normalizeJobNumber(suffixBase) : null;
      if (!byLabel && !bySuffix) {
        reject("JOB_NOT_FOUND", rawJob);
        continue;
      }
      jobId = byLabel ?? bySuffix!;
    } else {
      jobId = normalizeJobNumber(rawJob);
      // Numerically fine but the app has no such job. Distinct from the above: this
      // is a job that needs creating or a typo, not a Paylocity coding category.
      if (known && !known.has(jobId)) {
        reject("JOB_NOT_FOUND", rawJob);
        continue;
      }
    }

    // Pool tally from the RAW phase/function — the aliases fold warranty away and two
    // of the four pools are warranty. After the job check, so the pools use the same
    // notion of a genuine punch as everything else.
    const poolCategory = poolCategoryForPunch(machineSec, fn);
    if (poolCategory) {
      const k = `${month}::${poolCategory}`;
      poolHours.set(k, (poolHours.get(k) ?? 0) + hours);
    }

    // ── One row per raw punch, `section` IS the raw pair (2026-08-21) ────────
    //
    // Storage never rewrites a punch to fit a rule book: no alias, no fold, no
    // 10-311 30/70 split here. `rawSection` (this function's local var, above) is
    // already the untransformed "${machineSec}-${fn}" string read straight off the
    // sheet — exactly what the raw-truth rule requires `section` to hold. The ETC
    // grid's fixed-column fold (mapPunchToColumns/SECTION_ALIASES) still exists and
    // is still correct for its OWN narrow purpose — it now runs at aggregation time
    // in sync-actuals.ts (syncActualHours/syncHoursWorked) and in the ETC-month /
    // T&M drills, reading these raw rows and folding on the fly. It never touches
    // what gets stored here.
    const rawSectionId = normalizeSectionId(machineSec);
    const rawFunctionId = normalizeFunctionId(fn);
    // `section` is built from the SAME normalized halves as rawSection/rawFunction —
    // NOT from the pre-normalization `rawSection` local var above (which can read
    // "Not Defined-216" while its normalized form is really the blank-section case
    // "-216"). Building it any other way is exactly the "regenerated from a different
    // representation" mistake the raw-key rule forbids: section and the two halves
    // must describe the identical fact, always.
    rows.push({
      jobId,
      section: `${rawSectionId}-${rawFunctionId}`,
      year: workDate.getUTCFullYear(),
      month: workDate.getUTCMonth() + 1,
      date: workDate,
      hours,
      employeeId,
      rawSection: rawSectionId,
      rawFunction: rawFunctionId,
      travel: COL.travel === undefined ? "" : normalizeTravel(cellText(row.getCell(COL.travel).value)),
    });
  }

  if (rowsWithHours === 0) {
    throw new WorkbookError(
      "no_valid_rows",
      `The "${SHEET_NAME}" sheet has ${rowsRead} rows but not one carries a usable work date and hours figure. Refusing to import — the last good dataset is kept.`,
      { path, sheet: SHEET_NAME, rowsRead },
    );
  }

  return {
    identity,
    sheet: SHEET_NAME,
    rows,
    rejected,
    poolHours,
    monthsCovered: [...months].sort(),
    firstWorkDate,
    lastWorkDate,
    stats: {
      rowsRead,
      rowsWithHours,
      rowsResolved: rows.length,
      rowsRejected: rejected.length,
      segmentsMerged,
      zeroHourRows,
      rowsExcludedByYear,
      hoursExcludedByYear,
      excludedYears: [...excludedYears].sort(),
    },
  };
}

// Would this punch have landed in an ETC grid column, had its job number been
// valid? The existing headline definition of Undefined Hours depends on it — see
// KPI_COUNTED_REASONS. Kept identical to job-hours-source.ts's `wouldHaveCounted`,
// including the 10-311 special case, so the two readers cannot disagree about what
// the KPI counts.
function wouldHaveCountedOnTheGrid(rawSection: string, resolve?: (s: string) => string | null): boolean {
  if (rawSection === "10-311") return true;
  const mapped = mapPunchToColumns(rawSection, 1, resolve);
  const section = mapped[0]?.section ?? rawSection;
  return ETC_TRACKED_CODES.has(section);
}
