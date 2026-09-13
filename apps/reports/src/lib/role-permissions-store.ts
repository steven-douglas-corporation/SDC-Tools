import "server-only";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { publishPermissionsChanged } from "@/lib/realtime-hub";
import { setOwnPermissions, EDITABLE_ROLES, ROLES, isEditableRole, type AppRole, type EditableRole, type Permission } from "@/lib/permissions";

// The live-editable half of the role/permission system — the DB-backed
// source lib/permissions.ts's in-memory cache is loaded from at boot and
// refreshed from on every ELT save. RolePermission has no generated Prisma
// Client type yet (`prisma generate` is blocked on this box while a server
// process holds node_modules/.prisma open — the same standing constraint
// documented on DepartmentEtcCompletion/Employee.team), so this reads and
// writes it with $queryRaw/$executeRaw, same as employee-team-field.ts.
//
// ELT is never stored here — hasPermission()'s wildcard is what actually
// grants ELT everything, unconditionally, before this table is even
// consulted. Keeping ELT out of the table entirely (rather than seeding it
// `true` and hoping nothing ever flips it) means there is no row an ELT user
// could accidentally disable to lock their own role out.
//
// There is no cascade any more (2026-09-01). A write reaches exactly the one
// (role, permission) row it names — see setRolePermission.

type RolePermissionRow = { role: AppRole; permission: string; enabled: boolean | number };

function buildOwnPermissionsShape(rows: RolePermissionRow[]): Record<AppRole, readonly Permission[]> {
  // Built from ROLES rather than a literal so a role added to the union cannot
  // be forgotten here and silently read back as `undefined` (hasPermission
  // fails closed on that, but a role whose every permission vanished would look
  // like a permissions bug, not a missing key).
  const byRole = Object.fromEntries(ROLES.map((r) => [r, [] as Permission[]])) as Record<AppRole, Permission[]>;
  for (const r of rows) {
    // A row for a role this build no longer knows (rolled back mid-migration)
    // is ignored rather than crashing the boot load.
    if (Boolean(r.enabled) && byRole[r.role]) byRole[r.role].push(r.permission as Permission);
  }
  return byRole;
}

/** Called once at process boot (src/instrumentation.ts) — populates the live cache from the DB. */
export async function loadRolePermissionsFromDb(): Promise<void> {
  const rows = await prisma.$queryRaw<RolePermissionRow[]>`SELECT role, permission, enabled FROM RolePermission`;
  setOwnPermissions(buildOwnPermissionsShape(rows));
}

/** Every editable role, all false — the starting point for a permission no role holds yet. */
function emptyEnabledMap(): Record<EditableRole, boolean> {
  return Object.fromEntries(EDITABLE_ROLES.map((r) => [r, false])) as Record<EditableRole, boolean>;
}

export type RolePermissionMatrixRow = {
  permission: Permission;
  enabled: Record<EditableRole, boolean>;
};

/** Current state for every stored permission, for the admin page to render. ELT isn't included — it's always true, drawn by the UI, never read from here. */
export async function getRolePermissionsMatrix(): Promise<RolePermissionMatrixRow[]> {
  const rows = await prisma.$queryRaw<RolePermissionRow[]>`SELECT role, permission, enabled FROM RolePermission`;
  const byPermission = new Map<Permission, RolePermissionMatrixRow>();
  for (const r of rows) {
    const key = r.permission as Permission;
    let row = byPermission.get(key);
    if (!row) {
      row = { permission: key, enabled: emptyEnabledMap() };
      byPermission.set(key, row);
    }
    if (isEditableRole(r.role)) row.enabled[r.role] = Boolean(r.enabled);
  }
  return [...byPermission.values()];
}

export type SetRolePermissionResult =
  | { ok: true; changed: { role: AppRole; enabled: boolean }[] }
  | { ok: false; error: string };

/**
 * The one write path — ONE ROW PER CALL (2026-09-01).
 *
 * This used to cascade: enabling a permission for `role` also enabled it for
 * every editable role "above" it, and disabling cleared it for `role` and
 * everything at or below. That was how the hierarchy was kept gap-free, and it
 * is exactly the behavior being removed — ticking Managers → Monthly ETC must
 * not tick Sales, and unticking Sales must not untick Managers.
 *
 * So there is no `affected` list any longer. `role` and `permission` name one
 * row in RolePermission, and that row is the only thing this touches. ELT is
 * still refused outright: defense in depth on top of the fact that
 * hasPermission()'s wildcard makes a stored ELT row meaningless anyway.
 */
export async function setRolePermission(
  role: AppRole,
  permission: Permission,
  enabled: boolean,
  actorEmail: string | null,
): Promise<SetRolePermissionResult> {
  if (role === "ELT") return { ok: false, error: "ELT always has full access — it can't be changed here." };
  if (!isEditableRole(role)) return { ok: false, error: `"${role}" is not a role this can change.` };

  const existing = await prisma.$queryRaw<{ enabled: boolean | number }[]>`
    SELECT enabled FROM RolePermission WHERE role = ${role} AND permission = ${permission} LIMIT 1
  `;
  // Boolean(), because $queryRaw can hand back MySQL's TINYINT(1) as 0/1 rather
  // than false/true depending on the driver path. Without it the no-op check
  // below compares 1 === true, misses, and writes an audit row saying a value
  // changed to what it already was.
  const before = existing.length > 0 ? Boolean(existing[0].enabled) : false;
  // Already correct: no row touched, nothing audited, nothing broadcast.
  if (before === enabled) return { ok: true, changed: [] };

  await prisma.$executeRaw`
    INSERT INTO RolePermission (role, permission, enabled, updatedAt, updatedByEmail)
    VALUES (${role}, ${permission}, ${enabled}, ${new Date()}, ${actorEmail})
    ON DUPLICATE KEY UPDATE enabled = ${enabled}, updatedAt = ${new Date()}, updatedByEmail = ${actorEmail}
  `;
  await logAudit({
    action: "permission.updated",
    entityType: "RolePermission",
    entityId: `${role}:${permission}`,
    summary: `${permission} for ${role} set to ${enabled ? "on" : "off"} by ${actorEmail ?? "unknown"}`,
    metadata: { role, permission, before, after: enabled },
  });

  // Re-read the whole table rather than patch the in-memory shape by hand —
  // the table is small (dozens of rows), and re-deriving from the DB is one
  // fewer place this and loadRolePermissionsFromDb could quietly disagree.
  await loadRolePermissionsFromDb();
  publishPermissionsChanged();

  return { ok: true, changed: [{ role, enabled }] };
}
