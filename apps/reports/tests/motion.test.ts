import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  MOTION,
  PRESS_MS,
  HOVER_MS,
  MENU_MS,
  PANEL_MS,
  FLASH_MS,
  FLASH_CAP,
  LOADING_REVEAL_DELAY_MS,
  INTERACTION_BUDGET_MS,
  isInteractionDuration,
  isFlashDuration,
  resolveMotionMs,
  changedForFlash,
  mergeExiting,
  hasLeaving,
  withoutLeaving,
  type ExitEntry,
} from "../src/lib/motion";

// ── The motion system's invariants (§36) ────────────────────────────────────
//
// §36 is mostly a list of things that should LOOK right, which a unit test cannot
// judge. What it can do — and what this file does — is pin the four rules that are
// actually decidable, and that are the ones a later change would break silently:
//
//   1. every duration an interaction triggers is inside §36.2's band;
//   2. the CSS tokens and the TypeScript tokens are the same numbers, because a
//      timer that waits for an animation is only correct if they are;
//   3. a bulk grid update does not flash every cell (§36.6), and a first paint
//      flashes nothing;
//   4. a removed toast/banner survives long enough to animate out, holds its
//      position while it does, and is not duplicated if it comes back (§36.13).
//
// Plus a regression guard that no component reintroduces its own hand-rolled
// duration (§36.17), which is the drift the whole system exists to stop.

const SRC = join(import.meta.dirname, "..", "src");

// ── 1. §36.2's timing bands ────────────────────────────────────────────────

test("every interaction duration is inside §36.2's band", () => {
  for (const [name, ms] of Object.entries(MOTION)) {
    assert.equal(isInteractionDuration(ms), true, `MOTION.${name} = ${ms}ms is outside 50–${INTERACTION_BUDGET_MS}ms`);
  }
});

test("the tokens are ordered press < hover < menu < panel", () => {
  // Not cosmetic. The bands in §36.2 rank by how much the thing being animated
  // moves, and a press that took longer than a panel would make the smallest
  // interaction the slowest one.
  assert.ok(PRESS_MS < HOVER_MS, `press ${PRESS_MS} should be shorter than hover ${HOVER_MS}`);
  assert.ok(HOVER_MS < MENU_MS, `hover ${HOVER_MS} should be shorter than menu ${MENU_MS}`);
  assert.ok(MENU_MS < PANEL_MS, `menu ${MENU_MS} should be shorter than panel ${PANEL_MS}`);
});

test("each token sits in the §36.2 range it was drawn from", () => {
  assert.ok(PRESS_MS >= 50 && PRESS_MS <= 100, "button press feedback: 50–100ms");
  assert.ok(HOVER_MS >= 100 && HOVER_MS <= 150, "hover and focus: 100–150ms");
  assert.ok(MENU_MS >= 120 && MENU_MS <= 180, "dropdown open and close: 120–180ms");
  assert.ok(PANEL_MS >= 150 && PANEL_MS <= 250, "tabs/panels/modals/banners/cards: 150–250ms");
});

test("the value-changed flash is longer than the interaction budget, on purpose", () => {
  // If somebody ever moves FLASH_MS into MOTION, the first test in this file starts
  // failing and this one explains why it should not be there: it is feedback that has
  // to be readable, not a transition that has to keep up with a click.
  assert.equal(isInteractionDuration(FLASH_MS), false);
  assert.equal(isFlashDuration(FLASH_MS), true);
});

test("the loading-reveal delay is short enough not to read as lag", () => {
  // Long enough that a warm route never paints a skeleton, short enough that a cold
  // one does not feel unacknowledged (§36.9, §36.19's ~200ms shell target).
  assert.ok(LOADING_REVEAL_DELAY_MS >= 80 && LOADING_REVEAL_DELAY_MS <= 200);
});

test("reduced motion collapses a duration to zero rather than shortening it", () => {
  // §36.16. Zero, not 1ms: callers use this for setTimeout waits, and a 1ms timer
  // still costs a task and a re-render for an animation that is not running.
  assert.equal(resolveMotionMs(PANEL_MS, true), 0);
  assert.equal(resolveMotionMs(PANEL_MS, false), PANEL_MS);
  assert.equal(resolveMotionMs(FLASH_MS, true), 0);
});

// ── 2. CSS and TypeScript hold the same numbers ────────────────────────────

test("globals.css declares the same --motion-* values as lib/motion.ts", () => {
  const css = readFileSync(join(SRC, "app", "globals.css"), "utf8");
  const expected: Record<string, number> = {
    "--motion-press": PRESS_MS,
    "--motion-hover": HOVER_MS,
    "--motion-menu": MENU_MS,
    "--motion-panel": PANEL_MS,
    "--motion-flash": FLASH_MS,
    "--motion-loading-delay": LOADING_REVEAL_DELAY_MS,
  };
  for (const [token, ms] of Object.entries(expected)) {
    const match = new RegExp(`${token}\\s*:\\s*(\\d+)ms`).exec(css);
    assert.ok(match, `${token} is not declared in globals.css`);
    assert.equal(
      Number(match![1]),
      ms,
      `${token} is ${match![1]}ms in globals.css but ${ms}ms in lib/motion.ts — a timer that waits for this animation would be wrong`,
    );
  }
});

test("globals.css honours prefers-reduced-motion and keeps the loading spinner turning", () => {
  const css = readFileSync(join(SRC, "app", "globals.css"), "utf8");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/, "§36.16 requires a reduced-motion block");
  // The block must zero DELAYS too, not only durations: an enter animation that keeps
  // its 120ms delay while its duration collapses simply never arrives.
  assert.match(css, /animation-delay:\s*0s\s*!important/);
  assert.match(css, /transition-duration:\s*0\.01ms\s*!important/);
  // §36.16 protects loading and status indicators explicitly. A frozen spinner reads
  // as a hung request, which is worse information than a moving one.
  assert.match(css, /\.animate-spin\s*\{[^}]*animation-iteration-count:\s*infinite\s*!important/);
});

// ── 3. Which grid cells flash (§36.6) ──────────────────────────────────────

test("a cell seen for the first time is not a change", () => {
  // First paint, a column being unhidden, a month switch: the whole grid arrives at
  // once, and treating arrival as a change would light up every total on the page.
  const decision = changedForFlash(new Map(), new Map([["a", "10"], ["b", "20"]]));
  assert.deepEqual(decision.keys, []);
  assert.equal(decision.bulk, false);
});

test("only the cells whose text actually moved are flashed", () => {
  const before = new Map([["a", "10"], ["b", "20"], ["c", "30"]]);
  const after = new Map([["a", "10"], ["b", "21"], ["c", "30"]]);
  const decision = changedForFlash(before, after);
  assert.deepEqual(decision.keys, ["b"]);
  assert.equal(decision.bulk, false);
});

test("a change that rounds to the same text is not a change", () => {
  // These cells print whole hours. 1,768.4 -> 1,768.6 moves the number and not the
  // display, and flashing for it would be the grid crying wolf.
  const decision = changedForFlash(new Map([["a", "1,768"]]), new Map([["a", "1,768"]]));
  assert.deepEqual(decision.keys, []);
});

test("a bulk update flashes nothing at all", () => {
  // §36.6: "do not animate every cell during large refreshes". A Refresh Data pass or
  // a Show-all can move every total on the page; forty simultaneous animations is
  // strobing, not feedback.
  const before = new Map<string, string>();
  const after = new Map<string, string>();
  for (let i = 0; i <= FLASH_CAP + 5; i++) {
    before.set(`cell${i}`, "0");
    after.set(`cell${i}`, String(i + 1));
  }
  const decision = changedForFlash(before, after);
  assert.equal(decision.bulk, true);
  assert.deepEqual(decision.keys, [], "a bulk update must produce no flashes, not a truncated list of them");
});

test("exactly at the cap is still an edit, not a bulk update", () => {
  const before = new Map<string, string>();
  const after = new Map<string, string>();
  for (let i = 0; i < FLASH_CAP; i++) {
    before.set(`cell${i}`, "0");
    after.set(`cell${i}`, "1");
  }
  const decision = changedForFlash(before, after);
  assert.equal(decision.bulk, false);
  assert.equal(decision.keys.length, FLASH_CAP);
});

// ── 4. Lists whose removals animate out (§36.13) ───────────────────────────

type Item = { id: string; text: string };
const keyOf = (i: Item) => i.id;
const entry = (id: string, text = id, leaving = false): ExitEntry<Item> => ({ key: id, item: { id, text }, leaving });

test("a steady list passes straight through", () => {
  const items: Item[] = [{ id: "a", text: "a" }, { id: "b", text: "b" }];
  const merged = mergeExiting(items, keyOf, [entry("a"), entry("b")]);
  assert.deepEqual(merged.map((e) => [e.key, e.leaving]), [["a", false], ["b", false]]);
  assert.equal(hasLeaving(merged), false);
});

test("a removed item is kept, marked leaving, IN ITS OWN SLOT", () => {
  // The position is the point (§36.14): a toast in the middle of a stack has to fade
  // where it stands. Moving it to the end of the list while it faded would make the
  // ones below it jump up and then back down.
  const merged = mergeExiting([{ id: "a", text: "a" }, { id: "c", text: "c" }], keyOf, [
    entry("a"),
    entry("b"),
    entry("c"),
  ]);
  assert.deepEqual(merged.map((e) => [e.key, e.leaving]), [["a", false], ["b", true], ["c", false]]);
  assert.equal(hasLeaving(merged), true);
});

test("an item that comes back while leaving is restored, not duplicated", () => {
  // The same change can be re-announced on the realtime feed. A card mid-fade must
  // stop fading rather than appearing twice.
  const merged = mergeExiting([{ id: "b", text: "b" }], keyOf, [entry("b", "b", true)]);
  assert.deepEqual(merged.map((e) => [e.key, e.leaving]), [["b", false]]);
});

test("a leaving item carries its last known content, not undefined", () => {
  // It is still on screen for one --motion-panel, so it still has to render. This is
  // why mergeExiting keeps the previous ITEM and not just its key.
  const merged = mergeExiting([], keyOf, [entry("a", "saved 42 hours")]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].item.text, "saved 42 hours");
  assert.equal(merged[0].leaving, true);
});

test("new arrivals append after the surviving order", () => {
  const merged = mergeExiting([{ id: "a", text: "a" }, { id: "z", text: "z" }], keyOf, [entry("a"), entry("b")]);
  assert.deepEqual(merged.map((e) => [e.key, e.leaving]), [["a", false], ["b", true], ["z", false]]);
});

test("the exit timer's payload drops only what is leaving", () => {
  const merged = mergeExiting([{ id: "a", text: "a" }], keyOf, [entry("a"), entry("b")]);
  assert.deepEqual(withoutLeaving(merged).map((e) => e.key), ["a"]);
});

test("an empty list with nothing pending stays empty", () => {
  const merged = mergeExiting([], keyOf, []);
  assert.deepEqual(merged, []);
  assert.equal(hasLeaving(merged), false);
});

// ── The §36.17 regression guard ────────────────────────────────────────────

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
    } else if (/\.tsx?$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

// Comments in this codebase describe the classes they replaced, at length. Stripping
// them is what keeps this guard about CODE. Block comments first, then line comments —
// a `//` inside a string literal can over-strip, which only ever hides a violation
// (a false pass), never invents one.
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

test("no component hand-rolls its own transition or duration (§36.17)", () => {
  // The whole point of the system: "do not use different arbitrary animation values in
  // each component". Tailwind's `transition-*` and `duration-*` utilities are how that
  // happened the first time — nine components, four different answers, most of the app
  // unanimated. Motion now arrives through the motion-* classes in globals.css, which
  // read the shared tokens.
  //
  // lib/motion.ts is exempt: its comments and this guard's own vocabulary describe the
  // utilities being replaced.
  const offenders: string[] = [];
  for (const file of sourceFiles(SRC)) {
    if (file.endsWith(join("lib", "motion.ts"))) continue;
    const code = stripComments(readFileSync(file, "utf8"));
    for (const match of code.matchAll(/\b(transition-(?:all|colors|shadow|opacity|transform|\[[a-z]+\])|duration-\d+)\b/g)) {
      offenders.push(`${file.slice(SRC.length + 1)}: ${match[1]}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `hand-rolled motion found — use a motion-* class from globals.css instead:\n  ${offenders.join("\n  ")}`,
  );
});

test("the motion classes every component references are actually defined", () => {
  // A typo in a class name is invisible: nothing animates and nothing errors, which is
  // indistinguishable from the un-animated app this change set out to fix.
  const css = readFileSync(join(SRC, "app", "globals.css"), "utf8");
  const used = new Set<string>();
  for (const file of sourceFiles(SRC)) {
    const code = stripComments(readFileSync(file, "utf8"));
    for (const match of code.matchAll(/\bmotion-[a-z-]+\b/g)) used.add(match[0]);
  }
  assert.ok(used.size > 0, "expected the components to reference the motion classes");
  for (const name of used) {
    // `motion-reduce`/`motion-safe` would be Tailwind variants, not classes of ours.
    if (name === "motion-reduce" || name === "motion-safe") continue;
    assert.ok(css.includes(`.${name}`), `.${name} is used in src/ but not defined in globals.css`);
  }
});
