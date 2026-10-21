import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { permissionForPath, safeFallbackPath, ROUTE_PERMISSIONS } from "../src/lib/route-permissions";
import { hasPermission, setOwnPermissions, ROLES } from "../src/lib/permissions";
import { PERMISSION_CATALOG } from "../src/lib/permission-catalog";

// Data Management (2026-10-20) opened to everyone who holds dashboard:view, because it now
// carries the Dashboard's old Data Quality tab and Data source health. The one tool that
// needs more, Reconcile with Scheduler, keeps employees:edit — on the page AND in its
// server action, since hiding a button is not a gate.
//
// 2026-10-21: the page has its own permission, data-management:view, so a role can be given
// it without the whole Dashboard. It was seeded to match dashboard:view, so nobody's access
// moved; widening it is a tick on Role Permissions.

const src = (rel: string) => readFileSync(join(__dirname, "..", "src", rel), "utf8");

test("the Data Management route takes its own permission, and the default roles that held the page still do", () => {
  assert.equal(permissionForPath("/admin/data-management"), "data-management:view");
  for (const role of ["MANAGER", "PM", "SALES", "ELT"] as const) {
    assert.ok(hasPermission(role, "data-management:view"), `${role} holds data-management:view`);
  }
  assert.ok(!hasPermission("ALL", "data-management:view"), "the base role still does not");
});

test("by default it is held by exactly the roles that hold dashboard:view — nobody gained or lost the page", () => {
  for (const role of ROLES) {
    assert.equal(
      hasPermission(role, "data-management:view"),
      hasPermission(role, "dashboard:view"),
      `${role}: data-management:view should start out equal to dashboard:view`,
    );
  }
});

test("it has a row on the Role Permissions page, in Administration", () => {
  const entry = PERMISSION_CATALOG.find((e) => (e.keys as readonly string[]).includes("data-management:view"));
  assert.ok(entry, "no matrix row — nobody could tick it");
  assert.equal(entry!.section, "Administration");
  assert.equal(entry!.label, "Data Management");
});

test("the migration seeds it from dashboard:view per role, skips ELT, and never overwrites a row", () => {
  const sql = readFileSync(
    join(__dirname, "..", "prisma", "migrations", "20261021130000_add_data_management_permission", "migration.sql"),
    "utf8",
  ).replace(/--[^\n]*/g, "");
  // Copies the live value rather than hard-coding which roles had the page.
  assert.match(
    sql,
    /SELECT src\.`role`, 'data-management:view', src\.`enabled`[\s\S]*?FROM `RolePermission` AS src\s+WHERE src\.`permission` = 'dashboard:view' AND src\.`role` <> 'ELT'/,
  );
  // An explicit OFF for each editable role, and ELT never gets a row.
  for (const role of ["ALL", "MANAGER", "PM", "SALES"]) assert.match(sql, new RegExp(`'${role}',\\s+'data-management:view', FALSE`));
  assert.doesNotMatch(sql, /'ELT',\s+'data-management:view'/);
  // Both inserts are no-ops on a row that already exists, so re-running cannot revoke a tick.
  assert.equal((sql.match(/ON DUPLICATE KEY UPDATE `(RolePermission`\.`)?id` = `(RolePermission`\.`)?id`;/g) ?? []).length, 2);
  // The source is aliased: an unqualified `id` in an INSERT ... SELECT from the same table is
  // MySQL error 1052, which is how this migration first failed.
  assert.match(sql, /ON DUPLICATE KEY UPDATE `RolePermission`\.`id` = `RolePermission`\.`id`;/);
  assert.doesNotMatch(sql, /\b(DELETE|UPDATE `RolePermission`|DROP|TRUNCATE)\b/i);
});

test("only roles that can edit the roster hold the permission Reconcile needs", () => {
  assert.ok(hasPermission("ELT", "employees:edit"));
  for (const role of ["MANAGER", "PM", "SALES", "ALL"] as const) {
    assert.ok(!hasPermission(role, "employees:edit"), `${role} does not hold employees:edit by default`);
  }
});

test("the page renders Reconcile only for employees:edit, and its server action checks the same", () => {
  const page = src("app/(app)/admin/data-management/page.tsx");
  assert.match(page, /requirePagePermission\("data-management:view"\)/);
  assert.doesNotMatch(page, /requirePagePermission\("dashboard:view"\)/, "the page must not still ride on the Dashboard");
  assert.match(page, /const canReconcile = hasPermission\(session\.user\.role, "employees:edit"\);/);
  assert.match(page, /\{canReconcile && \(/);
  // The button must sit inside that condition, not beside it.
  assert.ok(page.indexOf("{canReconcile && (") < page.indexOf("<ReconcileRosterButton"), "button is after the gate");

  const actions = src("lib/employee-actions.ts");
  const fn = actions.slice(actions.indexOf("export async function reconcileSchedulerRosterAction("));
  assert.match(fn.slice(0, 200), /await assertActionPermission\("employees:edit"\);/);
});

test("the action that returns a named person's whole punch history takes the page's permission", () => {
  // It is a server action, so anyone who can POST can call it: it has to ask for exactly what the
  // page it is hosted on asks for, or widening the page would not widen it (a broken drill) and
  // narrowing it would not narrow it (a leak).
  const s = src("lib/data-quality-actions.ts");
  const fn = s.slice(s.indexOf("export async function getEmployeePunches("));
  assert.match(fn, /^\s*await assertActionPermission\("data-management:view"\);/m);
  assert.equal(permissionForPath("/admin/data-management"), "data-management:view");
});

test("the Dashboard no longer carries the Data Quality section or the source-health card", () => {
  const page = src("app/(app)/page.tsx");
  assert.doesNotMatch(page, /DataQualityPanel|RefreshScheduleCard|getDataQuality/);
});

// Last in the file on purpose: it installs a matrix, which the tests above would otherwise inherit.
test("a role given Data Management alone sees that page and not the Dashboard, and it never becomes the fallback", () => {
  setOwnPermissions({
    ALL: ["job-hour-details:view", "data-management:view"],
    MANAGER: ["job-hour-details:view"],
    PM: ["job-hour-details:view"],
    SALES: ["job-hour-details:view"],
    ELT: [],
  });
  assert.ok(hasPermission("ALL", "data-management:view"));
  assert.ok(!hasPermission("ALL", "dashboard:view"), "ticking Data Management must not hand over the Dashboard");
  // A denied redirect still lands on Job Details, not on the admin page.
  assert.equal(safeFallbackPath("ALL"), "/job-hours");
  const dm = ROUTE_PERMISSIONS.findIndex((r) => r.path === "/admin/data-management");
  const jobHours = ROUTE_PERMISSIONS.findIndex((r) => r.path === "/job-hours");
  assert.ok(dm > jobHours, "Data Management stays listed after Job Details");
});
