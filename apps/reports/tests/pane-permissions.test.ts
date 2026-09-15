import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { paneAllowed, permittedRoutePaths } from "../src/lib/pane-permissions";
import { openableRoutes } from "../src/lib/workspace";
import { SPLIT_ROUTES } from "../src/lib/split-view";

// ── A tab the role cannot see refuses in ITS pane, not by ejecting the workspace ─
//
// REPORTED 2026-09-14: the tab bar offered every SPLIT_ROUTE regardless of role, and a
// tab whose page the role cannot see rendered the page body, whose own
// requirePagePermission() redirect()ed the WHOLE /w route away — on load, and again
// on every `permissions` realtime event's router.refresh(). lib/pane-permissions.ts
// carries the pre-check; these pin the rule and the two places that apply it.

test("paneAllowed is an exact match after normalization — never a prefix", () => {
  const permitted = ["/", "/job-hours", "/etc/"];
  assert.equal(paneAllowed("/job-hours", permitted), true);
  assert.equal(paneAllowed("/etc", permitted), true, "a trailing slash on either side is the same route");
  assert.equal(paneAllowed("/etc/", permitted), true);
  assert.equal(paneAllowed("/", permitted), true);
  assert.equal(paneAllowed("/hours", permitted), false);
  assert.equal(paneAllowed("/job-hours-x", permitted), false, "no prefix matching");
  assert.equal(paneAllowed("/quoted", []), false);
});

test("ELT sees every pane route; the empty role sees none", () => {
  const elt = permittedRoutePaths("ELT");
  for (const r of SPLIT_ROUTES) assert.ok(paneAllowed(r.path, elt), `${r.path} should be visible to ELT`);
  assert.deepEqual(permittedRoutePaths(null), []);
  assert.deepEqual(permittedRoutePaths(undefined), []);
});

test("permittedRoutePaths is the layout's own visibleHrefs rule, verbatim", () => {
  // If the sidebar and the pane pre-check ever computed this differently, a page could
  // be offered in one place and refused in the other — the exact drift the shared map
  // exists to prevent. Pinned against the layout's source rather than trusted.
  const layout = readFileSync(join(process.cwd(), "src", "app", "(app)", "layout.tsx"), "utf8");
  assert.match(layout, /ROUTE_PERMISSIONS\.filter\(\(r\) => hasPermission\(role, r\.permission\)\)\.map\(\(r\) => r\.path\)/);
  assert.match(layout, /if \(hasPermission\(role, "dashboard:view"\)\) visibleHrefs\.push\("\/"\)/);
  const lib = readFileSync(join(process.cwd(), "src", "lib", "pane-permissions.ts"), "utf8");
  assert.match(lib, /ROUTE_PERMISSIONS\.filter\(\(r\) => hasPermission\(role, r\.permission\)\)\.map\(\(r\) => r\.path\)/);
  assert.match(lib, /if \(hasPermission\(role, "dashboard:view"\)\) out\.push\("\/"\)/);
});

test("the tab bar offers only what the role may see", () => {
  const offered = openableRoutes(["/etc", "/hours"]).map((r) => r.path);
  assert.deepEqual(offered, ["/etc", "/hours"]);
  assert.equal(openableRoutes(null).length, SPLIT_ROUTES.length, "unknown yet: offer everything, never nothing");
  assert.equal(openableRoutes(undefined).length, SPLIT_ROUTES.length);
  assert.deepEqual(openableRoutes([]), [], "a role with no pages gets no picker entries");
  const bar = readFileSync(join(process.cwd(), "src", "components", "WorkspaceTabBar.tsx"), "utf8");
  assert.match(bar, /const permitted = usePermittedRoutes\(\);/);
  assert.match(bar, /const openable = openableRoutes\(permitted\);/);
  assert.ok(!/openableRoutes\(\)/.test(bar), "no unfiltered call left");
  const sidebar = readFileSync(join(process.cwd(), "src", "components", "Sidebar.tsx"), "utf8");
  assert.match(sidebar, /publishPermittedRoutes\(visibleHrefs\);/, "the sidebar publishes the same list it filters on");
});

test("PaneView renders the in-pane refusal instead of letting the page-level redirect fire", () => {
  const paneView = readFileSync(join(process.cwd(), "src", "components", "PaneView.tsx"), "utf8");
  const code = paneView.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.match(code, /paneAllowed\(pane\.path, permittedRoutePaths\(session\?\.user\?\.role\)\)/);
  assert.match(code, /title="You no longer have access to this page"/);
  // Still not a second gate: the page body's requirePagePermission remains the check
  // that actually refuses; this only decides what a refusal looks like inside a pane.
  assert.ok(!/requirePagePermission|assertPermission|redirect\(/.test(code), "PaneView must not redirect or add its own gate");
});
