import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ── The App Refresh button's contract (2026-09-02) ──────────────────────────
//
// It reloads the frontend and nothing else. The risks are all things it must NOT
// do — navigate somewhere, or clear storage that carries the session, the tab's
// realtime identity, or a user's saved preferences — and none of those would
// fail a type check or a render. They are asserted against the source.

const RAW = readFileSync(join(process.cwd(), "src", "components", "AppRefreshButton.tsx"), "utf8");
// Comments stripped for the "must NOT contain" assertions: this file's header
// deliberately QUOTES the things it refuses to do (`location.reload(true)`,
// clearing storage) to explain why, and a naive match on the whole file fails on
// its own prose. The positive assertions read RAW so tooltip text still counts.
const SRC = RAW.split(/\r?\n/)
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join("\n");

test("it reloads the CURRENT location and never navigates", () => {
  assert.match(SRC, /window\.location\.reload\(\)/);
  // Any assignment to location/href would replace the URL — which is exactly how
  // a refresh button ends up dumping people on the Dashboard.
  assert.doesNotMatch(SRC, /location\.href\s*=/);
  assert.doesNotMatch(SRC, /location\.assign|location\.replace|router\.push|router\.replace/);
});

test("it clears no storage — session, tab identity and preferences all survive", () => {
  // Cookies carry the next-auth session AND the remembered Job Hour Details job;
  // sessionStorage carries this tab's realtime presence id; localStorage carries
  // saved views, zoom and the sidebar state.
  assert.doesNotMatch(SRC, /localStorage\.(clear|removeItem)/);
  assert.doesNotMatch(SRC, /sessionStorage\.(clear|removeItem)/);
  assert.doesNotMatch(SRC, /document\.cookie\s*=/);
  assert.doesNotMatch(SRC, /caches\.delete|indexedDB\.deleteDatabase/);
});

test("it does not claim a cache-bypass it cannot perform", () => {
  // `location.reload(true)` is ignored by every current browser. Passing it would
  // read as a hard refresh to the next person and do nothing at all.
  assert.doesNotMatch(SRC, /reload\(\s*true\s*\)/);
  // And no cache-busting query param: that would change the URL the request asked
  // to preserve.
  assert.doesNotMatch(SRC, /[?&]_(r|cb|t)=/);
});

test("it is a separate control from Refresh Data, with its own glyph", () => {
  const sidebar = readFileSync(join(process.cwd(), "src", "components", "Sidebar.tsx"), "utf8");
  assert.match(sidebar, /<AppRefreshButton/, "mounted in the sidebar");
  assert.match(sidebar, /<RefreshDataButton/, "alongside, not replacing");
  // Refresh Data's icon is a circular arrow; in the collapsed rail the icon is the
  // only thing distinguishing them, so App Refresh draws a window instead.
  assert.match(SRC, /<rect /, "App Refresh draws a window outline, not a bare arrow");
  const refreshData = readFileSync(join(process.cwd(), "src", "components", "RefreshDataButton.tsx"), "utf8");
  assert.doesNotMatch(refreshData, /<rect /, "…and Refresh Data does not, so the two rail icons differ");
});

test("both buttons say which is which on hover", () => {
  assert.match(RAW, /App Refresh — reloads the Reports App/);
  assert.match(RAW, /does not change any data/);
  const refreshData = readFileSync(join(process.cwd(), "src", "components", "RefreshDataButton.tsx"), "utf8");
  assert.match(refreshData, /Refresh Data — pulls the latest business data from Paylocity, Total ETO/);
  assert.match(refreshData, /use App Refresh/, "and points at the other control");
});
