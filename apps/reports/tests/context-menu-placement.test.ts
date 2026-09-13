import { test } from "node:test";
import assert from "node:assert/strict";
import { placeContextMenu } from "../src/lib/job-cell-menu";

// ── The Job cell right-click menu opened far below the cursor ───────────────
//
// Reported 2026-08-28. Root cause: globals.css puts `zoom: var(--app-zoom)` on
// <html> (lib/app-zoom.ts, §45). A `position: fixed` child of document.body is
// inside that zoomed root, so a `top` of N paints at N x zoom physical pixels —
// while MouseEvent's clientX/clientY are unzoomed viewport pixels. Assigning
// `top: clientY` misses by `clientY x (zoom - 1)`.
//
// Measured in a real browser with a real right-click at app zoom 1.25:
// clientY 756, menu painted at 945 — 189px below the cursor, exactly the
// symptom. At 0.8 the same click landed 100px HIGH.
//
// The portal, `position: fixed`, the clientX/clientY source and the edge flip
// were all already correct — the zoom conversion was the whole bug.

/** Where the browser actually paints it: layout px x zoom. */
const painted = (p: { x: number; y: number }, zoom: number) => ({ x: p.x * zoom, y: p.y * zoom });

const MENU = { width: 213, height: 96 };
const VIEW = { viewportWidth: 1440, viewportHeight: 900 };

test("the menu lands next to the cursor at 100%", () => {
  const p = placeContextMenu({ clientX: 300, clientY: 500, ...VIEW, ...MENU, zoom: 1 });
  const s = painted(p, 1);
  assert.ok(Math.abs(s.x - 300) <= 4, `x off by ${s.x - 300}`);
  assert.ok(Math.abs(s.y - 500) <= 4, `y off by ${s.y - 500}`);
});

test("it stays ADJACENT to the cursor at every app zoom level", () => {
  // The regression, stated as the invariant it broke. Before the fix the y
  // error was clientY x (zoom - 1): +189px at 1.25, -100px at 0.8.
  //
  // "Adjacent" rather than "below", because near the bottom of the viewport
  // opening upward is correct — at zoom 1.5 a click at clientY 756 is 84% of
  // the way down a 900px viewport and the menu genuinely does not fit under it.
  // So the test is that one EDGE of the menu meets the cursor, either way up.
  for (const zoom of [0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5]) {
    for (const clientY of [50, 200, 500, 756]) {
      const p = placeContextMenu({ clientX: 300, clientY, ...VIEW, ...MENU, zoom });
      const s = painted(p, zoom);
      const top = s.y;
      const bottom = s.y + MENU.height * zoom;
      const gap = Math.min(Math.abs(top - clientY), Math.abs(bottom - clientY));
      assert.ok(
        gap <= 6,
        `zoom ${zoom}, clientY ${clientY}: menu spans ${Math.round(top)}-${Math.round(bottom)}, nearest edge ${Math.round(gap)}px from the cursor`,
      );
    }
  }
});

test("it sits beside the pointer, never exactly under it", () => {
  // A menu whose first item is directly beneath the cursor eats the next click.
  const p = placeContextMenu({ clientX: 300, clientY: 300, ...VIEW, ...MENU, zoom: 1 });
  assert.notEqual(p.x, 300);
  assert.notEqual(p.y, 300);
});

test("it flips up and left near the bottom-right corner", () => {
  const p = placeContextMenu({ clientX: 1400, clientY: 870, ...VIEW, ...MENU, zoom: 1 });
  assert.ok(p.x < 1400, "should flip left");
  assert.ok(p.y < 870, "should flip up");
});

test("it is never off-screen, at any zoom or corner", () => {
  for (const zoom of [0.75, 1, 1.25, 1.5]) {
    for (const [cx, cy] of [
      [0, 0], [1439, 899], [1400, 20], [20, 880], [720, 450],
    ] as const) {
      const p = placeContextMenu({ clientX: cx, clientY: cy, ...VIEW, ...MENU, zoom });
      const s = painted(p, zoom);
      assert.ok(s.x >= 0, `zoom ${zoom} (${cx},${cy}): x ${s.x} < 0`);
      assert.ok(s.y >= 0, `zoom ${zoom} (${cx},${cy}): y ${s.y} < 0`);
      assert.ok(s.x + MENU.width * zoom <= VIEW.viewportWidth + 1, `zoom ${zoom} (${cx},${cy}): overflows right`);
      assert.ok(s.y + MENU.height * zoom <= VIEW.viewportHeight + 1, `zoom ${zoom} (${cx},${cy}): overflows bottom`);
    }
  }
});

test("a menu taller than the viewport still starts on screen", () => {
  // Clamp-after-flip: flipping alone would give a negative offset here.
  const p = placeContextMenu({ clientX: 300, clientY: 800, ...VIEW, width: 213, height: 2000, zoom: 1 });
  assert.ok(p.y >= 0, `y should not be negative, got ${p.y}`);
});

test("zoom 0 or NaN is treated as 100% rather than dividing by zero", () => {
  // currentZoom() reads a CSS custom property; an empty/unset value must not
  // produce Infinity and throw the menu into the void.
  for (const zoom of [0, Number.NaN]) {
    const p = placeContextMenu({ clientX: 300, clientY: 300, ...VIEW, ...MENU, zoom });
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), `zoom ${zoom} produced ${p.x},${p.y}`);
  }
});
