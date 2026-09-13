import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isStaleBundleError, STALE_BUNDLE_TITLE, STALE_BUNDLE_BODY } from "../src/lib/stale-bundle";

// ── "Failed to load chunk" is a stale tab, not a rejected submission (§70) ───
//
// The reported panel was titled "Submission rejected" and advised "fix the value above
// and submit again" for a missing JS chunk: nothing had been submitted, there was no
// value above, and the button called reset() — which asks for the same 404 again.
//
// These pin the detector (it has to survive the bundler rewording its message) and the
// two claims the boundaries must no longer make.

const SRC = join(import.meta.dirname, "..", "src");

// Comment-stripped, and that is not incidental: these boundaries now carry a note
// QUOTING the old wording to explain why it was wrong, so a raw-text search for
// "Submission rejected" matches the explanation and fails. The first run of this file did
// exactly that — the same trap tests/quoted-view.test.ts hit (DEVLOG §35.2) and the same
// fix tests/drill-design.test.ts already uses.
const code = (p: string) =>
  readFileSync(join(SRC, "app", "(app)", ...p.split("/")), "utf8")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/[^\n]*$/gm, "")
    .replace(/\/\/[^\n"'`]*$/gm, "");
const ETC_BOUNDARY = code("etc/error.tsx");
const APP_BOUNDARY = code("error.tsx");

test("the exact reported message is recognised", () => {
  // Verbatim from the screenshot, including the "from module" tail Turbopack adds.
  assert.equal(
    isStaleBundleError(new Error("Failed to load chunk /_next/static/chunks/3q20900fw39rz.js from module 964893")),
    true,
  );
});

test("every bundler and browser wording is recognised", () => {
  // There is no stable error code for this, so the list of phrasings IS the detector.
  const messages = [
    "Failed to load chunk /_next/static/chunks/abc.js from module 1",
    "Loading chunk 437 failed.",
    "Loading CSS chunk 12 failed.",
    "Failed to fetch dynamically imported module: http://x/y.js",
    "error loading dynamically imported module",
    "Importing a module script failed.",
    "Unable to preload CSS for /_next/static/css/a.css",
  ];
  for (const m of messages) {
    assert.equal(isStaleBundleError(new Error(m)), true, `not detected: ${m}`);
  }
});

// ── A stale Server Action reference is the same class of problem (2026-08-19) ─
//
// Reported live: T&M's KPI "Detail" drill-throughs — whose server actions had
// just been edited repeatedly in the same dev session — crashed the whole
// page with the GENERIC error card instead of the stale-bundle one. A tab
// open across the recompile holds an action reference ID the server no
// longer registers; calling it throws this wording, not a chunk-load
// failure, but reset() is equally useless (it re-sends the identical stale
// reference), so it needs the same "reload" treatment, not the same
// detection string.
test("a stale Server Action reference is recognised — Next's exact wording", () => {
  assert.equal(
    isStaleBundleError(new Error('Failed to find Server Action "60f0648c50f0a1234567890abcdef1234567890". This request might be from an older or newer deployment.')),
    true,
  );
});

test("webpack's ChunkLoadError is caught by NAME, whatever its message says", () => {
  const e = new Error("something entirely reworded by a future release");
  e.name = "ChunkLoadError";
  assert.equal(isStaleBundleError(e), true);
});

test("matching is case-insensitive", () => {
  assert.equal(isStaleBundleError(new Error("FAILED TO LOAD CHUNK /x.js")), true);
});

test("a genuine application error is NOT mistaken for a stale tab", () => {
  // The cost of a false positive is real: it would tell someone to reload when the actual
  // problem is their data, and reloading would reproduce it forever.
  for (const m of [
    "Cannot read properties of null (reading 'jobId')",
    "TotalETO parts (job 1142) did not respond within 12000ms",
    "2026-07 is already submitted and locked.",
    "P2002: Unique constraint failed",
    "chunk", // a bare word must not trip it — the signs are phrases
  ]) {
    assert.equal(isStaleBundleError(new Error(m)), false, `false positive: ${m}`);
  }
});

test("a non-Error value cannot make the detector itself throw", () => {
  // An error boundary's `error` is only typed as Error by convention; a thrown string or
  // a rejected object reaches it just as easily, and a detector that assumed `.message`
  // would throw INSIDE the boundary — replacing the error card with a blank screen.
  assert.equal(isStaleBundleError("Failed to load chunk /x.js"), true, "a thrown string still counts");
  assert.equal(isStaleBundleError(undefined), false);
  assert.equal(isStaleBundleError(null), false);
  assert.equal(isStaleBundleError({}), false);
  assert.equal(isStaleBundleError(42), false);
  assert.equal(isStaleBundleError({ message: null }), false);
});

// ── What the boundaries may no longer say (§70) ──────────────────────────────

test("the Monthly ETC boundary no longer calls every error a rejected submission", () => {
  // A real submission failure never reaches this boundary — submitMonthlyReport returns a
  // typed failure kind and SubmitReportAction renders it inline — so this title was wrong
  // for every error it ever showed.
  assert.doesNotMatch(ETC_BOUNDARY, /Submission rejected/, "the headline must not claim a submission was rejected");
  assert.doesNotMatch(
    ETC_BOUNDARY,
    /fix the value above/,
    "there is often no value above: the page can fail before the grid renders",
  );
});

test("both boundaries reload rather than reset for a stale bundle", () => {
  // reset() re-renders the same segment, which requests the same missing chunk: the card
  // reappears and the user is stuck in a loop with no way out but knowing to reload.
  for (const [name, body] of [["etc/error.tsx", ETC_BOUNDARY], ["error.tsx", APP_BOUNDARY]] as const) {
    assert.match(body, /isStaleBundleError/, `${name} must branch on the stale-bundle case`);
    assert.match(body, /window\.location\.reload\(\)/, `${name} must offer a real document reload`);
    assert.match(body, /Reload the page/, `${name} must label that action for a human`);
  }
});

test("the stale-bundle wording is stated once and shared", () => {
  // Two boundaries describing the same condition in two ways is how one of them ends up
  // still giving the old advice after the other is fixed.
  assert.match(STALE_BUNDLE_TITLE, /older version/i);
  assert.match(STALE_BUNDLE_BODY, /[Nn]othing was saved/, "it must say the data is untouched");
  assert.match(STALE_BUNDLE_BODY, /[Rr]eload/, "…and name the action that fixes it");
  for (const body of [ETC_BOUNDARY, APP_BOUNDARY]) {
    assert.match(body, /STALE_BUNDLE_TITLE/);
    assert.match(body, /STALE_BUNDLE_BODY/);
  }
});
