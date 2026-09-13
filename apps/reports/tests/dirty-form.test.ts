import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldSend, ALWAYS_SEND_PREFIXES, BASELINE_ATTR } from "../src/lib/dirty-form";

// The Projects grid is one <form> around the whole matrix, so a native submit
// posts ~1,100 fields however little was edited. These pin the rule that decides
// what actually goes — the risk being a rule that drops a real edit, which is far
// worse than one that sends too much.

test("an untouched cell is not sent", () => {
  assert.equal(shouldSend({ name: "quoted__12__10-211", value: "40", baseline: "40" }), false);
});

test("an edited cell is sent", () => {
  assert.equal(shouldSend({ name: "quoted__12__10-211", value: "48", baseline: "40" }), true);
});

test("clearing a cell that had a value is an edit", () => {
  // "" vs "40" — a cleared cell means zero hours, and must not be mistaken for
  // an untouched blank.
  assert.equal(shouldSend({ name: "quoted__12__10-211", value: "", baseline: "40" }), true);
});

test("a blank cell that was already blank is not sent", () => {
  assert.equal(shouldSend({ name: "quoted__12__10-211", value: "", baseline: "" }), false);
});

test("an UNKNOWN baseline is always sent", () => {
  // A control whose render site never declared data-baseline. Sending it is the
  // old behaviour, which is the only safe reading of "no baseline stated".
  assert.equal(shouldSend({ name: "jobField__12__jobName", value: "Coil Staker", baseline: null }), true);
});

test("new-project rows are always sent, even matching their baseline", () => {
  // They exist only in the browser until saved, and the action needs every field
  // of a new row (Job Id and Type are required) — not just the typed ones.
  for (const p of ALWAYS_SEND_PREFIXES) {
    assert.equal(shouldSend({ name: `${p}tmp1__jobId`, value: "", baseline: "" }), true);
  }
});

test("a job field edit is sent, its siblings are not", () => {
  // saveJobFields keys off which fields are PRESENT for a job, so a partial
  // payload is exactly what it expects.
  assert.equal(shouldSend({ name: "jobField__12__customer", value: "Molex, LLC", baseline: "Molex" }), true);
  assert.equal(shouldSend({ name: "jobField__12__status", value: "Active", baseline: "Active" }), false);
});

test("the baseline attribute name is the one the components render", () => {
  // Renamed in one place only — page.tsx, DateCell and MoneyCell all stamp this.
  assert.equal(BASELINE_ATTR, "data-baseline");
});
