import { test } from "node:test";
import assert from "node:assert/strict";
import {
  phaseForLevel,
  shouldDisableForPhase,
  shouldShowBusyForPhase,
  SLOW_AFTER_MS,
  TIMEOUT_AFTER_MS,
  type PendingLevel,
} from "../src/lib/pending-watchdog";

// A pending state that cannot last forever (§35.1, §35.7, §35.14).
//
// The reported bug was the Projects "Show all" button stuck on "Showing all…" and
// disabled, with a browser reload as the only way out. `useTransition`'s pending flag is
// true for the whole server round-trip and has no other exit, so a transition that never
// settles leaves the control dead. The property that matters most below is that
// `timedout` RE-ENABLES the control — a disabled button after a visibly failed operation
// is indistinguishable from a broken app.

test("nothing in flight is idle", () => {
  assert.equal(phaseForLevel(false, 0), "idle");
});

test("a fresh operation is plain pending", () => {
  assert.equal(phaseForLevel(true, 0), "pending");
});

test("level 1 admits it is slow, but stays busy", () => {
  const phase = phaseForLevel(true, 1);
  assert.equal(phase, "slow");
  // Still working as far as the user is concerned — this is the "slow vs broken"
  // distinction, not a failure.
  assert.equal(shouldShowBusyForPhase(phase), true);
  assert.equal(shouldDisableForPhase(phase), true);
});

test("level 2 stops claiming to be working AND re-enables the control", () => {
  const phase = phaseForLevel(true, 2);
  assert.equal(phase, "timedout");
  // The whole point. A stuck spinner is bad; a permanently disabled button is the
  // reported bug, because there is then no way to retry short of reloading.
  assert.equal(shouldShowBusyForPhase(phase), false, "no spinner turning forever");
  assert.equal(shouldDisableForPhase(phase), false, "the user can click again");
});

test("completing always wins over any level, so a busy state can never latch", () => {
  // The failure mode being excluded: an operation that finishes while the watchdog had
  // already given up must read idle, not timed-out. `pending` is the authority.
  for (const level of [0, 1, 2] as PendingLevel[]) {
    assert.equal(phaseForLevel(false, level), "idle", `level ${level} must not survive completion`);
  }
});

test("every phase is reachable, in order, as the timers advance", () => {
  // Guards against a reordering that makes one phase unreachable.
  const walk = ([0, 1, 2] as PendingLevel[]).map((l) => phaseForLevel(true, l));
  assert.deepEqual(walk, ["pending", "slow", "timedout"]);
});

test("idle is never busy and never disabled", () => {
  assert.equal(shouldShowBusyForPhase("idle"), false);
  assert.equal(shouldDisableForPhase("idle"), false);
});

test("the thresholds are ordered, and slow comes comfortably before giving up", () => {
  // A timeout at or below the slow threshold would skip "slow" entirely and jump a
  // healthy-but-slow operation straight to "try again", which is worse than the bug.
  assert.ok(SLOW_AFTER_MS > 0);
  assert.ok(TIMEOUT_AFTER_MS > SLOW_AFTER_MS, "timeout must be later than the slow hint");
  // And the slow hint must not fire on an ordinary render. The heaviest measured server
  // render in this app is the ETC grid at a few hundred ms, so a sub-second threshold
  // would label normal operation as slow.
  assert.ok(SLOW_AFTER_MS >= 1_000, "the slow hint must not fire on a normal render");
});
