import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { permissionForPath } from "../src/lib/route-permissions";
import { hasPermission } from "../src/lib/permissions";

// Data Management (2026-10-20) opened to everyone who holds dashboard:view, because it now
// carries the Dashboard's old Data Quality tab and Data source health. The one tool that
// needs more, Reconcile with Scheduler, keeps employees:edit — on the page AND in its
// server action, since hiding a button is not a gate.

const src = (rel: string) => readFileSync(join(__dirname, "..", "src", rel), "utf8");

test("the Data Management route takes dashboard:view, so manager, PM and sales roles reach it", () => {
  assert.equal(permissionForPath("/admin/data-management"), "dashboard:view");
  for (const role of ["MANAGER", "PM", "SALES", "ELT"] as const) {
    assert.ok(hasPermission(role, "dashboard:view"), `${role} holds dashboard:view`);
  }
});

test("only roles that can edit the roster hold the permission Reconcile needs", () => {
  assert.ok(hasPermission("ELT", "employees:edit"));
  for (const role of ["MANAGER", "PM", "SALES", "ALL"] as const) {
    assert.ok(!hasPermission(role, "employees:edit"), `${role} does not hold employees:edit by default`);
  }
});

test("the page renders Reconcile only for employees:edit, and its server action checks the same", () => {
  const page = src("app/(app)/admin/data-management/page.tsx");
  assert.match(page, /requirePagePermission\("dashboard:view"\)/);
  assert.match(page, /const canReconcile = hasPermission\(session\.user\.role, "employees:edit"\);/);
  assert.match(page, /\{canReconcile && \(/);
  // The button must sit inside that condition, not beside it.
  assert.ok(page.indexOf("{canReconcile && (") < page.indexOf("<ReconcileRosterButton"), "button is after the gate");

  const actions = src("lib/employee-actions.ts");
  const fn = actions.slice(actions.indexOf("export async function reconcileSchedulerRosterAction("));
  assert.match(fn.slice(0, 200), /await assertActionPermission\("employees:edit"\);/);
});

test("the Dashboard no longer carries the Data Quality tab or the source-health card", () => {
  const page = src("app/(app)/page.tsx");
  assert.doesNotMatch(page, /DataQualityPanel|RefreshScheduleCard|getDataQuality|DashboardTabs/);
});
