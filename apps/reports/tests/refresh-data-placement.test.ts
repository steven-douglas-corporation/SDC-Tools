import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Refresh Data: there must be exactly ONE of it on screen. As of 2026-11-23 it lives on the
// Data Management page (the Data sources tab), not the sidebar.
//
// These read source rather than render, because what is being asserted is a placement decision
// that has moved several times (§25 removed a duplicate, §29 re-added one in the ETC toolbar and
// hid the sidebar copy, §41.16 put one back in the sidebar, and 2026-11-23 moved it onto Data
// Management — it pulls Reports' OWN sources into the warehouse, so it belongs beside the source
// freshness it affects, not in a footer shared by every tool). Each move looked like "moved a
// button" in a diff, and each time the failure mode was TWO buttons for one action — which a unit
// test can still catch by counting call sites.

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const DATA_MANAGEMENT = "src/app/(app)/admin/data-management/page.tsx";

test("the Monthly ETC page renders no Refresh Data button of its own", () => {
  const page = read("src/app/(app)/etc/page.tsx");
  assert.ok(!page.includes("<RefreshDataButton"), "the ETC toolbar must not render its own Refresh Data");
  assert.ok(
    !/^import \{ RefreshDataButton \}/m.test(page),
    "and it should not still import the component it no longer uses",
  );
});

test("the Data Management page renders Refresh Data", () => {
  // Its new home: the Data sources tab already shows each source's freshness, so the control
  // that refreshes them sits beside it.
  const page = read(DATA_MANAGEMENT);
  assert.ok(page.includes("<RefreshDataButton"), "Refresh Data belongs on the Data Management page");
});

test("the sidebar no longer renders Refresh Data (it moved to Data Management)", () => {
  // The regression this now guards: adding Refresh Data back to the global footer, where it
  // showed on Internal Projects and Admin — tools whose data that pass does not touch.
  const sidebar = read("src/components/Sidebar.tsx");
  assert.ok(!sidebar.includes("<RefreshDataButton"), "the sidebar must not render Refresh Data any more");
  assert.ok(
    !/^import \{ RefreshDataButton \}/m.test(sidebar),
    "and it should not still import the component it no longer uses",
  );
  // App Refresh — the tab reload — stays in the sidebar; it is a different control.
  assert.ok(sidebar.includes("<AppRefreshButton"), "App Refresh stays in the sidebar");
});

test("exactly one component in the app renders Refresh Data", () => {
  // The invariant behind all of the above: one button on screen. Counting call sites is the
  // only way to state it without a browser.
  const files = [
    DATA_MANAGEMENT,
    "src/components/Sidebar.tsx",
    "src/app/(app)/etc/page.tsx",
    "src/app/(app)/quoted/page.tsx",
    "src/app/(app)/dashboard/page.tsx",
    "src/app/(app)/jobs/page.tsx",
    "src/app/(app)/employees/page.tsx",
  ];
  const renderers = files.filter((f) => {
    try {
      return read(f).includes("<RefreshDataButton");
    } catch {
      return false; // a route that does not exist cannot render a second button
    }
  });
  assert.deepEqual(renderers, [DATA_MANAGEMENT], "only the Data Management page may render it");
});
