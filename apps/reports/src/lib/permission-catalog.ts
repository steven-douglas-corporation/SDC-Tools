import type { Permission } from "@/lib/permissions";

// The Role Permissions matrix's presentation layer — which section each
// permission shows under, its human label, and which ROWS control more than
// one Permission key together. Dependency-free (no React/Prisma) so both the
// admin page (server) and the matrix component (client) import the same
// list rather than keeping two.
//
// "Standard Fees" is the one row backing two keys at once (standards:view +
// standards:edit) — by request, matching the sketched table exactly rather
// than splitting it like Projects. Every other row is one key.
//
// Monthly ETC is THREE rows since 2026-09-01 (View / Edit / Submit) rather than
// one all-or-nothing row: PM needs to open and fill in the grid without also
// being able to finalise the month. Standard Fees is the fourth part of that
// workflow and already had its own rows, so it is left where it is rather than
// duplicated under Monthly ETC.
export type PermissionCatalogEntry = {
  keys: readonly [Permission, ...Permission[]];
  label: string;
  section: string;
  /** Rendered indented, as a sub-item of the row above it (PM/Mfg/Warranty under Standard Fees). */
  indent?: boolean;
};

export const PERMISSION_SECTIONS = ["General", "Projects", "Monthly ETC", "Hours", "Standards", "Financial", "Administration"] as const;

export const PERMISSION_CATALOG: readonly PermissionCatalogEntry[] = [
  // Display labels only. The permission KEYS stay `job-hour-details:*` — they are
  // stored on roles in the database, so renaming them would revoke access, and the
  // 2026-09-03 rename was a label change.
  { keys: ["job-hour-details:view"], label: "Job Details", section: "General" },
  { keys: ["job-hour-details:schedule"], label: "Schedule button in Job Details", section: "General" },
  { keys: ["build-readiness:view"], label: "Build Readiness", section: "General" },
  { keys: ["dashboard:view"], label: "Dashboard", section: "General" },
  { keys: ["tm:view"], label: "T&M", section: "General" },
  { keys: ["projects:view"], label: "Projects — View", section: "Projects" },
  { keys: ["projects:edit"], label: "Projects — Edit", section: "Projects" },
  { keys: ["monthly-etc:view"], label: "Monthly ETC — View", section: "Monthly ETC" },
  { keys: ["monthly-etc:edit"], label: "Monthly ETC — Edit (enter/save New ETC)", section: "Monthly ETC" },
  { keys: ["monthly-etc:submit"], label: "Monthly ETC — Submit Monthly Report", section: "Monthly ETC" },
  { keys: ["hours:view"], label: "Hours", section: "Hours" },
  { keys: ["standards:view", "standards:edit"], label: "Standard Fees", section: "Standards" },
  { keys: ["standards:pm"], label: "PM", section: "Standards", indent: true },
  { keys: ["standards:mfg"], label: "Mfg", section: "Standards", indent: true },
  { keys: ["standards:warranty"], label: "Warranty (Engineering + Shop)", section: "Standards", indent: true },
  { keys: ["profitability:view"], label: "Profitability / Job Cost Explorer", section: "Financial" },
  // Was hard-coded ELT-only (lib/cash-flow-access.ts) and deliberately absent
  // from this list, so no admin could hand it out by accident. Now a real row
  // by request — seeded OFF for every role but ELT, so today's access is
  // unchanged and widening it is a deliberate click rather than a code change.
  { keys: ["cash-flow:view"], label: "Cash Flow Forecast", section: "Financial" },
  { keys: ["employees:view"], label: "Employees — View", section: "Administration" },
  { keys: ["employees:edit"], label: "Employees — Edit (Add Member)", section: "Administration" },
  { keys: ["employees:hiring:assign"], label: "Employees — Manage Hiring Positions (Create/Edit/Assign)", section: "Administration" },
  { keys: ["audit-log:view"], label: "Audit Log", section: "Administration" },
  { keys: ["users:manage"], label: "User Role Assignment", section: "Administration" },
  { keys: ["permissions:manage"], label: "Role Permissions (this page)", section: "Administration" },
] as const;
