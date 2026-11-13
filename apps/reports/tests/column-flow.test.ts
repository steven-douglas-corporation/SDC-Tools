import test from "node:test";
import assert from "node:assert/strict";
import { splitInOrder } from "../src/lib/column-flow";

// Cards that run down columns (ListCardGrid flow="columns"): where the columns are cut.

const total = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
/** The tallest column's weight for a split. */
function tallest(weights: number[], sizes: number[]): number {
  let at = 0;
  return Math.max(
    ...sizes.map((n) => {
      const h = total(weights.slice(at, at + n));
      at += n;
      return h;
    }),
  );
}

test("few equal cards fill every column instead of leaving the last one empty", () => {
  // What CSS columns do with this is 2, 2, 2 and a blank fourth column.
  assert.deepEqual(splitInOrder([1, 1, 1, 1, 1, 1], 4), [2, 2, 1, 1]);
  assert.deepEqual(splitInOrder([1, 1, 1, 1, 1], 3), [2, 2, 1]);
});

test("every card is placed once, in order, and no column is empty while cards remain", () => {
  const weights = [5, 1, 1, 8, 2, 2, 2, 9, 1, 3];
  for (const k of [1, 2, 3, 4, 5]) {
    const sizes = splitInOrder(weights, k);
    assert.equal(sizes.length, k);
    assert.equal(total(sizes), weights.length);
    assert.ok(sizes.every((n) => n > 0), `no empty column at ${k}`);
  }
});

test("the tallest column is as short as it can be", () => {
  // Two columns: the best cut is after the third card (10 and 10), not half the cards each.
  assert.deepEqual(splitInOrder([7, 2, 1, 4, 3, 3], 2), [3, 3]);
  // A single tall card gets a column to itself.
  const weights = [1, 1, 10, 1, 1];
  const sizes = splitInOrder(weights, 3);
  assert.equal(tallest(weights, sizes), 10);
  assert.deepEqual(sizes, [2, 1, 2]);
});

test("more columns than cards: one card each, the rest empty; nothing to place: all empty", () => {
  assert.deepEqual(splitInOrder([3, 1], 4), [1, 1, 0, 0]);
  assert.deepEqual(splitInOrder([], 3), [0, 0, 0]);
  assert.deepEqual(splitInOrder([4, 4, 4], 1), [3]);
});

test("a missing or nonsensical weight counts as 1 rather than breaking the layout", () => {
  assert.equal(total(splitInOrder([NaN, 0, -3, 2], 2)), 4);
  assert.deepEqual(splitInOrder([NaN, NaN, NaN, NaN], 2), [2, 2]);
});
