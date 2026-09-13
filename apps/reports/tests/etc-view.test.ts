import { test } from "node:test";
import assert from "node:assert/strict";
import { ETC_DEPT_GROUPS, nextHiddenGroups, etcViewWriteParams, etcViewExtraRules } from "../src/lib/etc-view";

// The Monthly ETC "Section columns" / "Job Name column" rules.
//
// These exist as tests because the first implementation of nextHiddenGroups had its
// boolean inverted: clicking the box hid nothing, produced no error, and looked exactly
// like a working control that had stopped working. That is the whole subject of §40, so
// the rule is pinned rather than reviewed.

test("clicking a visible group hides it", () => {
  const bothVisible = new Set(ETC_DEPT_GROUPS);
  assert.deepEqual(nextHiddenGroups(bothVisible, "Shop"), ["Shop"]);
  assert.deepEqual(nextHiddenGroups(bothVisible, "Engineering"), ["Engineering"]);
});

test("clicking a hidden group shows it again, hiding nothing", () => {
  // Shop hidden, Engineering visible; clicking Shop brings it back.
  assert.deepEqual(nextHiddenGroups(new Set(["Engineering"]), "Shop"), []);
});

test("unticking the LAST visible group restores both instead of emptying the grid", () => {
  // Shop already hidden. Unticking Engineering would leave zero section columns, which
  // the grid cannot render and `?dept=` cannot express — so it resets to both.
  assert.deepEqual(nextHiddenGroups(new Set(["Engineering"]), "Engineering"), []);
});

test("the click is idempotent in pairs — two clicks return to the start", () => {
  let hidden = nextHiddenGroups(new Set(ETC_DEPT_GROUPS), "Shop");
  assert.deepEqual(hidden, ["Shop"]);
  const visible = new Set(ETC_DEPT_GROUPS.filter((g) => !hidden.includes(g)));
  hidden = nextHiddenGroups(visible, "Shop");
  assert.deepEqual(hidden, [], "clicking the same box twice must return to both visible");
});

test("writeParams: dept and jobname round-trip, and defaults leave the URL clean", () => {
  const qs = new URLSearchParams();
  etcViewWriteParams(new Set(), qs);
  assert.equal(qs.toString(), "", "nothing hidden must write no params at all");

  const q2 = new URLSearchParams();
  etcViewWriteParams(new Set(["Shop"]), q2);
  assert.equal(q2.get("dept"), "Engineering");
  assert.equal(q2.get("jobname"), null);

  const q3 = new URLSearchParams();
  etcViewWriteParams(new Set(["jobname"]), q3);
  assert.equal(q3.get("jobname"), "0");
  assert.equal(q3.get("dept"), null, "hiding Job Name must not touch dept");
});

test("writeParams CLEARS a param that is no longer needed", () => {
  // The load-bearing direction: the URL is rewritten in place, so showing a group again
  // has to delete `dept` rather than leave the old value behind. A stale `dept` would
  // survive a reload and re-hide a column the user had just restored.
  const qs = new URLSearchParams("dept=Engineering&jobname=0&month=2026-07");
  etcViewWriteParams(new Set(), qs);
  assert.equal(qs.get("dept"), null);
  assert.equal(qs.get("jobname"), null);
  assert.equal(qs.get("month"), "2026-07", "unrelated params must survive untouched");
});

test("extraRules only fires for Job Name, and is scoped", () => {
  assert.equal(etcViewExtraRules(new Set(["Shop"]), "[data-grid]"), "", "hiding a group needs no extra rules");
  const css = etcViewExtraRules(new Set(["jobname"]), '[data-grid="etc"]');
  assert.match(css, /\[data-etc-jobid\]\{border-right:8px/, "the heavy divider must move onto Job Id");
  assert.match(css, /\[data-etc-total-fallback\]\{visibility:visible\}/, "the footer Total label must move with it");
  assert.ok(!css.includes("[data-etc-jobid]{border-right:8px solid #808080}[data-etc"), "rules must stay scoped");
  assert.ok(css.startsWith('[data-grid="etc"] '), "every rule must be prefixed with the grid scope");
});
