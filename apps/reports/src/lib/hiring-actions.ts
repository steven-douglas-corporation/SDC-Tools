"use server";

import { assertActionPermission } from "@/lib/require-permission";
import {
  setHiringAssignment,
  setHiringExpectedStartDate,
  setHiringPositionVisibility as setHiringPositionVisibilityRow,
  insertCreatedHiringPosition,
  updateCreatedHiringPosition as updateCreatedHiringPositionRow,
  updateCreatedHiringPositionVisibility,
  setHiringQuantity,
  setHiringFilledCount,
  updateCreatedHiringPositionFilledCount,
} from "@/lib/hiring-positions-store";
import { getHiringPositionById } from "@/lib/hiring-positions";
import { logAudit } from "@/lib/audit";
import { EMPLOYEE_TEAMS } from "@/lib/employee-teams";
import { workforceGroupForCardKey, WORKFORCE_GROUPS, type WorkforceGroupKey } from "@/lib/employee-workforce-groups";
import { MANUAL_JOB_STATUSES, DEFAULT_MANUAL_JOB_STATUS, isManualJobStatus } from "@/lib/hiring-position-status";

// The write paths for hiring positions (2026-08-19) — `employees:hiring:assign`
// gates all of them (create/edit/move), same permission key as before this
// feature, just broader scope now. Every call is audited via the existing
// AuditLog (logAudit) — no separate hiring-specific audit table.

const VALID_GROUPS = new Set(WORKFORCE_GROUPS.map((g) => g.key));
const ASSIGNABLE_GROUPS = new Set(WORKFORCE_GROUPS.filter((g) => g.key !== "other").map((g) => g.key));
const VALID_DEPARTMENTS = new Set(EMPLOYEE_TEAMS.map((t) => t.schedulerCode));

export type AssignHiringPositionResult = { ok: true } | { ok: false; error: string };

/**
 * `department` implies its own workforce group (a department belongs to
 * exactly one group — employee-workforce-groups.ts) — the caller only ever
 * needs to pass ONE of {group-only, department}, never both independently,
 * so there is no way to submit a group/department pair that disagree with
 * each other. Passing both `null` explicitly clears the position back to
 * Unassigned (a real write — see the model's own comment on why that differs
 * from never having a row at all).
 *
 * Workbook-sourced positions ONLY — a manually-created position's group/
 * department live directly on its own HiringPositionCreated row (there is no
 * external source to overlay), so it's edited via updateHiringPosition
 * instead. Rejected here rather than silently writing a useless
 * HiringPositionAssignment row a manual position would never consult.
 */
export async function assignHiringPosition(
  positionSourceId: string,
  target: { workforceGroup: WorkforceGroupKey | null; department: string | null },
): Promise<AssignHiringPositionResult> {
  const session = await assertActionPermission("employees:hiring:assign");
  if (!positionSourceId) return { ok: false, error: "Missing position." };
  if (positionSourceId.startsWith("manual-")) return { ok: false, error: "This position was created in SDC Reports — edit it directly instead of moving it." };

  const { department } = target;
  let { workforceGroup } = target;
  if (department) {
    if (!VALID_DEPARTMENTS.has(department)) return { ok: false, error: `"${department}" isn't a known department.` };
    workforceGroup = workforceGroupForCardKey(department); // department is authoritative over whatever group was also passed
  } else if (workforceGroup && !VALID_GROUPS.has(workforceGroup)) {
    return { ok: false, error: `"${workforceGroup}" isn't a known workforce group.` };
  }

  const before = await getHiringPositionById(positionSourceId);
  if (!before) return { ok: false, error: "This position is no longer open — it may have been filled or removed from the workbook." };

  await setHiringAssignment(positionSourceId, workforceGroup, department, session.user.email ?? null);

  await logAudit({
    action: "hiring.positionAssigned",
    entityType: "HiringPositionAssignment",
    entityId: positionSourceId,
    summary: `${before.title}: ${before.workforceGroup ?? "Unassigned"}/${before.department ?? "—"} → ${workforceGroup ?? "Unassigned"}/${department ?? "—"} (by ${session.user.email ?? "unknown"})`,
    metadata: {
      positionSourceId,
      title: before.title,
      previousWorkforceGroup: before.workforceGroup,
      previousDepartment: before.department,
      newWorkforceGroup: workforceGroup,
      newDepartment: department,
    },
  });

  return { ok: true };
}

export type SetHiringExpectedStartDateResult = { ok: true } | { ok: false; error: string };

/**
 * Workbook-sourced positions ONLY, same reason as assignHiringPosition above
 * — a manual position's expected start date lives directly on its own
 * HiringPositionCreated row, edited via updateHiringPosition instead. `date:
 * null` explicitly clears it back to "unknown" (full-year, not zero — see
 * workforce-capacity.ts's isStartedByMonth).
 */
export async function setHiringPositionExpectedStartDate(positionSourceId: string, date: Date | null): Promise<SetHiringExpectedStartDateResult> {
  const session = await assertActionPermission("employees:hiring:assign");
  if (!positionSourceId) return { ok: false, error: "Missing position." };
  if (positionSourceId.startsWith("manual-")) return { ok: false, error: "This position was created in SDC Reports — edit it directly instead." };

  const before = await getHiringPositionById(positionSourceId);
  if (!before) return { ok: false, error: "This position is no longer open — it may have been filled or removed from the workbook." };

  // The position's CURRENT effective group/department (manual or still just
  // the classifier's best-effort guess) -- so if this position has no
  // HiringPositionAssignment row yet, creating one here for the date alone
  // doesn't also blank out its placement. See
  // setHiringExpectedStartDate's own comment.
  await setHiringExpectedStartDate(positionSourceId, date, before.workforceGroup, before.department, session.user.email ?? null);

  await logAudit({
    action: "hiring.expectedStartDateSet",
    entityType: "HiringPositionAssignment",
    entityId: positionSourceId,
    summary: `${before.title}: expected start ${before.expectedStartDate?.toLocaleDateString("en-US") ?? "—"} → ${date?.toLocaleDateString("en-US") ?? "—"} (by ${session.user.email ?? "unknown"})`,
    metadata: {
      positionSourceId,
      title: before.title,
      previousExpectedStartDate: before.expectedStartDate,
      newExpectedStartDate: date,
    },
  });

  return { ok: true };
}

export type SetHiringPositionVisibilityResult = { ok: true } | { ok: false; error: string };

/**
 * Workbook-sourced positions ONLY, same reason as assignHiringPosition/
 * setHiringPositionExpectedStartDate above — a manual position's visibility
 * is set via setCreatedHiringPositionVisibility instead.
 *
 * Display-only: does not touch isOpen/status, so this never affects Open
 * Positions, Planned Headcount, Hiring Capacity Hours, or any workforce-
 * group/department hiring total — see redactHiddenPositions in
 * hiring-positions.ts for how hiding actually takes effect (identity
 * redaction for non-editors, never a change to the position's own data).
 */
export async function setHiringPositionVisibility(positionSourceId: string, isVisible: boolean): Promise<SetHiringPositionVisibilityResult> {
  const session = await assertActionPermission("employees:hiring:assign");
  if (!positionSourceId) return { ok: false, error: "Missing position." };
  if (positionSourceId.startsWith("manual-")) return { ok: false, error: "This position was created in SDC Reports — use its own Hide/Show control instead." };

  const before = await getHiringPositionById(positionSourceId);
  if (!before) return { ok: false, error: "This position is no longer open — it may have been filled or removed from the workbook." };

  // Current effective group/department/date -- so a first-ever
  // HiringPositionAssignment row created here for visibility alone doesn't
  // also blank them. See setHiringPositionVisibility's own comment in
  // hiring-positions-store.ts.
  await setHiringPositionVisibilityRow(positionSourceId, isVisible, before.workforceGroup, before.department, before.expectedStartDate, session.user.email ?? null);

  await logAudit({
    action: "hiring.visibilityChanged",
    entityType: "HiringPositionAssignment",
    entityId: positionSourceId,
    summary: `${before.title}: ${before.isVisible ? "Shown" : "Hidden"} → ${isVisible ? "Shown" : "Hidden"} (by ${session.user.email ?? "unknown"})`,
    metadata: {
      positionSourceId,
      title: before.title,
      previousIsVisible: before.isVisible,
      newIsVisible: isVisible,
    },
  });

  return { ok: true };
}

/** Manually-created positions ONLY — see setHiringPositionVisibility's comment above. */
export async function setCreatedHiringPositionVisibility(sourceId: string, isVisible: boolean): Promise<SetHiringPositionVisibilityResult> {
  const session = await assertActionPermission("employees:hiring:assign");
  const match = /^manual-(\d+)$/.exec(sourceId);
  if (!match) return { ok: false, error: "Only positions created in SDC Reports can be hidden this way." };
  const id = Number(match[1]);

  const before = await getHiringPositionById(sourceId);
  if (!before) return { ok: false, error: "This position no longer exists." };

  await updateCreatedHiringPositionVisibility(id, isVisible, session.user.email ?? null);

  await logAudit({
    action: "hiring.visibilityChanged",
    entityType: "HiringPositionCreated",
    entityId: sourceId,
    summary: `${before.title}: ${before.isVisible ? "Shown" : "Hidden"} → ${isVisible ? "Shown" : "Hidden"} (by ${session.user.email ?? "unknown"})`,
    metadata: {
      sourceId,
      title: before.title,
      previousIsVisible: before.isVisible,
      newIsVisible: isVisible,
    },
  });

  return { ok: true };
}

export type HiringPositionFormInput = {
  title: string;
  jobStatus: string;
  workforceGroup: WorkforceGroupKey;
  department: string;
  workLocDescription?: string | null;
  remote?: boolean;
  internal?: boolean;
  expectedStartDate?: Date | null;
  /** Openings this one position represents (2026-08-24). Omitted reads as 1, so an older caller keeps today's behaviour. */
  quantity?: number;
};

export type HiringPositionActionResult = { ok: true; sourceId: string } | { ok: false; error: string };

/**
 * Quantity as a whole number >= 1, or an error message (2026-08-24).
 *
 * Validated SERVER-side even though the form's <input type="number"> already
 * carries min/step: the number input is a hint to the browser, not a
 * constraint on what reaches a server action, and "2.5 Mechanical Engineers"
 * or "-1" would otherwise land in the column and skew every hiring total that
 * multiplies by it. Rejects rather than silently rounding — a request for 2.5
 * people is a mistake worth telling someone about, not one to quietly reinterpret.
 */
function parseQuantity(value: number | undefined): { ok: true; quantity: number } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, quantity: 1 };
  if (!Number.isFinite(value)) return { ok: false, error: "Quantity must be a number." };
  if (!Number.isInteger(value)) return { ok: false, error: "Quantity must be a whole number — you cannot hire part of a person." };
  if (value < 1) return { ok: false, error: "Quantity must be at least 1." };
  if (value > 999) return { ok: false, error: "Quantity looks wrong — 999 is the maximum." };
  return { ok: true, quantity: value };
}

function validateGroupDepartment(workforceGroup: string, department: string): string | null {
  if (!ASSIGNABLE_GROUPS.has(workforceGroup as WorkforceGroupKey)) return `"${workforceGroup}" isn't a valid workforce group.`;
  if (!VALID_DEPARTMENTS.has(department)) return `"${department}" isn't a known department.`;
  if (workforceGroupForCardKey(department) !== workforceGroup) return `"${department}" doesn't belong to the ${workforceGroup} group.`;
  return null;
}

/** The "+ Create Position" drawer's write path — see HiringPositionCreated's own comment in schema.prisma for why this is a real table, not a write into Job.xlsx. */
export async function createHiringPosition(input: HiringPositionFormInput): Promise<HiringPositionActionResult> {
  const session = await assertActionPermission("employees:hiring:assign");

  const title = input.title.trim();
  if (!title) return { ok: false, error: "Position Title is required." };

  const jobStatus = input.jobStatus.trim() || DEFAULT_MANUAL_JOB_STATUS;
  if (!isManualJobStatus(jobStatus)) return { ok: false, error: `Job Status must be one of: ${MANUAL_JOB_STATUSES.join(", ")}.` };

  const groupDeptError = validateGroupDepartment(input.workforceGroup, input.department);
  if (groupDeptError) return { ok: false, error: groupDeptError };

  const qty = parseQuantity(input.quantity);
  if (!qty.ok) return { ok: false, error: qty.error };

  const row = await insertCreatedHiringPosition({
    title,
    jobStatus,
    workforceGroup: input.workforceGroup,
    department: input.department,
    workLocDescription: input.workLocDescription?.trim() || null,
    remote: !!input.remote,
    internal: !!input.internal,
    expectedStartDate: input.expectedStartDate ?? null,
    quantity: qty.quantity,
    actorEmail: session.user.email ?? null,
  });

  const sourceId = `manual-${row.id}`;

  await logAudit({
    action: "hiring.positionCreated",
    entityType: "HiringPositionCreated",
    entityId: sourceId,
    summary: `${title}${qty.quantity > 1 ? ` ×${qty.quantity}` : ""}: created as ${jobStatus} · ${input.workforceGroup} · ${input.department} (by ${session.user.email ?? "unknown"})`,
    metadata: { sourceId, title, jobStatus, workforceGroup: input.workforceGroup, department: input.department, quantity: qty.quantity },
  });

  return { ok: true, sourceId };
}

/** Editing a manually-created position — title/status/group/department all live directly on its row (see createHiringPosition's comment). Workbook-sourced positions aren't editable this way; use assignHiringPosition for their group/department. */
export async function updateHiringPosition(sourceId: string, input: HiringPositionFormInput): Promise<HiringPositionActionResult> {
  const session = await assertActionPermission("employees:hiring:assign");
  const match = /^manual-(\d+)$/.exec(sourceId);
  if (!match) return { ok: false, error: "Only positions created in SDC Reports can be edited this way." };
  const id = Number(match[1]);

  const title = input.title.trim();
  if (!title) return { ok: false, error: "Position Title is required." };

  const jobStatus = input.jobStatus.trim();
  if (!isManualJobStatus(jobStatus)) return { ok: false, error: `Job Status must be one of: ${MANUAL_JOB_STATUSES.join(", ")}.` };

  const groupDeptError = validateGroupDepartment(input.workforceGroup, input.department);
  if (groupDeptError) return { ok: false, error: groupDeptError };

  const before = await getHiringPositionById(sourceId);
  if (!before) return { ok: false, error: "This position no longer exists." };

  const qty = parseQuantity(input.quantity ?? before.quantity);
  if (!qty.ok) return { ok: false, error: qty.error };
  // Lowering quantity below what has already been hired would leave the row
  // claiming more people were filled than were ever asked for. readOpenings()
  // in hiring-positions.ts clamps that on read so nothing breaks, but the
  // number someone typed would silently not be what they got — better to say so.
  if (qty.quantity < before.filledCount) {
    return {
      ok: false,
      error: `Quantity can't be lower than the ${before.filledCount} opening${before.filledCount === 1 ? "" : "s"} already filled on this position.`,
    };
  }

  await updateCreatedHiringPositionRow(id, {
    title,
    jobStatus,
    workforceGroup: input.workforceGroup,
    department: input.department,
    expectedStartDate: input.expectedStartDate ?? null,
    quantity: qty.quantity,
    actorEmail: session.user.email ?? null,
  });

  await logAudit({
    action: "hiring.positionUpdated",
    entityType: "HiringPositionCreated",
    entityId: sourceId,
    summary: `${before.title}: ${before.status} · ${before.workforceGroup ?? "—"}/${before.department ?? "—"} → ${jobStatus} · ${input.workforceGroup}/${input.department} (by ${session.user.email ?? "unknown"})`,
    metadata: {
      sourceId,
      previousTitle: before.title,
      previousJobStatus: before.status,
      previousWorkforceGroup: before.workforceGroup,
      previousDepartment: before.department,
      newTitle: title,
      newJobStatus: jobStatus,
      newWorkforceGroup: input.workforceGroup,
      newDepartment: input.department,
      previousQuantity: before.quantity,
      newQuantity: qty.quantity,
    },
  });

  return { ok: true, sourceId };
}

// ── Openings: hiring against a position, and changing how many it asks for ──
//
// Unlike every other write above, these two take BOTH sources in one entry
// point rather than a workbook/manual pair. The reason is that the caller here
// is a stepper on a position card, and which table backs that card is an
// implementation detail the component has no business branching on — whereas
// assign/visibility genuinely mean different things for the two sources (a
// workbook position's group is a guess being corrected; a manual one's is the
// record itself). Openings mean exactly the same thing either way.

export type SetHiringOpeningsResult = { ok: true } | { ok: false; error: string };

/**
 * Records that `filledCount` of this position's openings have now been hired.
 *
 * This is the "hire one against a Quantity 2 position and the requirement
 * becomes 1" path. It deliberately does NOT create an Employee row: nothing in
 * this app links a requisition to the person hired against it, and inventing
 * that link here would mean guessing at a name, a department and a start date.
 * So the two stay independent — you add the new hire on the Employees tab as
 * you do today, and mark the opening filled here.
 *
 * When filledCount reaches quantity the position stops being open (see
 * hiring-positions.ts's isOpen) and drops out of every hiring total. That is
 * the request's "only mark it completely filled when ALL openings are filled" —
 * and for a workbook position it is the ONLY way this app can express filled at
 * all, since the status text belongs to Paylocity.
 */
export async function setHiringFilled(positionSourceId: string, filledCount: number): Promise<SetHiringOpeningsResult> {
  const session = await assertActionPermission("employees:hiring:assign");
  if (!positionSourceId) return { ok: false, error: "Missing position." };

  const before = await getHiringPositionById(positionSourceId);
  if (!before) return { ok: false, error: "This position no longer exists." };

  if (!Number.isInteger(filledCount)) return { ok: false, error: "Filled count must be a whole number." };
  if (filledCount < 0) return { ok: false, error: "Filled count can't be negative." };
  if (filledCount > before.quantity) {
    return { ok: false, error: `This position only has ${before.quantity} opening${before.quantity === 1 ? "" : "s"} — you can't fill more than that. Raise Quantity first.` };
  }
  if (filledCount === before.filledCount) return { ok: true }; // nothing to do, and nothing worth auditing

  const manual = /^manual-(\d+)$/.exec(positionSourceId);
  if (manual) {
    await updateCreatedHiringPositionFilledCount(Number(manual[1]), filledCount, session.user.email ?? null);
  } else {
    await setHiringFilledCount(positionSourceId, filledCount, before.workforceGroup, before.department, session.user.email ?? null);
  }

  const nowClosed = filledCount >= before.quantity;
  await logAudit({
    action: nowClosed ? "hiring.positionFilled" : "hiring.openingFilled",
    entityType: manual ? "HiringPositionCreated" : "HiringPositionAssignment",
    entityId: positionSourceId,
    summary:
      `${before.title}: ${before.filledCount} → ${filledCount} of ${before.quantity} opening${before.quantity === 1 ? "" : "s"} filled` +
      `${nowClosed ? " — position now fully filled" : ""} (by ${session.user.email ?? "unknown"})`,
    metadata: {
      positionSourceId,
      title: before.title,
      quantity: before.quantity,
      previousFilledCount: before.filledCount,
      newFilledCount: filledCount,
      fullyFilled: nowClosed,
    },
  });

  return { ok: true };
}

/**
 * Changes how many openings a position asks for, for EITHER source. A manual
 * position's quantity also travels through updateHiringPosition (the edit
 * form); this exists so a workbook position — which has no edit form, only
 * overlay controls — can have one too, and so the stepper on a card can change
 * it without submitting a whole form.
 */
export async function setHiringPositionQuantity(positionSourceId: string, quantity: number): Promise<SetHiringOpeningsResult> {
  const session = await assertActionPermission("employees:hiring:assign");
  if (!positionSourceId) return { ok: false, error: "Missing position." };

  const parsed = parseQuantity(quantity);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const before = await getHiringPositionById(positionSourceId);
  if (!before) return { ok: false, error: "This position no longer exists." };

  if (parsed.quantity < before.filledCount) {
    return {
      ok: false,
      error: `Quantity can't be lower than the ${before.filledCount} opening${before.filledCount === 1 ? "" : "s"} already filled on this position.`,
    };
  }
  if (parsed.quantity === before.quantity) return { ok: true };

  const manual = /^manual-(\d+)$/.exec(positionSourceId);
  if (manual) {
    // Reuses the full edit write path rather than adding a quantity-only
    // UPDATE for this table: a manual position owns all its fields, so passing
    // its current values back is not a clobber risk, and it keeps one SET
    // clause for this row instead of two that could drift.
    await updateCreatedHiringPositionRow(Number(manual[1]), {
      title: before.title,
      jobStatus: before.status,
      workforceGroup: before.workforceGroup ?? "",
      department: before.department ?? "",
      expectedStartDate: before.expectedStartDate,
      quantity: parsed.quantity,
      actorEmail: session.user.email ?? null,
    });
  } else {
    await setHiringQuantity(positionSourceId, parsed.quantity, before.workforceGroup, before.department, session.user.email ?? null);
  }

  await logAudit({
    action: "hiring.quantityChanged",
    entityType: manual ? "HiringPositionCreated" : "HiringPositionAssignment",
    entityId: positionSourceId,
    summary: `${before.title}: quantity ${before.quantity} → ${parsed.quantity} (by ${session.user.email ?? "unknown"})`,
    metadata: { positionSourceId, title: before.title, previousQuantity: before.quantity, newQuantity: parsed.quantity },
  });

  return { ok: true };
}
