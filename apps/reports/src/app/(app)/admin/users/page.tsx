import { PageTitle } from "@/components/ui/Typography";
import { PAGE_SHELL } from "@/components/ui/classnames";
import { requirePagePermission } from "@/lib/require-permission";
import { listUsersForAdmin, setUserRole } from "@/lib/user-role-actions";
import { UserRoleSelect } from "@/components/UserRoleSelect";

// ELT-only. The one screen that assigns All/Managers/Sales/ELT to a User row
// — before this it took a raw DB write (see lib/user-role-actions.ts).
export default async function AdminUsersPage() {
  const session = await requirePagePermission("users:manage");
  const users = await listUsersForAdmin();

  return (
    <div className={PAGE_SHELL}>
      <PageTitle className="mb-1">Users &amp; Roles</PageTitle>
      <p className="mb-6 text-sm text-sdc-gray-600">
        Assign each account&apos;s role. Roles are independent groups, not tiers &mdash; none of them inherits another&apos;s access.
        What each one can see or do is set on the Role Permissions page, one checkbox per role. ELT always has full access.
      </p>
      <table className="w-full max-w-3xl border-collapse text-sm">
        <thead>
          <tr className="border-b border-sdc-border text-left text-sdc-muted">
            <th className="py-2 pr-4 font-medium">Name</th>
            <th className="py-2 pr-4 font-medium">Email</th>
            <th className="py-2 pr-4 font-medium">Role</th>
            <th className="py-2 pr-4 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id} className="border-b border-sdc-border/60">
              <td className="py-2 pr-4">{u.name}</td>
              <td className="py-2 pr-4">{u.email}</td>
              <td className="py-2 pr-4">
                <UserRoleSelect userId={u.id} role={u.role} isSelf={u.email === session.user.email} action={setUserRole} />
              </td>
              <td className="py-2 pr-4 text-sdc-gray-600">{u.active ? "Active" : "Deactivated"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
