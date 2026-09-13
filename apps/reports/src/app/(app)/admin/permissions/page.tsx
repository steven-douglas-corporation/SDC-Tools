import { PageTitle } from "@/components/ui/Typography";
import { PAGE_SHELL } from "@/components/ui/classnames";
import { requirePagePermission } from "@/lib/require-permission";
import { getRolePermissionsMatrix } from "@/lib/role-permissions-store";
import { RolePermissionsMatrix } from "@/components/RolePermissionsMatrix";

// ELT-only. The live-editable permission matrix — see role-permissions-store.ts
// for the DB-backed source of truth and lib/permissions.ts for the
// in-memory cache every enforcement point in the app actually reads.
export default async function AdminPermissionsPage() {
  await requirePagePermission("permissions:manage");
  const rows = await getRolePermissionsMatrix();

  return (
    <div className={PAGE_SHELL}>
      <PageTitle className="mb-1">Role Permissions</PageTitle>
      <p className="mb-6 max-w-2xl text-sm text-sdc-gray-600">
        Controls what each role can see and do, everywhere in the app — the sidebar, direct URLs, and every edit action all
        read from this same matrix. Changes apply immediately to everyone currently signed in, no refresh needed. Checking a
        lower tier automatically checks every tier above it (All &lt; Managers &lt; Sales &lt; ELT), so a gap can&apos;t be
        created by accident. ELT always has full access and can&apos;t be changed here.
      </p>
      <RolePermissionsMatrix initialRows={rows} />
    </div>
  );
}
