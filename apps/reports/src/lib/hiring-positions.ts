import "server-only";
import { readHiringWorkbook, isOpenPosition, type HiringPositionSourceRow } from "@/lib/hiring-workbook";
import { classifyHiringPosition } from "@/lib/hiring-position-classify";
import { getHiringAssignments, getCreatedHiringPositions, type HiringAssignmentRow, type CreatedHiringPositionRow } from "@/lib/hiring-positions-store";
import { isOpenHiringStatus } from "@/lib/hiring-position-status";
import type { WorkforceGroupKey } from "@/lib/employee-workforce-groups";

// The one place the Excel source, the manual-assignment table, the
// best-effort classifier, and app-created positions all come together into
// what the Employees tab actually renders (2026-08-19). Nothing downstream of
// this file should ever read hiring-workbook.ts, hiring-position-classify.ts,
// or hiring-positions-store.ts directly — reconciliation (a manual
// assignment always wins over the classifier's guess; a workbook position
// gone from the file simply stops appearing; nothing here ever writes an
// Employee row) all happens exactly once, here.
//
// (2026-08-19, Job Status): positions are no longer filtered down to "open
// only" before being returned — a Filled/Cancelled position stays visible
// (with `isOpen: false`) so it can still be found/filtered historically, per
// the task's own "closed/filled positions should remain available
// historically". Callers that feed hiring/planned-headcount totals must
// filter on `isOpen` themselves (see WorkforceSummaryCards' caller in
// EmployeesGrid.tsx) — this file no longer does that filtering for them.

export type HiringPosition = {
  sourceId: string;
  title: string;
  status: string;
  subStatus: string | null;
  /**
   * Whether this position currently counts toward hiring/planned-headcount
   * totals. Two conditions, both required (2026-08-24): its status must read as
   * open (hiring-position-status.ts) AND it must have at least one opening left
   * unfilled. The second is what implements "only close it when ALL requested
   * openings have been filled" — and it is also the only way a WORKBOOK
   * position can ever read as filled by this app, since its status text belongs
   * to Paylocity and cannot be written here.
   */
  isOpen: boolean;
  /** How many openings this one requisition represents. Always >= 1; rows predating the quantity column read as 1. */
  quantity: number;
  /** How many of those openings have been hired against so far. 0..quantity. */
  filledCount: number;
  /**
   * quantity - filledCount, floored at 0 — the ONLY count anything downstream
   * should use for hiring totals, capacity hours or planning KPIs. A filled
   * opening is a real employee now, counted under Current capacity, so counting
   * it here too would double it into Planned.
   */
  remainingQuantity: number;
  /** "workbook" = read from Job.xlsx (Paylocity); "manual" = created inside SDC Reports (HiringPositionCreated). */
  source: "workbook" | "manual";
  workforceGroup: WorkforceGroupKey | null;
  /** A DepartmentCard key (an employee-teams.ts schedulerCode) — the SAME key EmployeesCards' own cards use, so a hiring count slots into the identical card as its real employees. */
  department: string | null;
  /** True if a person has explicitly assigned/moved this position — false means workforceGroup/department (if any) are only the classifier's best-effort guess. Always true for a manually-created position (it was assigned outright at creation). */
  isManuallyAssigned: boolean;
  /** Prorates this position's Hiring Capacity hours (workforce-capacity.ts) — null means "unknown," which counts as full-year, not zero. */
  expectedStartDate: Date | null;
  /** Display-only — never affects isOpen or any hiring/headcount/capacity total. See redactHiddenPositions below for how this is enforced against non-editors. */
  isVisible: boolean;
  functionDescription: string | null;
  sectionDescription: string | null;
  workLocDescription: string | null;
  createdDate: string | null;
  createdBy: string | null;
  modifiedBy: string | null;
  remote: boolean;
  internal: boolean;
};

export type HiringPositionsResult = {
  positions: HiringPosition[];
  /** Set only when the workbook itself couldn't be read/parsed — the page shows this instead of a card, the same fail-soft pattern tm/page.tsx uses for its own two independent sources. Manually-created positions still show even when this is set — they don't depend on the workbook being readable. */
  error: string | null;
};

/**
 * quantity/filledCount as they should be READ, from a source that may predate
 * the columns entirely (a workbook position with no overlay row at all) or
 * carry values that have drifted (a quantity later lowered below what had
 * already been filled). Clamped here, once, so nothing downstream has to think
 * about a negative remainder or a null quantity.
 */
function readOpenings(quantity: number | null | undefined, filledCount: number | null | undefined) {
  const q = Math.max(1, Math.trunc(Number(quantity ?? 1)) || 1);
  const filled = Math.min(q, Math.max(0, Math.trunc(Number(filledCount ?? 0)) || 0));
  return { quantity: q, filledCount: filled, remainingQuantity: Math.max(0, q - filled) };
}

function toWorkbookPosition(row: HiringPositionSourceRow, manual: HiringAssignmentRow | undefined): HiringPosition {
  const auto = classifyHiringPosition(row);
  const workforceGroup = manual ? (manual.workforceGroup as WorkforceGroupKey | null) : auto.workforceGroup;
  const department = manual ? manual.department : auto.department;
  const openings = readOpenings(manual?.quantity, manual?.filledCount);
  return {
    sourceId: row.sourceId,
    title: row.title,
    status: row.status,
    subStatus: row.subStatus,
    isOpen: isOpenPosition(row) && openings.remainingQuantity > 0,
    ...openings,
    source: "workbook",
    workforceGroup,
    department,
    isManuallyAssigned: !!manual,
    expectedStartDate: manual?.expectedStartDate ?? null,
    isVisible: manual?.isVisible ?? true,
    functionDescription: row.functionDescription,
    sectionDescription: row.sectionDescription,
    workLocDescription: row.workLocDescription,
    createdDate: row.createdDate,
    createdBy: row.createdBy,
    modifiedBy: row.modifiedBy,
    remote: row.remote,
    internal: row.internal,
  };
}

function toManualPosition(row: CreatedHiringPositionRow): HiringPosition {
  return {
    sourceId: `manual-${row.id}`,
    title: row.title,
    status: row.jobStatus,
    subStatus: null,
    isOpen: isOpenHiringStatus(row.jobStatus, null, false) && readOpenings(row.quantity, row.filledCount).remainingQuantity > 0,
    ...readOpenings(row.quantity, row.filledCount),
    source: "manual",
    workforceGroup: row.workforceGroup as WorkforceGroupKey,
    department: row.department,
    isManuallyAssigned: true,
    expectedStartDate: row.expectedStartDate,
    isVisible: row.isVisible,
    functionDescription: null,
    sectionDescription: null,
    workLocDescription: row.workLocDescription,
    createdDate: row.createdAt.toLocaleDateString("en-US"),
    createdBy: row.createdByEmail,
    modifiedBy: row.updatedByEmail,
    remote: row.remote,
    internal: row.internal,
  };
}

export async function getHiringPositions(): Promise<HiringPositionsResult> {
  // ── Every one of the three sources fails soft, independently (2026-08-24) ──
  //
  // The workbook read below was already guarded; these two DB reads were not,
  // so a failure in either threw straight out of here — and because
  // employees/page.tsx awaits this in a Promise.all, that took down the ENTIRE
  // Employees page, roster included.
  //
  // Found the hard way: the quantity/filledCount columns were deployed before
  // their migration was applied, so both SELECTs failed with "Unknown column
  // 'quantity'" and /employees would not load at all. The missing migration was
  // the immediate cause and is fixed by applying it — but a secondary feature
  // being unreadable should never cost the primary one, which is exactly the
  // rule page.tsx already states for its Scheduler sources ("both fail soft to
  // 'nothing extra shown', so a roster load never depends on Scheduler being
  // up"). The hiring store now follows the same rule.
  //
  // Guarded SEPARATELY rather than as one try/catch around both, because they
  // degrade differently: losing the assignments overlay only costs the manual
  // group/department corrections (the classifier's guesses still apply, so
  // positions stay usable), while losing the created-positions table costs
  // those positions outright. One combined catch would throw away both
  // whenever either failed.
  const notes: string[] = [];

  let manualRows: CreatedHiringPositionRow[] = [];
  try {
    manualRows = await getCreatedHiringPositions();
  } catch (err) {
    console.error("[hiring-positions] couldn't read created hiring positions:", err);
    notes.push("Positions created in SDC Reports couldn't be read.");
  }

  let assignments: HiringAssignmentRow[] = [];
  try {
    assignments = await getHiringAssignments();
  } catch (err) {
    console.error("[hiring-positions] couldn't read hiring assignments:", err);
    notes.push("Saved group/department assignments couldn't be read, so some positions may show an automatic placement instead.");
  }

  const manualPositions = manualRows.map(toManualPosition);

  let sourceRows: HiringPositionSourceRow[];
  try {
    sourceRows = await readHiringWorkbook();
  } catch (err) {
    notes.push(err instanceof Error ? err.message : "Couldn't read the hiring positions workbook.");
    return { positions: manualPositions, error: notes.join(" ") };
  }

  const byId = new Map(assignments.map((a) => [a.positionSourceId, a]));
  const workbookPositions = sourceRows.map((row) => toWorkbookPosition(row, byId.get(row.sourceId)));

  return { positions: [...workbookPositions, ...manualPositions], error: notes.length > 0 ? notes.join(" ") : null };
}

export async function getHiringPositionById(sourceId: string): Promise<HiringPosition | null> {
  const { positions } = await getHiringPositions();
  return positions.find((p) => p.sourceId === sourceId) ?? null;
}

/**
 * The server-side enforcement point for "users without hiring-edit
 * permission should only see positions currently marked visible" (2026-08-19)
 * — called once, in employees/page.tsx, BEFORE the array is ever handed to
 * the client component tree (EmployeesGrid.tsx and everything under it).
 * Doing this client-side instead (e.g. a `.filter()` inside a component)
 * would not be enough: the full array — including a hidden position's real
 * title — would still be serialized into the RSC/Flight payload and sit in
 * the browser's React state/DevTools regardless of what any component's own
 * render logic does with it.
 *
 * Deliberately redacts identity fields rather than removing the position
 * outright: every field business math depends on (isOpen, workforceGroup,
 * department, expectedStartDate) is left untouched, so Open Positions/
 * Planned Headcount/Hiring Capacity Hours keep summing correctly over this
 * same array regardless of visibility — only what would reveal WHICH
 * position it is gets blanked. Components that want a hidden position to
 * disappear entirely from a browsable list (HiringPositionsList.tsx,
 * EmployeesCards.tsx's per-department hiring list) filter on `isVisible`
 * themselves on top of this — safe to do client-side at that point, since
 * there's no real identity left in the payload to leak either way.
 */
export function redactHiddenPositions(positions: HiringPosition[], canSeeHidden: boolean): HiringPosition[] {
  if (canSeeHidden) return positions;
  return positions.map((p) =>
    p.isVisible
      ? p
      : {
          ...p,
          title: "Hidden position",
          functionDescription: null,
          sectionDescription: null,
          workLocDescription: null,
          createdBy: null,
          modifiedBy: null,
        },
  );
}
