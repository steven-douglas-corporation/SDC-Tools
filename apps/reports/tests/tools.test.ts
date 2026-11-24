import { test } from "node:test";
import assert from "node:assert/strict";
import { adminFor, isTrackerPath, toolForPath, toolsFor } from "../src/lib/tools";
import { ROUTE_PERMISSIONS, permissionForPath, safeFallbackPath } from "../src/lib/route-permissions";
import { ROLES } from "../src/lib/permissions";

test("a tool is offered only when the person may open one of its pages", () => {
  assert.deepEqual(toolsFor([]), []);
  // Admin pages are shared by every tool, so on their own they make no tool.
  assert.deepEqual(toolsFor(["/feedback", "/audit-log", "/admin/users"]), []);
  assert.deepEqual(
    toolsFor(["/job-hours", "/etc"]).map((t) => [t.id, t.href]),
    [["reports", "/job-hours"]],
  );
  // Internal Projects (/tracker) is a Reports page now, so it folds into the one Reports tile
  // rather than earning its own; the Dashboard still wins the landing when the person holds it.
  assert.deepEqual(
    toolsFor(["/job-hours", "/dashboard", "/tracker"]).map((t) => [t.id, t.href]),
    [["reports", "/dashboard"]],
  );
  // A tracker-only role still gets a tool: the Reports tile, landing on /tracker.
  assert.deepEqual(
    toolsFor(["/tracker", "/feedback"]).map((t) => [t.id, t.href]),
    [["reports", "/tracker"]],
  );
});

test("a page belongs to one tool, and the tools page to none", () => {
  assert.equal(toolForPath("/"), null);
  // Internal Projects pages show the Reports menu (their link lives in Reports' Planning group).
  assert.equal(toolForPath("/tracker"), "reports");
  assert.equal(toolForPath("/tracker/ALPHA/7"), "reports");
  for (const path of ["/dashboard", "/etc", "/w", "/split"]) assert.equal(toolForPath(path), "reports");
  // Admin is an area of its own, with its own menu, and is never counted as a tool. The audit
  // log belongs here too — it records every tool's actions, not only Reports'.
  for (const path of ["/feedback", "/admin/users", "/admin/permissions", "/audit-log"])
    assert.equal(toolForPath(path), "admin");
  // Data Management has an /admin address but shows Reports' menu — it is about Reports' data.
  assert.equal(toolForPath("/admin/data-management"), "reports");
});

test("isTrackerPath marks the Internal Projects pages (used for feedback tagging)", () => {
  assert.equal(isTrackerPath("/tracker"), true);
  assert.equal(isTrackerPath("/tracker/ALPHA/7"), true);
  assert.equal(isTrackerPath("/trackers"), false, "a prefix that is not a path segment is not the tracker");
  assert.equal(isTrackerPath("/dashboard"), false);
});

test("the Admin tile shows only for a real admin page, never Feedback alone", () => {
  assert.equal(adminFor([]), null);
  assert.equal(adminFor(["/dashboard", "/feedback"]), null, "Feedback alone does not make an admin");
  assert.equal(adminFor(["/feedback", "/admin/users"])?.href, "/admin/users");
  assert.equal(adminFor(["/audit-log"])?.href, "/audit-log");
  // Lands on the most canonical admin page the person holds, not merely the first listed.
  assert.equal(adminFor(["/admin/permissions", "/admin/users"])?.href, "/admin/users");
});

test("the tools page needs no permission, the Dashboard keeps its own, and neither is a fallback", () => {
  assert.equal(permissionForPath("/"), null);
  assert.equal(permissionForPath("/dashboard"), "dashboard:view");
  assert.notEqual(ROUTE_PERMISSIONS[0]!.path, "/dashboard", "the first row is the fallback every role must hold");
  for (const role of ROLES) assert.notEqual(safeFallbackPath(role), "/");
});
