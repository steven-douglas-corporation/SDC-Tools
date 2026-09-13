import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BUTTON_PRIMARY,
  BUTTON_SECONDARY,
  BUTTON_COMPACT,
  BUTTON_COMPACT_DANGER,
  BUTTON_MENU_LINK,
  BTN_H_STANDARD,
  BTN_MIN_H_STANDARD,
  BTN_H_COMPACT,
  TOOLBAR_BTN,
  TOOLBAR_MIN_W,
  GRID_SCROLLER,
  GRID_LINE_BORDER,
  TABLE_CARD,
} from "../src/components/ui/classnames";

// §41.19-41.25. These are class strings, so a test can only check the tokens agree with
// each other — the rendered geometry was measured in the browser (8 distinct heights and
// 4 radii in one toolbar band before; see DEVLOG §27). What these pin is the thing that
// drifted: two controls in the same row getting their height from different places.

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
/**
 * Declarations only. These files' comments QUOTE the geometry they replaced — that is
 * the point of the comments — so a test that greps the raw source fails on its own
 * explanation. (It did, first run.)
 */
const code = (s: string) =>
  s
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/[^\n]*$/gm, "");
const heightClasses = (s: string) => s.match(/(^|\s)h-\[[^\]]+\]|(^|\s)h-\d+(\.\d+)?/g)?.map((m) => m.trim()) ?? [];

test("everything that shares a toolbar row shares ONE height token", () => {
  // The measured defect §41.21 names: Export rendered 39px beside six 34px triggers.
  for (const [name, cls] of [
    ["BUTTON_PRIMARY", BUTTON_PRIMARY],
    ["BUTTON_SECONDARY", BUTTON_SECONDARY],
    ["TOOLBAR_BTN", TOOLBAR_BTN],
  ] as const) {
    assert.ok(cls.includes(BTN_H_STANDARD), `${name} must use BTN_H_STANDARD`);
    assert.deepEqual(heightClasses(cls), [BTN_H_STANDARD], `${name} must declare exactly one height`);
  }
});

test("the compact category shares one height, and it is smaller than standard", () => {
  for (const [name, cls] of [
    ["BUTTON_COMPACT", BUTTON_COMPACT],
    ["BUTTON_COMPACT_DANGER", BUTTON_COMPACT_DANGER],
    ["BUTTON_MENU_LINK", BUTTON_MENU_LINK],
  ] as const) {
    assert.ok(cls.includes(BTN_H_COMPACT), `${name} must use BTN_H_COMPACT`);
  }
  const rem = (h: string) => Number(h.replace(/[^\d.]/g, ""));
  assert.ok(rem(BTN_H_COMPACT) < rem(BTN_H_STANDARD), "compact must be shorter than standard");
});

test("the standard height clears §41.20's floor at the default root font", () => {
  // Root is 15px (globals.css), so Tailwind's h-9 = 2.25rem = 33.75px — under the 36px
  // §41.20 asks for. That is why the token is an explicit rem rather than h-9.
  const px = Number(BTN_H_STANDARD.replace(/[^\d.]/g, "")) * 15;
  assert.ok(px >= 36 && px <= 40, `${px}px must sit in §41.20's 36-40px band`);
  // And rem, not px, or the sidebar's Text size control desyncs the box from its label.
  assert.match(BTN_H_STANDARD, /rem\]$/, "must be rem so it scales with the root font");
  assert.match(BTN_H_COMPACT, /rem\]$/);
});

test("the min-height variant is the SAME height as the fixed one", () => {
  // BTN_MIN_H_STANDARD exists for a strip that must match the toolbar's height but is
  // allowed to wrap (the department checklist — a fixed `h-` would clip its second row).
  // Two literals in one file is the only way Tailwind's scanner can see both class names,
  // so the thing worth guarding is that they never drift apart — which is the whole
  // failure §41.21 documented, arriving by a different route.
  assert.equal(
    BTN_MIN_H_STANDARD.replace("min-h-", "h-"),
    BTN_H_STANDARD,
    "the floor and the fixed height must be the same number",
  );
});

test("every control in the Monthly ETC toolbar row shares the tokens", () => {
  // Measured before this pass: 169 / 76 / 76 / 95 / 131 / 95 px wide, at 34px and 36px
  // tall, with rounded-md next to rounded-lg. The View menu and the month/year selects
  // had never adopted TOOLBAR_BTN / BTN_H_STANDARD and were hand-rolling their own
  // geometry — which is exactly what §41.21 found the first time, in a row it did not
  // reach. A row is only as even as its least-adopted control.
  for (const [file, mustHave] of [
    ["src/components/EtcViewMenu.tsx", ["TOOLBAR_BTN", "TOOLBAR_MIN_W"]],
    ["src/components/MonthYearSelect.tsx", ["BTN_H_STANDARD", "TOOLBAR_MIN_W"]],
    ["src/components/EtcRatesButton.tsx", ["TOOLBAR_MIN_W"]],
  ] as const) {
    const src = read(file);
    for (const token of mustHave) {
      assert.ok(src.includes(token), `${file} must take its geometry from ${token}`);
    }
    // And must not go back to declaring its own height or radius inline.
    assert.ok(
      !/rounded-md border px-3\.5 py-1\.5/.test(code(src)),
      `${file}: no hand-rolled toolbar geometry`,
    );
  }
});

test("the toolbar width floor is a floor, not a fixed width", () => {
  // "Hide Standards" needs 131px. A fixed width would clip it, and clipping a label is a
  // worse answer to "make them even" than one control being wider than the rest.
  assert.match(TOOLBAR_MIN_W, /^min-w-/, "must be a minimum, so a long label still fits");
  assert.match(TOOLBAR_MIN_W, /rem\]$/, "rem, so it scales with the root font like the heights");
});

test("a compact control is still an accessible target", () => {
  // "Select all" / "Clear" measured 15px tall — the text line and nothing else.
  const px = Number(BTN_H_COMPACT.replace(/[^\d.]/g, "")) * 15;
  assert.ok(px >= 26, `${px}px is too small a click target for an in-menu action`);
});

test("one radius per category, and the categories do not disagree within themselves", () => {
  const radius = (s: string) => s.match(/rounded-\w+/g) ?? [];
  assert.deepEqual(radius(BUTTON_PRIMARY), ["rounded-lg"]);
  assert.deepEqual(radius(BUTTON_SECONDARY), ["rounded-lg"]);
  assert.deepEqual(radius(TOOLBAR_BTN), ["rounded-lg"], "toolbar triggers match the buttons beside them");
  assert.deepEqual(radius(BUTTON_COMPACT), ["rounded-md"]);
  assert.deepEqual(radius(BUTTON_COMPACT_DANGER), ["rounded-md"]);
});

test("a loading label cannot resize its button", () => {
  // §41.21 "Label movement during loading" / §36.3. A fixed height is half of it; the other
  // half is busySlot, and what must NOT be present is a transition on `all`, which animated
  // the geometry as the label changed.
  for (const cls of [BUTTON_PRIMARY, BUTTON_SECONDARY, TOOLBAR_BTN, BUTTON_COMPACT]) {
    assert.ok(!/transition-all/.test(cls), "no transition-all: it animates width/height");
    assert.ok(/h-\[/.test(cls), "a fixed height keeps a label swap from resizing the box");
  }
});

test("the three dead button tokens are gone", () => {
  // BUTTON_PRIMARY_SM, BUTTON_GHOST and BUTTON_DANGER had zero call sites — three of the
  // categories §41.22 asks to standardise did not exist in the rendered UI at all.
  // Declarations only — the comment above them explains why they went, and naming them
  // there is the point of the comment.
  const src = read("src/components/ui/classnames.ts");
  for (const dead of ["BUTTON_PRIMARY_SM", "BUTTON_GHOST", "BUTTON_DANGER"]) {
    assert.ok(
      !new RegExp(`export const ${dead}\\b`).test(src),
      `${dead} should not be reintroduced without a call site`,
    );
  }
});

// ── Table edges (§41.23, §41.24) ────────────────────────────────────────────

test("the grid's scrolling frame is the same colour as the gridlines it continues", () => {
  // TABLE_GRID gives cells a BOTTOM and LEFT border only, so the container's border IS the
  // grid's top and right edge. A different colour makes the frame two-toned and the corners
  // fail to meet.
  assert.ok(GRID_SCROLLER.includes(GRID_LINE_BORDER), "scroller border must match the gridline colour");
  assert.ok(TABLE_CARD.includes(GRID_LINE_BORDER), "and so must the static table card");
  assert.ok(!/border-sdc-border/.test(GRID_SCROLLER), "the old two-toned frame must not come back");
});

test("the scrolling frame has square corners", () => {
  // rounded-xl on a scroll container clips the corner cells' gridlines (§41.23).
  assert.ok(!/rounded/.test(GRID_SCROLLER), "a rounded frame cannot contain a square grid cleanly");
});

test("both big grids use the shared scroller rather than their own", () => {
  // They had drifted apart: ETC sharp with a #808080 top only, Projects rounded-xl.
  for (const page of ["src/app/(app)/etc/page.tsx", "src/app/(app)/quoted/page.tsx"]) {
    const src = read(page);
    assert.ok(src.includes("GRID_SCROLLER"), `${page} must use the shared scroller`);
    assert.ok(
      !/DragScroll className="[^"]*border-sdc-border/.test(src),
      `${page} must not hand-roll its own grid frame`,
    );
  }
});

test("one shadow on the frame, not per cell", () => {
  // §41.25: no expensive shadow work around a 4,272-cell grid. One shadow-sm on the
  // container, and nothing shadow-related in the per-cell grid classes.
  assert.match(GRID_SCROLLER, /(^|\s)shadow-sm(\s|$)/);
  assert.ok(!/blur|shadow-(lg|xl|2xl)/.test(GRID_SCROLLER), "no large blur around a big table");
});
