import { parseTransferCode } from "@/lib/manual-contractor-punch-parse";

// ── Contractor timecards from a file, not from code (2026-10-01) ────────────
//
// Paylocity's dynamic punch reports cannot carry temp employees at all — not a
// July/August glitch, a standing limitation. The first batch of timecards was
// hard-coded into scripts/seed-manual-contractor-punches.ts; every month after
// that would have meant editing and deploying code. This module turns a plain
// CSV transcription of the timecard screenshots into ManualContractorPunch rows
// instead (scripts/import-contractor-punches.ts writes them).
//
// The rows it produces are the seed's rows exactly — same transfer parse, same
// derived hours, same segment key — so lib/manual-contractor-hours.ts merges
// them with no change, and the official-feed suppression still applies.
//
// Pure (no Prisma, no "server-only") so the script and a node:test can load it.
//
// ── The file ────────────────────────────────────────────────────────────────
//
//   employeeName,employeeRef,paylocityId,payPeriod,workDate,in,out,transfer,note
//   Vipin Vijayan,Temp3,100600,2026-08-30..2026-09-12,2026-09-01,08:00,12:00,211/1158/10/Concord,
//
// One line per punch SEGMENT, exactly as the card prints it. The lunch gap is the
// space between two lines, so it is excluded by construction. `hours` is never a
// column: it is derived from in/out, so a typo shows up as a wrong time on the
// card, not as a plausible-looking total.

export const CSV_HEADERS = ["employeeName", "employeeRef", "paylocityId", "payPeriod", "workDate", "in", "out", "transfer", "note"] as const;
const REQUIRED = CSV_HEADERS.filter((h) => h !== "note");

export type ImportRow = {
  line: number;
  employeeName: string;
  employeeRef: string;
  paylocityId: string;
  payPeriod: string;
  workDate: string;
  transferRaw: string;
  jobNumber: string;
  machineSec: string;
  functionId: string;
  location: string;
  startTime: string;
  endTime: string;
  hours: number;
  note: string | null;
};

export type ImportIssue = { line: number; message: string };

/** Minutes since midnight for a 24h "H:MM" / "HH:MM" wall-clock time, or null. */
export function toMinutes(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** "7:05" -> "07:05", so the segment key matches however the time was typed. */
function padTime(hhmm: string): string {
  const [h, m] = hhmm.trim().split(":");
  return `${h.padStart(2, "0")}:${m}`;
}

/** Same 2dp rounding as the seed — the grain every hours column stores. */
export function segmentHours(startMinutes: number, endMinutes: number): number {
  return Math.round(((endMinutes - startMinutes) / 60) * 100) / 100;
}

/** "2026-08-30..2026-09-12" -> its two ends, or null when malformed or backwards. */
export function parsePayPeriod(raw: string): { start: string; end: string } | null {
  const m = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(raw.trim());
  if (!m || m[1] > m[2]) return null;
  return { start: m[1], end: m[2] };
}

/** True when two pay periods share at least one day. */
export function payPeriodsOverlap(a: { start: string; end: string }, b: { start: string; end: string }): boolean {
  return a.start <= b.end && b.start <= a.end;
}

/** Minimal CSV: commas, optional double-quoted fields ("Vijayan, Vipin"), "" escapes. */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/**
 * Parses and validates the whole file. Anything wrong is an ERROR and the import
 * writes nothing — a half-imported timecard is worse than none, because the
 * missing half looks like a day off. Warnings are things a human should glance at
 * but that can be legitimate (a 12-hour day).
 */
export function parseContractorCsv(text: string): { rows: ImportRow[]; errors: ImportIssue[]; warnings: ImportIssue[] } {
  const rows: ImportRow[] = [];
  const errors: ImportIssue[] = [];
  const warnings: ImportIssue[] = [];

  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const headerIdx = lines.findIndex((l) => l.trim() !== "" && !l.trim().startsWith("#"));
  if (headerIdx < 0) return { rows, errors: [{ line: 0, message: "File is empty" }], warnings };
  const header = parseCsvLine(lines[headerIdx]);
  const missing = REQUIRED.filter((h) => !header.includes(h));
  if (missing.length) {
    return { rows, errors: [{ line: headerIdx + 1, message: `Missing column(s): ${missing.join(", ")}. Expected: ${CSV_HEADERS.join(",")}` }], warnings };
  }
  const col = (cells: string[], h: string) => cells[header.indexOf(h)] ?? "";

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim() === "" || raw.trim().startsWith("#")) continue;
    const line = i + 1;
    const cells = parseCsvLine(raw);
    const get = (h: string) => col(cells, h);
    const fail = (message: string) => errors.push({ line, message });

    const blank = REQUIRED.filter((h) => get(h) === "");
    if (blank.length) { fail(`Blank ${blank.join(", ")}`); continue; }

    const workDate = get("workDate");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(workDate) || Number.isNaN(Date.parse(`${workDate}T00:00:00Z`))) {
      fail(`workDate "${workDate}" must be YYYY-MM-DD`); continue;
    }
    const s = toMinutes(get("in"));
    const e = toMinutes(get("out"));
    if (s == null || e == null) { fail(`in/out "${get("in")}"-"${get("out")}" must be 24h HH:MM`); continue; }
    if (e <= s) { fail(`Segment ${get("in")}-${get("out")} is not positive — check the transcription (overnight shifts must be split at midnight)`); continue; }

    const parsed = parseTransferCode(get("transfer"));
    if (!parsed) { fail(`Unparseable transfer "${get("transfer")}" — expected FUNCTION/JOB/PHASE[/LOCATION]`); continue; }

    rows.push({
      line,
      employeeName: get("employeeName"),
      employeeRef: get("employeeRef"),
      paylocityId: get("paylocityId"),
      payPeriod: get("payPeriod"),
      workDate,
      transferRaw: get("transfer"),
      jobNumber: parsed.jobNumber,
      machineSec: parsed.machineSec,
      functionId: parsed.functionId,
      location: parsed.location,
      startTime: padTime(get("in")),
      endTime: padTime(get("out")),
      hours: segmentHours(s, e),
      note: get("note") || null,
    });
  }

  // Cross-row checks, per employee and day.
  const byDay = new Map<string, ImportRow[]>();
  for (const r of rows) {
    const k = `${r.paylocityId}|${r.workDate}`;
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k)!.push(r);
  }
  for (const segs of byDay.values()) {
    const sorted = [...segs].sort((a, b) => a.startTime.localeCompare(b.startTime));
    for (let j = 1; j < sorted.length; j++) {
      const prev = sorted[j - 1];
      const cur = sorted[j];
      if (cur.startTime === prev.startTime && cur.endTime === prev.endTime && cur.transferRaw === prev.transferRaw) {
        errors.push({ line: cur.line, message: `Duplicate of line ${prev.line} (${cur.employeeName} ${cur.workDate} ${cur.startTime}-${cur.endTime})` });
      } else if (cur.startTime < prev.endTime) {
        errors.push({ line: cur.line, message: `Overlaps line ${prev.line}: ${cur.employeeName} ${cur.workDate} ${prev.startTime}-${prev.endTime} and ${cur.startTime}-${cur.endTime}` });
      }
    }
    const total = segs.reduce((t, r) => t + r.hours, 0);
    if (total > 12) warnings.push({ line: sorted[0].line, message: `${sorted[0].employeeName} ${sorted[0].workDate}: ${total.toFixed(2)}h in one day` });
  }

  // Pay periods: every punch must sit inside the card it was copied from, and one
  // employee's cards must not overlap — two screenshots covering the same dates
  // would otherwise put the same day in twice under two different payPeriod labels.
  const periodsById = new Map<string, Map<string, { start: string; end: string; line: number }>>();
  for (const r of rows) {
    const p = parsePayPeriod(r.payPeriod);
    if (!p) { errors.push({ line: r.line, message: `payPeriod "${r.payPeriod}" must be YYYY-MM-DD..YYYY-MM-DD` }); continue; }
    if (r.workDate < p.start || r.workDate > p.end) {
      errors.push({ line: r.line, message: `workDate ${r.workDate} is outside its pay period ${r.payPeriod}` });
    }
    if (!periodsById.has(r.paylocityId)) periodsById.set(r.paylocityId, new Map());
    const mine = periodsById.get(r.paylocityId)!;
    if (!mine.has(r.payPeriod)) mine.set(r.payPeriod, { ...p, line: r.line });
  }
  for (const [id, periods] of periodsById) {
    const list = [...periods.entries()].sort((a, b) => a[1].start.localeCompare(b[1].start));
    for (let j = 1; j < list.length; j++) {
      if (list[j][1].start <= list[j - 1][1].end) {
        errors.push({ line: list[j][1].line, message: `paylocityId ${id}: pay periods ${list[j - 1][0]} and ${list[j][0]} overlap` });
      }
    }
  }

  // One id must mean one person within the file, or the dedup against the
  // official feed would compare against the wrong employee.
  const nameById = new Map<string, ImportRow>();
  for (const r of rows) {
    const seen = nameById.get(r.paylocityId);
    if (!seen) nameById.set(r.paylocityId, r);
    else if (seen.employeeName !== r.employeeName) {
      errors.push({ line: r.line, message: `paylocityId ${r.paylocityId} is "${r.employeeName}" here but "${seen.employeeName}" on line ${seen.line}` });
    }
  }

  return { rows, errors, warnings };
}
