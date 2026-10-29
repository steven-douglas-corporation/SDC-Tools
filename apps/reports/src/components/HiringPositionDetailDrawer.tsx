"use client";

import { BuildReadinessDrawer } from "@/components/build-readiness/BuildReadinessDrawer";
import { HiringMoveToControl } from "@/components/HiringMoveToControl";
import { HiringExpectedStartDateControl } from "@/components/HiringExpectedStartDateControl";
import { HiringOpeningsControl } from "@/components/HiringOpeningsControl";
import { HiringRequestForm } from "@/components/HiringRequestForm";
import { workforceGroupTitle, type WorkforceGroupKey } from "@/lib/employee-workforce-groups";
import { EMPLOYEE_TEAMS } from "@/lib/employee-teams";
import { isOpenHiringStatus } from "@/lib/hiring-position-status";
import { waitingLabel, type TeamLead } from "@/lib/hiring-requests";
import { HiringStatusPill } from "@/components/HiringStatusPill";
import type { HiringPosition } from "@/lib/hiring-positions";

// Level 3 for a hiring position (2026-08-19). Two modes, by `position.source`:
//
// - "workbook": a Paylocity posting. Read-only fields from the warehouse, plus
//   the overlays this app does own for it: Move to (group/department), Expected
//   Start Date and Openings.
// - "manual": a hire request (2026-10-29; see lib/hiring-requests.ts). Editors get
//   the request form, which also closes it, as posted (when the app has matched
//   it to a posting) or as no longer needed. Anyone else sees what was asked
//   for. A Paylocity posting is never closed here: that is done in Paylocity.

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-sdc-border-soft px-4 py-2.5">
      <span className="text-xs font-semibold uppercase tracking-wide text-sdc-muted">{label}</span>
      <span className="truncate text-sm text-sdc-navy" title={value}>
        {value}
      </span>
    </div>
  );
}

/** A hire request, for someone who can't edit it. */
function RequestDetails({ position, managerName, posting }: { position: HiringPosition; managerName: string | null; posting: HiringPosition | null }) {
  const team = EMPLOYEE_TEAMS.find((t) => t.schedulerCode === position.department)?.name;
  return (
    <div className="flex flex-col">
      {posting && (
        <p className="border-b border-sdc-border-soft bg-sdc-blue-light px-4 py-2.5 text-sm text-sdc-navy">
          Looks posted in Paylocity as {posting.title} (Job {posting.sourceId}).
        </p>
      )}
      <Field label="Status" value={`Requested ${waitingLabel(position.requestedAt)}`.trim()} />
      {team && <Field label="Team" value={team} />}
      <Field label="Hiring manager" value={managerName ?? (position.hiringManagerIds[0] ? `Paylocity ID ${position.hiringManagerIds[0]}` : "Not set")} />
      <Field label="How many" value={String(position.quantity)} />
      {position.expectedStartDate && <Field label="Needed by" value={position.expectedStartDate.toLocaleDateString("en-US", { timeZone: "UTC" })} />}
      {position.createdBy && <Field label="Requested by" value={position.createdBy} />}
      {position.note && <p className="whitespace-pre-wrap border-b border-sdc-border-soft px-4 py-2.5 text-sm text-sdc-navy">{position.note}</p>}
    </div>
  );
}

export function HiringPositionDetailDrawer({
  position,
  canAssign,
  onAssigned,
  onUpdated,
  onClosed,
  onClose,
  leads,
  managerName,
  posting,
}: {
  position: HiringPosition;
  canAssign: boolean;
  onAssigned: (positionSourceId: string, next: { workforceGroup: WorkforceGroupKey | null; department: string | null }) => void;
  onUpdated: (sourceId: string, patch: Partial<HiringPosition>) => void;
  /** A hire request was closed: drop it from the page. The caller closes the drawer. */
  onClosed: (sourceId: string) => void;
  onClose: () => void;
  /** Team leads, for a request's hiring manager. */
  leads: TeamLead[];
  /** A request's hiring manager, by name. */
  managerName: string | null;
  /** The Paylocity posting a request looks like it became, if any. */
  posting: HiringPosition | null;
}) {
  const departmentTitle = EMPLOYEE_TEAMS.find((t) => t.schedulerCode === position.department)?.name;
  const isRequest = position.source === "manual";

  return (
    <BuildReadinessDrawer
      title={position.title}
      subtitle={
        isRequest
          ? `Hire request${departmentTitle ? ` · ${departmentTitle}` : ""}`
          : position.workforceGroup
            ? `${workforceGroupTitle(position.workforceGroup)}${departmentTitle ? ` · ${departmentTitle}` : ""}`
            : "Unassigned"
      }
      breadcrumb={["Hiring Positions", position.title]}
      onBreadcrumbClick={() => {}}
      onClose={onClose}
    >
      {isRequest ? (
        canAssign ? (
          <HiringRequestForm request={position} leads={leads} posting={posting} onUpdated={onUpdated} onClosed={onClosed} onCancel={onClose} />
        ) : (
          <RequestDetails position={position} managerName={managerName} posting={posting} />
        )
      ) : (
        <div className="flex flex-col">
          <div className="flex items-center justify-between gap-3 border-b border-sdc-border-soft px-4 py-2.5">
            <span className="text-xs font-semibold uppercase tracking-wide text-sdc-muted">Move to</span>
            <HiringMoveToControl
              positionSourceId={position.sourceId}
              workforceGroup={position.workforceGroup}
              department={position.department}
              canAssign={canAssign}
              onAssigned={onAssigned}
            />
          </div>
          <div className="flex items-center justify-between gap-3 border-b border-sdc-border-soft px-4 py-2.5">
            <span className="text-xs font-semibold uppercase tracking-wide text-sdc-muted">Expected Start Date</span>
            <HiringExpectedStartDateControl
              positionSourceId={position.sourceId}
              expectedStartDate={position.expectedStartDate}
              canAssign={canAssign}
              onSaved={(sourceId, date) => onUpdated(sourceId, { expectedStartDate: date })}
            />
          </div>
          {/* Openings (2026-08-24): plain text without `canAssign`. */}
          <div className="flex items-start justify-between gap-3 border-b border-sdc-border-soft px-4 py-2.5">
            <span className="pt-1 text-xs font-semibold uppercase tracking-wide text-sdc-muted">Openings</span>
            <HiringOpeningsControl
              positionSourceId={position.sourceId}
              quantity={position.quantity}
              filledCount={position.filledCount}
              canAssign={canAssign}
              onSaved={(sourceId, next) =>
                onUpdated(sourceId, {
                  quantity: next.quantity,
                  filledCount: next.filledCount,
                  remainingQuantity: Math.max(0, next.quantity - next.filledCount),
                  // isOpen depends on BOTH status and remaining openings (see
                  // hiring-positions.ts), so filling the last one has to flip it
                  // here too or the totals on the page behind this drawer would
                  // keep counting a position this drawer already shows as filled.
                  // Exactly the server's own rule (hiring-positions.ts): open
                  // status AND at least one opening left.
                  isOpen: next.quantity > next.filledCount && isOpenHiringStatus(position.status, position.subStatus, false),
                })
              }
            />
          </div>

          {/* The pill, not plain text -- same colors as the row this drawer
              was opened from (HiringStatusPill / hiring-position-status.ts). */}
          <div className="flex items-center justify-between gap-3 border-b border-sdc-border-soft px-4 py-2.5">
            <span className="text-xs font-semibold uppercase tracking-wide text-sdc-muted">Job Status</span>
            <span className="flex items-center gap-2">
              <HiringStatusPill status={position.status} />
              {position.subStatus && position.subStatus !== "None" && <span className="text-note text-sdc-muted">{position.subStatus}</span>}
            </span>
          </div>
          {position.functionDescription && <Field label="Function" value={position.functionDescription} />}
          {position.sectionDescription && <Field label="Section" value={position.sectionDescription} />}
          {position.workLocDescription && <Field label="Work Location" value={position.workLocDescription} />}
          {position.createdDate && <Field label="Posted Date" value={position.createdDate} />}
          {position.createdBy && <Field label="Posted By" value={position.createdBy} />}
          {position.modifiedBy && <Field label="Last Updated By" value={position.modifiedBy} />}
          {position.remote && <Field label="Remote" value="Yes" />}
          {position.internal && <Field label="Internal Only" value="Yes" />}
          <Field label="Position ID" value={position.sourceId} />
          {!position.isManuallyAssigned && position.workforceGroup && (
            <p className="px-4 py-2.5 text-note text-sdc-muted">
              Placed here automatically from its hiring manager&apos;s team — not yet manually confirmed.
            </p>
          )}
        </div>
      )}
    </BuildReadinessDrawer>
  );
}
