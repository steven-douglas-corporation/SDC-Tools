import { test } from "node:test";
import assert from "node:assert/strict";
import { MIN_PASSWORD_LENGTH, isAcceptablePassword, passwordTooShortMessage } from "../src/lib/password-policy";

// Self-registration accepted a 1-character password until 2026-09-14.

test("the floor is 8 characters", () => {
  assert.equal(MIN_PASSWORD_LENGTH, 8);
  assert.equal(isAcceptablePassword("a"), false);
  assert.equal(isAcceptablePassword("1234567"), false);
  assert.equal(isAcceptablePassword("12345678"), true);
  assert.equal(isAcceptablePassword(""), false);
});

test("the message names the number so the form does not have to", () => {
  assert.match(passwordTooShortMessage(), /8/);
});
