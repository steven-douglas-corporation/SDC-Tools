// The status badge for a hiring position (2026-08-21) — a colored dot plus
// the status text, so a position's Job Status is readable at a glance and
// nobody has to open Edit to find out what it is.
//
// Styling comes entirely from hiringStatusStyle() in lib/hiring-position-status.ts,
// the same lookup that drives the row's left accent and background tint and
// the status filter's own options, so every place a position appears
// (HiringPositionsList's table, EmployeesCards' per-department Hiring list,
// the detail drawer) shows identical colors for identical statuses.
import { hiringStatusStyle } from "@/lib/hiring-position-status";

export function HiringStatusPill({ status, className = "" }: { status: string; className?: string }) {
  const style = hiringStatusStyle(status);
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-label font-semibold ${style.pill} ${className}`}
      title={`Job Status: ${style.label}`}
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${style.dot}`} aria-hidden />
      {style.label}
    </span>
  );
}
