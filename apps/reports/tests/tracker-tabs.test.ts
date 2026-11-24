import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Internal Projects' three top pages — Projects, Timeline, People and time — are tabs across the
// top of the pages (modules/tracker/components/TrackerTabs.tsx), not three separate sidebar
// entries. This was the arrangement before the tracker became a tool of its own, restored
// 2026-11-24. Source-read, like refresh-data-placement.test.ts, because it is a placement
// decision a diff hides, and the failure mode is two navigations for one set of pages.

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const TOP_PAGES = {
  "src/app/(app)/tracker/page.tsx": "projects",
  "src/app/(app)/tracker/timeline/page.tsx": "timeline",
  "src/app/(app)/tracker/people/page.tsx": "people",
} as const;

test("each tracker top page renders the tab strip with its own tab active", () => {
  for (const [path, active] of Object.entries(TOP_PAGES)) {
    assert.match(read(path), new RegExp(`<TrackerTabs active="${active}"`), `${path} marks its own tab active`);
  }
});

test("the sidebar lists the tracker as one item, not one per page", () => {
  const sidebar = read("src/components/Sidebar.tsx");
  assert.ok(sidebar.includes('href: "/tracker"'), "the one Projects entry stays");
  assert.ok(!sidebar.includes('href: "/tracker/timeline"'), "Timeline is a tab, not a sidebar item");
  assert.ok(!sidebar.includes('href: "/tracker/people"'), "People and time is a tab, not a sidebar item");
});
