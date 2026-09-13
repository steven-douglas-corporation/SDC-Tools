// ── The department ETC completion checklist (§50) ───────────────────────────
//
// Five departments sign off that they have finished entering their ETC for a month.
// This module is the vocabulary, the permission policy and the wording — everything
// about the feature that is a decision rather than a database row.
//
// Deliberately dependency-free: no React, no Prisma, no `@/` imports. Same reason as
// lib/monthly-report-flow.ts — `tsx --test` can load it directly, the SERVER and the
// BROWSER both need it (the checklist renders one side, the submission gate the other),
// and a client component importing it cannot drag Prisma into the bundle.

// ── The five, in the order the work moves through them ──────────────────────
//
// The order is the same spine as EMPLOYEE_TEAMS and the ETC grid's phase bands:
// PM → ME → CE → build → wire.
//
// ── Electrical Build and Wire are ONE sign-off (2026-08-05, by request) ─────
//
// This shipped as six, with "Electrical Build" and "Wire" as separate boxes. They were
// merged on the same day, and the merge is the more defensible shape: EMPLOYEE_TEAMS
// already folds Machine Wiring INTO Electrical Build — one team, one code, both
// Paylocity department strings — because they are one group of people who finish
// together. Two boxes were asking one team to answer twice.
//
// The CODE stays `elec-build`. Only the label moved, which is exactly why the two are
// separate fields: a rename must never orphan a month's stored rows. (The same thing
// happened to "Build" -> "Mechanical Build" on the roster.)
//
// ── Still its own list, not derived from EMPLOYEE_TEAMS ─────────────────────
//
// These are now the first five delivery teams — but EMPLOYEE_TEAMS has seven, and MFG
// and Service do not sign off an ETC month. Deriving the checklist from it would add
// two boxes nobody can tick, and the month would never become submittable. A short
// deliberate list beats a long list filtered by a rule someone has to remember.
export type EtcDepartment = {
  /** Stored value. Stable forever — renaming a label must not orphan a month's rows. */
  code: string;
  /** The department's name. What the "submission blocked" sentence says out loud. */
  label: string;
  /**
   * The name as the TOOLBAR strip prints it.
   *
   * Three of the five are already as short as a name gets; the two that are not cost
   * 281px between them, and the strip shares a row with the month picker, View, Export
   * and — when Standards is unlocked — two more buttons. These are the ETC grid's own
   * column names for the same work (10-411 "Mech Build", 10-412 "Elec Build"), so this
   * is the app's existing vocabulary rather than an abbreviation invented for the space.
   *
   * Nothing is lost by using it: the full `label` is still what the submission blocker
   * names, what the audit log records, and what the tooltip and accessible name on each
   * checkbox say.
   */
  short: string;
  /** Longer form for the checkbox's accessible name, where "ME" alone is not a word. */
  fullName: string;
};

export const ETC_DEPARTMENTS: readonly EtcDepartment[] = [
  { code: "pm", label: "PM", short: "PM", fullName: "Project Management" },
  { code: "me", label: "ME", short: "ME", fullName: "Mechanical Engineering" },
  { code: "ce", label: "CE", short: "CE", fullName: "Controls Engineering" },
  { code: "mech-build", label: "Mechanical Build", short: "Mech Build", fullName: "Mechanical Build" },
  {
    code: "elec-build",
    label: "Electrical Build and Wire",
    short: "Elec Build & Wire",
    fullName: "Electrical Build and Machine Wiring",
  },
] as const;

const BY_CODE = new Map(ETC_DEPARTMENTS.map((d) => [d.code, d]));

/** null for anything not in the list — the actions reject rather than inventing a row. */
export function departmentByCode(code: string): EtcDepartment | null {
  return BY_CODE.get(code.trim().toLowerCase()) ?? null;
}

export function departmentLabel(code: string): string {
  return BY_CODE.get(code)?.label ?? code;
}

// ── The stored status ───────────────────────────────────────────────────────

export type DepartmentCompletion = {
  code: string;
  completed: boolean;
  /** Display-name snapshot of whoever set the CURRENT state. Null while incomplete. */
  completedBy: string | null;
  /** ISO. The client formats it — the server does not know the reader's timezone. */
  completedAt: string | null;
};

/** Every department, in order, with a row for the ones nobody has touched yet. */
export function fillDepartments(stored: Iterable<DepartmentCompletion>): DepartmentCompletion[] {
  const byCode = new Map([...stored].map((s) => [s.code, s]));
  return ETC_DEPARTMENTS.map(
    (d) => byCode.get(d.code) ?? { code: d.code, completed: false, completedBy: null, completedAt: null },
  );
}

export function incompleteDepartmentLabels(statuses: Iterable<DepartmentCompletion>): string[] {
  return fillDepartments(statuses)
    .filter((s) => !s.completed)
    .map((s) => departmentLabel(s.code));
}

// ── Permission (§50, "backend authorization must be enforced") ──────────────
//
// ── The honest state of this app's permission model ─────────────────────────
//
// A real role hierarchy exists now (see lib/permissions.ts) for the named tabs/features it
// covers, but department sign-off predates it and stays on its own narrower rule: ELT may
// toggle any department (the old ADMIN escape hatch, renamed), everything else is governed
// by ETC_DEPARTMENT_OWNERS below. §32's note records that requiring ADMIN for EVERY month
// correction "just meant corrections didn't happen" — that's still why an unconfigured
// department stays open to any signed-in user rather than defaulting to ELT-only.
//
// There is also no link from a User to an Employee. User has {email, name, role};
// Employee has {name, department} and no email. So the app cannot currently answer
// "which department does this signed-in person belong to" from data, and inventing an
// answer by fuzzy name match is how you get a manager who cannot tick their own box
// (the Scheduler grouping sync matches 48 of 52 names — the four misses would be four
// people locked out of a control that is theirs).
//
// So ownership is CONFIGURED rather than inferred, through one environment variable:
//
//     ETC_DEPARTMENT_OWNERS="pm:lisa@sdc.com|dan@sdc.com,wire:joe@sdc.com"
//
// - A department with owners listed may be toggled ONLY by those addresses (or an ADMIN).
// - A department with NO owners listed may be toggled by any signed-in user, which is
//   this app's existing grain and what keeps the feature usable the moment it ships
//   rather than after someone fills in a table.
// - Unset entirely: every department behaves as the second case.
//
// Enforced in the server action on every call, not by the checkbox's `disabled`
// attribute — the UI reads the same policy purely so it can grey out a box it already
// knows will be refused.
export const DEPARTMENT_OWNERS_ENV = "ETC_DEPARTMENT_OWNERS";

export type DepartmentOwners = ReadonlyMap<string, ReadonlySet<string>>;

/**
 * Lenient on purpose: this is hand-edited in a `.env` on a server, and a stray space or
 * a trailing comma must not silently lock every department. An entry naming a department
 * that does not exist is dropped rather than throwing — it would otherwise take the
 * whole app down at import time over a typo.
 */
export function parseDepartmentOwners(raw: string | undefined | null): DepartmentOwners {
  const out = new Map<string, Set<string>>();
  if (!raw) return out;
  for (const entry of raw.split(",")) {
    const [codeRaw, listRaw] = entry.split(":");
    if (!codeRaw || !listRaw) continue;
    const dept = departmentByCode(codeRaw);
    if (!dept) continue;
    const emails = listRaw
      .split("|")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
    if (emails.length === 0) continue;
    const set = out.get(dept.code) ?? new Set<string>();
    for (const e of emails) set.add(e);
    out.set(dept.code, set);
  }
  return out;
}

export type DepartmentActor = {
  /** Null means nobody is signed in, which is refused for every department. */
  email: string | null;
  role?: string | null;
};

export function canManageDepartment(actor: DepartmentActor, code: string, owners: DepartmentOwners): boolean {
  // Signing in is the floor, in both tiers. Everything below assumes it.
  if (!actor.email) return false;
  if (!departmentByCode(code)) return false;
  if (actor.role === "ELT") return true;
  const list = owners.get(code);
  if (!list || list.size === 0) return true; // unconfigured — the app's existing grain
  return list.has(actor.email.trim().toLowerCase());
}

/** Which of them this actor may toggle, for the UI's `disabled` attributes. */
export function manageableDepartments(actor: DepartmentActor, owners: DepartmentOwners): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const d of ETC_DEPARTMENTS) out[d.code] = canManageDepartment(actor, d.code, owners);
  return out;
}

// ── Wording ─────────────────────────────────────────────────────────────────

/** "CE", "CE and Wire", "PM, CE and Wire" — an Oxford-comma-free English list. */
export function joinLabels(labels: string[]): string {
  if (labels.length === 0) return "";
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/**
 * The submission blocker, worded exactly as §50 specifies:
 * "Submission blocked: CE and Wire have not completed their ETC review."
 *
 * Returns null when nothing is outstanding, so the caller can fall through to whatever
 * the next-most-specific blocker is.
 */
export function departmentBlockMessage(incompleteLabels: string[]): string | null {
  if (incompleteLabels.length === 0) return null;
  const verb = incompleteLabels.length === 1 ? "has" : "have";
  return `Submission blocked: ${joinLabels(incompleteLabels)} ${verb} not completed their ETC review.`;
}

// ── The submission issues, built here (§50) ─────────────────────────────────
//
// One issue per outstanding department, in the shape validateMonthlyReport pushes into
// its blocked list. It lives here, not there, for a reason worth stating: everything on
// both sides of it is testable without a database — the reader that produces the labels,
// and the readiness line that consumes them — while validateMonthlyReport itself can
// only run inside Next (its dependency chain reaches `server-only`). Leaving the
// department half inline would have left the one piece of it that decides what a manager
// sees permanently untested, sitting between two tested halves.
//
// The type is imported for its SHAPE only; `import type` is erased at build time, so
// monthly-report-flow importing joinLabels from here is not a runtime cycle.
import type { ValidationIssue } from "./monthly-report-flow";

export function departmentIssues(month: string, incompleteLabels: string[]): ValidationIssue[] {
  return incompleteLabels.map((label) => ({
    section: "Monthly ETC",
    // The month, not a job number: this issue is about the month as a whole, and a
    // rowRef naming a job would send someone to a grid row that is perfectly fine.
    rowRef: month,
    department: label,
    column: DEPARTMENT_COLUMN,
    // Says where the fix is. "Mark it complete" without saying where the control lives
    // is the dead end §26.4 exists to prevent.
    reason: `${label} has not marked its ETC review complete for ${month}. Tick its box in the checklist above the summary card.`,
  }));
}

/** "Completed by Lisa at 2:35 PM" — the line under each ticked box. */
export function completionCaption(s: DepartmentCompletion, now?: Date): string {
  if (!s.completed) return "Not complete";
  const who = s.completedBy?.trim() || "someone";
  if (!s.completedAt) return `Completed by ${who}`;
  const at = new Date(s.completedAt);
  if (Number.isNaN(at.getTime())) return `Completed by ${who}`;
  const today = now ?? new Date();
  const sameDay =
    at.getFullYear() === today.getFullYear() && at.getMonth() === today.getMonth() && at.getDate() === today.getDate();
  // The time alone on the day it happened — which is the §50 example — and the date as
  // well once it is not today, because "at 2:35 PM" on its own is a lie by Wednesday.
  const when = sameDay
    ? at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    : at.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return `Completed by ${who} at ${when}`;
}

// ── The realtime / audit key for one department-month ───────────────────────
//
// One string, built in one place, so the server's broadcast and the browser's filter
// cannot drift. Rides in the change event's `cellKey` — the same channel the grid uses
// to update a single cell without refetching the route (lib/etc-remote-values.ts).
export const DEPARTMENT_CELL_PREFIX = "deptEtcComplete__";

export function departmentCellKey(month: string, code: string): string {
  return `${DEPARTMENT_CELL_PREFIX}${month}__${code}`;
}

/** null for anything that is not one of ours — every other change event on the feed. */
export function parseDepartmentCellKey(cellKey: string | undefined): { month: string; code: string } | null {
  if (!cellKey || !cellKey.startsWith(DEPARTMENT_CELL_PREFIX)) return null;
  const rest = cellKey.slice(DEPARTMENT_CELL_PREFIX.length);
  const split = rest.indexOf("__");
  if (split <= 0) return null;
  const month = rest.slice(0, split);
  const code = rest.slice(split + 2);
  if (!departmentByCode(code)) return null;
  return { month, code };
}

/** What the audit row and the change banner say the value became. */
export function completionValueText(completed: boolean): string {
  return completed ? "Complete" : "Not complete";
}

/** The audit log's `columnName`, so a cell-history search has one term to look for. */
export const DEPARTMENT_COLUMN = "Department ETC Complete";
