"use client";

import { BuildReadinessDrawer } from "@/components/build-readiness/BuildReadinessDrawer";
import { DASH, type EmployeeRow } from "@/lib/employee-row";
import { workforceGroupTitle, type WorkforceGroupKey } from "@/lib/employee-workforce-groups";

// Level 3 of the Employees tab (2026-08-19, by request) — net new; there was
// no per-employee detail view before this. Reuses the same generic drawer
// shell Build Readiness's own drilldowns share (BuildReadinessDrawer) rather
// than inventing a second drawer pattern, and shows ONLY fields that already
// exist on `EmployeeRow` — no field here is computed or guessed for this
// view; see EmployeesCards.tsx / lib/employee-row.ts for where each one
// actually comes from.

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

export function EmployeeDetailDrawer({
  employee,
  departmentTitle,
  workforceGroup,
  onClose,
}: {
  employee: EmployeeRow;
  /** The Level-2 department card title this person is filed under (may differ from the raw Paylocity `department` string — e.g. two spellings share one card). */
  departmentTitle: string;
  workforceGroup: WorkforceGroupKey;
  onClose: () => void;
}) {
  return (
    <BuildReadinessDrawer
      title={employee.name}
      subtitle={`${departmentTitle} · ${workforceGroupTitle(workforceGroup)}`}
      badge={employee.active ? undefined : { label: "INACTIVE", cls: "bg-sdc-gray-100 text-sdc-muted" }}
      breadcrumb={[employee.name]}
      onBreadcrumbClick={() => {}}
      onClose={onClose}
    >
      <div className="flex flex-col">
        <Field label="Workforce Group" value={workforceGroupTitle(workforceGroup)} />
        <Field label="Department" value={departmentTitle} />
        <Field label="Title" value={employee.positionTitle} />
        <Field label="Discipline" value={employee.discipline} />
        <Field label="Supervisor" value={employee.supervisor} />
        <Field label="Level / Specialty" value={employee.specialty ?? DASH} />
        <Field label="Status" value={employee.active ? "Active" : "Inactive"} />
        {employee.isLead && <Field label="Department Lead" value="Yes" />}
        {employee.paylocityId && <Field label="Paylocity ID" value={employee.paylocityId} />}
      </div>
    </BuildReadinessDrawer>
  );
}
