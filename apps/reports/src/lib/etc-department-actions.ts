"use server";

import { auth } from "@/lib/auth";
import { isValidMonth } from "@/lib/etc";
import { recordChanges } from "@/lib/change-log";
import {
  canManageDepartment,
  departmentByCode,
  departmentCellKey,
  completionValueText,
  parseDepartmentOwners,
  DEPARTMENT_COLUMN,
  DEPARTMENT_OWNERS_ENV,
  type DepartmentCompletion,
} from "@/lib/etc-departments";
import { readDepartmentCompletions, writeDepartmentCompletion } from "@/lib/etc-department-status";

// ── Ticking a department's ETC sign-off (§50) ───────────────────────────────
//
// One action, and it is where the authorization actually happens. §50 is explicit that
// the checkbox being greyed out is not a control — "do not rely only on frontend
// disabling" — and a server action is a public HTTP endpoint whatever renders it, so
// every call re-derives the answer from the session rather than trusting anything the
// browser sent.
//
// Four gates, in the order that fails cheapest first:
//
//   1. signed in            — the floor for every action in this app
//   2. a real month         — the value goes into a WHERE and a stored key
//   3. a real department    — an unknown code would create a seventh, invisible row
//   4. may manage THIS one  — the configured owner policy (see etc-departments.ts)
//
// The audit row and the realtime broadcast are ONE call to recordChanges, which is the
// app's single place where a change is both recorded and announced. That is not
// convenience: it is what makes it impossible to ship a status change that other tabs
// can see but the audit log never heard about, which §50's audit list would otherwise
// be one forgotten line away from.

export type SetCompletionResult =
  | { ok: true; status: DepartmentCompletion }
  // Every refusal names its cause, so the checklist can say WHY a click did nothing
  // instead of silently snapping the box back.
  | { ok: false; reason: "auth" | "permission" | "month" | "department" | "error"; message: string };

export async function setDepartmentCompletion(
  month: string,
  department: string,
  // ── Absolute, never a toggle ──────────────────────────────────────────────
  //
  // The client sends the state it wants, not "flip it". From a stale view a toggle
  // produces the OPPOSITE of what was clicked — you see unticked, a colleague ticks it,
  // your click unticks it — and §50 forbids exactly that ("stale sessions must not
  // overwrite a newer completion status", "duplicate events must not create incorrect
  // status changes"). An absolute write is idempotent by construction: the second
  // delivery of the same request changes nothing and records nothing.
  completed: boolean,
): Promise<SetCompletionResult> {
  const session = await auth();
  const user = session?.user;
  if (!user) return { ok: false, reason: "auth", message: "You need to be signed in to change this." };

  if (!isValidMonth(month)) return { ok: false, reason: "month", message: `"${month}" is not a valid month.` };

  const dept = departmentByCode(department);
  if (!dept) return { ok: false, reason: "department", message: `"${department}" is not a department on this checklist.` };

  const owners = parseDepartmentOwners(process.env[DEPARTMENT_OWNERS_ENV]);
  if (!canManageDepartment({ email: user.email ?? null, role: user.role }, dept.code, owners)) {
    return {
      ok: false,
      reason: "permission",
      // Names the department rather than saying "denied": on a short checklist, which
      // one was refused is the only useful part of the message.
      message: `You are not set up to sign off ${dept.label}. Ask whoever owns that department, or an administrator.`,
    };
  }

  const userName = user.name?.trim() || user.email?.split("@")[0] || "Unknown user";
  const written = await writeDepartmentCompletion({
    month,
    department: dept.code,
    completed,
    userId: user.id ? Number(user.id) : null,
    userName,
  });
  if (!written.ok) return { ok: false, reason: "error", message: written.message };

  // Nothing moved — a re-click, or the same request delivered twice. Return the current
  // state so the caller lands on the truth, and record nothing: an audit log with an
  // entry for every no-op is one nobody can read.
  if (!written.changed) return { ok: true, status: written.status };

  // ── The audit row and the broadcast, in one call ──────────────────────────
  //
  // recordChanges covers §50's audit list without anything extra: department (rowRef),
  // report month and year (rowRef + the key), previous status, new status, user id,
  // user name, timestamp, application version, and a unique change id — those last four
  // are columns it always writes. The `cellKey` is what lets every other browser update
  // the ONE checkbox instead of refetching the route.
  await recordChanges(
    [
      {
        tab: "Monthly ETC",
        // Department and month together, because a status is only meaningful as a pair —
        // a history search for "Wire — 2026-07" is the question people actually have.
        rowRef: `${dept.label} — ${month}`,
        columnName: DEPARTMENT_COLUMN,
        previousValue: completionValueText(!completed),
        newValue: completionValueText(completed),
        changeType: "edited",
        entityType: "DepartmentEtcCompletion",
        entityId: `${month}:${dept.code}`,
        cellKey: departmentCellKey(month, dept.code),
      },
    ],
    { action: "etc.departmentCompletion" },
  );

  return { ok: true, status: written.status };
}

/**
 * The whole checklist for a month. Used by the client to resync after a refused write or
 * a reconnect, so a browser that missed an event while its SSE stream was down does not
 * sit on a stale checklist until the next navigation.
 */
export async function loadDepartmentCompletions(month: string): Promise<DepartmentCompletion[]> {
  const session = await auth();
  if (!session?.user) throw new Error("Not signed in.");
  if (!isValidMonth(month)) throw new Error(`Invalid month "${month}".`);
  return readDepartmentCompletions(month);
}
