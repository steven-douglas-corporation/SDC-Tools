import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  canAbsorb,
  chooseHandoff,
  containsOverscroll,
  roomToScroll,
  scrollsVertically,
  wheelPixels,
  zoomScale,
  type ScrollNode,
} from "../src/lib/scroll-handoff";

// ── What these guard ────────────────────────────────────────────────────────
//
// ScrollHandoff is the app's ONLY wheel listener, and it is on `document`, so a
// mistake in it is not a mistake on one page — it is a mistake everywhere at once,
// in both directions: too eager and the page lurches while a table still had room
// (or scrolls behind an open modal), too shy and the table stays stuck, which is the
// bug it exists to fix.
//
// The decision is therefore a pure function over plain descriptors and is tested
// directly. Its DOM half — reading real elements into those descriptors — was
// verified in the running app: at zoom 0.8, an inner container at its bottom hands a
// deltaY of 100 to the page (which moves 100), a nested element scroller receives 125
// (the 1/zoom correction below, measured: 100 units of element scrollTop travel 80
// visual px at 0.8), a container with room left is left alone, a horizontal-dominant
// gesture is ignored, `overscroll-behavior-y: contain` is honoured, deltaMode 1
// resolves to 16px per line, and a scroller inside a `position: fixed` overlay does
// not move the page behind it at either end.

const node = (n: Partial<ScrollNode> = {}): ScrollNode => ({
  fixed: false,
  overflowY: "visible",
  overscrollY: "auto",
  scrollTop: 0,
  scrollHeight: 100,
  clientHeight: 100,
  ...n,
});

/** A scroller with room on both sides. */
const scroller = (n: Partial<ScrollNode> = {}) =>
  node({ overflowY: "auto", scrollHeight: 1000, clientHeight: 200, scrollTop: 400, ...n });

const atTop = (n: Partial<ScrollNode> = {}) => scroller({ scrollTop: 0, ...n });
const atBottom = (n: Partial<ScrollNode> = {}) => scroller({ scrollTop: 800, ...n });
const plain = () => node();
const pageWithRoom = () => scroller({ scrollTop: 500 });

const UP = -100;
const DOWN = 100;

// ── Recognising a scroll container ──────────────────────────────────────────

test("only an overflowing auto/scroll container counts as a scroller", () => {
  assert.ok(scrollsVertically(scroller()));
  assert.ok(scrollsVertically(scroller({ overflowY: "scroll" })));
  assert.ok(scrollsVertically(scroller({ overflowY: "overlay" })));
  assert.ok(!scrollsVertically(scroller({ overflowY: "hidden" })), "hidden is not user-scrollable");
  assert.ok(!scrollsVertically(scroller({ overflowY: "visible" })));
  assert.ok(
    !scrollsVertically(scroller({ scrollHeight: 200, clientHeight: 200 })),
    "auto with nothing to scroll is not a scroller",
  );
});

test("a sub-pixel overflow does not make an element a scroller", () => {
  // Layout routinely leaves scrollHeight a hair over clientHeight. Treating those as
  // scrollers would put a handoff decision in front of ordinary page scrolling on
  // half the app, for containers a user can't scroll at all.
  assert.ok(!scrollsVertically(scroller({ scrollHeight: 200.5, clientHeight: 200 })));
  assert.ok(scrollsVertically(scroller({ scrollHeight: 202, clientHeight: 200 })));
});

// ── The boundary itself ─────────────────────────────────────────────────────

test("room is measured in the direction of travel", () => {
  const s = scroller({ scrollTop: 400, scrollHeight: 1000, clientHeight: 200 });
  assert.equal(roomToScroll(s, UP), 400);
  assert.equal(roomToScroll(s, DOWN), 400);
  assert.equal(roomToScroll(atTop(), UP), 0);
  assert.equal(roomToScroll(atBottom(), DOWN), 0);
});

test("a fractional scrollTop still reads as 'at the end'", () => {
  // The case that makes this necessary: §45 runs the app at 0.8 by default, and a
  // container scrolled fully to its bottom lands on 799.5 of 800. Without the 1px
  // tolerance it never reads as at the end, never hands off, and stays stuck —
  // exactly the bug this whole component exists to remove.
  assert.ok(!canAbsorb(scroller({ scrollTop: 799.5, scrollHeight: 1000, clientHeight: 200 }), DOWN));
  assert.ok(!canAbsorb(scroller({ scrollTop: 0.5 }), UP));
  assert.ok(canAbsorb(scroller({ scrollTop: 5 }), UP), "5px of room is real room");
});

// ── The decision ────────────────────────────────────────────────────────────

test("a container with room left is left entirely to the browser", () => {
  // The overwhelmingly common case, and the one that must cost nothing: native
  // scrolling is already correct, so the listener returns null and does not
  // preventDefault.
  assert.equal(chooseHandoff([scroller(), plain()], pageWithRoom(), DOWN), null);
  assert.equal(chooseHandoff([scroller(), plain()], pageWithRoom(), UP), null);
});

test("at the top, continued upward scrolling is handed to the page", () => {
  assert.equal(chooseHandoff([atTop(), plain()], pageWithRoom(), UP), "root");
});

test("at the bottom, continued downward scrolling is handed to the page", () => {
  assert.equal(chooseHandoff([atBottom(), plain()], pageWithRoom(), DOWN), "root");
});

test("at the top, scrolling DOWN is still the inner container's own business", () => {
  // The direction that is not at a boundary must never hand off, or every gesture
  // away from an edge would jump the page.
  assert.equal(chooseHandoff([atTop(), plain()], pageWithRoom(), DOWN), null);
  assert.equal(chooseHandoff([atBottom(), plain()], pageWithRoom(), UP), null);
});

test("the pointer outside any scroll container is not this component's business", () => {
  assert.equal(chooseHandoff([plain(), plain()], pageWithRoom(), DOWN), null);
});

test("with nowhere to hand off to, the event is left alone", () => {
  // A short page behind a maxed-out table: preventDefault here would suppress a
  // gesture and scroll nothing, which is worse than the stuck feeling.
  const shortPage = node({ overflowY: "auto", scrollHeight: 300, clientHeight: 300 });
  assert.equal(chooseHandoff([atBottom(), plain()], shortPage, DOWN), null);
});

test("the innermost scroller is the one that decides, not the outermost", () => {
  // A table inside a scrollable card: while the table can still move, nothing else
  // may — otherwise the card would steal the gesture from the thing under the cursor.
  const chain = [scroller(), plain(), scroller()];
  assert.equal(chooseHandoff(chain, pageWithRoom(), DOWN), null);
});

test("an inner container at its end hands off to the nearest OUTER container, not the page", () => {
  const outer = scroller();
  assert.equal(chooseHandoff([atBottom(), plain(), outer], pageWithRoom(), DOWN), 2);
});

test("an intermediate container that is also at its end is walked past, not treated as a dead end", () => {
  // page → card (at its end) → table (at its end). The gesture belongs to the page.
  assert.equal(chooseHandoff([atBottom(), atBottom()], pageWithRoom(), DOWN), "root");
});

// ── Containment and modals ──────────────────────────────────────────────────

test("overscroll-behavior-y contain/none is obeyed, not overridden", () => {
  assert.ok(containsOverscroll(node({ overscrollY: "contain" })));
  assert.ok(containsOverscroll(node({ overscrollY: "none" })));
  assert.ok(!containsOverscroll(node({ overscrollY: "auto" })));
  assert.equal(chooseHandoff([atTop({ overscrollY: "contain" })], pageWithRoom(), UP), null);
  assert.equal(chooseHandoff([atBottom({ overscrollY: "none" })], pageWithRoom(), DOWN), null);
});

test("an intermediate container that contains its overscroll stops the chain there", () => {
  assert.equal(chooseHandoff([atBottom(), atBottom({ overscrollY: "contain" })], pageWithRoom(), DOWN), null);
});

test("nothing inside a fixed overlay scrolls the page behind it", () => {
  // Modal scroll-lock, detected structurally: this codebase has modals with
  // role="dialog" and modals without it, and a rule that reads the markup would
  // silently miss the second kind. `position: fixed` is what they all share.
  const modalBody = atBottom();
  const overlay = node({ fixed: true });
  assert.equal(chooseHandoff([modalBody, overlay], pageWithRoom(), DOWN), null);
  assert.equal(chooseHandoff([atTop(), overlay], pageWithRoom(), UP), null);
});

test("a fixed overlay with no scroller of its own is inert too", () => {
  // Pointer over the static chrome of a dropdown or dialog: there is nothing to hand
  // off, and the page behind must not move.
  assert.equal(chooseHandoff([plain(), node({ fixed: true })], pageWithRoom(), DOWN), null);
});

test("a scroller INSIDE a fixed overlay still chains to the overlay's own outer scroller", () => {
  // Scroll-lock means "not the page behind", not "nothing at all": a drawer whose
  // body sits inside its own scrollable panel must still chain between the two.
  const panel = scroller();
  assert.equal(chooseHandoff([atBottom(), panel, node({ fixed: true })], pageWithRoom(), DOWN), 1);
});

// ── Units and zoom ──────────────────────────────────────────────────────────

test("wheel deltas are converted to pixels for all three delta modes", () => {
  assert.equal(wheelPixels(100, 0, 500), 100, "pixels pass through");
  assert.equal(wheelPixels(3, 1, 500), 48, "lines are 16px each");
  assert.equal(wheelPixels(1, 2, 500), 500, "a page is the container's own height");
  assert.equal(wheelPixels(-3, 1, 500), -48, "direction survives the conversion");
});

test("element scrollers are corrected for the app zoom; the page is not", () => {
  // Measured, not assumed: at zoom 0.8, 100 units of an element's scrollTop move its
  // content 80 visual px, while 100 units of the page's scrollTop move 100. So a
  // deltaY of 100 must become 125 on an element and stay 100 on the page.
  assert.equal(zoomScale(0.8, false), 1.25);
  assert.equal(zoomScale(0.8, true), 1);
  assert.equal(zoomScale(0.5, false), 2);
  assert.equal(zoomScale(1, false), 1);
});

test("a missing or nonsensical zoom falls back to no correction", () => {
  // getComputedStyle can hand back "" before the stylesheet applies. Scrolling
  // slightly the wrong distance is recoverable; NaN pixels is a scroll container that
  // stops responding entirely.
  for (const bad of [NaN, 0, -1, Infinity]) assert.equal(zoomScale(bad, false), 1);
});

// ── The listener itself ─────────────────────────────────────────────────────

test("there is exactly one wheel listener in the app, and it is the shared one", () => {
  // The point of a document-level handler is that no page adds its own. A second
  // wheel listener somewhere would fight this one, and a per-row one would be the
  // performance problem the request explicitly rules out.
  const SRC = join(import.meta.dirname, "..", "src");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry)) files.push(path);
    }
  };
  walk(SRC);
  const offenders = files.filter((f) => {
    if (f.endsWith(join("components", "ScrollHandoff.tsx"))) return false;
    const code = readFileSync(f, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/[^\n]*$/gm, "");
    return /onWheel[=\s]|addEventListener\(\s*["']wheel["']/.test(code);
  });
  assert.deepEqual(offenders, [], "wheel handling belongs in ScrollHandoff alone");
});

test("the handoff listener is non-passive and mounted once in the shell", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "src", "components", "ScrollHandoff.tsx"), "utf8");
  // Without this the browser applies its own (latched, no-op) scroll AND this scrolls
  // the outer container — the gesture counted twice.
  assert.match(src, /\{\s*passive:\s*false\s*\}/, "handing off requires preventDefault, so it cannot be passive");
  assert.match(src, /removeEventListener\("wheel"/, "the listener must be torn down");
  const shell = readFileSync(join(import.meta.dirname, "..", "src", "components", "AppShell.tsx"), "utf8");
  assert.match(shell, /<ScrollHandoff \/>/, "mounted once at the shell, like ExcelCellFocus and ColumnResize");
});

test("no scroll container traps vertical overscroll in CSS", () => {
  // The audit result, kept as a guard. `overscroll-behavior: contain` on a vertical
  // scroller is exactly the thing that makes a table swallow the gesture, and it is
  // easy to add without realising. The Job Hour Details chart's horizontal
  // `overscroll-x-contain` is the deliberate exception — sideways movement SHOULD
  // stay inside a wide table — so only the y-axis and the shorthand are refused.
  const SRC = join(import.meta.dirname, "..", "src");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(tsx?|css)$/.test(entry)) files.push(path);
    }
  };
  walk(SRC);
  const offenders: string[] = [];
  for (const f of files) {
    const code = readFileSync(f, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/[^\n]*$/gm, "");
    // Tailwind's `overscroll-contain`/`overscroll-none` (both axes) and
    // `overscroll-y-contain`/`overscroll-y-none`, plus the raw CSS properties.
    if (/\boverscroll-(y-)?(contain|none)\b/.test(code)) offenders.push(f);
    if (/overscroll-behavior(-y)?\s*:\s*(contain|none)/.test(code)) offenders.push(f);
  }
  assert.deepEqual(offenders, [], "vertical overscroll containment must be deliberate — see ScrollHandoff");
});
