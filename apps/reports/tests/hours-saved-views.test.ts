import { test } from "node:test";
import assert from "node:assert/strict";
import {
  snapshotFromSearch,
  renameMyView,
  deleteMyView,
  fixupDefaultPointer,
  parseMyViews,
  parseDefaultPointer,
  hrefForView,
  type MyViews,
} from "../src/lib/hours-saved-views";

// ── snapshotFromSearch ───────────────────────────────────────────────────────

test("snapshots only the allowlisted params that are actually present", () => {
  const config = snapshotFromSearch("?jobs=1148%2C1150&from=2026-07-01&bogus=x");
  assert.deepEqual(config.params, { jobs: "1148,1150", from: "2026-07-01" });
});

test("page and view are never captured, even if present in the search string", () => {
  const config = snapshotFromSearch("?jobs=1148&page=3&view=SomeView");
  assert.deepEqual(config.params, { jobs: "1148" });
});

test("works with or without a leading question mark", () => {
  const withQ = snapshotFromSearch("?jobs=1148");
  const withoutQ = snapshotFromSearch("jobs=1148");
  assert.deepEqual(withQ.params, withoutQ.params);
});

test("an empty search string snapshots to no params", () => {
  assert.deepEqual(snapshotFromSearch("").params, {});
});

// ── hrefForView ──────────────────────────────────────────────────────────────

test("builds a /hours href carrying every param plus the view label", () => {
  const href = hrefForView({ params: { jobs: "1148", from: "2026-07-01" } }, "My View");
  const url = new URL(href, "https://example.test");
  assert.equal(url.pathname, "/hours");
  assert.equal(url.searchParams.get("jobs"), "1148");
  assert.equal(url.searchParams.get("from"), "2026-07-01");
  assert.equal(url.searchParams.get("view"), "My View");
});

// ── renameMyView ─────────────────────────────────────────────────────────────

test("renames a view, preserving its config under the new name", () => {
  const all: MyViews = { Old: { params: { jobs: "1148" } } };
  const result = renameMyView(all, "Old", "New");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.views, { New: { params: { jobs: "1148" } } });
  }
});

test("renaming to a name already in use fails rather than silently overwriting it", () => {
  const all: MyViews = { A: { params: { jobs: "1" } }, B: { params: { jobs: "2" } } };
  const result = renameMyView(all, "A", "B");
  assert.equal(result.ok, false);
});

test("renaming a view to its own current name is a harmless no-op", () => {
  const all: MyViews = { A: { params: { jobs: "1" } } };
  const result = renameMyView(all, "A", "A");
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.views, all);
});

test("renaming a view that no longer exists fails rather than creating one", () => {
  const result = renameMyView({}, "Ghost", "New");
  assert.equal(result.ok, false);
});

test("an empty new name is rejected", () => {
  const all: MyViews = { A: { params: {} } };
  const result = renameMyView(all, "A", "   ");
  assert.equal(result.ok, false);
});

// ── deleteMyView ─────────────────────────────────────────────────────────────

test("deletes the named view and leaves the rest untouched", () => {
  const all: MyViews = { A: { params: { jobs: "1" } }, B: { params: { jobs: "2" } } };
  assert.deepEqual(deleteMyView(all, "A"), { B: { params: { jobs: "2" } } });
});

test("deleting a name that isn't there is a no-op", () => {
  const all: MyViews = { A: { params: {} } };
  assert.deepEqual(deleteMyView(all, "Ghost"), all);
});

// ── fixupDefaultPointer ──────────────────────────────────────────────────────
//
// The one piece of genuinely new logic worth its own attention: a rename/delete
// elsewhere must patch or clear the default pointer if (and only if) it names the
// view being touched, or the pointer goes stale or starts pointing at whatever later
// reuses that name.

test("a null pointer stays null regardless of what changed", () => {
  assert.equal(fixupDefaultPointer(null, { kind: "rename", from: "A", to: "B" }), null);
  assert.equal(fixupDefaultPointer(null, { kind: "delete", name: "A" }), null);
});

test("renaming the view the pointer names repoints it to the new name", () => {
  const ptr = { tier: "mine" as const, name: "A" };
  assert.deepEqual(fixupDefaultPointer(ptr, { kind: "rename", from: "A", to: "B" }), { tier: "mine", name: "B" });
});

test("renaming a DIFFERENT view leaves the pointer untouched", () => {
  const ptr = { tier: "mine" as const, name: "A" };
  assert.deepEqual(fixupDefaultPointer(ptr, { kind: "rename", from: "Other", to: "B" }), ptr);
});

test("deleting the view the pointer names clears it", () => {
  const ptr = { tier: "mine" as const, name: "A" };
  assert.equal(fixupDefaultPointer(ptr, { kind: "delete", name: "A" }), null);
});

test("deleting a DIFFERENT view leaves the pointer untouched", () => {
  const ptr = { tier: "mine" as const, name: "A" };
  assert.deepEqual(fixupDefaultPointer(ptr, { kind: "delete", name: "Other" }), ptr);
});

// ── parseMyViews / parseDefaultPointer ────────────────────────────────────────

test("parseMyViews recovers a valid map", () => {
  const raw = JSON.stringify({ "My View": { params: { jobs: "1148" } } });
  assert.deepEqual(parseMyViews(raw), { "My View": { params: { jobs: "1148" } } });
});

test("parseMyViews tolerates null, malformed JSON, and malformed entries", () => {
  assert.deepEqual(parseMyViews(null), {});
  assert.deepEqual(parseMyViews("not json"), {});
  assert.deepEqual(parseMyViews(JSON.stringify({ Good: { params: {} }, Bad: { oops: true } })), { Good: { params: {} } });
});

test("parseDefaultPointer recovers a valid pointer and rejects everything else", () => {
  assert.deepEqual(parseDefaultPointer(JSON.stringify({ tier: "mine", name: "A" })), { tier: "mine", name: "A" });
  assert.equal(parseDefaultPointer(null), null);
  assert.equal(parseDefaultPointer("not json"), null);
  assert.equal(parseDefaultPointer(JSON.stringify({ tier: "shared", name: "A" })), null);
  assert.equal(parseDefaultPointer(JSON.stringify({ tier: "mine", name: "" })), null);
});
