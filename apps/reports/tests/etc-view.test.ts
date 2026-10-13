import { test } from "node:test";
import assert from "node:assert/strict";
import { etcViewWriteParams, etcViewExtraRules, hiddenFromEtcParams, nextHiddenBlocks } from "../src/lib/etc-view";
import { etcViewCookieValue, hasExplicitEtcView, parseEtcViewCookie } from "../src/lib/etc-view-cookie";

// The Monthly ETC "Columns" rules: Engineering, Shop and Parts Cost blocks, and Job Name.
//
// These exist as tests because the first implementation of the group rule had its
// boolean inverted: clicking the box hid nothing, produced no error, and looked exactly
// like a working control that had stopped working. That is the whole subject of §40, so
// the rule is pinned rather than reviewed.

const hiddenOf = (...keys: string[]) => new Set(keys);
const sorted = (xs: Iterable<string>) => [...xs].sort();

test("clicking a visible block hides it", () => {
  assert.deepEqual(nextHiddenBlocks(hiddenOf(), "Shop"), ["Shop"]);
  assert.deepEqual(nextHiddenBlocks(hiddenOf(), "Engineering"), ["Engineering"]);
  assert.deepEqual(nextHiddenBlocks(hiddenOf(), "parts"), ["parts"]);
});

test("clicking a hidden block shows it again", () => {
  assert.deepEqual(nextHiddenBlocks(hiddenOf("Shop"), "Shop"), []);
  assert.deepEqual(nextHiddenBlocks(hiddenOf("parts", "Shop"), "parts"), ["Shop"]);
});

test("both hours blocks can go off while Parts Cost stays on — the PM view", () => {
  const afterEng = nextHiddenBlocks(hiddenOf(), "Engineering");
  const afterBoth = nextHiddenBlocks(new Set(afterEng), "Shop");
  assert.deepEqual(sorted(afterBoth), ["Engineering", "Shop"]);
});

test("hiding the LAST visible block is refused and changes nothing", () => {
  // Parts Cost is the only block left: it cannot be unticked.
  const partsOnly = hiddenOf("Engineering", "Shop");
  assert.deepEqual(sorted(nextHiddenBlocks(partsOnly, "parts")), ["Engineering", "Shop"]);
  // ...and the same when the last one is an hours block.
  const shopOnly = hiddenOf("Engineering", "parts");
  assert.deepEqual(sorted(nextHiddenBlocks(shopOnly, "Shop")), ["Engineering", "parts"]);
});

test("non-block keys such as jobname are carried through untouched, and unknown clicks do nothing", () => {
  assert.deepEqual(sorted(nextHiddenBlocks(hiddenOf("jobname"), "Shop")), ["Shop", "jobname"]);
  assert.deepEqual(nextHiddenBlocks(hiddenOf("jobname"), "jobname"), ["jobname"], "jobname is not a block");
});

test("the click is idempotent in pairs — two clicks return to the start", () => {
  let hidden = nextHiddenBlocks(hiddenOf(), "Shop");
  hidden = nextHiddenBlocks(new Set(hidden), "Shop");
  assert.deepEqual(hidden, [], "clicking the same box twice must return to everything visible");
});

test("hiddenFromEtcParams: the params a URL or cookie can carry", () => {
  assert.deepEqual(hiddenFromEtcParams({}), []);
  assert.deepEqual(hiddenFromEtcParams({ dept: "Engineering" }), ["Shop"]);
  assert.deepEqual(hiddenFromEtcParams({ dept: "Shop,Engineering" }), []);
  assert.deepEqual(sorted(hiddenFromEtcParams({ dept: "none" })), ["Engineering", "Shop"]);
  assert.deepEqual(hiddenFromEtcParams({ parts: "0" }), ["parts"]);
  assert.deepEqual(hiddenFromEtcParams({ parts: "1" }), [], "only 0 hides Parts Cost");
  assert.deepEqual(hiddenFromEtcParams({ jobname: "0" }), ["jobname"]);
  // Unrecognized dept values are the full grid, as before, not "none".
  assert.deepEqual(hiddenFromEtcParams({ dept: "Banana" }), []);
  assert.deepEqual(hiddenFromEtcParams({ dept: "" }), []);
});

test("hiddenFromEtcParams: a view that would hide every block is shown in full", () => {
  // Only reachable from a hand-edited URL or cookie; the menu cannot produce it. An
  // empty grid is the wrong reading of nonsense.
  assert.deepEqual(hiddenFromEtcParams({ dept: "none", parts: "0" }), []);
  assert.deepEqual(hiddenFromEtcParams({ dept: "none", parts: "0", jobname: "0" }), ["jobname"], "Job Name is independent");
});

test("every hidden set the menu can produce survives write -> parse", () => {
  const sets = [[], ["Shop"], ["Engineering"], ["Engineering", "Shop"], ["parts"], ["Engineering", "parts"], ["jobname"], ["Engineering", "Shop", "jobname"], ["Shop", "parts", "jobname"]];
  for (const hidden of sets) {
    const qs = new URLSearchParams();
    etcViewWriteParams(new Set(hidden), qs);
    const back = hiddenFromEtcParams({ dept: qs.get("dept") ?? undefined, jobname: qs.get("jobname") ?? undefined, parts: qs.get("parts") ?? undefined });
    assert.deepEqual(sorted(back), sorted(hidden), `hidden=${JSON.stringify(hidden)}`);
  }
});

test("the saved-view cookie: round-trips, forgets the default, and a bad value is the full grid", () => {
  assert.equal(etcViewCookieValue(hiddenOf()), "", "nothing hidden = nothing stored");
  const partsOnly = etcViewCookieValue(hiddenOf("Engineering", "Shop"));
  assert.equal(partsOnly, "dept=none");
  assert.deepEqual(sorted(hiddenFromEtcParams(parseEtcViewCookie(partsOnly))), ["Engineering", "Shop"]);
  // Next hands the server a decoded value; a browser-encoded one must parse the same.
  assert.deepEqual(parseEtcViewCookie(encodeURIComponent("dept=none&jobname=0")), { dept: "none", jobname: "0", parts: undefined });
  assert.deepEqual(parseEtcViewCookie(undefined), {});
  assert.deepEqual(parseEtcViewCookie(""), {});
  assert.deepEqual(parseEtcViewCookie("%E0%A4%A"), {}, "a malformed escape degrades to the default");
  assert.deepEqual(hiddenFromEtcParams(parseEtcViewCookie("dept=none&parts=0")), [], "a nonsense cookie is the full grid");
});

test("an explicit view in the URL wins over the cookie; none of the three params falls back to it", () => {
  assert.equal(hasExplicitEtcView({}), false);
  assert.equal(hasExplicitEtcView({ dept: "Shop" }), true);
  assert.equal(hasExplicitEtcView({ parts: "0" }), true);
  assert.equal(hasExplicitEtcView({ jobname: "0" }), true);
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
  const qs = new URLSearchParams("dept=none&jobname=0&parts=0&month=2026-07");
  etcViewWriteParams(new Set(), qs);
  assert.equal(qs.get("dept"), null);
  assert.equal(qs.get("jobname"), null);
  assert.equal(qs.get("parts"), null);
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

test("writeParams: Parts Cost only is `dept=none`, and hiding Parts Cost is `parts=0`", () => {
  const q1 = new URLSearchParams();
  etcViewWriteParams(new Set(["Engineering", "Shop"]), q1);
  assert.equal(q1.get("dept"), "none");
  assert.equal(q1.get("parts"), null);

  const q2 = new URLSearchParams();
  etcViewWriteParams(new Set(["parts"]), q2);
  assert.equal(q2.get("parts"), "0");
  assert.equal(q2.get("dept"), null, "hiding Parts Cost must not touch dept");
});

// Every Parts Cost cell has to carry data-col="parts": one without it stays on screen in
// the Parts Cost-only view's mirror image (hours only) and leaves a stray column, and a
// header band over missing cells shears the table sideways. The count is the guard — if a
// Parts Cost column is added, this number moves with it, on purpose.
test("every Parts Cost header, body and footer cell carries the hide key", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const read = (...p: string[]) => readFileSync(join(process.cwd(), "src", ...p), "utf8");
  const count = (s: string) => (s.match(/data-col="parts"/g) ?? []).length;
  // 3 header cells + 5 body cells (no-entry fallback, Prior, Money Spent, Money Left, Diff)
  // + 7 footer cells (Prior, Money Spent, Money Left, Left to Invoice/Purchase, New ETC, Diff).
  assert.equal(count(read("app", "(app)", "etc", "page.tsx")), 15);
  // The two client cells the body renders: Left to Invoice / Left to Purchase (read-only
  // and editable variants) and Parts Cost New ETC.
  assert.equal(count(read("components", "PartsBreakoutCell.tsx")), 2);
  assert.equal(count(read("components", "PartsCostNewEtcCell.tsx")), 1);
});
