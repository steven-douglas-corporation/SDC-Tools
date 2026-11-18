import test from "node:test";
import assert from "node:assert/strict";
import { CARD_SIZES, DEFAULT_CARD_SIZE, parseCardSize } from "../src/lib/open-pos-card-size";

test("card size: the default is one step larger than the cards were before the slider (fewer across)", () => {
  assert.deepEqual(CARD_SIZES[DEFAULT_CARD_SIZE - 1], { min: 380, list: 288 });
  assert.deepEqual(CARD_SIZES[DEFAULT_CARD_SIZE], { min: 460, list: 384 });
});

test("card size: every step is bigger both ways than the one before", () => {
  for (let i = 1; i < CARD_SIZES.length; i++) {
    assert.ok(CARD_SIZES[i].min > CARD_SIZES[i - 1].min);
    assert.ok(CARD_SIZES[i].list > CARD_SIZES[i - 1].list);
  }
});

test("card size: a stored step is read back; anything else is the default", () => {
  assert.equal(parseCardSize("0"), 0);
  assert.equal(parseCardSize(String(CARD_SIZES.length - 1)), CARD_SIZES.length - 1);
  for (const bad of [null, "", " ", "-1", String(CARD_SIZES.length), "1.5", "large"]) {
    assert.equal(parseCardSize(bad), DEFAULT_CARD_SIZE, `${JSON.stringify(bad)}`);
  }
});
