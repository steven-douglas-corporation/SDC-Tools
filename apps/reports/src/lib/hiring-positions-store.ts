import "server-only";
import { prisma } from "@/lib/prisma";

// The durable half of "Hiring Position -> Workforce Group -> Department"
// (2026-08-19) — raw-SQL accessed, same reason as RolePermission/
// BuildReadinessSavedView: `prisma generate` is blocked on this box while a
// server process holds node_modules/.prisma open, so HiringPositionAssignment
// has no generated Client model to call. See the model's own comment in
// schema.prisma for why a row existing at all (however null its two columns)
// means "explicitly cleared", not "never touched".

export type HiringAssignmentRow = {
  positionSourceId: string;
  workforceGroup: string | null;
  department: string | null;
  expectedStartDate: Date | null;
  isVisible: boolean;
  /** Openings this requisition represents, and how many are already hired against (2026-08-24). See schema.prisma's own comment on the pair. */
  quantity: number;
  filledCount: number;
  updatedByEmail: string | null;
  updatedAt: Date;
};

export async function getHiringAssignments(): Promise<HiringAssignmentRow[]> {
  return prisma.$queryRaw<HiringAssignmentRow[]>`
    SELECT positionSourceId, workforceGroup, department, expectedStartDate, isVisible, quantity, filledCount, updatedByEmail, updatedAt
      FROM HiringPositionAssignment
  `;
}

export async function getHiringAssignment(positionSourceId: string): Promise<HiringAssignmentRow | null> {
  const rows = await prisma.$queryRaw<HiringAssignmentRow[]>`
    SELECT positionSourceId, workforceGroup, department, expectedStartDate, isVisible, quantity, filledCount, updatedByEmail, updatedAt
      FROM HiringPositionAssignment
     WHERE positionSourceId = ${positionSourceId}
     LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function setHiringAssignment(
  positionSourceId: string,
  workforceGroup: string | null,
  department: string | null,
  actorEmail: string | null,
): Promise<void> {
  // Lists only workforceGroup/department in the UPDATE clause -- MySQL leaves
  // any unlisted column (expectedStartDate) untouched on the update branch,
  // so this can never clobber a date set via setHiringExpectedStartDate
  // below, and vice versa.
  await prisma.$executeRaw`
    INSERT INTO HiringPositionAssignment (positionSourceId, workforceGroup, department, updatedByEmail, updatedAt, createdAt)
    VALUES (${positionSourceId}, ${workforceGroup}, ${department}, ${actorEmail}, ${new Date()}, ${new Date()})
    ON DUPLICATE KEY UPDATE workforceGroup = ${workforceGroup}, department = ${department}, updatedByEmail = ${actorEmail}, updatedAt = ${new Date()}
  `;
}

/**
 * Sets/clears just the expected-start-date overlay for a workbook-sourced
 * position -- independent of setHiringAssignment above (see its own
 * comment: the UPDATE clause here lists only expectedStartDate, never
 * workforceGroup/department, so an EXISTING row's group/department -- real
 * values or an explicit Unassigned clear -- is never touched by this call).
 *
 * `currentWorkforceGroup`/`currentDepartment` matter only for the INSERT
 * branch, when this position has no HiringPositionAssignment row yet (i.e.
 * it's still on the classifier's best-effort guess, isManuallyAssigned:
 * false). Without them, creating a new row here with group/department left
 * at their column default (NULL) would make the position look explicitly
 * Unassigned the moment someone sets a date on it -- found live: the
 * classifier's guess silently disappeared the first time this was tested
 * against an auto-placed position. The caller (setHiringPositionExpectedStartDate)
 * passes the position's CURRENT effective group/department (whatever
 * hiring-positions.ts already resolved them to, manual or auto-guessed) so
 * the new row preserves exactly what was already showing, and this call
 * changes nothing about placement -- only the date.
 *
 * `expectedStartDate: null` explicitly clears it back to "unknown" (counts
 * as full-year, per workforce-capacity.ts's isStartedByMonth).
 */
export async function setHiringExpectedStartDate(
  positionSourceId: string,
  expectedStartDate: Date | null,
  currentWorkforceGroup: string | null,
  currentDepartment: string | null,
  actorEmail: string | null,
): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO HiringPositionAssignment (positionSourceId, workforceGroup, department, expectedStartDate, updatedByEmail, updatedAt, createdAt)
    VALUES (${positionSourceId}, ${currentWorkforceGroup}, ${currentDepartment}, ${expectedStartDate}, ${actorEmail}, ${new Date()}, ${new Date()})
    ON DUPLICATE KEY UPDATE expectedStartDate = ${expectedStartDate}, updatedByEmail = ${actorEmail}, updatedAt = ${new Date()}
  `;
}

/**
 * Sets the display-visibility overlay for a workbook-sourced position --
 * independent of setHiringAssignment/setHiringExpectedStartDate above (same
 * reason: the UPDATE clause here lists only isVisible, never workforceGroup/
 * department/expectedStartDate, so none of those are ever touched by this
 * call, and vice versa).
 *
 * `currentWorkforceGroup`/`currentDepartment`/`currentExpectedStartDate`
 * matter only for the INSERT branch, same as setHiringExpectedStartDate's own
 * comment explains -- without them, a position with no HiringPositionAssignment
 * row yet would have its group/department/date silently blanked the moment
 * someone hides or shows it for the first time. The caller
 * (setHiringPositionVisibility in hiring-actions.ts) passes the position's
 * CURRENT effective values for all three so this call changes nothing except
 * visibility.
 *
 * Visibility is display-only -- see HiringPositionAssignment.isVisible's
 * comment in schema.prisma. It must never be read by anything that computes
 * Open Positions/Planned Headcount/Hiring Capacity Hours.
 */
export async function setHiringPositionVisibility(
  positionSourceId: string,
  isVisible: boolean,
  currentWorkforceGroup: string | null,
  currentDepartment: string | null,
  currentExpectedStartDate: Date | null,
  actorEmail: string | null,
): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO HiringPositionAssignment (positionSourceId, workforceGroup, department, expectedStartDate, isVisible, updatedByEmail, updatedAt, createdAt)
    VALUES (${positionSourceId}, ${currentWorkforceGroup}, ${currentDepartment}, ${currentExpectedStartDate}, ${isVisible}, ${actorEmail}, ${new Date()}, ${new Date()})
    ON DUPLICATE KEY UPDATE isVisible = ${isVisible}, updatedByEmail = ${actorEmail}, updatedAt = ${new Date()}
  `;
}

// ── Positions created directly in SDC Reports (2026-08-19) ─────────────────
//
// A position's own authoritative row (see the model's comment in
// schema.prisma for why this is NOT an overlay like HiringPositionAssignment
// above) — title/status/group/department all live here and are edited in
// place.

export type CreatedHiringPositionRow = {
  id: number;
  title: string;
  jobStatus: string;
  workforceGroup: string;
  department: string;
  workLocDescription: string | null;
  remote: boolean;
  internal: boolean;
  expectedStartDate: Date | null;
  isVisible: boolean;
  /** Openings this requisition represents, and how many are already hired against (2026-08-24). */
  quantity: number;
  filledCount: number;
  createdByEmail: string | null;
  updatedByEmail: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export async function getCreatedHiringPositions(): Promise<CreatedHiringPositionRow[]> {
  return prisma.$queryRaw<CreatedHiringPositionRow[]>`
    SELECT id, title, jobStatus, workforceGroup, department, workLocDescription, remote, internal, expectedStartDate, isVisible, quantity, filledCount, createdByEmail, updatedByEmail, createdAt, updatedAt
      FROM HiringPositionCreated
     ORDER BY createdAt DESC
  `;
}

export async function getCreatedHiringPositionById(id: number): Promise<CreatedHiringPositionRow | null> {
  const rows = await prisma.$queryRaw<CreatedHiringPositionRow[]>`
    SELECT id, title, jobStatus, workforceGroup, department, workLocDescription, remote, internal, expectedStartDate, isVisible, quantity, filledCount, createdByEmail, updatedByEmail, createdAt, updatedAt
      FROM HiringPositionCreated
     WHERE id = ${id}
     LIMIT 1
  `;
  return rows[0] ?? null;
}

export type CreateHiringPositionFields = {
  title: string;
  jobStatus: string;
  workforceGroup: string;
  department: string;
  workLocDescription: string | null;
  remote: boolean;
  internal: boolean;
  expectedStartDate: Date | null;
  /** How many openings this one position represents. Validated >= 1 by the action layer before it gets here. */
  quantity: number;
  actorEmail: string | null;
};

/**
 * Insert + read-back in one transaction — LAST_INSERT_ID() is session-scoped
 * in MySQL, so the insert and the read-back must share the same connection
 * rather than each grabbing whatever connection Prisma's pool hands out next.
 */
export async function insertCreatedHiringPosition(fields: CreateHiringPositionFields): Promise<CreatedHiringPositionRow> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      INSERT INTO HiringPositionCreated
        (title, jobStatus, workforceGroup, department, workLocDescription, remote, internal, expectedStartDate, quantity, createdByEmail, updatedByEmail, createdAt, updatedAt)
      VALUES
        (${fields.title}, ${fields.jobStatus}, ${fields.workforceGroup}, ${fields.department}, ${fields.workLocDescription}, ${fields.remote}, ${fields.internal}, ${fields.expectedStartDate}, ${fields.quantity}, ${fields.actorEmail}, ${fields.actorEmail}, ${new Date()}, ${new Date()})
    `;
    const rows = await tx.$queryRaw<CreatedHiringPositionRow[]>`
      SELECT id, title, jobStatus, workforceGroup, department, workLocDescription, remote, internal, expectedStartDate, isVisible, quantity, filledCount, createdByEmail, updatedByEmail, createdAt, updatedAt
        FROM HiringPositionCreated
       WHERE id = LAST_INSERT_ID()
    `;
    return rows[0];
  });
}

export type UpdateHiringPositionFields = {
  title: string;
  jobStatus: string;
  workforceGroup: string;
  department: string;
  expectedStartDate: Date | null;
  /** Editable on an existing position, per the request. filledCount is NOT here — it moves only via setHiringFilledCount below. */
  quantity: number;
  actorEmail: string | null;
};

export async function updateCreatedHiringPosition(id: number, fields: UpdateHiringPositionFields): Promise<void> {
  // Deliberately does NOT include isVisible in this SET clause -- see
  // updateCreatedHiringPositionVisibility below. Keeping visibility out of
  // the general edit-position write path means a stale "Edit position" form
  // save can never accidentally revert a hide/show toggle someone else made.
  await prisma.$executeRaw`
    UPDATE HiringPositionCreated
       SET title = ${fields.title}, jobStatus = ${fields.jobStatus}, workforceGroup = ${fields.workforceGroup},
           department = ${fields.department}, expectedStartDate = ${fields.expectedStartDate}, quantity = ${fields.quantity},
           updatedByEmail = ${fields.actorEmail}, updatedAt = ${new Date()}
     WHERE id = ${id}
  `;
}

/**
 * Sets ONLY the display-visibility flag for a manually-created position --
 * intentionally a separate, narrow function rather than a field on
 * updateCreatedHiringPosition/UpdateHiringPositionFields (see that function's
 * comment). Visibility is display-only -- see
 * HiringPositionCreated.isVisible's comment in schema.prisma.
 */
export async function updateCreatedHiringPositionVisibility(id: number, isVisible: boolean, actorEmail: string | null): Promise<void> {
  await prisma.$executeRaw`
    UPDATE HiringPositionCreated
       SET isVisible = ${isVisible}, updatedByEmail = ${actorEmail}, updatedAt = ${new Date()}
     WHERE id = ${id}
  `;
}

// ── Openings: quantity and filled count (2026-08-24) ────────────────────────
//
// Four narrow writers rather than folding these into the general edit paths,
// for the reason already established by setHiringExpectedStartDate and
// setHiringPositionVisibility above: each ON DUPLICATE KEY UPDATE clause lists
// ONLY the columns it owns, so MySQL leaves everything else on an existing row
// untouched. That is what stops a "mark one hired" click from reverting a
// group/department assignment someone else made a moment earlier, and vice
// versa.
//
// The workbook pair takes currentWorkforceGroup/currentDepartment for the
// INSERT branch only — identical to setHiringExpectedStartDate's contract.

export async function setHiringQuantity(
  positionSourceId: string,
  quantity: number,
  currentWorkforceGroup: string | null,
  currentDepartment: string | null,
  actorEmail: string | null,
): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO HiringPositionAssignment (positionSourceId, workforceGroup, department, quantity, updatedByEmail, updatedAt, createdAt)
    VALUES (${positionSourceId}, ${currentWorkforceGroup}, ${currentDepartment}, ${quantity}, ${actorEmail}, ${new Date()}, ${new Date()})
    ON DUPLICATE KEY UPDATE quantity = ${quantity}, updatedByEmail = ${actorEmail}, updatedAt = ${new Date()}
  `;
}

export async function setHiringFilledCount(
  positionSourceId: string,
  filledCount: number,
  currentWorkforceGroup: string | null,
  currentDepartment: string | null,
  actorEmail: string | null,
): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO HiringPositionAssignment (positionSourceId, workforceGroup, department, filledCount, updatedByEmail, updatedAt, createdAt)
    VALUES (${positionSourceId}, ${currentWorkforceGroup}, ${currentDepartment}, ${filledCount}, ${actorEmail}, ${new Date()}, ${new Date()})
    ON DUPLICATE KEY UPDATE filledCount = ${filledCount}, updatedByEmail = ${actorEmail}, updatedAt = ${new Date()}
  `;
}

export async function updateCreatedHiringPositionFilledCount(id: number, filledCount: number, actorEmail: string | null): Promise<void> {
  await prisma.$executeRaw`
    UPDATE HiringPositionCreated
       SET filledCount = ${filledCount}, updatedByEmail = ${actorEmail}, updatedAt = ${new Date()}
     WHERE id = ${id}
  `;
}
