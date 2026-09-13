import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildGridViewCss,
  bandColSpan,
  isSafeViewKey,
  toggleHidden,
  deptParamFromHidden,
} from "../src/lib/grid-view";

// The properties that make a presentational filter instant, and the two that make it
// SAFE. §40.2 asks for filter results within 150ms using already-loaded data; the
// mechanism only delivers that if hiding a column stays O(1) in cell count, so what is
// pinned here is the shape of the output rather than a timing.

test("nothing hidden emits no CSS at all", () => {
  // The common case must not put a rule in the document. An empty `{display:none}`
  // rule would be harmless but it is also the shape a bug takes — a selector that
  // matched everything would blank the grid.
  assert.equal(buildGridViewCss('[data-grid="etc"]', []), "");
});

test("one rule covers every hidden key, scoped to the one grid", () => {
  const css = buildGridViewCss('[data-grid="etc"]', ["10-311", "Shop"]);
  assert.equal(css, '[data-grid="etc"] [data-col~="10-311"],[data-grid="etc"] [data-col~="Shop"]{display:none}');
  // Scoped: a second grid on the page keeps its own columns.
  assert.ok(!css.includes('[data-col~="10-311"]{'), "rule must always be scoped to the grid");
});

test("display:none, not visibility:hidden — the remaining columns have to close up", () => {
  // visibility:hidden leaves the cell occupying its column, so the grid would keep a
  // blank gap where the section used to be. That was the visible symptom the first
  // attempt at this produced.
  assert.match(buildGridViewCss("[data-grid]", ["x"]), /display:none/);
});

test("a key that needs escaping is dropped, not escaped", () => {
  // Keys arrive from the query string. Anything that could close the selector or the
  // <style> element is refused outright.
  assert.ok(!isSafeViewKey('a"]{}'), "quote/brace must be rejected");
  assert.ok(!isSafeViewKey("</style>"), "angle brackets must be rejected");
  assert.ok(!isSafeViewKey(""), "empty key must be rejected");
  assert.ok(isSafeViewKey("10-311"), "a section code is a valid key");
  assert.ok(isSafeViewKey("startDate"), "an info-column key is a valid key");
  assert.ok(isSafeViewKey("General Engineering"), "a space-bearing group label is a valid key");

  const css = buildGridViewCss("[data-grid]", ['evil"]{color:red}[x="', "10-311"]);
  assert.ok(!css.includes("color:red"), "an unsafe key must not reach the stylesheet");
  assert.ok(css.includes('[data-col~="10-311"]'), "the safe key alongside it still applies");
});

test("bandColSpan counts only the visible leaf columns, times the sub-column width", () => {
  const codes = ["10-211", "10-312", "10-313"];
  // Monthly ETC prints five sub-columns per section.
  assert.equal(bandColSpan(codes, new Set(), 5), 15);
  assert.equal(bandColSpan(codes, new Set(["10-312"]), 5), 10);
  // Projects prints one.
  assert.equal(bandColSpan(codes, new Set(["10-312"]), 1), 2);
});

test("a band shrinks when a leaf's GROUP is hidden, not just its own code", () => {
  // The regression this pins: entries carry every key that can hide the leaf, the same
  // way `data-col` does. Comparing codes alone left the phase row spanning 78 columns
  // over a 58-column body — the banded header sheared sideways on screen.
  const entries = ["10-211 Engineering", "10-312 Engineering", "10-411 Shop", "10-412 Shop"];
  assert.equal(bandColSpan(entries, new Set(), 5), 20, "nothing hidden spans all four leaves");
  assert.equal(bandColSpan(entries, new Set(["Shop"]), 5), 10, "hiding the Shop GROUP must drop its two leaves");
  assert.equal(bandColSpan(entries, new Set(["Engineering"]), 5), 10);
  assert.equal(bandColSpan(entries, new Set(["10-211"]), 5), 15, "hiding one code still works");
  // Both mechanisms at once, and a leaf hidden twice counts once.
  assert.equal(bandColSpan(entries, new Set(["Shop", "10-211"]), 5), 5);
  assert.equal(bandColSpan(entries, new Set(["Shop", "10-411"]), 5), 10, "a leaf hidden by code AND group is one leaf");
});

test("header bands and body row agree on the total column count", () => {
  // The invariant that actually matters: whatever is hidden, the sum of the bands'
  // colSpans must equal the number of visible leaf columns. This is the arithmetic the
  // browser uses to lay the table out, so if it holds the header cannot shear.
  const leaves = [
    "10-211 Engineering", "10-312 Engineering", "10-313 Engineering",
    "10-411 Shop", "10-412 Shop",
  ];
  // Two bands: Engineering's three leaves and Shop's two.
  const bands = [leaves.slice(0, 3), leaves.slice(3)];
  for (const hidden of [[], ["Shop"], ["Engineering"], ["10-312"], ["Shop", "10-211"]]) {
    const h = new Set(hidden);
    const bandTotal = bands.reduce((s, b) => s + bandColSpan(b, h, 5), 0);
    const visibleLeaves = leaves.filter((l) => !l.split(" ").some((k) => h.has(k))).length;
    assert.equal(bandTotal, visibleLeaves * 5, `bands must span exactly the visible leaves for hidden=${JSON.stringify(hidden)}`);
  }
});

test("a band with every leaf column hidden reports 0 so the caller hides it", () => {
  // Load-bearing: colSpan={0} means "span to the end of the column group" in HTML,
  // not "span nothing". Writing 0 would make the band swallow the rest of the row,
  // which is the misaligned-header failure this returns 0 to prevent.
  assert.equal(bandColSpan(["a", "b"], new Set(["a", "b"]), 5), 0);
});

test("toggleHidden adds and removes without mutating its input", () => {
  const before = ["a"];
  assert.deepEqual(toggleHidden(before, "b"), ["a", "b"]);
  assert.deepEqual(toggleHidden(before, "a"), []);
  assert.deepEqual(before, ["a"], "input array must not be mutated");
});

test("dept: hiding one group names the other; hiding both or neither is the default", () => {
  const groups = ["Engineering", "Shop"];
  assert.equal(deptParamFromHidden(groups, new Set()), null, "neither hidden = default URL");
  assert.equal(deptParamFromHidden(groups, new Set(["Shop"])), "Engineering");
  assert.equal(deptParamFromHidden(groups, new Set(["Engineering"])), "Shop");
  // The grid cannot render zero section columns, and the server reads an absent
  // `dept` as both — so "both hidden" must normalise to the same thing rather than
  // producing a URL that renders an empty grid on reload.
  assert.equal(deptParamFromHidden(groups, new Set(["Engineering", "Shop"])), null);
});

test("the URL the client writes round-trips through the server's own parser", () => {
  // The invariant that keeps a share link and a reload honest: whatever
  // deptParamFromHidden writes, the page's parser must turn back into the same
  // visible groups. This mirrors the parser at etc/page.tsx (raw -> Set, empty =>
  // both) rather than importing it, because that module is server-only.
  const groups = ["Engineering", "Shop"] as const;
  const parse = (param: string | null) => {
    const raw = (param ?? "").split(",").map((s) => s.trim()).filter((g) => g === "Engineering" || g === "Shop");
    return new Set(raw.length ? raw : groups);
  };
  for (const hidden of [[], ["Shop"], ["Engineering"], ["Engineering", "Shop"]]) {
    const shownAfterReload = parse(deptParamFromHidden(groups, new Set(hidden)));
    const expected = new Set(hidden.length === groups.length ? groups : groups.filter((g) => !hidden.includes(g)));
    assert.deepEqual([...shownAfterReload].sort(), [...expected].sort(), `round-trip failed for hidden=${JSON.stringify(hidden)}`);
  }
});
