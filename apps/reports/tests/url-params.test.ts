import { test } from "node:test";
import assert from "node:assert/strict";
import { nextParams, notePendingParams, __resetPendingParams } from "../src/lib/url-params";

// The in-flight overlay behind every toolbar filter. The failure it prevents is
// silent — a filter you set a moment ago simply reverts, with no error — so the
// window it applies in, and the windows it must NOT apply in, are pinned here.

test("with nothing in flight, builds on what the router reports", () => {
  __resetPendingParams();
  assert.equal(nextParams("statuses=Active").toString(), "statuses=Active");
});

test("a second change while the first is in flight builds on the FIRST", () => {
  // The whole point. searchParams still says A because the navigation to B
  // hasn't committed; without the overlay this second change would be built on
  // A and would throw away everything the first one set.
  __resetPendingParams();
  const base = "statuses=Active";
  notePendingParams(base, "statuses=Active&customers=Acme");

  const qs = nextParams(base); // the router still reports A
  qs.set("types", "Custom");
  assert.equal(qs.get("customers"), "Acme", "the first change must survive");
  assert.equal(qs.get("types"), "Custom");
});

test("three changes in a row all survive", () => {
  __resetPendingParams();
  const base = "";
  let qs = nextParams(base);
  qs.set("a", "1");
  notePendingParams(base, qs.toString());

  qs = nextParams(base);
  qs.set("b", "2");
  notePendingParams(base, qs.toString());

  qs = nextParams(base);
  qs.set("c", "3");
  assert.deepEqual([qs.get("a"), qs.get("b"), qs.get("c")], ["1", "2", "3"]);
});

test("once the navigation commits, the overlay stops applying", () => {
  // Self-clearing: the reported value IS our result now, so it no longer
  // matches the base we derived from. No effect, nothing to tear down.
  __resetPendingParams();
  notePendingParams("statuses=Active", "statuses=Active&customers=Acme");
  assert.equal(nextParams("statuses=Active&customers=Acme").toString(), "statuses=Active&customers=Acme");
});

test("Back does NOT resurrect a stale overlay", () => {
  // The dangerous case. After navigating away, the reported value is some third
  // thing; building on the old pending write would drag the user forwards again
  // instead of back.
  __resetPendingParams();
  notePendingParams("statuses=Active", "statuses=Active&customers=Acme");
  assert.equal(nextParams("cols=10-211").toString(), "cols=10-211");
});

test("a hand-edited URL is respected, not overwritten by a stale overlay", () => {
  __resetPendingParams();
  notePendingParams("a=1", "a=1&b=2");
  assert.equal(nextParams("a=1&b=2&typed=byhand").get("typed"), "byhand");
});

test("the returned object is a copy — mutating it cannot corrupt the overlay", () => {
  __resetPendingParams();
  const base = "a=1";
  notePendingParams(base, "a=1&b=2");
  const first = nextParams(base);
  first.set("scratch", "x");
  // A second read of the same in-flight state must not see the scratch value.
  assert.equal(nextParams(base).get("scratch"), null);
});

test("an empty query string is a valid base", () => {
  __resetPendingParams();
  notePendingParams("", "hide=customer");
  assert.equal(nextParams("").get("hide"), "customer");
});
