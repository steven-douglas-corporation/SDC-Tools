import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanKey, freeKey, isKey, keyFromName } from "../src/modules/tracker/project-key";

test("a key is 2 to 8 capitals or digits, starting with a letter", () => {
  assert.equal(isKey("BIN"), true);
  assert.equal(isKey("VISION2"), true);
  assert.equal(isKey("A"), false, "too short");
  assert.equal(isKey("TOOLONGKEY"), false);
  assert.equal(isKey("2FAST"), false, "starts with a digit");
  assert.equal(cleanKey("open po's!! page"), "OPENPOSP", "made capital, stripped, cut to 8");
});

test("a taken key gets the lowest number that frees it, within 8 characters", () => {
  assert.equal(freeKey("VISION", []), "VISION");
  assert.equal(freeKey("VISION", ["vision"]), "VISION2", "case does not matter");
  assert.equal(freeKey("VISION", ["VISION", "VISION2"]), "VISION3");
  assert.equal(freeKey("PRIVREPO", ["PRIVREPO"]), "PRIVREP2", "the number takes the last letter's place");
});

test("a key is made from a name by rule: the word, or the initials of the words that carry meaning", () => {
  assert.equal(keyFromName("Vision"), "VISION");
  assert.equal(keyFromName("Open POs page"), "OPP");
  assert.equal(keyFromName("Move to GitHub Enterprise"), "MGE", "filler words are left out");
  assert.equal(keyFromName("Data warehouse"), "DATA", "two initials say too little, so the first word");
  assert.equal(keyFromName("The"), "THE", "a name of only filler still gets one");
  assert.equal(keyFromName("2027 server move"), "SM", "never starts with a digit");
  assert.equal(keyFromName(""), "");
  assert.equal(keyFromName("  !!  "), "");
  assert.equal(keyFromName("Vision", ["VISION"]), "VISION2");
});
