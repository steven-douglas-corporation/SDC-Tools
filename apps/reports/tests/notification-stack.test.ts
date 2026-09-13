import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  foldToast,
  capToasts,
  shouldSuppress,
  autoDismissMs,
  MAX_VISIBLE_TOASTS,
  type ToastItem,
} from "../src/lib/notification-stack";

// Two independent notification surfaces (Toast.tsx, ChangeNotifications.tsx) used to
// spread across two corners of the screen with no shared cap and, on Toast's side, no
// dedup at all. They now render into one stack; this file pins the half of the merged
// rules that belongs to arbitrary-message toasts (ChangeNotifications' own cap/dedup,
// keyed on a grid cell rather than a message, is unchanged and stays pinned by its own
// existing tests).

function item(over: Partial<ToastItem> = {}): ToastItem {
  return { id: 1, message: "Saved", type: "success", critical: false, count: 1, ...over };
}

// ── Dedup (foldToast) ────────────────────────────────────────────────────────

test("a brand new message is appended, not folded", () => {
  const { items, bumpedId } = foldToast([], { id: 1, message: "Saved", type: "success", critical: false });
  assert.deepEqual(items, [item({ id: 1, count: 1 })]);
  assert.equal(bumpedId, null);
});

test("an identical (message, type) toast is bumped, not stacked as a second card", () => {
  const existing = [item({ id: 1, count: 1 })];
  const { items, bumpedId } = foldToast(existing, { id: 2, message: "Saved", type: "success", critical: false });
  assert.equal(items.length, 1, "still one card, not two");
  assert.equal(items[0].count, 2);
  assert.equal(items[0].id, 1, "the SURVIVING id is the original card's, so its own timer is the one re-scheduled");
  assert.equal(bumpedId, 1);
});

test("the same wording but a DIFFERENT type is a different toast, not a bump", () => {
  const existing = [item({ id: 1, type: "success", count: 1 })];
  const { items, bumpedId } = foldToast(existing, { id: 2, message: "Saved", type: "error", critical: false });
  assert.equal(items.length, 2, "success and error versions of the same words are not the same fact");
  assert.equal(bumpedId, null);
});

test("two DIFFERENT messages of the same shape are never merged into one", () => {
  // The dedup key is the exact string. "Copied 1101" and "Copied 1104" are two
  // different facts and merging them would hide the second copy entirely.
  const existing = [item({ id: 1, message: "Copied 1101", count: 1 })];
  const { items, bumpedId } = foldToast(existing, { id: 2, message: "Copied 1104", type: "success", critical: false });
  assert.equal(items.length, 2);
  assert.equal(bumpedId, null);
});

test("a bumped toast moves to the end — it is the most recent, whatever its original position", () => {
  const existing = [item({ id: 1, message: "A", count: 1 }), item({ id: 2, message: "B", count: 1 })];
  const { items } = foldToast(existing, { id: 3, message: "A", type: "success", critical: false });
  assert.deepEqual(items.map((t) => t.message), ["B", "A"]);
});

test("bumping takes the LATEST call's critical flag, not the first one's", () => {
  const existing = [item({ id: 1, critical: false, count: 1 })];
  const { items } = foldToast(existing, { id: 2, message: "Saved", type: "success", critical: true });
  assert.equal(items[0].critical, true);
});

test("bumping repeatedly keeps incrementing, not resetting to 2", () => {
  let items: ToastItem[] = [];
  for (let i = 0; i < 5; i++) {
    items = foldToast(items, { id: i + 1, message: "Saved", type: "success", critical: false }).items;
  }
  assert.equal(items.length, 1);
  assert.equal(items[0].count, 5);
});

// ── Cap (capToasts) ──────────────────────────────────────────────────────────

test("under the cap, nothing is trimmed", () => {
  const items = [item({ id: 1 }), item({ id: 2, message: "B" })];
  assert.deepEqual(capToasts(items, MAX_VISIBLE_TOASTS), items);
});

test("over the cap, the OLDEST non-critical items are trimmed first", () => {
  const items = [1, 2, 3, 4, 5].map((n) => item({ id: n, message: `M${n}` }));
  const kept = capToasts(items, 3);
  assert.deepEqual(kept.map((t) => t.id), [3, 4, 5], "the three most recent survive");
});

test("a burst of routine toasts cannot push a critical one off screen", () => {
  const critical = item({ id: 99, message: "Refresh failed", critical: true });
  const routine = [1, 2, 3, 4, 5].map((n) => item({ id: n, message: `M${n}` }));
  const items = [critical, ...routine]; // critical arrived FIRST, i.e. is the "oldest"
  const kept = capToasts(items, 3);
  assert.ok(kept.some((t) => t.id === 99), "the critical toast survives even though it is the oldest");
  assert.equal(kept.length, 3);
});

test("every critical toast survives even if critical items alone exceed the cap", () => {
  const critical = [1, 2, 3, 4].map((n) => item({ id: n, message: `C${n}`, critical: true }));
  const kept = capToasts(critical, 2);
  assert.equal(kept.length, 4, "the cap does not drop a critical message; see the note in the source");
});

test("relative order survives a trim — no reordering just because some items were cut", () => {
  const items = [1, 2, 3, 4, 5].map((n) => item({ id: n, message: `M${n}` }));
  const kept = capToasts(items, 3);
  const ids = kept.map((t) => t.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b), "still oldest-to-newest, not shuffled");
});

// ── Suppression (shouldSuppress) ─────────────────────────────────────────────

test("not suppressed anywhere outside the three named subtrees", () => {
  assert.equal(shouldSuppress(false, false), false);
  assert.equal(shouldSuppress(false, true), false);
});

test("a routine toast IS suppressed inside a suppressed subtree", () => {
  assert.equal(shouldSuppress(true, false), true);
  assert.equal(shouldSuppress(true, undefined), true);
});

test("a critical toast is NEVER suppressed, even inside a suppressed subtree", () => {
  // This is the one property the whole suppression feature must not get backwards:
  // Job Cost Explorer / Standard Sheet / Standard Card are told to stop generating
  // routine noise, not to stop reporting a save failure or a permission error.
  assert.equal(shouldSuppress(true, true), false);
});

// ── Timing (autoDismissMs) ────────────────────────────────────────────────────

test("errors linger longer than confirmations", () => {
  assert.ok(autoDismissMs("error") > autoDismissMs("success"));
  assert.ok(autoDismissMs("error") > autoDismissMs("info"));
});

// ── Severity grading and the one-action-one-notification rule (2026-09-02) ───
//
// Reported with a screenshot: a single refresh produced two cards side by side —
// a change-notification card ("Refresh for All data in Application recalculated
// from (blank) to refreshed at 8:25 AM") and the refresh toast that said the
// same thing in plainer words. Plus every confirmation sat for four seconds.

test("a confirmation clears in about 2.5s; a warning and an error linger", () => {
  assert.equal(autoDismissMs("success"), 2500);
  assert.equal(autoDismissMs("info"), 2500);
  assert.equal(autoDismissMs("warning"), 4000);
  assert.equal(autoDismissMs("error"), 6000);
  // The grade must stay monotonic — the whole point is that severity buys time.
  assert.ok(autoDismissMs("warning") > autoDismissMs("success"));
  assert.ok(autoDismissMs("error") > autoDismissMs("warning"));
});

test("nothing is sticky: every severity eventually clears itself", () => {
  // A toast that never leaves is one the reader has to tidy up by hand. The
  // message that genuinely needs standing attention (a refused edit) is a
  // ChangeNotifications card, which has its own no-expiry rule for that case.
  for (const kind of ["success", "info", "warning", "error"] as const) {
    assert.ok(Number.isFinite(autoDismissMs(kind)) && autoDismissMs(kind) > 0, kind);
  }
});

test("the toast half caps at 3, the same ceiling the change cards use", () => {
  // Two halves of one stack with different ideas of "too many" is how seven
  // cards end up on screen at once.
  assert.equal(MAX_VISIBLE_TOASTS, 3);
});

test("a warning is capped and folded like any other kind", () => {
  const w = (id: number) => item({ id, message: `W${id}`, type: "warning" as const });
  assert.deepEqual(capToasts([w(1), w(2), w(3), w(4)], MAX_VISIBLE_TOASTS).map((t) => t.id), [2, 3, 4]);
  const folded = foldToast([item({ id: 1, message: "Skipped 2 rows", type: "warning" })], {
    id: 2, message: "Skipped 2 rows", type: "warning", critical: false,
  });
  assert.equal(folded.items.length, 1);
  assert.equal(folded.items[0].count, 2);
});

test("a refresh announces itself ONCE — the change event syncs tabs without a card", () => {
  // The two halves of the fix, asserted where they live: the pass marks its
  // event `system`, and the card stack skips those. Either one alone puts the
  // duplicate card back.
  const service = readFileSync(join(process.cwd(), "src", "lib", "refresh-service.ts"), "utf8");
  const recordAt = service.indexOf("recordChanges(");
  assert.ok(recordAt !== -1, "the pass still publishes an event, so open tabs still update");
  assert.ok(service.slice(recordAt, recordAt + 900).includes("system: true"), "and marks it transport-only");

  const cards = readFileSync(join(process.cwd(), "src", "components", "ChangeNotifications.tsx"), "utf8");
  assert.match(cards, /if \(c\.system\) continue;/, "the card stack draws nothing for a system event");
});
