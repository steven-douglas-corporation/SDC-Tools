import { test } from "node:test";
import assert from "node:assert/strict";
import { applyDelayMs, shouldAdoptCommitted } from "../src/components/useDraftParamMenu";

// When a toolbar multi-select sends its navigation (§32.7, §32.12).
//
// The rule this pins is the one the user complaint is about: ticking ONE box must
// not wait on a timer. It used to wait 250ms before the server was even asked,
// because the same timer that collapses a five-tick burst was also charged to the
// single tick. A regression to trailing-only would make every filter feel a quarter
// of a second slower and would be invisible in review — hence a test.

const WINDOW = 250;

test("a lone tick after a pause goes out immediately", () => {
  // The common case by a wide margin, and the one §32.12 gives 100ms for. Nothing
  // recent, nothing in flight: there is nobody to wait for.
  assert.equal(applyDelayMs(5_000, false, WINDOW), 0);
});

test("the very first tick on a freshly opened menu goes out immediately", () => {
  // lastAppliedAt starts at 0, so `since` is effectively "forever ago".
  assert.equal(applyDelayMs(Number.MAX_SAFE_INTEGER, false, WINDOW), 0);
});

test("a tick exactly at the window boundary is treated as a new burst", () => {
  assert.equal(applyDelayMs(WINDOW, false, WINDOW), 0);
});

test("a second tick inside the window waits out only the remainder", () => {
  // Collapsing is still the point: this is what keeps five customers in a row from
  // costing five renders of the grid.
  assert.equal(applyDelayMs(100, false, WINDOW), 150);
  assert.equal(applyDelayMs(249, false, WINDOW), 1);
});

test("nothing is sent while a navigation is still rendering", () => {
  // Racing the in-flight render gains nothing — the newer navigation would
  // supersede it and both would have been paid for. Wait, then send once.
  assert.equal(applyDelayMs(5_000, true, WINDOW), WINDOW);
});

test("in-flight beats the leading edge even long after the window has passed", () => {
  // The ETC grid renders in ~600ms, well past a 250ms window, so this is the
  // normal case there rather than an edge case: without this, ticking every ~300ms
  // would issue a fresh navigation each time and each would supersede the last.
  assert.equal(applyDelayMs(10_000, true, WINDOW), WINDOW);
});

test("a burst is collapsed but never dropped", () => {
  // Walk a five-tick burst: the first goes out at once, the rest fold into one
  // trailing navigation. Two round-trips for five ticks — and, crucially, the last
  // tick is always included, which a pure throttle would lose.
  const ticks = [0, 40, 90, 150, 210]; // ms since the menu was opened
  let lastNavAt = -Infinity;
  const sent: number[] = [];
  for (const t of ticks) {
    const delay = applyDelayMs(t - lastNavAt, false, WINDOW);
    if (delay === 0) {
      lastNavAt = t;
      sent.push(t);
    }
  }
  // Only the first tick navigated on its own; the remainder are still pending and
  // the effect's trailing timer carries them.
  assert.deepEqual(sent, [0], "one leading navigation for the burst");
  assert.equal(applyDelayMs(ticks[4] - lastNavAt, false, WINDOW), 40, "the rest land 40ms later");
});

test("a slow, deliberate sequence applies every tick at once", () => {
  // Someone ticking a box, reading the grid, then ticking another is NOT a burst
  // and must not be treated as one — each selection is a separate decision.
  for (const gap of [400, 900, 1500]) {
    assert.equal(applyDelayMs(gap, false, WINDOW), 0, `a tick ${gap}ms later is immediate`);
  }
});

test("a zero window disables collapsing entirely", () => {
  // Not used by the app, but the arithmetic should degrade sensibly rather than
  // producing a negative timeout.
  assert.equal(applyDelayMs(0, false, 0), 0);
});


// ── Ticks made DURING a navigation must survive it (2026-09-02) ─────────────
//
// Reported as filter options that "sometimes do not select". Measured in the
// running app before the fix: five Department checkboxes ticked 40ms apart left
// exactly ONE selected. The first tick navigates on the leading edge; ticks two
// to five land in the draft while that navigation renders; the server's answer
// describes only the first tick; the resync adopted it and deleted the rest —
// checkbox and all. After the fix the same five ticks leave five selected, in
// two requests.

test("our own answer coming back does not overwrite newer ticks", () => {
  // The key we pushed after tick one. Ticks two-to-five are in the draft only.
  const pushed = ['[["departments",["A"]]]'];
  assert.equal(shouldAdoptCommitted('[["departments",["A"]]]', pushed), false);
});

test("a change from somewhere else IS adopted — Back, a saved view, Show all", () => {
  // Nothing this menu pushed, so the draft must yield to it. This is the case
  // the resync exists for and the fix must not break.
  const pushed = ['[["departments",["A"]]]'];
  assert.equal(shouldAdoptCommitted('[["departments",["B","C"]]]', pushed), true);
  assert.equal(shouldAdoptCommitted('[["departments",[]]]', []), true, "nothing pushed yet");
});

test("an answer arriving out of order is still recognised as ours", () => {
  // Two pushes in flight; the older answer lands last. Comparing against only
  // the newest key would treat it as external and clobber the draft.
  const pushed = ['[["departments",["A"]]]', '[["departments",["A","B"]]]'];
  assert.equal(shouldAdoptCommitted('[["departments",["A"]]]', pushed), false);
  assert.equal(shouldAdoptCommitted('[["departments",["A","B"]]]', pushed), false);
});
