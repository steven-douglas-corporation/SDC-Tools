import type { TempFeed } from "@/lib/temp-punches";
import type { TempPersonSummary } from "@/lib/temp-punch-people";
import { isPaylocityId } from "@/lib/employee-row";

// ── The temp punches' findings, as plain data (2026-10-22) ───────────────────
//
// Pure: everything is passed in, so the rules can be tested without a database or a
// warehouse. lib/temp-punch-quality.ts does the reading; the Data Management panel draws
// what comes out. See that file for why the app's own reader supplies the rejections.

/** A row of "Paylocity"."TempPunch": one clock-in/out, as the report delivered it. */
export type StagingPunch = {
  sheetRow: number;
  name: string | null;
  workDate: string; // YYYY-MM-DD
  punchIn: string | null; // HH:MM
  punchOut: string | null;
  isOpen: boolean;
  hours: number | null;
  jobCode: string | null;
  sectionCode: string | null;
  functionCode: string | null;
};

export type TempFinding = {
  sheetRow: number;
  name: string;
  date: string;
  times: string;
  hours: number;
  detail: string;
};

export type FindingGroup = { count: number; hours: number; rows: TempFinding[] };

export type NameFindingKind = "no-person" | "placeholder" | "ambiguous" | "id-differs";

export type TempNameFinding = {
  name: string;
  /** The id the person's hours are filed under (a placeholder or NAME: id), if any. */
  employeeId: string | null;
  kind: NameFindingKind;
  punches: number;
  hours: number;
  firstDate: string;
  lastDate: string;
  detail: string;
};

export type TempPunchFindings = {
  /** The report has not reached the warehouse yet. */
  waiting: boolean;
  file: { name: string; modifiedAt: string; ageDays: number; stale: boolean } | null;
  punches: number;
  hours: number;
  people: number;
  /** Columns the warehouse view reads that the latest file no longer has. */
  missingColumns: string[];
  noJob: FindingGroup;
  noPhase: FindingGroup;
  jobNotFound: FindingGroup;
  open: FindingGroup;
  names: TempNameFinding[];
};

export type TempPunchQuality = TempPunchFindings & { configured: boolean; error: string | null };

/** Rows kept per finding. The counts are always complete; the lists are capped like the other checks. */
export const FINDING_ROW_LIMIT = 200;

const EMPTY_GROUP = (): FindingGroup => ({ count: 0, hours: 0, rows: [] });

function add(group: FindingGroup, f: TempFinding) {
  group.count += 1;
  group.hours = Math.round((group.hours + f.hours) * 100) / 100;
  if (group.rows.length < FINDING_ROW_LIMIT) group.rows.push(f);
}

const times = (s: Pick<StagingPunch, "punchIn" | "punchOut"> | undefined) =>
  s ? `${s.punchIn ?? "?"}–${s.punchOut ?? "no Out"}` : "";

export function tempPunchFindings(input: {
  staging: readonly StagingPunch[];
  feed: Pick<TempFeed, "rejected" | "people" | "identity" | "ageDays" | "stale" | "punchesRead"> | null;
  missingColumns: readonly string[];
}): TempPunchFindings {
  const { staging, feed } = input;
  const out: TempPunchFindings = {
    waiting: false,
    file: null,
    punches: 0,
    hours: 0,
    people: 0,
    missingColumns: [...input.missingColumns],
    noJob: EMPTY_GROUP(),
    noPhase: EMPTY_GROUP(),
    jobNotFound: EMPTY_GROUP(),
    open: EMPTY_GROUP(),
    names: [],
  };
  if (!feed) return out;

  out.file = feed.identity
    ? { name: feed.identity.fileName, modifiedAt: feed.identity.modifiedAt.toISOString(), ageDays: feed.ageDays ?? 0, stale: feed.stale }
    : null;
  out.punches = feed.punchesRead;
  out.hours = Math.round(staging.reduce((s, p) => s + (p.hours ?? 0), 0) * 100) / 100;
  out.people = feed.people.length;

  const byRow = new Map(staging.map((s) => [s.sheetRow, s]));

  // What the hours reader could not use. Its rejection IS the finding.
  for (const r of feed.rejected) {
    const s = byRow.get(r.sourceRow);
    const base = {
      sheetRow: r.sourceRow,
      name: s?.name ?? r.label,
      date: r.workDate ? r.workDate.toISOString().slice(0, 10) : (s?.workDate ?? ""),
      times: times(s),
      hours: r.hours,
    };
    // Sorted by what is actually MISSING, not by the reader's reason code: the reader checks
    // the phase before the job, so a punch with neither comes back as INVALID_LABOR_CODE, and
    // going by the code would file every no-job punch under "no phase". The staging row says
    // what the punch really lacks; the reason is only the fallback when the row is gone.
    if (r.reason === "EMPLOYEE_NOT_MAPPED") continue; // a name problem, reported under names below
    if (r.reason === "JOB_NOT_FOUND") {
      add(out.jobNotFound, { ...base, detail: `Job ${r.label} is not a job here` });
      continue;
    }
    if (s) {
      if (!s.jobCode) {
        const lacks = !s.sectionCode || !s.functionCode ? "No job and no phase" : "No job";
        add(out.noJob, { ...base, detail: s.functionCode ? `${lacks} (function ${s.functionCode})` : lacks });
      } else {
        add(out.noPhase, { ...base, detail: `Job ${s.jobCode}: ${!s.sectionCode ? "no phase" : "no function"}` });
      }
      continue;
    }
    if (r.reason === "MISSING_JOB_ID") add(out.noJob, { ...base, detail: "No job" });
    else add(out.noPhase, { ...base, detail: "No phase or function" });
  }

  // A punch with no Out carries 0 hours, so the reader never sees it. Only the staging view does.
  for (const s of staging) {
    if (!s.isOpen) continue;
    add(out.open, {
      sheetRow: s.sheetRow,
      name: s.name ?? "(no name)",
      date: s.workDate,
      times: times(s),
      hours: 0,
      detail: `Clocked in${s.punchIn ? ` ${s.punchIn}` : ""}, no clock-out${s.jobCode ? ` · job ${s.jobCode}` : " · no job"}`,
    });
  }
  const byDate = (a: TempFinding, b: TempFinding) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name);
  for (const g of [out.noJob, out.noPhase, out.jobNotFound, out.open]) g.rows.sort(byDate);

  out.names = feed.people.map(nameFinding).filter((n): n is TempNameFinding => n !== null);
  return out;
}

/** Someone worth listing under "names without a Paylocity ID", or null when they are fine. */
function nameFinding(p: TempPersonSummary): TempNameFinding | null {
  const common = { name: p.name, punches: p.punches, hours: p.hours, firstDate: p.firstDate, lastDate: p.lastDate };
  const person = p.person;
  if (person.kind === "ambiguous") {
    return {
      ...common,
      employeeId: null,
      kind: "ambiguous",
      detail: `Matches ${person.candidates.length} people here (${person.candidates.join(", ")}). Their punches are held back until the duplicate is fixed.`,
    };
  }
  if (person.kind === "unmatched") {
    return {
      ...common,
      employeeId: p.employeeId,
      kind: "no-person",
      detail: `No one by this name on the Employees page, and the refresh did not add them: it adds new temps itself, but not when someone with the same last name is already there. The hours count on the job under “${p.employeeId}”. Add them on the Employees page, or correct the name that is there.`,
    };
  }
  if (!isPaylocityId(person.employeeId)) {
    return {
      ...common,
      employeeId: person.employeeId,
      kind: "placeholder",
      detail:
        person.via === "typed-in"
          ? `Only on the typed-in timecards, as ${person.employeeId}. Add them on the Employees page with their Paylocity ID.`
          : `Filed under ${person.employeeId}, which isn't a Paylocity ID. Replace it on the Employees page with their real one.`,
    };
  }
  if (person.reportId && person.reportId !== person.employeeId) {
    return {
      ...common,
      employeeId: person.employeeId,
      kind: "id-differs",
      detail: `Paylocity's report says ${person.reportId}; this app has ${person.employeeId}. The app's is used.`,
    };
  }
  return null;
}
