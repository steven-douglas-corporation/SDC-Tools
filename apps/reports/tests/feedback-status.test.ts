import test from "node:test";
import assert from "node:assert/strict";
import {
  FEEDBACK_STATUSES,
  FEEDBACK_STATUS_LABELS,
  FEEDBACK_STATUS_VARIANT,
  OPEN_FEEDBACK_STATUSES,
  DEFAULT_FEEDBACK_STATUS,
  isFeedbackStatus,
  isOpenFeedbackStatus,
  canTransition,
  FEEDBACK_CATEGORIES,
  FEEDBACK_CATEGORY_LABELS,
  DEFAULT_FEEDBACK_CATEGORY,
  isFeedbackCategory,
  FEEDBACK_SEVERITIES,
  FEEDBACK_SEVERITY_LABELS,
  DEFAULT_FEEDBACK_SEVERITY,
  isFeedbackSeverity,
} from "../src/lib/feedback-status";

// ── Totality ────────────────────────────────────────────────────────────────
//
// The status column is a VARCHAR, so TypeScript is the only thing constraining
// this vocabulary. These assertions are what make "add a status" a change that
// fails loudly here rather than one that renders an unstyled badge in the grid.

test("every status has a label and a badge variant", () => {
  for (const s of FEEDBACK_STATUSES) {
    assert.ok(FEEDBACK_STATUS_LABELS[s], `${s} needs a label`);
    assert.ok(FEEDBACK_STATUS_VARIANT[s], `${s} needs a badge variant`);
  }
  assert.equal(Object.keys(FEEDBACK_STATUS_LABELS).length, FEEDBACK_STATUSES.length);
  assert.equal(Object.keys(FEEDBACK_STATUS_VARIANT).length, FEEDBACK_STATUSES.length);
});

test("every category and severity has a label", () => {
  for (const c of FEEDBACK_CATEGORIES) assert.ok(FEEDBACK_CATEGORY_LABELS[c], `${c} needs a label`);
  for (const s of FEEDBACK_SEVERITIES) assert.ok(FEEDBACK_SEVERITY_LABELS[s], `${s} needs a label`);
  assert.equal(Object.keys(FEEDBACK_CATEGORY_LABELS).length, FEEDBACK_CATEGORIES.length);
  assert.equal(Object.keys(FEEDBACK_SEVERITY_LABELS).length, FEEDBACK_SEVERITIES.length);
});

test("the defaults are members of their own vocabularies", () => {
  assert.ok(isFeedbackStatus(DEFAULT_FEEDBACK_STATUS));
  assert.ok(isFeedbackCategory(DEFAULT_FEEDBACK_CATEGORY));
  assert.ok(isFeedbackSeverity(DEFAULT_FEEDBACK_SEVERITY));
  // A new item has to land in the queue, or the feature silently swallows it.
  assert.equal(DEFAULT_FEEDBACK_STATUS, "open");
  assert.ok(isOpenFeedbackStatus(DEFAULT_FEEDBACK_STATUS));
  // The button exists for data accuracy; that is the default it should offer.
  assert.equal(DEFAULT_FEEDBACK_CATEGORY, "data-accuracy");
});

test("the open queue is exactly the not-yet-resolved statuses", () => {
  assert.deepEqual([...OPEN_FEEDBACK_STATUSES], ["open", "ack"]);
  assert.ok(isOpenFeedbackStatus("ack"), "acknowledged still needs a resolution");
  assert.ok(!isOpenFeedbackStatus("fixed"));
  assert.ok(!isOpenFeedbackStatus("wontfix"));
});

// ── Narrowing at the write boundary ─────────────────────────────────────────

test("the guards reject anything outside the vocabulary", () => {
  for (const bad of ["", "OPEN", "closed", "resolved", "won't fix", "dataAccuracy"]) {
    assert.ok(!isFeedbackStatus(bad), `${JSON.stringify(bad)} is not a status`);
    assert.ok(!isFeedbackCategory(bad), `${JSON.stringify(bad)} is not a category`);
    assert.ok(!isFeedbackSeverity(bad), `${JSON.stringify(bad)} is not a severity`);
  }
  assert.ok(isFeedbackStatus("open"));
  assert.ok(isFeedbackCategory("data-accuracy"));
  assert.ok(isFeedbackSeverity("blocking"));
});

// ── Transitions ─────────────────────────────────────────────────────────────

test("closing an item requires a written note", () => {
  // The rule this feature exists for: a submitter who gets "Fixed" with no
  // explanation cannot tell it apart from being ignored.
  for (const to of ["fixed", "wontfix"] as const) {
    assert.equal(canTransition("open", to).ok, false, `${to} with no note must be refused`);
    assert.equal(canTransition("open", to, "   ").ok, false, "whitespace is not a note");
    assert.equal(canTransition("open", to, "Sage was posting to the wrong job.").ok, true);
  }
});

test("acknowledging needs no note", () => {
  // Picking something up should cost one click, or nobody triages.
  assert.equal(canTransition("open", "ack").ok, true);
});

test("a closed item can be reopened without a note", () => {
  // Direction is deliberately unconstrained: an item that turns out not to be
  // fixed must be reopenable, and walking back through "ack" to do it would be
  // ceremony with no reader.
  assert.equal(canTransition("fixed", "open").ok, true);
  assert.equal(canTransition("wontfix", "ack").ok, true);
});

test("a no-op transition is refused with a readable reason", () => {
  const r = canTransition("ack", "ack");
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /already acknowledged/i);
});

test("every refusal carries a message a user can act on", () => {
  for (const from of FEEDBACK_STATUSES) {
    for (const to of FEEDBACK_STATUSES) {
      const r = canTransition(from, to);
      if (!r.ok) {
        assert.ok(r.error.length > 0, `${from}->${to} must explain itself`);
        assert.ok(/[.!]$/.test(r.error), `${from}->${to} should read as a sentence`);
      }
    }
  }
});
