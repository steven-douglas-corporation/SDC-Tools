import { test } from "node:test";
import assert from "node:assert/strict";
import { toolForPath, toolsFor } from "../src/lib/tools";
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
  assert.deepEqual(
    toolsFor(["/job-hours", "/dashboard", "/tracker"]).map((t) => [t.id, t.href]),
    [
      ["reports", "/dashboard"],
      ["tracker", "/tracker"],
    ],
  );
  assert.deepEqual(
    toolsFor(["/tracker", "/feedback"]).map((t) => t.id),
    ["tracker"],
  );
});

test("a page belongs to one tool, and the tools page to none", () => {
  assert.equal(toolForPath("/"), null);
  assert.equal(toolForPath("/tracker"), "tracker");
  assert.equal(toolForPath("/tracker/ALPHA/7"), "tracker");
  assert.equal(toolForPath("/trackers"), "reports", "a prefix that is not a path segment is not the tracker");
  for (const path of ["/dashboard", "/etc", "/w", "/split"]) assert.equal(toolForPath(path), "reports");
  // Admin is an area of its own, with its own menu, and is never counted as a tool.
  for (const path of ["/feedback", "/admin/users", "/admin/permissions"]) assert.equal(toolForPath(path), "admin");
  // Reports' own housekeeping shows Reports' menu, though one of them has an /admin address.
  for (const path of ["/audit-log", "/admin/data-management"]) assert.equal(toolForPath(path), "reports");
});

test("the tools page needs no permission, the Dashboard keeps its own, and neither is a fallback", () => {
  assert.equal(permissionForPath("/"), null);
  assert.equal(permissionForPath("/dashboard"), "dashboard:view");
  assert.notEqual(ROUTE_PERMISSIONS[0]!.path, "/dashboard", "the first row is the fallback every role must hold");
  for (const role of ROLES) assert.notEqual(safeFallbackPath(role), "/");
});
