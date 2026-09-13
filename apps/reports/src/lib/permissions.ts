// ── Role-based access control ────────────────────────────────────────────────
//
// Deliberately dependency-free (no React, no Prisma, no `@/` imports) — the
// same reason etc-departments.ts and sections.ts are: `tsx --test` can load it
// directly, and it needs to run from proxy.ts (Node runtime), server
// components, server actions, and client components alike without dragging
// any of those environments' assumptions into the other.
//
// ── NO HIERARCHY (2026-09-01, by request) ───────────────────────────────────
//
// This file used to read: "Hierarchy: ALL < MANAGER < SALES < ELT. Higher tiers
// inherit every lower tier's permissions." That is gone, and so are the three
// things that implemented it: ROLE_RANK, roleAtLeast(), and
// affectedRolesForCascade().
//
// Role names describe GROUPS OF USERS. They do not describe an access level.
// Every (role, permission) pair is stored and evaluated on its own, so all of
// these are now expressible, and none of them were before:
//
//   * MANAGER has Monthly ETC, SALES does not.
//   * SALES has Dashboard, MANAGER does not.
//   * PM has Monthly ETC, SALES is blocked from it.
//
// Ticking a box for one role reaches exactly one row. Nothing cascades, nothing
// is implied, and there is no "which is the lowest tier holding this" question
// left to ask — which is why roleAtLeast() was deleted rather than kept for
// convenience. It had no callers outside its own test, and any new caller would
// be reintroducing the ranking this change exists to remove.
//
// ELT is the ONE exception, and it is a wildcard rather than a rank: it passes
// for every permission, including ones added after this file was last touched.
// That is deliberate (see hasPermission) and it is not a mechanism the other
// roles route through — ALL, MANAGER, PM and SALES are independent of it and of
// each other.

export type AppRole = "ALL" | "MANAGER" | "PM" | "SALES" | "ELT";

export const ROLES: readonly AppRole[] = ["ALL", "MANAGER", "PM", "SALES", "ELT"];

/** Human labels, for every dropdown and column header that names a role. */
export const ROLE_LABELS: Record<AppRole, string> = {
  ALL: "All",
  MANAGER: "Managers",
  PM: "PM",
  SALES: "Sales",
  ELT: "ELT",
};

export type Permission =
  | "job-hour-details:view"
  | "job-hour-details:schedule"
  | "build-readiness:view"
  | "projects:view"
  | "projects:edit"
  | "monthly-etc:view"
  | "monthly-etc:edit"
  | "monthly-etc:submit"
  | "hours:view"
  | "dashboard:view"
  | "cash-flow:view"
  | "standards:view"
  | "standards:edit"
  | "standards:pm"
  | "standards:mfg"
  | "standards:warranty"
  | "employees:view"
  | "employees:edit"
  | "employees:hiring:assign"
  | "audit-log:view"
  | "profitability:view"
  | "users:manage"
  | "permissions:manage"
  | "tm:view";

// The shape every role's grants take. Now COMPLETE per role rather than "what
// this tier adds on top of the one below it" — that phrasing only made sense
// while hasPermission() walked a chain, and leaving the data as a delta would
// have been the hierarchy surviving in storage after being removed from code.
type OwnPermissionsShape = Record<AppRole, readonly Permission[]>;

// What ships in code, and what the app falls back to if the database is ever
// unreachable at boot (role-permissions-store.ts's loadRolePermissionsFromDb
// normally overwrites this before the first real request).
//
// These lists are the EFFECTIVE access each role held on 2026-09-01, read off
// the live RolePermission table and flattened — so removing inheritance moved
// nobody's access, including on this fallback path. Verified before writing
// them: every column of that table was already monotonic (no role held a
// permission the role "above" it lacked), which is why the flattening was a
// no-op rather than a guess.
const DEFAULT_OWN_PERMISSIONS: OwnPermissionsShape = {
  ALL: [
    "job-hour-details:view",
    "job-hour-details:schedule",
    "build-readiness:view",
    "monthly-etc:view",
    // Nobody checked these before they existed: every caller who could open
    // Monthly ETC could also type in it, and submission was gated only by the
    // Standard Sheet password. Seeded ON so splitting the permission apart
    // takes nothing away from anyone who has it today — see the seed
    // migration's note about tightening them deliberately rather than by
    // accident of a refactor.
    "monthly-etc:edit",
    "monthly-etc:submit",
  ],
  MANAGER: [
    "job-hour-details:view",
    "job-hour-details:schedule",
    "build-readiness:view",
    "monthly-etc:view",
    "monthly-etc:edit",
    "monthly-etc:submit",
    "dashboard:view",
    "employees:view",
    "hours:view",
    "projects:view",
    "tm:view",
  ],
  // NEW ROLE (2026-09-01). Project execution, and nothing else — explicitly NOT
  // seeded from MANAGER's or SALES's list, per the request. What PM gets is the
  // set named there: Monthly ETC (view + edit), Projects, Job Hour Details,
  // Build Readiness, plus the two execution views those are read alongside.
  //
  // Deliberately withheld, every one of them a single checkbox away: ETC Submit
  // (finalising a month stays with MANAGER/SALES/ELT), Standard Fees,
  // Profitability, T&M, Projects — Edit, Cash Flow, and every Administration
  // row.
  PM: [
    "job-hour-details:view",
    "job-hour-details:schedule",
    "build-readiness:view",
    "monthly-etc:view",
    "monthly-etc:edit",
    "projects:view",
    "dashboard:view",
    "hours:view",
  ],
  SALES: [
    "job-hour-details:view",
    "job-hour-details:schedule",
    "build-readiness:view",
    "monthly-etc:view",
    "monthly-etc:edit",
    "monthly-etc:submit",
    "dashboard:view",
    "employees:view",
    "hours:view",
    "projects:view",
    "projects:edit",
    "tm:view",
  ],
  // ELT's real answer is "everything", from the wildcard in hasPermission. This
  // list is never consulted for an ELT caller; it exists so the type is total
  // and so the DB seed has something honest to point at.
  ELT: [
    "employees:edit",
    "employees:hiring:assign",
    "audit-log:view",
    "users:manage",
    "permissions:manage",
    "cash-flow:view",
  ],
};

// ── Why globalThis, not a plain module-level `let` ──────────────────────────
//
// Found live once already for realtime-hub.ts, and the identical problem
// applies here: Next.js bundles Server Actions separately from Route
// Handlers/Server Components. A plain `let OWN_PERMISSIONS` would silently
// become two different variables in two different bundles — a write from
// the Role Permissions page's server action (a Server Action bundle) would
// be invisible to proxy.ts or a page.tsx read (a different bundle). Pinning
// to `globalThis` makes every bundle in this one Node.js process share the
// same slot, the same fix realtime-hub.ts already uses for its own state.
const g = globalThis as unknown as { __ownPermissions?: OwnPermissionsShape };
if (!g.__ownPermissions) g.__ownPermissions = DEFAULT_OWN_PERMISSIONS;

/**
 * Swaps in a freshly-loaded permission set — called by
 * role-permissions-store.ts after a DB read (boot) or a write (an ELT
 * user's save). Every hasPermission() call anywhere in this process sees the
 * new data on its very next invocation; no restart, no cache TTL.
 */
export function setOwnPermissions(next: OwnPermissionsShape): void {
  g.__ownPermissions = next;
}

/**
 * The one function every enforcement point calls — proxy.ts, page-level
 * guards, server actions, route handlers, and the sidebar's nav filter.
 *
 * ONE ROLE, ONE LOOKUP. No rank comparison and no walk across other roles: the
 * question is only ever "does THIS role hold THIS permission". A role that is
 * not in the set at all — an unrecognised claim from a stale session cookie
 * issued before the role list changed — fails closed rather than throwing.
 *
 * ELT is a wildcard and passes for ANY permission, including ones added after
 * this file was last touched, per "any future restricted feature unless
 * explicitly excluded." It is checked before the store is consulted, which is
 * what guarantees an ELT user can never lock their own role out by
 * misconfiguring the Role Permissions matrix. It grants nothing to the other
 * roles and is not a hierarchy: no other role's answer depends on it.
 */
export function hasPermission(role: AppRole | null | undefined, permission: Permission): boolean {
  if (!role) return false;
  if (role === "ELT") return true;
  const own = g.__ownPermissions![role];
  return own !== undefined && own.includes(permission);
}

/**
 * Roles a Role Permissions matrix save can actually change — ELT is never
 * included. ELT's access comes from the wildcard in hasPermission() above,
 * unconditionally, so there is no row for it in that table and nothing for a
 * save to reach.
 */
export const EDITABLE_ROLES: readonly Exclude<AppRole, "ELT">[] = ["ALL", "MANAGER", "PM", "SALES"];

export type EditableRole = Exclude<AppRole, "ELT">;

/** Narrows an arbitrary string (a form field, a client argument) to a known editable role. */
export function isEditableRole(value: string): value is EditableRole {
  return (EDITABLE_ROLES as readonly string[]).includes(value);
}
