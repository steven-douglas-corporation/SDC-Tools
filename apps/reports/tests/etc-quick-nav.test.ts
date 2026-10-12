import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  activeSectionIndex,
  mapAcross,
  scrollLeftForCenter,
  scrollLeftForSection,
  visibleWindow,
} from "../src/lib/etc-quick-nav";

// Grid: frozen columns take [0, 300). Three blocks of 600 / 200 / 100 content px.
const content = [
  { start: 300, end: 900 },
  { start: 900, end: 1100 },
  { start: 1100, end: 1200 },
];
// The bar gives the narrow blocks more room than their true share: 300 / 150 / 100.
const bar = [
  { start: 0, end: 300 },
  { start: 300, end: 450 },
  { start: 450, end: 550 },
];

test("mapAcross is linear inside a segment and uses segment edges as breakpoints", () => {
  assert.equal(mapAcross(600, content, bar), 150); // halfway through block 0
  assert.equal(mapAcross(900, content, bar), 300); // the shared edge
  assert.equal(mapAcross(1000, content, bar), 375); // halfway through block 1
  assert.equal(mapAcross(1150, content, bar), 500);
});

test("mapAcross clamps outside the range and round-trips", () => {
  assert.equal(mapAcross(0, content, bar), 0);
  assert.equal(mapAcross(5000, content, bar), 550);
  for (const x of [320, 600, 899, 1000, 1180]) {
    assert.ok(Math.abs(mapAcross(mapAcross(x, content, bar), bar, content) - x) < 1e-9);
  }
});

test("mapAcross returns 0 for mismatched or empty spans rather than NaN", () => {
  assert.equal(mapAcross(10, [], []), 0);
  assert.equal(mapAcross(10, content, bar.slice(1)), 0);
});

test("scrollLeftForSection centres a block that fits in the window, clamped to the scroll range", () => {
  // 1000 wide scroller, 300 frozen -> window is 700 wide. A 200 block at 2000-2200 has
  // its centre (2100) at window centre: scrollLeft + 300 + 350 = 2100 -> 1450.
  assert.equal(scrollLeftForSection({ start: 2000, end: 2200 }, 300, 1000, 5000), 1450);
  // Near the start there is not enough to the left to centre: stop at 0.
  assert.equal(scrollLeftForSection({ start: 300, end: 500 }, 300, 1000, 5000), 0);
  // The last block cannot be centred once the grid runs out of content.
  assert.equal(scrollLeftForSection({ start: 1100, end: 1200 }, 300, 1000, 150), 150);
  assert.equal(scrollLeftForSection({ start: 1100, end: 1200 }, 300, 1000, -20), 0);
});

test("scrollLeftForSection left-aligns a block wider than the window instead of cutting both ends", () => {
  // 600 wide block in a 700 wide window still fits -> centred.
  assert.equal(scrollLeftForSection({ start: 900, end: 1500 }, 300, 1000, 5000), 550);
  // 3500 wide block in a 700 wide window -> its first column goes just after the frozen ones.
  assert.equal(scrollLeftForSection({ start: 300, end: 3800 }, 300, 1000, 5000), 0);
  assert.equal(scrollLeftForSection({ start: 1000, end: 4500 }, 300, 1000, 5000), 700);
});

test("scrollLeftForCenter centres the visible window and honours the grab offset", () => {
  // 800 wide scroller, 300 frozen -> window is 500 wide.
  const base = { clientWidth: 800, stickyWidth: 300, maxScroll: 1000 };
  // Window centre at 1000 -> window starts at 750 -> scrollLeft 450.
  assert.equal(scrollLeftForCenter({ ...base, contentX: 1000, grabOffset: 0 }), 450);
  // Grabbed 50px right of centre: the centre sits 50px left of the pointer.
  assert.equal(scrollLeftForCenter({ ...base, contentX: 1000, grabOffset: 50 }), 400);
  assert.equal(scrollLeftForCenter({ ...base, contentX: 0, grabOffset: 0 }), 0);
  assert.equal(scrollLeftForCenter({ ...base, contentX: 99999, grabOffset: 0 }), 1000);
});

test("visibleWindow excludes the frozen columns", () => {
  assert.deepEqual(visibleWindow(0, 800, 300), { start: 300, end: 800 });
  assert.deepEqual(visibleWindow(450, 800, 300), { start: 750, end: 1250 });
});

test("activeSectionIndex picks the block with the most on screen, and -1 for none", () => {
  assert.equal(activeSectionIndex(content, { start: 300, end: 800 }), 0);
  // Mostly block 1 and 2 at the far right; block 1 has more of the window.
  assert.equal(activeSectionIndex(content, { start: 950, end: 1200 }), 1);
  // A sliver of block 0 against a full block 1.
  assert.equal(activeSectionIndex(content, { start: 880, end: 1100 }), 1);
  assert.equal(activeSectionIndex(content, { start: 5000, end: 6000 }), -1);
  assert.equal(activeSectionIndex([], { start: 0, end: 10 }), -1);
});

test("the grid marks exactly the five main blocks the bar navigates to", () => {
  const page = readFileSync(join(process.cwd(), "src", "app", "(app)", "etc", "page.tsx"), "utf8");
  // Phase blocks are labelled from the data, so the marker is on the phase header cell;
  // the other two are fixed header cells.
  assert.match(page, /data-etc-nav=\{p\.label\}/);
  assert.match(page, /data-etc-nav="Total \(New ETC\)"/);
  assert.match(page, /data-etc-nav="Parts Cost"/);
  assert.match(page, /<EtcQuickNav \/>/);
});
