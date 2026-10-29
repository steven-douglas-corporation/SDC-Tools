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
  deleteCreatedHiringPosition,
} from "@/lib/hiring-positions-store";
import { getHiringPositionById } from "@/lib/hiring-positions";
import { logAudit } from "@/lib/audit";
import { EMPLOYEE_TEAMS } from "@/lib/employee-teams";
import { workforceGroupForCardKey, WORKFORCE_GROUPS, type WorkforceGroupKey } from "@/lib/employee-workforce-groups";
import { REQUEST_STATUS } from "@/lib/hiring-requests";

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

// ── Hire requests (2026-10-29) ──────────────────────────────────────────────
//
// What used to be "Create Position" is a manager's request for a hire: the
// recruiter files it in Paylocity, and the posting it becomes is what counts.
// See lib/hiring-requests.ts. The group is derived from the team, so the two can
// never disagree, and there is no status to pick: a request is just requested
// until it is closed (posted, or no longer needed).

export type HiringRequestInput = {
  title: string;
  /** Which team the hire is for: an employee-teams.ts schedulerCode. */
  department: string;
  /** Paylocity id of the team lead who will be the posting's hiring manager. */
  hiringManagerId: string;
  /** How many people. Omitted reads as 1. */
  quantity?: number;
  /** Needed by. */
  expectedStartDate?: Date | null;
  note?: string | null;
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

/** Title, team, hiring manager, quantity and note as stored, or the first problem with them. */
function parseHiringRequest(input: HiringRequestInput):
  | { ok: true; title: string; workforceGroup: WorkforceGroupKey; department: string; hiringManagerId: string; quantity: number; note: string | null }
  | { ok: false; error: string } {
  const title = input.title.trim();
  if (!title) return { ok: false, error: "Position title is required." };
  if (!VALID_DEPARTMENTS.has(input.department)) return { ok: false, error: `"${input.department}" isn't a known team.` };
  const workforceGroup = workforceGroupForCardKey(input.department);
  if (!ASSIGNABLE_GROUPS.has(workforceGroup)) return { ok: false, error: `"${input.department}" isn't a team a hire can be requested for.` };
  const hiringManagerId = input.hiringManagerId.trim();
  if (!/^\d{1,32}$/.test(hiringManagerId)) return { ok: false, error: "Pick the team lead who will be the hiring manager." };
  const qty = parseQuantity(input.quantity);
  if (!qty.ok) return { ok: false, error: qty.error };
  const note = input.note?.trim() || null;
  if (note && note.length > 1000) return { ok: false, error: "The note is too long — 1,000 characters at most." };
  return { ok: true, title, workforceGroup, department: input.department, hiringManagerId, quantity: qty.quantity, note };
}

/** The "Request a hire" form's write path. */
export async function createHiringRequest(input: HiringRequestInput): Promise<HiringPositionActionResult> {
  const session = await assertActionPermission("employees:hiring:assign");
  const parsed = parseHiringRequest(input);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const row = await insertCreatedHiringPosition({
    title: parsed.title,
    jobStatus: REQUEST_STATUS,
    workforceGroup: parsed.workforceGroup,
    department: parsed.department,
    workLocDescription: null,
    remote: false,
    internal: false,
    expectedStartDate: input.expectedStartDate ?? null,
    quantity: parsed.quantity,
    hiringManagerId: parsed.hiringManagerId,
    note: parsed.note,
    actorEmail: session.user.email ?? null,
  });

  const sourceId = `manual-${row.id}`;

  await logAudit({
    action: "hiring.requestCreated",
    entityType: "HiringPositionCreated",
    entityId: sourceId,
    summary: `${parsed.title}${parsed.quantity > 1 ? ` ×${parsed.quantity}` : ""}: hire requested for ${parsed.department}, hiring manager ${parsed.hiringManagerId} (by ${session.user.email ?? "unknown"})`,
    metadata: { sourceId, title: parsed.title, department: parsed.department, hiringManagerId: parsed.hiringManagerId, quantity: parsed.quantity, note: parsed.note },
  });

  return { ok: true, sourceId };
}

/** Editing a hire request. Paylocity postings aren't editable this way; their team is set with assignHiringPosition. */
export async function updateHiringRequest(sourceId: string, input: HiringRequestInput): Promise<HiringPositionActionResult> {
  const session = await assertActionPermission("employees:hiring:assign");
  const match = /^manual-(\d+)$/.exec(sourceId);
  if (!match) return { ok: false, error: "Only hire requests can be edited this way." };
  const id = Number(match[1]);

  const parsed = parseHiringRequest(input);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const before = await getHiringPositionById(sourceId);
  if (!before) return { ok: false, error: "This request no longer exists." };

  await updateCreatedHiringPositionRow(id, {
    title: parsed.title,
    jobStatus: REQUEST_STATUS,
    workforceGroup: parsed.workforceGroup,
    department: parsed.department,
    expectedStartDate: input.expectedStartDate ?? null,
    quantity: parsed.quantity,
    hiringManagerId: parsed.hiringManagerId,
    note: parsed.note,
    actorEmail: session.user.email ?? null,
  });

  await logAudit({
    action: "hiring.requestUpdated",
    entityType: "HiringPositionCreated",
    entityId: sourceId,
    summary: `${before.title}: request edited (by ${session.user.email ?? "unknown"})`,
    metadata: {
      sourceId,
      previousTitle: before.title,
      previousDepartment: before.department,
      previousHiringManagerId: before.hiringManagerIds[0] ?? null,
      previousQuantity: before.quantity,
      newTitle: parsed.title,
      newDepartment: parsed.department,
      newHiringManagerId: parsed.hiringManagerId,
      newQuantity: parsed.quantity,
    },
  });

  return { ok: true, sourceId };
}

export type CloseHiringRequestResult = { ok: true } | { ok: false; error: string };

/**
 * Closing a hire request. Two reasons, one write: it has been posted in Paylocity
 * (`postedAsJobId`, the posting the app matched it to and a person confirmed), or
 * it is no longer needed. Either way the row is removed; the audit entry keeps
 * what it said and why it closed, so a mistake can be traced and re-made.
 * Paylocity postings are refused: the app doesn't own them, and the next
 * warehouse load would bring them back.
 */
export async function closeHiringRequest(sourceId: string, postedAsJobId?: string): Promise<CloseHiringRequestResult> {
  const session = await assertActionPermission("employees:hiring:assign");
  const match = /^manual-(\d+)$/.exec(sourceId);
  if (!match) return { ok: false, error: "Only hire requests can be closed here. A Paylocity posting is closed in Paylocity." };
  const id = Number(match[1]);

  const before = await getHiringPositionById(sourceId);
  if (!before) return { ok: false, error: "This request no longer exists." };

  if (postedAsJobId !== undefined) {
    const posting = await getHiringPositionById(postedAsJobId);
    if (!posting || posting.source !== "workbook") return { ok: false, error: "That Paylocity posting isn't in the latest load any more." };
  }

  await deleteCreatedHiringPosition(id);

  const posted = postedAsJobId !== undefined;
  await logAudit({
    action: posted ? "hiring.requestPosted" : "hiring.requestWithdrawn",
    entityType: "HiringPositionCreated",
    entityId: sourceId,
    summary:
      `${before.title}${before.quantity > 1 ? ` ×${before.quantity}` : ""}: ` +
      `${posted ? `request closed, posted in Paylocity as Job ${postedAsJobId}` : "request withdrawn, no longer needed"} (by ${session.user.email ?? "unknown"})`,
    metadata: {
      sourceId,
      postedAsJobId: postedAsJobId ?? null,
      title: before.title,
      department: before.department,
      hiringManagerId: before.hiringManagerIds[0] ?? null,
      quantity: before.quantity,
      expectedStartDate: before.expectedStartDate,
      note: before.note,
      requestedAt: before.requestedAt,
      createdBy: before.createdBy,
    },
  });

  return { ok: true };
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

  // A hire request has nothing to fill (2026-10-29): it is filled in Paylocity,
  // once it is posted there.
  const manual = /^manual-(\d+)$/.exec(positionSourceId);
  if (manual) return { ok: false, error: "A hire request isn't filled here. Once it is posted, fill it in Paylocity." };
  await setHiringFilledCount(positionSourceId, filledCount, before.workforceGroup, before.department, session.user.email ?? null);

  const nowClosed = filledCount >= before.quantity;
  await logAudit({
    action: nowClosed ? "hiring.positionFilled" : "hiring.openingFilled",
    entityType: "HiringPositionAssignment",
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

  // A hire request's quantity is edited on the request itself (updateHiringRequest).
  const manual = /^manual-(\d+)$/.exec(positionSourceId);
  if (manual) return { ok: false, error: "Change how many on the request itself." };
  await setHiringQuantity(positionSourceId, parsed.quantity, before.workforceGroup, before.department, session.user.email ?? null);

  await logAudit({
    action: "hiring.quantityChanged",
    entityType: "HiringPositionAssignment",
    entityId: positionSourceId,
    summary: `${before.title}: quantity ${before.quantity} → ${parsed.quantity} (by ${session.user.email ?? "unknown"})`,
    metadata: { positionSourceId, title: before.title, previousQuantity: before.quantity, newQuantity: parsed.quantity },
  });

  return { ok: true };
}
