import { test } from "node:test";
import assert from "node:assert/strict";
import { computeAnchoredPosition, type Rect } from "../src/lib/anchored-position";

// This is the one positioning rule every portaled menu that anchors to a trigger
// element (rather than a cursor position) shares — see ExportMenu.tsx. The invariant
// that matters most: align="end" means the panel's right edge equals the trigger's
// right edge, exactly, whenever there is room — no unnecessary shifting, and no
// drifting toward whatever other control happens to be nearby.

function rect(left: number, top: number, width: number, height: number): Rect {
  return { left, top, right: left + width, bottom: top + height, width, height };
}

const VIEWPORT = { width: 1000, height: 800 };

test("align=end places the panel's right edge flush with the trigger's right edge", () => {
  const anchor = rect(700, 100, 80, 24); // right edge at 780
  const pos = computeAnchoredPosition(anchor, { width: 210, height: 120 }, VIEWPORT, { side: "bottom", align: "end" });
  assert.equal(pos.left + 210, 780);
});

test("side=bottom, default offset: panel starts 4px below the trigger", () => {
  const anchor = rect(700, 100, 80, 24); // bottom at 124
  const pos = computeAnchoredPosition(anchor, { width: 210, height: 120 }, VIEWPORT, { side: "bottom", align: "end" });
  assert.equal(pos.top, 128);
  assert.equal(pos.side, "bottom");
});

test("plenty of room: the panel is never shifted or centered under the toolbar", () => {
  const anchor = rect(700, 100, 80, 24);
  const pos = computeAnchoredPosition(anchor, { width: 210, height: 120 }, VIEWPORT, { side: "bottom", align: "end" });
  // Unshifted position would be anchor.right - width = 780 - 210 = 570.
  assert.equal(pos.left, 570);
});

test("flips above only when below doesn't fit AND above does", () => {
  const anchor = rect(700, 750, 80, 24); // near the bottom of an 800-tall viewport
  const pos = computeAnchoredPosition(anchor, { width: 210, height: 120 }, VIEWPORT, { side: "bottom", align: "end" });
  assert.equal(pos.side, "top");
  assert.equal(pos.top, 750 - 4 - 120);
});

test("does not flip above when below still fits, even if above would also fit", () => {
  const anchor = rect(700, 100, 80, 24);
  const pos = computeAnchoredPosition(anchor, { width: 210, height: 120 }, VIEWPORT, { side: "bottom", align: "end" });
  assert.equal(pos.side, "bottom");
});

test("stays on the preferred side when a panel taller than the viewport fits nowhere — no third option", () => {
  const anchor = rect(700, 400, 80, 24);
  const pos = computeAnchoredPosition(anchor, { width: 210, height: 900 }, VIEWPORT, { side: "bottom", align: "end" });
  assert.equal(pos.side, "bottom");
});

test("collision detection only shifts the minimum needed to stay in the viewport", () => {
  const anchor = rect(940, 100, 60, 24); // right edge at 1000, flush with the viewport edge
  const pos = computeAnchoredPosition(anchor, { width: 210, height: 120 }, VIEWPORT, { side: "bottom", align: "end", pad: 6 });
  // Unshifted would put the panel's right edge at 1000, running 6px past the pad.
  assert.equal(pos.left, VIEWPORT.width - 210 - 6);
});

test("a narrow window shifts the panel left just enough to clear the viewport's right pad", () => {
  const anchor = rect(568, 30, 68, 22); // right edge at 636, in a 640-wide viewport
  const narrow = { width: 640, height: 800 };
  const pos = computeAnchoredPosition(anchor, { width: 210, height: 60 }, narrow, { side: "bottom", align: "end" });
  assert.equal(pos.left, 640 - 210 - 6);
});

test("align=start places the panel's left edge flush with the trigger's left edge", () => {
  const anchor = rect(100, 50, 80, 24);
  const pos = computeAnchoredPosition(anchor, { width: 210, height: 120 }, VIEWPORT, { side: "bottom", align: "start" });
  assert.equal(pos.left, 100);
});

test("align=center centers the panel under the trigger's midpoint", () => {
  const anchor = rect(100, 50, 80, 24); // midpoint at 140
  const pos = computeAnchoredPosition(anchor, { width: 200, height: 120 }, VIEWPORT, { side: "bottom", align: "center" });
  assert.equal(pos.left, 40); // 140 - 200/2
});

test("side=top opens above with the same sideOffset gap", () => {
  const anchor = rect(700, 400, 80, 24);
  const pos = computeAnchoredPosition(anchor, { width: 210, height: 120 }, VIEWPORT, { side: "top", align: "end", sideOffset: 6 });
  assert.equal(pos.side, "top");
  assert.equal(pos.top, 400 - 6 - 120);
});

test("a custom sideOffset changes only the gap, not the horizontal placement", () => {
  const anchor = rect(700, 100, 80, 24);
  const pos = computeAnchoredPosition(anchor, { width: 210, height: 120 }, VIEWPORT, { side: "bottom", align: "end", sideOffset: 10 });
  assert.equal(pos.top, 124 + 10);
  assert.equal(pos.left, 570);
});
