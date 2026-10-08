import * as XLSX from "xlsx";
import { normalizeName } from "@/lib/employee-name-key";

// ── The Paylocity employee roster, parsed and planned (2026-09-30) ──────────
//
// The pure half of lib/paylocity-roster-sync.ts: no `fs`, no Prisma, no
// "server-only", so the rules below are unit-testable against synthetic rows
// (tests/paylocity-roster.test.ts). Same split as hiring-workbook-parse.ts.
//
// ── The file ────────────────────────────────────────────────────────────────
//
// A Paylocity report ("Report" sheet, confirmed against Employee_Information.xlsx)
// with one row per person, current and former:
//
//   Employee Id | First Name | Last Name | Job Title | Supervisor's Employee ID |
//   Is Active | Position Code | Position Job Title
//
// Position Code (2026-10-02) is optional, so an older export without it still
// imports with codes left alone. Its family comes from the PositionFamily table
// (lib/position-families-parse.ts), not from this file.
//
// ── What the sync is allowed to do ──────────────────────────────────────────
//
// ADD and UPDATE, never remove. Decided with the user on 2026-09-30, and
// amended 2026-10-02 so leavers are hidden:
//
//   • Everyone in the file ends up in the app, current and former staff alike.
//     A person NEW to the app is created HIDDEN (active = false), whatever the
//     file's Is Active says. The app's `active` flag means "shown on the boards",
//     which is an app decision rather than an employment fact — back-office
//     people are deliberately kept off the boards although Paylocity has them
//     active. So a person arrives hidden and someone turns them on.
//   • `active` changes on an existing person in ONE direction only: someone
//     shown here whom the file marks "No" is hidden (2026-10-02) — they have
//     left. Nobody is hidden for being absent from the file, and nobody hidden
//     on purpose is brought back. A pass that would hide more than half of the
//     shown roster is held (`hideHeld`) as a broken export, not applied.
//   • Supervisor, job title and position code are PAYLOCITY-OWNED: the app
//     mirrors what the file says, a blank included, and the app offers no way to
//     edit them. Change them in Paylocity.
//   • Team is set by the team rule after this plan is applied (2026-10-02) —
//     lib/team-resolution.ts, run by paylocity-roster-sync.ts on every pass —
//     from position families and the reporting line, not from this file.
//   • Name, department, discipline and billing group are never touched on an
//     existing person. Names here were curated (the outsourced rows were renamed
//     on purpose — scripts/rename-outsourced-employees.ts), and the other fields
//     have their own owners.

export class RosterFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RosterFileError";
  }
}

export type RosterFileRow = {
  paylocityId: string;
  name: string;
  /** null = blank in the file (or Paylocity's "Not Defined" placeholder). */
  positionTitle: string | null;
  /** null = blank in the file: this person has no supervisor in Paylocity. */
  supervisorPaylocityId: string | null;
  /** Paylocity's own employment status. Recorded for reports only — see above. */
  paylocityActive: boolean;
  /** null = blank in the file; undefined = the file has no Position Code column (leave codes alone). */
  positionCode?: string | null;
};

// Header matching ignores case, spacing and punctuation, so "Supervisor's
// Employee ID" matches with a straight or a curly apostrophe.
function headerKey(h: unknown): string {
  return String(h ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

const COLUMNS = {
  paylocityId: "employeeid",
  firstName: "firstname",
  lastName: "lastname",
  title: "jobtitle",
  supervisor: "supervisorsemployeeid",
  active: "isactive",
} as const;

export const REQUIRED_HEADERS = ["Employee Id", "First Name", "Last Name", "Job Title", "Supervisor's Employee ID", "Is Active"];

// The same rule scripts/reconcile-roster-against-app.ts uses: Paylocity files the
// outsourced placeholders as First = "Kedar Tarlekar", Last = "CE Outsourced", and
// the person's name is the first half alone.
export function personName(first: string, last: string): string {
  const f = first.trim();
  const l = last.trim();
  if (/outsourced/i.test(l)) return f || l;
  return `${f} ${l}`.trim();
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

// Employee ids come through as text in this report, but a re-export can make them
// numbers; "100034" and 100034 must be the same person, and "100034.0" too.
function idText(v: unknown): string {
  const s = cellText(v);
  return /^\d+\.0+$/.test(s) ? s.replace(/\.0+$/, "") : s;
}

export function parseRosterWorkbook(buf: Buffer): RosterFileRow[] {
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buf, { type: "buffer" });
  } catch (err) {
    throw new RosterFileError(`The roster file could not be opened as a workbook: ${err instanceof Error ? err.message : String(err)}`);
  }
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) throw new RosterFileError("The roster file has no sheets.");
  const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null, raw: false });
  return parseRosterGrid(grid);
}

/** The grid half of parseRosterWorkbook — header row first — so tests need no .xlsx. */
export function parseRosterGrid(grid: unknown[][]): RosterFileRow[] {
  const header = (grid[0] ?? []).map(headerKey);
  const col = {} as Record<keyof typeof COLUMNS, number>;
  const missing: string[] = [];
  (Object.keys(COLUMNS) as (keyof typeof COLUMNS)[]).forEach((k, i) => {
    const at = header.indexOf(COLUMNS[k]);
    if (at < 0) missing.push(REQUIRED_HEADERS[i]);
    col[k] = at;
  });
  if (missing.length) {
    throw new RosterFileError(`The roster file is missing column(s): ${missing.join(", ")}. Nothing was imported.`);
  }
  const codeCol = header.indexOf("positioncode"); // optional — see the header note

  const rows: RosterFileRow[] = [];
  const seen = new Set<string>();
  for (const r of grid.slice(1)) {
    const paylocityId = idText(r[col.paylocityId]);
    if (!paylocityId) continue; // blank trailing rows
    if (seen.has(paylocityId)) {
      // Two rows for one id means the report is not one-row-per-person, and
      // there is no safe way to pick which row is current.
      throw new RosterFileError(`Employee Id ${paylocityId} appears more than once in the roster file. Nothing was imported.`);
    }
    seen.add(paylocityId);
    const name = personName(cellText(r[col.firstName]), cellText(r[col.lastName]));
    if (!name) throw new RosterFileError(`Employee Id ${paylocityId} has no name in the roster file. Nothing was imported.`);
    const title = cellText(r[col.title]);
    const supervisor = idText(r[col.supervisor]);
    rows.push({
      paylocityId,
      name,
      positionTitle: title && title !== "Not Defined" ? title : null,
      supervisorPaylocityId: supervisor && supervisor !== paylocityId ? supervisor : null,
      paylocityActive: /^(yes|y|true|active|1)$/i.test(cellText(r[col.active])),
      ...(codeCol < 0 ? {} : { positionCode: cellText(r[codeCol]) || null }),
    });
  }

  if (rows.length === 0) throw new RosterFileError("The roster file has a header but no employee rows. Nothing was imported.");

  // Blanks are mirrored (a blank supervisor clears the app's), so a column that is
  // blank from top to bottom would wipe every reporting line at once. That is a
  // broken export, not an org chart.
  if (rows.every((r) => r.supervisorPaylocityId === null)) {
    throw new RosterFileError("Every Supervisor's Employee ID in the roster file is blank — that looks like a broken export. Nothing was imported.");
  }
  if (rows.every((r) => r.positionTitle === null)) {
    throw new RosterFileError("Every Job Title in the roster file is blank — that looks like a broken export. Nothing was imported.");
  }
  if (codeCol >= 0 && rows.every((r) => r.positionCode === null)) {
    throw new RosterFileError("Every Position Code in the roster file is blank — that looks like a broken export. Nothing was imported.");
  }
  return rows;
}

// ── The plan ────────────────────────────────────────────────────────────────

export type AppEmployee = {
  id: number;
  name: string;
  paylocityId: string | null;
  positionTitle: string | null;
  supervisorId: number | null;
  active: boolean;
  positionCode?: string | null;
};

export type RosterPlan = {
  /** New people, created hidden. */
  create: RosterFileRow[];
  /**
   * App rows with no Paylocity id whose name matches exactly one file row (and
   * vice versa): the id is filled in rather than creating a duplicate person.
   */
  link: { employeeId: number; name: string; paylocityId: string }[];
  titleChanges: { paylocityId: string; name: string; from: string | null; to: string | null }[];
  positionCodeChanges: { paylocityId: string; name: string; from: string | null; to: string | null }[];
  /** Shown here, "No" in Paylocity: hidden by this pass (unless hideHeld). */
  hide: { paylocityId: string; name: string }[];
  /** True when `hide` covers more than half of the shown roster — not applied. */
  hideHeld: boolean;
  /** Supervisors by Paylocity id; applied after `create` so new supervisors exist. */
  supervisorChanges: { paylocityId: string; name: string; fromName: string | null; toPaylocityId: string | null }[];
  /** File rows that name an unlinked app row ambiguously — left for a person. */
  ambiguous: { paylocityId: string; name: string; candidates: string[] }[];
  /** Supervisor ids that are neither in the app nor in the file. */
  unresolvedSupervisors: { paylocityId: string; name: string; supervisorPaylocityId: string }[];
  /** Counts for the report. */
  fileRows: number;
  fileActive: number;
  unchanged: number;
};

/**
 * `hideLeavers: false` suspends the one-way hide: someone shown here whom the
 * file marks "No" is left shown and never reaches `plan.hide`. The policy lives
 * in paylocity-roster-sync.ts (HIDE_LEAVERS); the default stays true so this
 * function's own rules are unchanged. The disagreement is still reported —
 * rosterQualityFindings lists those people as `shownButInactive`.
 */
export function planRosterSync(file: RosterFileRow[], app: AppEmployee[], opts: { hideLeavers?: boolean } = {}): RosterPlan {
  const hideLeavers = opts.hideLeavers ?? true;
  const byPid = new Map<string, AppEmployee>();
  for (const e of app) if (e.paylocityId) byPid.set(e.paylocityId, e);
  const byId = new Map(app.map((e) => [e.id, e]));

  // Unlinked app rows by name key, for the one-time link of people who were
  // entered by hand before the roster sync existed.
  const unlinkedByKey = new Map<string, AppEmployee[]>();
  for (const e of app) {
    if (e.paylocityId) continue;
    const k = normalizeName(e.name);
    unlinkedByKey.set(k, [...(unlinkedByKey.get(k) ?? []), e]);
  }
  // A file name shared by two file rows can't identify either of them.
  const fileKeyCount = new Map<string, number>();
  for (const r of file) {
    if (byPid.has(r.paylocityId)) continue;
    const k = normalizeName(r.name);
    fileKeyCount.set(k, (fileKeyCount.get(k) ?? 0) + 1);
  }

  const plan: RosterPlan = {
    create: [],
    link: [],
    titleChanges: [],
    positionCodeChanges: [],
    hide: [],
    hideHeld: false,
    supervisorChanges: [],
    ambiguous: [],
    unresolvedSupervisors: [],
    fileRows: file.length,
    fileActive: file.filter((r) => r.paylocityActive).length,
    unchanged: 0,
  };

  // Who each file row IS in the app after this pass: an existing row, a linked
  // row, or a row about to be created (null — it has no current values).
  const resolved = new Map<string, AppEmployee | null>();
  for (const r of file) {
    const existing = byPid.get(r.paylocityId);
    if (existing) {
      resolved.set(r.paylocityId, existing);
      continue;
    }
    const k = normalizeName(r.name);
    const candidates = unlinkedByKey.get(k) ?? [];
    if (candidates.length === 1 && fileKeyCount.get(k) === 1) {
      plan.link.push({ employeeId: candidates[0].id, name: candidates[0].name, paylocityId: r.paylocityId });
      resolved.set(r.paylocityId, candidates[0]);
    } else if (candidates.length > 1 || (candidates.length === 1 && (fileKeyCount.get(k) ?? 0) > 1)) {
      plan.ambiguous.push({ paylocityId: r.paylocityId, name: r.name, candidates: candidates.map((c) => `#${c.id} ${c.name}`) });
    } else {
      plan.create.push(r);
      resolved.set(r.paylocityId, null);
    }
  }

  for (const r of file) {
    if (!resolved.has(r.paylocityId)) continue; // ambiguous — not touched at all
    const current = resolved.get(r.paylocityId) ?? null;
    let changed = false;

    // New rows are created with their title, so only existing rows can change.
    if (current && (current.positionTitle?.trim() || null) !== r.positionTitle) {
      plan.titleChanges.push({ paylocityId: r.paylocityId, name: current.name, from: current.positionTitle, to: r.positionTitle });
      changed = true;
    }

    // Same for the position code — and only when the file has the column at all.
    if (current && r.positionCode !== undefined && (current.positionCode?.trim() || null) !== r.positionCode) {
      plan.positionCodeChanges.push({ paylocityId: r.paylocityId, name: current.name, from: current.positionCode ?? null, to: r.positionCode });
      changed = true;
    }

    if (r.supervisorPaylocityId && !resolved.has(r.supervisorPaylocityId) && !byPid.has(r.supervisorPaylocityId)) {
      // Named a supervisor nobody can find: leave the current one rather than
      // clearing it on the strength of a dangling reference.
      plan.unresolvedSupervisors.push({ paylocityId: r.paylocityId, name: r.name, supervisorPaylocityId: r.supervisorPaylocityId });
    } else {
      const currentSup = current?.supervisorId != null ? byId.get(current.supervisorId) ?? null : null;
      const currentSupPid = currentSup ? (currentSup.paylocityId ?? linkedPid(plan, currentSup.id)) : null;
      const same = current
        ? r.supervisorPaylocityId === null
          ? current.supervisorId === null
          : currentSupPid === r.supervisorPaylocityId
        : r.supervisorPaylocityId === null;
      if (!same) {
        plan.supervisorChanges.push({
          paylocityId: r.paylocityId,
          name: current?.name ?? r.name,
          fromName: currentSup?.name ?? null,
          toPaylocityId: r.supervisorPaylocityId,
        });
        if (current) changed = true;
      }
    }

    if (hideLeavers && current?.active && !r.paylocityActive) {
      plan.hide.push({ paylocityId: r.paylocityId, name: current.name });
      changed = true;
    }

    if (current && !changed && !plan.link.some((l) => l.paylocityId === r.paylocityId)) plan.unchanged++;
  }

  // A file that marks most of the shown roster "No" is a broken export, not a
  // layoff — the same reasoning as the all-blank-supervisors check above.
  plan.hideHeld = plan.hide.length > app.filter((e) => e.active).length / 2;

  return plan;
}

function linkedPid(plan: RosterPlan, employeeId: number): string | null {
  return plan.link.find((l) => l.employeeId === employeeId)?.paylocityId ?? null;
}

export function isEmptyPlan(p: RosterPlan): boolean {
  return p.create.length === 0 && p.link.length === 0 && p.titleChanges.length === 0 && p.positionCodeChanges.length === 0 && p.supervisorChanges.length === 0 && (p.hide.length === 0 || p.hideHeld);
}

// ── Data quality: how the roster file and the app disagree ─────────────────
//
// The Dashboard's Data Quality tab (DataQualityPanel's roster section). The sync
// deliberately leaves `active` alone, so the places where Paylocity and the app
// disagree about who is current are exactly what a person has to decide — this
// lists them rather than acting on them.

export type RosterPerson = { name: string; paylocityId: string | null; title: string | null };

export type RosterQualityFindings = {
  /** Active in Paylocity, hidden here — usually a new hire waiting for Show. */
  awaitingShow: RosterPerson[];
  /** Shown here, inactive in Paylocity — usually a leaver still on the roster. */
  shownButInactive: RosterPerson[];
  /** Shown here but absent from the file (no id, or an id it doesn't carry) — the sync can't keep them current. */
  shownNotInFile: RosterPerson[];
  ambiguous: RosterPlan["ambiguous"];
  unresolvedSupervisors: RosterPlan["unresolvedSupervisors"];
  /** What the next pass would still change — non-empty only if the sync is behind the file. */
  pending: string | null;
  fileRows: number;
  /**
   * The two AGREEING cells of Paylocity status × app visibility, for people in both
   * the file and the app. The disagreeing cells are awaitingShow / shownButInactive.
   */
  shownAndActive: number;
  hiddenAndInactive: number;
};

export function rosterQualityFindings(file: RosterFileRow[], app: AppEmployee[]): RosterQualityFindings {
  const plan = planRosterSync(file, app);
  const fileByPid = new Map(file.map((r) => [r.paylocityId, r]));
  const person = (e: AppEmployee): RosterPerson => ({ name: e.name, paylocityId: e.paylocityId, title: e.positionTitle });
  const byName = (a: RosterPerson, b: RosterPerson) => a.name.localeCompare(b.name);
  return {
    awaitingShow: app.filter((e) => !e.active && e.paylocityId && fileByPid.get(e.paylocityId)?.paylocityActive).map(person).sort(byName),
    shownButInactive: app
      .filter((e) => e.active && e.paylocityId && fileByPid.has(e.paylocityId) && !fileByPid.get(e.paylocityId)!.paylocityActive)
      .map(person)
      .sort(byName),
    shownNotInFile: app.filter((e) => e.active && (!e.paylocityId || !fileByPid.has(e.paylocityId))).map(person).sort(byName),
    ambiguous: plan.ambiguous,
    unresolvedSupervisors: plan.unresolvedSupervisors,
    pending: isEmptyPlan(plan) ? null : describePlan(plan),
    fileRows: file.length,
    shownAndActive: app.filter((e) => e.active && e.paylocityId && fileByPid.get(e.paylocityId)?.paylocityActive).length,
    hiddenAndInactive: app.filter((e) => !e.active && e.paylocityId && fileByPid.has(e.paylocityId) && !fileByPid.get(e.paylocityId)!.paylocityActive).length,
  };
}

/** One line for the refresh log and the Data Sources panel. */
export function describePlan(p: RosterPlan): string {
  const parts = [
    `${p.create.length} added (hidden)`,
    p.link.length ? `${p.link.length} linked by name` : null,
    `${p.supervisorChanges.length} supervisor${p.supervisorChanges.length === 1 ? "" : "s"}`,
    `${p.titleChanges.length} title${p.titleChanges.length === 1 ? "" : "s"} updated`,
    p.positionCodeChanges.length ? `${p.positionCodeChanges.length} position code${p.positionCodeChanges.length === 1 ? "" : "s"} updated` : null,
    p.hide.length
      ? p.hideHeld
        ? `${p.hide.length} leavers NOT hidden — more than half the shown roster, check the export`
        : `${p.hide.length} leaver${p.hide.length === 1 ? "" : "s"} hidden`
      : null,
    p.ambiguous.length ? `${p.ambiguous.length} ambiguous name${p.ambiguous.length === 1 ? "" : "s"} skipped` : null,
    p.unresolvedSupervisors.length ? `${p.unresolvedSupervisors.length} unknown supervisor id${p.unresolvedSupervisors.length === 1 ? "" : "s"}` : null,
  ].filter(Boolean);
  return `${parts.join(", ")} — ${p.fileRows} in file`;
}
