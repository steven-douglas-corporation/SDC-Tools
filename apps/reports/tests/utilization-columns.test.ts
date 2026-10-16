import { test } from "node:test";
import assert from "node:assert/strict";
import { isEmptyMeasure } from "../src/lib/utilization-columns";

// The Utilization table drops any breakdown column that is empty for the month.
// What has to hold: a column with data is never hidden, and a column is only
// hidden when the TOTAL — the sum of every department row — says it is empty.

test("a column is empty when the total is zero or blank, and not otherwise", () => {
  const total = { bellco: 0, warranty: 42, travelHours: null, spare: 0.4 } as never;
  assert.equal(isEmptyMeasure(total, "bellco" as never), true);
  assert.equal(isEmptyMeasure(total, "travelHours" as never), true);
  assert.equal(isEmptyMeasure(total, "warranty" as never), false);
  assert.equal(isEmptyMeasure(total, "spare" as never), false, "a fraction of an hour is still something");
});
