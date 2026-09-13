import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hasPermission,
  setOwnPermissions,
  EDITABLE_ROLES,
  ROLES,
  ROLE_LABELS,
  isEditableRole,
  type AppRole,
  type Permission,
} from "../src/lib/permissions";
import { permissionForPath, safeFallbackPath, ROUTE_PERMISSIONS } from "../src/lib/route-permissions";
import { PERMISSION_CATALOG } from "../src/lib/permission-catalog";

// ── NO HIERARCHY (2026-09-01) ────────────────────────────────────────────────
//
// This file used to assert the opposite of what it asserts now: "MANAGER
// inherits ALL", "SALES inherits MANAGER", "enabling a tier also reaches every
// tier above it", and a simulation proving every save left the row MONOTONIC.
// All of that was the hierarchy, and all of it is deliberately gone.
//
// What replaces it is independence. The tests below are the ones named in the
// request (Test 1-4), driven through setOwnPermissions() so an arbitrary matrix
// can be installed without a database — including matrices the old cascade
// could never have produced, which is the whole point.

// Restores a known matrix. Every test that installs one calls this first so
// ordering between tests cannot matter.
const BASELINE: Record<AppRole, readonly Permission[]> = {
  ALL: ["job-hour-details:view"],
  MANAGER: ["job-hour-details:view", "dashboard:view"],
  PM: ["job-hour-details:view", "monthly-etc:view", "monthly-etc:edit"],
  SALES: ["job-hour-details:view", "projects:edit"],
  ELT: [],
};

function install(matrix: Partial<Record<AppRole, readonly Permission[]>>): void {
  setOwnPermissions({ ...BASELINE, ...matrix });
}

test("no role, and an unknown role, have no permissions", () => {
  install({});
  assert.equal(hasPermission(null, "dashboard:view"), false);
  assert.equal(hasPermission(undefined, "dashboard:view"), false);
  // A stale session cookie naming a role this build no longer has must fail
  // closed rather than throw on the undefined lookup.
  assert.equal(hasPermission("ADMIN" as AppRole, "dashboard:view"), false);
});

test("PM is a real role, listed and labelled", () => {
  assert.ok(ROLES.includes("PM"));
  assert.equal(ROLE_LABELS.PM, "PM");
  // Editable in the matrix (unlike ELT), so it gets a column and can be written.
  assert.deepEqual(EDITABLE_ROLES, ["ALL", "MANAGER", "PM", "SALES"]);
  assert.equal(isEditableRole("PM"), true);
  assert.equal(isEditableRole("ELT"), false);
  assert.equal(isEditableRole("nonsense"), false);
});

// ── Test 1: Manager has Monthly ETC, Sales does not ─────────────────────────

test("Test 1 — MANAGER can access Monthly ETC while SALES cannot", () => {
  install({ MANAGER: ["monthly-etc:view"], SALES: [] });
  assert.equal(hasPermission("MANAGER", "monthly-etc:view"), true);
  assert.equal(hasPermission("SALES", "monthly-etc:view"), false);
});

// ── Test 2: the combination the old hierarchy made IMPOSSIBLE ───────────────
//
// SALES ranked above MANAGER, so SALES held everything MANAGER did by
// construction. "Sales yes, Managers no" could not be expressed at all.

test("Test 2 — SALES can access Dashboard while MANAGER cannot", () => {
  install({ SALES: ["dashboard:view"], MANAGER: [] });
  assert.equal(hasPermission("SALES", "dashboard:view"), true);
  assert.equal(hasPermission("MANAGER", "dashboard:view"), false);
});

// ── Test 3: PM independently granted Monthly ETC ────────────────────────────

test("Test 3 — PM can access Monthly ETC while SALES cannot", () => {
  install({ PM: ["monthly-etc:view", "monthly-etc:edit"], SALES: [], MANAGER: [], ALL: [] });
  assert.equal(hasPermission("PM", "monthly-etc:view"), true);
  assert.equal(hasPermission("PM", "monthly-etc:edit"), true);
  for (const role of ["SALES", "MANAGER", "ALL"] as AppRole[]) {
    assert.equal(hasPermission(role, "monthly-etc:view"), false, role);
  }
});

test("granting a permission to the LOWEST role gives it to nobody else", () => {
  // Under the old rule this was the strongest possible grant: ALL sat at the
  // bottom, so anything it held every other tier inherited. Now it reaches ALL
  // and stops.
  install({ ALL: ["profitability:view"], MANAGER: [], PM: [], SALES: [] });
  assert.equal(hasPermission("ALL", "profitability:view"), true);
  for (const role of ["MANAGER", "PM", "SALES"] as AppRole[]) {
    assert.equal(hasPermission(role, "profitability:view"), false, role);
  }
});

// ── Test 4: one role's cell moving never moves another's ────────────────────

test("Test 4 — toggling one role's cell leaves every other role's answer untouched", () => {
  const permission: Permission = "monthly-etc:submit";
  const others = (target: AppRole): readonly Exclude<AppRole, "ELT">[] => EDITABLE_ROLES.filter((r) => r !== target);

  for (const target of EDITABLE_ROLES) {
    // A matrix where NOBODY has it, then only `target` does, then nobody again.
    // Every other role's answer must be identical at all three points, and
    // toggling twice must return to exactly the starting state.
    install({ ALL: [], MANAGER: [], PM: [], SALES: [] });
    const beforeOthers: boolean[] = others(target).map((r) => hasPermission(r, permission));
    assert.deepEqual(beforeOthers, others(target).map(() => false));

    install({ ALL: [], MANAGER: [], PM: [], SALES: [], [target]: [permission] });
    assert.equal(hasPermission(target, permission), true, `${target} on`);
    assert.deepEqual(
      others(target).map((r) => hasPermission(r, permission)),
      beforeOthers,
      `toggling ${target} on changed another role`,
    );

    install({ ALL: [], MANAGER: [], PM: [], SALES: [], [target]: [] });
    assert.equal(hasPermission(target, permission), false, `${target} off`);
    assert.deepEqual(
      others(target).map((r) => hasPermission(r, permission)),
      beforeOthers,
      `toggling ${target} off changed another role`,
    );
  }
});

test("every one of the 16 role/permission combinations is independently expressible", () => {
  // Two roles x two permissions: all 16 on/off combinations must be reachable
  // and read back exactly. Under the hierarchy, 7 of these were unrepresentable
  // (any state where MANAGER held something SALES did not).
  const a: Permission = "monthly-etc:view";
  const b: Permission = "dashboard:view";
  for (const ma of [false, true]) {
    for (const mb of [false, true]) {
      for (const sa of [false, true]) {
        for (const sb of [false, true]) {
          install({
            MANAGER: [...(ma ? [a] : []), ...(mb ? [b] : [])] as Permission[],
            SALES: [...(sa ? [a] : []), ...(sb ? [b] : [])] as Permission[],
          });
          const label = `M(${ma},${mb}) S(${sa},${sb})`;
          assert.equal(hasPermission("MANAGER", a), ma, `${label} MANAGER/${a}`);
          assert.equal(hasPermission("MANAGER", b), mb, `${label} MANAGER/${b}`);
          assert.equal(hasPermission("SALES", a), sa, `${label} SALES/${a}`);
          assert.equal(hasPermission("SALES", b), sb, `${label} SALES/${b}`);
        }
      }
    }
  }
});

test("ELT passes for everything, including a permission invented after this file was touched", () => {
  // Deliberately installed with an EMPTY ELT list: the wildcard must not depend
  // on stored data, which is what stops an ELT user misconfiguring the matrix
  // and locking their own role out.
  install({ ELT: [] });
  const known: Permission[] = [
    "job-hour-details:view",
    "projects:edit",
    "standards:warranty",
    "audit-log:view",
    "employees:edit",
    "users:manage",
    "monthly-etc:submit",
    "cash-flow:view",
  ];
  for (const p of known) assert.equal(hasPermission("ELT", p), true, p);
  assert.equal(hasPermission("ELT", "some-future-feature:view" as Permission), true);
});

test("ELT's wildcard grants nothing to any other role", () => {
  // The one remaining special case must not be a back door into a hierarchy:
  // ELT holding everything must leave the other four exactly as configured.
  install({ ALL: [], MANAGER: [], PM: [], SALES: [] });
  for (const role of EDITABLE_ROLES) {
    assert.equal(hasPermission(role, "users:manage"), false, role);
    assert.equal(hasPermission(role, "cash-flow:view"), false, role);
  }
});

// ── Monthly ETC is four separately-grantable things ─────────────────────────

test("Monthly ETC View / Edit / Submit are independent of each other", () => {
  // The §4 example: a PM who can open and fill in the grid but not finalise it.
  install({ PM: ["monthly-etc:view", "monthly-etc:edit"] });
  assert.equal(hasPermission("PM", "monthly-etc:view"), true);
  assert.equal(hasPermission("PM", "monthly-etc:edit"), true);
  assert.equal(hasPermission("PM", "monthly-etc:submit"), false);

  // And read-only: View without Edit is a real, expressible state.
  install({ SALES: ["monthly-etc:view"] });
  assert.equal(hasPermission("SALES", "monthly-etc:view"), true);
  assert.equal(hasPermission("SALES", "monthly-etc:edit"), false);

  // Submit without View is expressible too — nonsense to configure, but the
  // point is that no key implies another.
  install({ MANAGER: ["monthly-etc:submit"] });
  assert.equal(hasPermission("MANAGER", "monthly-etc:view"), false);
  assert.equal(hasPermission("MANAGER", "monthly-etc:submit"), true);
});

test("the matrix exposes every Monthly ETC stage, and Standard Fees separately", () => {
  const keys = PERMISSION_CATALOG.flatMap((e) => [...e.keys]);
  for (const k of ["monthly-etc:view", "monthly-etc:edit", "monthly-etc:submit"] as Permission[]) {
    assert.ok(keys.includes(k), `${k} has no row in the Role Permissions matrix`);
  }
  // Standard Fees was already its own row and stays there rather than being
  // duplicated under Monthly ETC.
  assert.ok(keys.includes("standards:view"));
  assert.ok(keys.includes("standards:edit"));
  // Cash Flow Forecast became a real row in the same change.
  assert.ok(keys.includes("cash-flow:view"));
});

test("every permission the app can check has a row in the matrix", () => {
  // A permission with no row is one nobody can ever grant: it silently becomes
  // ELT-only. That may be intended, but it must not happen by omission — this
  // is the check that would have caught employees:hiring:assign never being
  // seeded.
  const keys = new Set(PERMISSION_CATALOG.flatMap((e) => [...e.keys]));
  for (const { path, permission } of ROUTE_PERMISSIONS) {
    assert.ok(keys.has(permission), `${permission} gates ${path} but has no matrix row`);
  }
});

// ── The route map that proxy.ts and Sidebar.tsx both read ───────────────────

test("every top-level tab resolves to a permission", () => {
  const routes: [string, Permission][] = [
    ["/", "dashboard:view"],
    ["/job-hours", "job-hour-details:view"],
    ["/build-readiness", "build-readiness:view"],
    ["/quoted", "projects:view"],
    ["/etc", "monthly-etc:view"],
    ["/hours", "hours:view"],
    ["/employees", "employees:view"],
    ["/audit-log", "audit-log:view"],
    ["/job-cost-explorer", "profitability:view"],
    ["/cash-flow", "cash-flow:view"],
    ["/admin/users", "users:manage"],
  ];
  for (const [path, permission] of routes) {
    assert.equal(permissionForPath(path), permission, path);
  }
});

test("a sub-path inherits its top-level route's permission", () => {
  assert.equal(permissionForPath("/quoted/new"), "projects:view");
  assert.equal(permissionForPath("/job-hours?jobs=1079"), "job-hour-details:view");
});

test("only the exact root path resolves to dashboard:view", () => {
  // "/" is a prefix of every path, so it must be matched last / exactly, or
  // every route in the app would silently resolve to the Dashboard's
  // permission.
  assert.notEqual(permissionForPath("/quoted"), "dashboard:view");
  assert.notEqual(permissionForPath("/etc"), "dashboard:view");
});

// ── The redirect-loop regression (2026-08-18, ERR_TOO_MANY_REDIRECTS) ───────
//
// "/" requires dashboard:view. Every "permission denied" redirect used to land
// on a hardcoded "/", so a role without dashboard:view that was denied anywhere
// got sent to "/" and immediately refused "/" too — forever. safeFallbackPath
// must never be able to reproduce that.
//
// This matters MORE without a hierarchy, not less: there is no longer a base
// tier whose grants everyone is guaranteed to share, so "the one permission
// every role has" is now a configuration rather than a structural fact. The
// final case below is the one the old file could not have written — a role with
// an EMPTY permission set, which is now reachable by unticking a column.

test("safeFallbackPath never points at a route the role can't see", () => {
  setOwnPermissions(BASELINE);
  for (const role of ROLES) {
    const path = safeFallbackPath(role);
    if (path === "/login") continue; // nothing to check — see the empty-role case below
    const permission = permissionForPath(path);
    assert.ok(permission, `safeFallbackPath(${role}) = "${path}" has no known permission at all`);
    assert.equal(hasPermission(role, permission), true, `${role} was sent to "${path}" but lacks ${permission}`);
  }
});

test("safeFallbackPath never resolves to dashboard:view — that's the exact loop this fixes", () => {
  setOwnPermissions(BASELINE);
  for (const role of ROLES) {
    assert.notEqual(safeFallbackPath(role), "/", `${role} must not be sent to "/"`);
  }
});

test("a role with no session at all falls back to /login, not a loop", () => {
  assert.equal(safeFallbackPath(null), "/login");
  assert.equal(safeFallbackPath(undefined), "/login");
});

test("a role stripped of EVERY permission lands on /login, not a redirect loop", () => {
  // Newly reachable: with no inheritance, a column can be emptied completely.
  // safeFallbackPath must find no route and say /login rather than returning a
  // path the role will be refused at.
  install({ MANAGER: [] });
  assert.equal(safeFallbackPath("MANAGER"), "/login");
});

test("every route in the map is reachable by SOME role — no permission is unassigned", () => {
  setOwnPermissions(BASELINE);
  for (const { path, permission } of ROUTE_PERMISSIONS) {
    const reachable = ROLES.some((r) => hasPermission(r, permission));
    assert.ok(reachable, `no role has ${permission} (route ${path}) — it would 404-loop for everyone`);
  }
});
