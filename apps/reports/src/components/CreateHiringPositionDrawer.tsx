"use client";

import { BuildReadinessDrawer } from "@/components/build-readiness/BuildReadinessDrawer";
import { HiringRequestForm } from "@/components/HiringRequestForm";
import type { TeamLead } from "@/lib/hiring-requests";
import type { HiringPosition } from "@/lib/hiring-positions";

// "Request a hire" (2026-10-29; was "Create Position"). Same BuildReadinessDrawer
// shell as every other Employees drilldown. The form and its write path are
// HiringRequestForm's; the new request is handed back so EmployeesGrid can show
// it straight away, with no page reload.

export function CreateHiringPositionDrawer({
  leads,
  initialTeam,
  onClose,
  onCreated,
}: {
  leads: TeamLead[];
  /** Set when started from a team's card on the Org chart. */
  initialTeam?: string | null;
  onClose: () => void;
  onCreated: (position: HiringPosition) => void;
}) {
  return (
    <BuildReadinessDrawer title="Request a hire" breadcrumb={["Hiring Positions", "Request a hire"]} onBreadcrumbClick={() => {}} onClose={onClose}>
      <HiringRequestForm leads={leads} initialTeam={initialTeam} onCreated={onCreated} onCancel={onClose} />
    </BuildReadinessDrawer>
  );
}
