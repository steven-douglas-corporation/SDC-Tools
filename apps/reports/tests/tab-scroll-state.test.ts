import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  ROOT_KEY,
  applyEntry,
  applyScrollState,
  elementForKey,
  hasScrollRoom,
  parseScrollState,
  pruneScrollState,
  scrollKeyOf,
  tabScrollStorageKey,
  type TabScrollState,
  driftedKeys,
  roomOf,
  shouldRecordScroll,
  USER_INTENT_MS,
} from "../src/lib/tab-scroll-state";

// ── The reported bug ────────────────────────────────────────────────────────
//
// Scroll the Monthly ETC grid far right, switch tabs, come back — the grid is at the
// left again. The panes already stay mounted behind <Activity>, so React state and the
// pane's own scrollTop survived; what did not is a nested `overflow-x: auto` div, because
// Activity hides a pane with `display: none` and an element with no layout box has no
// scroll box for the browser to keep an offset in.
//
// These tests use a tiny fake DOM rather than jsdom: everything under test is index
// arithmetic and clamping logic, and the parts that genuinely need a browser (a
// capture-phase scroll listener, requestAnimationFrame) are asserted structurally at the
// bottom instead of mocked into something that proves nothing.

type FakeEl = {
  children: FakeEl[];
  parentElement: FakeEl | null;
  scrollLeft: number;
  scrollTop: number;
  scrollWidth: number;
  clientWidth: number;
  scrollHeight: number;
  clientHeight: number;
  attrs: Record<string, string>;
  getAttribute(name: string): string | null;
  querySelector(selector: string): FakeEl | null;
};

function el(opts: Partial<FakeEl> = {}): FakeEl {
  const node: FakeEl = {
    children: [],
    parentElement: null,
    scrollLeft: 0,
    scrollTop: 0,
    scrollWidth: 100,
    clientWidth: 100,
    scrollHeight: 100,
    clientHeight: 100,
    attrs: {},
    getAttribute(name: string) {
      return this.attrs[name] ?? null;
    },
    querySelector(selector: string) {
      return fakeQuerySelector(this, selector);
    },
    ...opts,
  };
  return node;
}

// The declared-key path resolves through querySelector + CSS.escape. Both are real
// browser APIs the lib is right to use, so the harness provides them rather than the lib
// avoiding them: a fake that forced the lib to be less capable would be testing the
// wrong code.
const CSSShim = { escape: (v: string) => v };
(globalThis as unknown as { CSS?: typeof CSSShim }).CSS ??= CSSShim;

/** Walk a fake subtree for `[data-scroll-key="…"]`, which is all the lib asks of it. */
function fakeQuerySelector(root: FakeEl, selector: string): FakeEl | null {
  const want = /^\[data-scroll-key="(.*)"\]$/.exec(selector)?.[1];
  if (want === undefined) return null;
  const stack = [...root.children];
  while (stack.length > 0) {
    const node = stack.shift()!;
    if (node.getAttribute("data-scroll-key") === want) return node;
    stack.push(...node.children);
  }
  return null;
}

function tree(root: FakeEl, ...kids: FakeEl[]): FakeEl {
  for (const k of kids) {
    k.parentElement = root;
    root.children.push(k);
  }
  return root;
}

// The lib takes Element/HTMLElement; the fakes above implement exactly the surface it
// touches. One cast at the boundary rather than a fake DOM library.
const as = <T,>(x: unknown) => x as T;

// ── Keys ───────────────────────────────────────────────────────────────────

test("a declared key wins, because it survives the tree changing shape", () => {
  const target = el({ attrs: { "data-scroll-key": "etc-grid" } });
  const root = tree(el(), el(), tree(el(), target));
  assert.equal(scrollKeyOf(as(target), as(root)), "@etc-grid");
});

test("without one, the key is the path of child indices from the pane root", () => {
  const target = el();
  const mid = tree(el(), el(), target);
  const root = tree(el(), el(), mid);
  // root -> child 1 -> child 1
  assert.equal(scrollKeyOf(as(target), as(root)), "1/1");
});

test("the pane container itself is the empty key", () => {
  const root = el();
  assert.equal(scrollKeyOf(as(root), as(root)), ROOT_KEY);
  assert.equal(ROOT_KEY, "");
});

test("a path round-trips back to the same element", () => {
  const target = el();
  const root = tree(el(), tree(el(), el(), target), el());
  const key = scrollKeyOf(as(target), as(root));
  assert.equal(elementForKey(as(root), key), target);
});

test("a path that no longer resolves is skipped, never applied to the wrong element", () => {
  // After a reload the DOM is rebuilt, and a saved path can point at something that is
  // not there any more. Losing a position is acceptable; scrolling an unrelated
  // container to a remembered offset is not.
  const root = tree(el(), el());
  assert.equal(elementForKey(as(root), "5/2"), null);
  assert.equal(elementForKey(as(root), "0/0"), null);
});

// ── Applying, and the silent-zero failure ──────────────────────────────────

test("an offset applies when the content is laid out", () => {
  const target = el({ scrollWidth: 3000, clientWidth: 800, scrollHeight: 5000, clientHeight: 600 });
  assert.equal(applyEntry(as(target), { left: 1800, top: 2400 }), true);
  assert.equal(target.scrollLeft, 1800);
  assert.equal(target.scrollTop, 2400);
});

test("an offset that cannot be applied yet reports FAILURE rather than a silent zero", () => {
  // The failure the report warned about: "setting scrollLeft too early may silently
  // reset to 0". A grid whose columns have not been measured has scrollWidth ===
  // clientWidth, so the assignment clamps to 0 and reads back 0 — and the only way to
  // know is to read it back.
  const notReady = el({ scrollWidth: 800, clientWidth: 800, scrollHeight: 600, clientHeight: 600 });
  // Simulate the browser clamping: nothing to scroll, so the write does not take.
  Object.defineProperty(notReady, "scrollLeft", {
    get: () => 0,
    set: () => {},
    configurable: true,
  });
  assert.equal(applyEntry(as(notReady), { left: 1800, top: 0 }), false, "must report that it did not stick");
});

test("a legitimately clamped offset counts as applied, so it is not retried forever", () => {
  // Saved 900 against a scroller that only reaches 850 — 850 IS the right answer, and
  // retrying it every frame until the cap would just burn frames.
  const target = el({ scrollWidth: 1650, clientWidth: 800, scrollHeight: 600, clientHeight: 600 });
  let left = 0;
  Object.defineProperty(target, "scrollLeft", {
    get: () => left,
    set: (v: number) => {
      left = Math.min(v, 850);
    },
    configurable: true,
  });
  assert.equal(applyEntry(as(target), { left: 900, top: 0 }), true);
  assert.equal(target.scrollLeft, 850);
});

test("applyScrollState returns exactly the keys that did not stick", () => {
  const ready = el({ scrollWidth: 3000, clientWidth: 500 });
  const notReady = el({ scrollWidth: 500, clientWidth: 500 });
  Object.defineProperty(notReady, "scrollLeft", { get: () => 0, set: () => {}, configurable: true });
  const root = tree(el(), ready, notReady);
  const pending = applyScrollState(as(root), { "0": { left: 1200, top: 0 }, "1": { left: 900, top: 0 } });
  assert.deepEqual(pending, ["1"]);
  assert.equal(ready.scrollLeft, 1200);
});

test("a zero entry is not applied at all — there is nothing to restore", () => {
  const target = el({ scrollWidth: 3000, clientWidth: 500, scrollLeft: 777 });
  const root = tree(el(), target);
  applyScrollState(as(root), { "0": { left: 0, top: 0 } });
  assert.equal(target.scrollLeft, 777, "restoring a zero must not scroll a container to the start");
});

// ── Storage ────────────────────────────────────────────────────────────────

test("the store is keyed by TAB INSTANCE, not by page type", () => {
  // "Monthly ETC tab A → own state, Monthly ETC tab B → own state." Two Monthly ETC
  // tabs on the same month with the same filters must still not share a position, which
  // is why this keys on the tab id rather than the route.
  assert.notEqual(tabScrollStorageKey("t1"), tabScrollStorageKey("t2"));
  assert.ok(tabScrollStorageKey("t1").includes("t1"));
});

test("duplicate tabs of one page keep separate state", () => {
  // Job Details A on job 1101 scrolled halfway; Job Details B on 1164 at the top.
  const a: TabScrollState = { "@parts-list": { left: 0, top: 4200 } };
  const b: TabScrollState = {};
  assert.notDeepEqual(a, b);
  assert.notEqual(tabScrollStorageKey("t3"), tabScrollStorageKey("t4"));
  // And restoring B's (empty) state cannot move A's scroller.
  const scroller = el({ scrollWidth: 9000, clientHeight: 600, scrollHeight: 9000, scrollTop: 4200 });
  const root = tree(el(), scroller);
  applyScrollState(as(root), b);
  assert.equal(scroller.scrollTop, 4200);
});

test("zero offsets are pruned, so a never-scrolled tab stores nothing", () => {
  assert.deepEqual(pruneScrollState({ "": { left: 0, top: 0 }, "1": { left: 0, top: 300 } }), {
    "1": { left: 0, top: 300 },
  });
  assert.deepEqual(pruneScrollState({}), {});
});

test("a malformed stored value reads as nothing saved, never as a position", () => {
  for (const raw of [null, "", "not json", "[]", '"x"', "42", '{"a":null}', '{"a":{"left":"x","top":1}}']) {
    assert.deepEqual(parseScrollState(raw), {}, `${JSON.stringify(raw)} should yield nothing`);
  }
  // Negative and non-finite are refused rather than clamped: they cannot have come from
  // a real scroller, so the entry is corrupt.
  assert.deepEqual(parseScrollState('{"a":{"left":-5,"top":0}}'), {});
  assert.deepEqual(parseScrollState('{"a":{"left":1e999,"top":0}}'), {});
  // A good entry beside a bad one survives.
  assert.deepEqual(parseScrollState('{"a":{"left":-5,"top":0},"@etc-grid":{"left":1800,"top":2400}}'), {
    "@etc-grid": { left: 1800, top: 2400 },
  });
});

test("hasScrollRoom ignores a one-pixel rounding difference", () => {
  assert.equal(hasScrollRoom(as(el({ scrollWidth: 801, clientWidth: 800 }))), false);
  assert.equal(hasScrollRoom(as(el({ scrollWidth: 900, clientWidth: 800 }))), true);
  assert.equal(hasScrollRoom(as(el({ scrollHeight: 2000, clientHeight: 600 }))), true);
});

// ── The acceptance case from the report ────────────────────────────────────

test("the acceptance test: Monthly ETC far right, deep down, and back", () => {
  // "Scroll horizontally to Parts Cost / Standard Sheet, vertically to about job 40,
  // switch to Job Details, return — the exact same position."
  const grid = el({
    attrs: { "data-scroll-key": "etc-grid" },
    scrollWidth: 7400,
    clientWidth: 1400,
    scrollHeight: 2600,
    clientHeight: 780,
  });
  const pane = tree(el({ scrollHeight: 1200, clientHeight: 780 }), tree(el(), grid));

  // Scrolled far right and well down.
  grid.scrollLeft = 5200;
  grid.scrollTop = 1830;
  const captured: TabScrollState = {
    [scrollKeyOf(as(grid), as(pane))]: { left: grid.scrollLeft, top: grid.scrollTop },
  };
  assert.deepEqual(Object.keys(captured), ["@etc-grid"]);

  // Hidden with display:none — the browser drops the offsets, which IS the bug.
  grid.scrollLeft = 0;
  grid.scrollTop = 0;

  // Shown again.
  assert.deepEqual(applyScrollState(as(pane), captured), [], "nothing should still be pending");
  assert.equal(grid.scrollLeft, 5200);
  assert.equal(grid.scrollTop, 1830);
});

test("switching rapidly cannot corrupt the record", () => {
  // Capture/restore is idempotent: restoring, re-capturing and restoring again lands on
  // the same numbers, so a fast switch back and forth cannot drift.
  const grid = el({ attrs: { "data-scroll-key": "etc-grid" }, scrollWidth: 7400, clientWidth: 1400 });
  const pane = tree(el(), grid);
  const state: TabScrollState = { "@etc-grid": { left: 5200, top: 0 } };
  for (let i = 0; i < 5; i++) {
    grid.scrollLeft = 0;
    applyScrollState(as(pane), state);
    state["@etc-grid"] = { left: grid.scrollLeft, top: grid.scrollTop };
  }
  assert.deepEqual(state["@etc-grid"], { left: 5200, top: 0 });
});

// ── Structural: the parts a fake DOM cannot prove ─────────────────────────

const COMPONENT = readFileSync(join(process.cwd(), "src", "components", "TabScrollMemory.tsx"), "utf8");

test("one CAPTURE-phase listener per pane, which is what makes this general", () => {
  // A scroll event does not bubble, so a plain listener on the pane would only ever see
  // the pane. A capture listener sees every scroller nested anywhere inside it — which
  // is why no page needs to know it is inside a tab, and why a scroller added to any
  // page later is covered the day it is added.
  assert.match(COMPONENT, /addEventListener\("scroll", onScroll, \{ capture: true, passive: true \}\)/);
  assert.match(COMPONENT, /removeEventListener\("scroll", onScroll, \{ capture: true \}\)/);
});

test("the restore retries across frames instead of trusting the first attempt", () => {
  assert.match(COMPONENT, /raf = requestAnimationFrame\(step\)/);
  assert.match(COMPONENT, /const pending = applyScrollState\(root, state\.current\)/);
  assert.match(COMPONENT, /frame >= MAX_RESTORE_FRAMES/, "and gives up rather than spinning");
  // In a LAYOUT effect, so the position is set before paint — a scroll set in a plain
  // effect is visible as a jump from the start.
  assert.match(COMPONENT, /useLayoutEffect\(\(\) => \{/);
});

test("the cleanup can never overwrite a remembered offset with a zero", () => {
  // If React has already applied display:none by the time the cleanup runs, every read
  // is 0. That is exactly why the recording is continuous and the cleanup only ADDS
  // non-zero values.
  assert.match(COMPONENT, /if \(node\.scrollLeft !== 0 \|\| node\.scrollTop !== 0\)/);
});

test("storage is seeded once, so a re-show cannot undo a newer position", () => {
  assert.match(COMPONENT, /if \(!loaded\.current\)/);
});

// ── Every page's big scroller is named ────────────────────────────────────

test("the grids worth not losing carry a stable key", () => {
  // The structural path is enough for a hide-and-show, but a re-render that changes the
  // tree above a scroller would invalidate it. The major grids are named so their
  // positions survive that too.
  const expected: Record<string, string> = {
    "src/app/(app)/etc/page.tsx": "etc-grid",
    "src/app/(app)/quoted/page.tsx": "projects-grid",
    "src/components/JobCostExplorer.tsx": "profitability-grid",
  };
  for (const [file, key] of Object.entries(expected)) {
    const src = readFileSync(join(process.cwd(), ...file.split("/")), "utf8");
    assert.ok(src.includes(key), `${file} should name its scroller "${key}"`);
  }
  const procurement = readFileSync(join(process.cwd(), "src", "components", "JobProcurement.tsx"), "utf8");
  for (const key of ["parts-list", "assemblies-tree"]) {
    assert.ok(procurement.includes(`scrollKey="${key}"`), `the Parts List card should name "${key}"`);
  }
});

test("DragScroll passes a declared key through to the element that actually scrolls", () => {
  // The overflow lives on DragScroll's own element, so the attribute has to land there —
  // on a wrapper it would name something whose scrollLeft is always 0.
  const drag = readFileSync(join(process.cwd(), "src", "components", "DragScroll.tsx"), "utf8");
  const scroller = drag.slice(drag.indexOf("className={className}"));
  assert.match(scroller.slice(0, 200), /data-scroll-key=\{scrollKey\}/);
});

test("no page keeps its own scroll-restore code beside this one", () => {
  // The failure mode this prevents: two mechanisms both setting scrollLeft on the same
  // element, where whichever runs second wins and the bug looks intermittent.
  const app = join(process.cwd(), "src");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry)) files.push(full);
    }
  };
  walk(app);
  const offenders = files
    .filter((f) => !f.endsWith("TabScrollMemory.tsx") && !f.endsWith("tab-scroll-state.ts") && !f.endsWith("DragScroll.tsx"))
    .filter((f) => /\.\s*scrollLeft\s*=/.test(readFileSync(f, "utf8").replace(/^\s*\/\/.*$/gm, "")))
    .map((f) => f.replace(process.cwd(), "").split("\\").join("/"));
  assert.deepEqual(offenders, [], `these set scrollLeft themselves:\n  ${offenders.join("\n  ")}`);
});

// ── The two bugs the first fix had ─────────────────────────────────────────
//
// Reported again 2026-09-04: "still losing its internal grid viewport state". Both are
// provable by reading, and the first is why saving values was never going to be enough.

test("a scroll to zero with no gesture behind it is REFUSED, not recorded", () => {
  // Bug 1, and the important one. Anything that reset the grid to 0 fired a scroll event
  // at 0, and the recorder wrote it over the remembered offset — destroying the value
  // before the restore could ever use it. A save/restore pair cannot work when the save
  // is what corrupts the value.
  const refused = shouldRecordScroll({
    next: { left: 0, top: 0 },
    remembered: { left: 5200, top: 1830 },
    sinceUserInputMs: null,
    room: { left: 6000, top: 1820 },
  });
  assert.equal(refused, false, "a reset must not overwrite the remembered position");
});

test("a person scrolling back to the far left IS recorded", () => {
  // The same shape as a reset, and it must still be honoured — the gesture is what
  // admits it. Anything else would leave a user unable to scroll back to the start.
  const recorded = shouldRecordScroll({
    next: { left: 0, top: 0 },
    remembered: { left: 5200, top: 1830 },
    sinceUserInputMs: 40,
    room: { left: 6000, top: 1820 },
  });
  assert.equal(recorded, true);
  // And just outside the window it is refused again.
  assert.equal(
    shouldRecordScroll({
      next: { left: 0, top: 0 },
      remembered: { left: 5200, top: 1830 },
      sinceUserInputMs: USER_INTENT_MS + 1,
      room: { left: 6000, top: 1820 },
    }),
    false,
  );
});

test("only a collapse to zero is ever refused — every other move is recorded", () => {
  const move = (next: { left: number; top: number }) =>
    shouldRecordScroll({ next, remembered: { left: 5200, top: 1830 }, sinceUserInputMs: null, room: { left: 6000, top: 1820 } });
  assert.equal(move({ left: 5400, top: 1830 }), true, "scrolling further right");
  assert.equal(move({ left: 40, top: 1830 }), true, "nearly to the left, but not zero");
  assert.equal(move({ left: 5200, top: 0 }), false, "one axis collapsing is still a reset");
});

test("with nothing remembered there is nothing to protect", () => {
  assert.equal(
    shouldRecordScroll({ next: { left: 0, top: 0 }, remembered: undefined, sinceUserInputMs: null, room: { left: 6000, top: 0 } }),
    true,
  );
});

test("a container with no room cannot be 'reset', so the guard stays out of the way", () => {
  // No room means the 0 is simply the truth. Refusing it would leave a stale remembered
  // offset for a scroller that has since become short.
  assert.equal(
    shouldRecordScroll({
      next: { left: 0, top: 0 },
      remembered: { left: 5200, top: 0 },
      sinceUserInputMs: null,
      room: { left: 0, top: 0 },
    }),
    true,
  );
});

test("drift is what makes the restore a standing intent rather than an event", () => {
  // Bug 2. The restore fired once, on show — but `apply({navigate:true})` re-delivers
  // every pane from the server, so the grid DOM is REPLACED after that has run. Nothing
  // put it back. driftedKeys is what notices.
  const grid = el({ attrs: { "data-scroll-key": "etc-grid" }, scrollWidth: 7400, clientWidth: 1400 });
  const pane = tree(el(), grid);
  const state: TabScrollState = { "@etc-grid": { left: 5200, top: 0 } };

  grid.scrollLeft = 5200;
  assert.deepEqual(driftedKeys(as(pane), state), [], "in position, nothing to do");

  grid.scrollLeft = 0; // something replaced the grid
  assert.deepEqual(driftedKeys(as(pane), state), ["@etc-grid"], "out of position, put it back");
});

test("a position the user has since changed is not treated as drift", () => {
  // The record moves with the user, so there is nothing to drift from — which is what
  // stops the standing intent from fighting the person using it.
  const grid = el({ attrs: { "data-scroll-key": "etc-grid" }, scrollWidth: 7400, clientWidth: 1400 });
  const pane = tree(el(), grid);
  grid.scrollLeft = 900;
  const state: TabScrollState = { "@etc-grid": { left: 900, top: 0 } };
  assert.deepEqual(driftedKeys(as(pane), state), []);
});

test("roomOf reports what each axis can actually do", () => {
  assert.deepEqual(roomOf(as(el({ scrollWidth: 7400, clientWidth: 1400, scrollHeight: 2600, clientHeight: 780 }))), {
    left: 6000,
    top: 1820,
  });
  assert.deepEqual(roomOf(as(el({ scrollWidth: 100, clientWidth: 100, scrollHeight: 100, clientHeight: 100 }))), {
    left: 0,
    top: 0,
  });
});

// ── The report's acceptance test, ten times over ───────────────────────────

test("ten switches with a reset on every one, and no drift", () => {
  // "Repeat the sequence 10 times. No gradual drift, no jump to column 1, no jump to
  // row 1." Each round simulates the whole failure: the pane is hidden, something resets
  // the grid to 0 and fires a scroll event with no gesture behind it, then the pane is
  // shown again.
  const grid = el({
    attrs: { "data-scroll-key": "etc-grid" },
    scrollWidth: 7400,
    clientWidth: 1400,
    scrollHeight: 2600,
    clientHeight: 780,
  });
  const pane = tree(el(), tree(el(), grid));
  const state: TabScrollState = {};

  // The user scrolls to Parts Cost / Standard Sheet, down to around job 40.
  grid.scrollLeft = 5200;
  grid.scrollTop = 1830;
  const key = scrollKeyOf(as(grid), as(pane));
  state[key] = { left: grid.scrollLeft, top: grid.scrollTop };

  for (let round = 1; round <= 10; round++) {
    // Deactivate, then a reset fires a scroll event at 0 with no gesture.
    grid.scrollLeft = 0;
    grid.scrollTop = 0;
    const record = shouldRecordScroll({
      next: { left: 0, top: 0 },
      remembered: state[key],
      sinceUserInputMs: null,
      room: roomOf(as(grid)),
    });
    assert.equal(record, false, `round ${round}: the reset must be refused`);

    // Reactivate: drift is detected and the position goes back.
    assert.deepEqual(driftedKeys(as(pane), state), [key], `round ${round}: drift must be seen`);
    assert.deepEqual(applyScrollState(as(pane), state), [], `round ${round}: nothing should stay pending`);
    assert.equal(grid.scrollLeft, 5200, `round ${round}: horizontal position`);
    assert.equal(grid.scrollTop, 1830, `round ${round}: vertical position`);
  }
});

// ── The lifecycle the report asked to be proven ────────────────────────────

const SHELL = readFileSync(join(process.cwd(), "src", "components", "WorkspaceShell.tsx"), "utf8");
const BAR = readFileSync(join(process.cwd(), "src", "components", "WorkspaceTabBar.tsx"), "utf8");

test("a plain tab switch is local state — it must never navigate", () => {
  // Steps 1, 2 and 5 of the report: an ordinary switch must not destroy the page, must
  // not refetch, and must not rebuild the grid. That holds only because activating goes
  // through `apply` WITHOUT `navigate`, so it is a setState plus history.replaceState —
  // which deliberately does not notify the router.
  assert.match(BAR, /const go = \(next: Workspace\) => apply\(next\);/);
  assert.match(BAR, /const goOpen = \(next: Workspace\) => apply\(next, \{ navigate: true \}\);/);
  // Activating uses the non-navigating one.
  assert.match(BAR, /if \(!isActive\) go\(activateTab\(ws, id\)\);/);
  // And `apply` only reaches the router when explicitly told to.
  assert.match(SHELL, /if \(opts\?\.navigate\) \{\s*router\.replace\(href\);/);
  assert.match(SHELL, /window\.history\.replaceState\(null, "", href\)/);
});

test("inactive tabs stay mounted behind <Activity>", () => {
  assert.match(SHELL, /<Activity key=\{tab\.id\} mode=\{isVisible\(tab\.id\) \? "visible" : "hidden"\}>/);
  // Keyed by the tab's own id, so a reorder, a close or a duplicate cannot reconcile one
  // tab's pane into another's slot — which WOULD be a remount, and would look exactly
  // like this bug.
  assert.match(SHELL, /key is the tab's own id/);
});

test("the restore is a standing intent, watching for the DOM changing under it", () => {
  const component = readFileSync(join(process.cwd(), "src", "components", "TabScrollMemory.tsx"), "utf8");
  // The fix for bug 2: an observer, not a single pass on show.
  assert.match(component, /new MutationObserver\(\(\) => reRestoreSoon\("mutation"\)\)/);
  assert.match(component, /mo\.observe\(root, \{ childList: true, subtree: true \}\)/);
  assert.match(component, /new ResizeObserver\(\(\) => reRestoreSoon\("resize"\)\)/);
  // Named scrollers are observed individually, because the pane's own size does not
  // change when a grid inside it finally measures its columns.
  assert.match(component, /querySelectorAll<HTMLElement>\("\[data-scroll-key\]"\)\) ro\.observe\(el\)/);
  // The fix for bug 1: gestures are tracked, and a refused reset triggers a re-restore
  // rather than being silently dropped.
  assert.match(component, /"pointerdown", "wheel", "keydown", "touchstart"/);
  assert.match(component, /reRestoreSoon\("reset"\)/);
  // No timers: the report ruled out arbitrary setTimeout as the permanent answer.
  assert.ok(!/setTimeout/.test(component), "the restore must be driven by frames and observers, not delays");
});

test("the instrumentation the report asked for exists, and is off by default", () => {
  const debug = readFileSync(join(process.cwd(), "src", "lib", "tab-debug.ts"), "utf8");
  const probe = readFileSync(join(process.cwd(), "src", "components", "PaneLifecycleProbe.tsx"), "utf8");
  const component = readFileSync(join(process.cwd(), "src", "components", "TabScrollMemory.tsx"), "utf8");
  // The four events, in the report's own vocabulary.
  assert.match(probe, /tabDebug\("MOUNT"/);
  assert.match(probe, /tabDebug\("UNMOUNT"/);
  assert.match(component, /tabDebug\("ACTIVATE"/);
  assert.match(component, /tabDebug\("DEACTIVATE"/);
  // Step 3: the real scroll container's numbers.
  assert.match(debug, /scrollWidth: el\.scrollWidth/);
  assert.match(debug, /canScrollX: el\.scrollWidth > el\.clientWidth/);
  // Off unless asked for — a grid scroll fires hundreds of events.
  assert.match(debug, /tabdebug/);
  assert.match(debug, /if \(!enabled\) return;/);
  // The mount counter has to outlive a remount, or it cannot measure one.
  assert.match(probe, /^const mounts = new Map<string, number>\(\);$/m);
});
