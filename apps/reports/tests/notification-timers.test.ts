import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { reconcileTimers } from "../src/lib/notification-timers";

// ── Change-notification cards expire on their own, even while events keep coming ─
//
// REPORTED 2026-09-14: cards never expired on a busy month. ChangeNotifications
// scheduled every visible card's timer in an effect on `[groups]`, and `groups` is
// rebuilt on every incoming event — so each event cleared and restarted every timer.
// The reconciliation behind the per-card fix is pure and pinned here.

test("a card that already has a timer is left alone when another card arrives", () => {
  const { start, stop } = reconcileTimers(["a"], ["a", "b"]);
  assert.deepEqual(start, ["b"]);
  assert.deepEqual(stop, []);
});

test("a card that left the visible set has its timer stopped", () => {
  const { start, stop } = reconcileTimers(["a", "b"], ["b"]);
  assert.deepEqual(start, []);
  assert.deepEqual(stop, ["a"]);
});

test("the same set twice — the shape of a repeat event on an existing card — changes nothing", () => {
  assert.deepEqual(reconcileTimers(["a", "b"], ["a", "b"]), { start: [], stop: [] });
});

test("first render starts everything; unmount-like empty set stops everything", () => {
  assert.deepEqual(reconcileTimers([], ["a", "b"]), { start: ["a", "b"], stop: [] });
  assert.deepEqual(reconcileTimers(["a", "b"], []), { start: [], stop: ["a", "b"] });
});

test("the component keeps one timer per card and never clears them on a groups change", () => {
  const src = readFileSync(join(process.cwd(), "src", "components", "ChangeNotifications.tsx"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.match(code, /reconcileTimers\(running\.keys\(\), expiring\.keys\(\)\)/);
  // The old shape: a timers array built per pass and cleared in the effect cleanup.
  assert.ok(!/return \(\) => timers\.forEach\(clearTimeout\)/.test(code), "the per-pass clear-all is the bug");
  // An existing card's members are refreshed WITHOUT touching its timer.
  assert.match(code, /entry\.members = g\.members/);
});
