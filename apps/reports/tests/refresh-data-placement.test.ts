import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// §41.16/41.28 — Refresh Data belongs in the sidebar, and there must be exactly ONE of it
// on screen on every route.
//
// These read source rather than render, because what is being asserted is a placement
// decision that has now been reversed twice (§25 removed a duplicate, §29 re-added one in
// the ETC toolbar and hid the sidebar copy, §41.16 reversed that). Each reversal looked
// like "moved a button" in a diff, and each time the failure mode was TWO buttons for one
// action — which is a UI question a unit test can still answer by counting call sites.

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("the Monthly ETC page renders no Refresh Data button of its own", () => {
  const page = read("src/app/(app)/etc/page.tsx");
  assert.ok(!page.includes("<RefreshDataButton"), "the ETC toolbar must not render its own Refresh Data");
  assert.ok(
    !/^import \{ RefreshDataButton \}/m.test(page),
    "and it should not still import the component it no longer uses",
  );
});

test("the sidebar renders Refresh Data unconditionally, on every route", () => {
  const sidebar = read("src/components/Sidebar.tsx");
  assert.ok(sidebar.includes("<RefreshDataButton"), "the sidebar must render Refresh Data");
  // The regression this guards: §29 wrapped it in `pathname !== "/etc" && (...)`, which
  // left Monthly ETC — the page people actually refresh — with no sidebar control at all.
  assert.ok(
    !/pathname\s*!==\s*["']\/etc["']\s*&&/.test(sidebar),
    "Refresh Data must not be route-gated: every page needs the one application-wide control",
  );
});

test("it stays reachable when the sidebar is collapsed to a rail", () => {
  // §29's objection to a sidebar-only button was that the sidebar collapses and "a control
  // nobody can find is not a control". The answer is the compact rail rendering, not a
  // second button — so if `compact` ever stops being wired, that objection becomes true.
  const sidebar = read("src/components/Sidebar.tsx");
  const call = sidebar.slice(sidebar.indexOf("<RefreshDataButton"));
  assert.match(call.slice(0, 400), /compact=\{collapsed\}/, "the rail must still render it as an icon");
});

test("exactly one component in the app renders Refresh Data", () => {
  // The invariant behind all of the above: one button on screen. Counting call sites is
  // the only way to state it without a browser.
  const files = [
    "src/components/Sidebar.tsx",
    "src/app/(app)/etc/page.tsx",
    "src/app/(app)/quoted/page.tsx",
    "src/app/(app)/page.tsx",
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
  assert.deepEqual(renderers, ["src/components/Sidebar.tsx"], "only the sidebar may render it");
});
