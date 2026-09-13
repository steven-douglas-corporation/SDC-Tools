"use server";

import { assertActionPermission } from "@/lib/require-permission";
import { setRolePermission, type SetRolePermissionResult } from "@/lib/role-permissions-store";
import type { AppRole, Permission } from "@/lib/permissions";

// The one Server Action the Role Permissions matrix's checkboxes call.
// permissions:manage is re-checked HERE independently of the page-level
// guard (src/app/(app)/admin/permissions/page.tsx) — same convention every
// other mutating action in this app follows, since a Server Action is
// directly callable by anyone who captures its id regardless of what the
// page rendered.
export async function setRolePermissionAction(
  role: AppRole,
  permission: Permission,
  enabled: boolean,
): Promise<SetRolePermissionResult> {
  const session = await assertActionPermission("permissions:manage");
  return setRolePermission(role, permission, enabled, session.user.email ?? null);
}
