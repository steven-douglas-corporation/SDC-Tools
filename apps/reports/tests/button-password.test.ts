import { test } from "node:test";
import assert from "node:assert/strict";
import { expectedButtonPassword, matchesButtonPassword, type ButtonGate } from "../src/lib/button-password";
import { APP_VERSION, appVersionLabel } from "../src/lib/app-version";

// The phrase behind every protected button, changed on 2026-08-04. It used to be
// declared in five places AND overridden by two .env values, so "change the
// password" was a seven-thing search in which missing one would leave the old
// phrase working on some buttons and not others. These tests are the guard against
// that: they assert every gate agrees, without ever writing the phrase down more
// than once.
//
// The phrase itself is deliberately NOT hardcoded here. A test that spells it out is
// one more place to update, and it would put the phrase in a file that ships to
// nobody but is read by everybody.
// Projects, Standard Sheet and Audit Log were retired from this list 2026-08-18
// — those three are role checks now (lib/permissions.ts), not a shared phrase.
const GATES: ButtonGate[] = ["submit", "confirm"];

// Read once from the module rather than restated — this is the value under test.
const PHRASE = expectedButtonPassword("submit");

test("every gate accepts the current shared phrase", () => {
  for (const gate of GATES) {
    assert.equal(matchesButtonPassword(PHRASE, gate), true, `${gate} rejected the shared phrase`);
  }
});

test("the previous phrase no longer works on ANY gate", () => {
  // The one place the old phrase appears, because "it no longer works" is exactly
  // what has to be provable. Both casings, since the gates compare exactly.
  for (const old of ["sdcautomation", "SDCAutomation"]) {
    for (const gate of GATES) {
      assert.equal(matchesButtonPassword(old, gate), false, `${gate} still accepts the old phrase "${old}"`);
    }
  }
});

test("a wrong phrase is rejected everywhere", () => {
  for (const gate of GATES) {
    assert.equal(matchesButtonPassword("", gate), false);
    assert.equal(matchesButtonPassword("sdc", gate), false, "comparison is case-sensitive");
    assert.equal(matchesButtonPassword(`${PHRASE} `, gate), false, "trailing space is not trimmed away");
    assert.equal(matchesButtonPassword(`${PHRASE}x`, gate), false);
  }
});

test("both gates resolve to the same phrase unless overridden", () => {
  // No per-gate env override is set in the test environment, so they must agree.
  // If one of these ever diverges silently, this is what catches it.
  const distinct = new Set(GATES.map((g) => expectedButtonPassword(g)));
  assert.equal(distinct.size, 1, "gates disagree about the shared phrase");
});

test("the comparison does not depend on input length", () => {
  // Both sides are hashed before comparing, so timingSafeEqual always sees equal
  // lengths. A short and a very long attempt must both simply return false rather
  // than throwing, which is what a raw timingSafeEqual on the strings would do.
  assert.equal(matchesButtonPassword("x", "submit"), false);
  assert.equal(matchesButtonPassword("x".repeat(5000), "submit"), false);
});

// ── Application version (one source, shown in the sidebar) ──────────────────

test("the app version is a real version, not a placeholder", () => {
  assert.match(APP_VERSION, /^\d+\.\d+\.\d+/, `APP_VERSION looks unset: "${APP_VERSION}"`);
});

test("the version label is formatted the way the sidebar shows it", () => {
  assert.equal(appVersionLabel(), `Version ${APP_VERSION}`);
});
