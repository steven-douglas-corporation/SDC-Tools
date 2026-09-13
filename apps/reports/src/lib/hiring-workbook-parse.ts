import * as XLSX from "xlsx";
import { isOpenHiringStatus } from "@/lib/hiring-position-status";

// The pure half of hiring-workbook.ts — no `fs`, no "server-only", so it's
// directly unit-testable from a plain node:test file the same way this
// repo's other server-only readers split their parsing out (see
// tm-hours-classify.ts's own header for the identical constraint: a
// value-import of a `server-only`-guarded module throws unconditionally
// under `tsx --test`). hiring-workbook.ts is the thin disk-reading wrapper
// around everything here.

export const SHEET_NAME = "Report";

// Confirmed present in the live file (2026-08-19) — enough to notice a
// materially different export loudly rather than silently reading garbage.
// Every OTHER column below is read defensively (missing -> null) since a
// Paylocity report export can add/drop optional columns between runs without
// warning.
export const REQUIRED_HEADERS = ["Job ID", "Job Title", "Job Status"] as const;

export type HiringPositionSourceRow = {
  /** The workbook's own "Job ID" — the one stable identifier this whole feature is keyed on. */
  sourceId: string;
  title: string;
  status: string;
  subStatus: string | null;
  functionCode: string | null;
  functionDescription: string | null;
  sectionCode: string | null;
  sectionDescription: string | null;
  /** Free text, sparsely populated in practice — NOT reliable enough to be the sole classification signal (see hiring-position-classify.ts). */
  hiringDepartment: string | null;
  workLocDescription: string | null;
  /** Display text exactly as the workbook shows it (e.g. "08/05/2026") — not reparsed, since nothing here does date arithmetic yet. */
  createdDate: string | null;
  createdBy: string | null;
  modifiedBy: string | null;
  archived: boolean;
  archiveDate: string | null;
  remote: boolean;
  internal: boolean;
};

export type HiringWorkbookFailureStage = "file_missing" | "sheet_missing" | "headers_missing";

export class HiringWorkbookError extends Error {
  constructor(
    readonly stage: HiringWorkbookFailureStage,
    message: string,
  ) {
    super(message);
    this.name = "HiringWorkbookError";
  }
}

function cell(v: unknown): string {
  return String(v ?? "").trim();
}

function cellOrNull(v: unknown): string | null {
  const s = cell(v);
  return s.length > 0 ? s : null;
}

function boolCell(v: unknown): boolean {
  return cell(v).toLowerCase() === "yes";
}

function fullName(first: unknown, last: unknown): string | null {
  const name = [cell(first), cell(last)].filter(Boolean).join(" ");
  return name.length > 0 ? name : null;
}

/**
 * Pure parse from bytes to rows — split from readHiringWorkbook() (the actual
 * disk read, in hiring-workbook.ts) so it's directly unit-testable with a
 * real or synthetic buffer, same split as import-employee-supervisors.ts's
 * parseSupervisorExport().
 */
export function parseHiringWorkbook(buf: Buffer): HiringPositionSourceRow[] {
  const wb = XLSX.read(buf, { type: "buffer" });
  const sheetName = wb.SheetNames.includes(SHEET_NAME) ? SHEET_NAME : wb.SheetNames[0];
  if (!sheetName) throw new HiringWorkbookError("sheet_missing", "The hiring workbook has no sheets at all.");

  const sheet = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "", raw: false });

  if (rows.length > 0) {
    const headers = new Set(Object.keys(rows[0]));
    const missing = REQUIRED_HEADERS.filter((h) => !headers.has(h));
    if (missing.length > 0) {
      throw new HiringWorkbookError(
        "headers_missing",
        `The hiring workbook is missing expected column(s): ${missing.join(", ")}. It may have been replaced with a differently-shaped export.`,
      );
    }
  }

  const seen = new Set<string>();
  const out: HiringPositionSourceRow[] = [];
  for (const r of rows) {
    const sourceId = cell(r["Job ID"]);
    if (!sourceId) continue; // no stable id, nothing to track this position by
    if (seen.has(sourceId)) continue; // defensive de-dup — never trust the export to be unique on its own
    seen.add(sourceId);
    out.push({
      sourceId,
      title: cell(r["Job Title"]) || "(untitled position)",
      status: cell(r["Job Status"]),
      subStatus: cellOrNull(r["Job Sub Status"]),
      functionCode: cellOrNull(r["Function Code"]),
      functionDescription: cellOrNull(r["Function Description"]),
      sectionCode: cellOrNull(r["Section # Code"]),
      sectionDescription: cellOrNull(r["Section # Description"]),
      hiringDepartment: cellOrNull(r["Hiring Department"]),
      workLocDescription: cellOrNull(r["Work Loc Description"]),
      createdDate: cellOrNull(r["Job Created Date"]),
      createdBy: fullName(r["Job Created by User First Name"], r["Job Created by User Last Name"]),
      modifiedBy: fullName(r["Job Modified by User First Name"], r["Job Modified by User Last Name"]),
      archived: boolCell(r["Archived?"]),
      archiveDate: cellOrNull(r["Archive Date"]),
      remote: boolCell(r["Remote?"]),
      internal: boolCell(r["Internal?"]),
    });
  }
  return out;
}

// A posting can be "open" in the sense of not-yet-archived while its Job
// Status/Sub Status text already says otherwise (a recruiter marking a
// requisition Filled/Cancelled sometimes happens before the posting itself
// gets archived) — checked on BOTH signals so neither one lagging the other
// causes a filled position to keep counting as open. The actual keyword
// check is shared with HiringPositionCreated's own status vocabulary — see
// hiring-position-status.ts.
export function isOpenPosition(row: HiringPositionSourceRow): boolean {
  return isOpenHiringStatus(row.status, row.subStatus, row.archived || !!row.archiveDate);
}
