import { test } from "node:test";
import assert from "node:assert/strict";
import { nameFromEmail } from "../src/lib/name-from-email";

test("a dot-separated local part becomes two title-cased words", () => {
  assert.equal(nameFromEmail("jane.doe@sdcautomation.com"), "Jane Doe");
});

test("underscore and hyphen separators work the same way", () => {
  assert.equal(nameFromEmail("jane_doe@sdcautomation.com"), "Jane Doe");
  assert.equal(nameFromEmail("jane-doe@sdcautomation.com"), "Jane Doe");
});

test("a local part with no separator is title-cased as one word", () => {
  assert.equal(nameFromEmail("jdoe@sdcautomation.com"), "Jdoe");
});

test("existing case is normalized, not just left alone", () => {
  assert.equal(nameFromEmail("JANE.DOE@sdcautomation.com"), "Jane Doe");
});

test("never returns an empty string", () => {
  assert.equal(nameFromEmail("@sdcautomation.com"), "New User");
});
