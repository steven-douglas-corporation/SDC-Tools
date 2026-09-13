import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSelectionCookie, selectionCookieAssignment, JOB_HOURS_SELECTION_COOKIE } from "../src/lib/job-hours-selection";

// ── The wrong-job flash (2026-09-02) ────────────────────────────────────────
//
// Job Hour Details rendered job 1130's hours, charts, parts and procurement for
// a beat before showing the job the user asked for. The cause was not a race or
// a cache: the remembered selection lived in localStorage, so the SERVER could
// not see it, rendered its data-richest default, and JobSelect replaced the URL
// after hydration. Two renders, two sets of live Total ETO calls, one visible
// frame of another job's figures.
//
// The fix is that the memory is a cookie, read during the page's first render.
// These tests hold the two halves of that: the parsing the server trusts, and
// the structural rule that the client no longer resolves the selection itself.

test("a stored value round-trips through the cookie", () => {
  const assignment = selectionCookieAssignment(["1105", "1130"]);
  assert.match(assignment, new RegExp(`^${JOB_HOURS_SELECTION_COOKIE}=1105%2C1130;`));
  assert.deepEqual(parseSelectionCookie("1105,1130"), ["1105", "1130"]);
});

test("an empty selection FORGETS rather than storing nothing", () => {
  // Clearing the picker means "deliberately nothing". A cookie that survived it
  // would re-select the job the user just removed on their next landing — the
  // exact bug that got multi-select reverted the first time.
  const assignment = selectionCookieAssignment([]);
  assert.match(assignment, /max-age=0/);
  assert.deepEqual(parseSelectionCookie(""), []);
  assert.deepEqual(parseSelectionCookie(undefined), []);
});

test("the cookie is scoped and same-site, and persists past the session", () => {
  const assignment = selectionCookieAssignment(["1105"]);
  assert.match(assignment, /path=\//);
  assert.match(assignment, /samesite=lax/i);
  assert.match(assignment, /max-age=31536000/);
});

test("junk in the cookie is dropped, not rendered", () => {
  // It arrives from the browser and decides which job's figures are shown.
  assert.deepEqual(parseSelectionCookie("1105, ,1130,"), ["1105", "1130"]);
  assert.deepEqual(parseSelectionCookie("<script>"), []);
  assert.deepEqual(parseSelectionCookie("1105,../../etc"), ["1105"]);
  assert.deepEqual(parseSelectionCookie("x".repeat(64)), []);
  assert.equal(parseSelectionCookie(Array.from({ length: 500 }, (_, i) => `J${i}`).join(",")).length, 100);
});

// ── The structural rules, asserted against the source ───────────────────────
// `tsc` cannot tell that a selection resolved after hydration is a bug; these
// can. Both are exactly what regressed.

test("the page resolves the remembered selection SERVER-side, before the default", () => {
  const page = readFileSync(join(process.cwd(), "src", "app", "(app)", "job-hours", "page.tsx"), "utf8");
  assert.match(page, /parseSelectionCookie/, "the page reads the remembered selection itself");
  // The USE site, not the import line at the top of the file.
  const rememberedAt = page.indexOf("parseSelectionCookie((await cookies())");
  const defaultAt = page.indexOf("defaultDashboardJobId()");
  assert.ok(rememberedAt !== -1 && defaultAt !== -1);
  assert.ok(rememberedAt < defaultAt, "the memory must beat the data-richest default, not follow it");
  // An explicit deep link still wins over both — it is resolved from the params
  // above either of them.
  assert.ok(page.indexOf("jobsParam") < rememberedAt, "an explicit ?jobs= outranks the remembered selection");
});

test("JobSelect no longer navigates to resolve the selection on a normal landing", () => {
  const src = readFileSync(join(process.cwd(), "src", "components", "JobSelect.tsx"), "utf8");
  // One replace survives, and only inside the one-time localStorage migration —
  // guarded by the cookie already being absent, so it cannot run twice.
  const replaces = src.match(/router\.replace\(/g) ?? [];
  assert.equal(replaces.length, 1, "only the one-time migration may replace the URL");
  assert.match(src, /if \(document\.cookie\.includes\(`\$\{JOB_HOURS_SELECTION_COOKIE\}=`\)\) return;/);
  assert.doesNotMatch(src, /localStorage\.setItem/, "the selection is no longer written to localStorage");
});
