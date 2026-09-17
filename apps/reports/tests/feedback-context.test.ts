import test from "node:test";
import assert from "node:assert/strict";
import {
  buildFeedbackContext,
  buildContextUrl,
  describeContext,
  type PaneLocation,
} from "../src/lib/feedback-context";
import { SPLIT_ROUTES, decodeSplit, splitRoute } from "../src/lib/split-view";
import { decodeWorkspace, tabById, type RawParams } from "../src/lib/workspace";

const labelFor = (p: string) => splitRoute(p)?.label ?? null;

// ── The three shapes a Flag click can happen in ─────────────────────────────
//
// These are the whole point of the module. Cases 2 and 3 decode a REAL /w and
// /split URL with the app's own decoders and feed the result through, which is
// exactly what FeedbackButton does via usePaneUrl() — so if the pane URL
// encoding ever changes shape, this fails here rather than silently recording
// "/w" for every tab user in production.

test("plain page: path and params are captured verbatim", () => {
  const ctx = buildFeedbackContext({ path: "/etc", params: { month: "2026-08", dept: "ENG" } }, labelFor);
  assert.equal(ctx.routePath, "/etc");
  assert.equal(ctx.viewLabel, "Monthly ETC");
  assert.equal(ctx.periodMonth, "2026-08");
  assert.equal(ctx.contextUrl, "/etc?dept=ENG&month=2026-08");
  assert.deepEqual(ctx.params, { month: "2026-08", dept: "ENG" });
});

test("workspace tab: captures the TAB's route, never /w, and de-namespaces its params", () => {
  // The document URL a user with two tabs open actually has.
  const raw: RawParams = { t: "t1~/etc,t2~/job-hours", a: "t1", "t1.month": "2026-08", "t2.jobs": "1131" };
  const ws = decodeWorkspace(raw);
  const tab = tabById(ws, ws.active);
  assert.ok(tab, "the active tab decodes");

  // This is what usePaneUrl() hands the button inside that pane.
  const location: PaneLocation = { path: tab.path, params: tab.params };
  const ctx = buildFeedbackContext(location, labelFor);

  assert.equal(ctx.routePath, "/etc", "must be the tab's route, not /w");
  assert.equal(ctx.periodMonth, "2026-08");
  assert.deepEqual(Object.keys(ctx.params), ["month"], "no t1.* keys survive");
  assert.ok(!ctx.contextUrl.includes("/w"), "the return link is the plain route");
  assert.ok(!ctx.contextUrl.includes("t1."), "and carries no other tab's state");
});

test("split pane: captures the pane's own route and params, never /split", () => {
  const state = decodeSplit({ l: "/etc", r: "/job-hours", "l.month": "2026-08", "r.jobs": "1131" });
  assert.ok(state, "the split URL decodes");
  assert.ok(state.r, "and carries a right-hand pane");

  const left = buildFeedbackContext({ path: state.l.path, params: state.l.params }, labelFor);
  const right = buildFeedbackContext({ path: state.r.path, params: state.r.params }, labelFor);

  assert.equal(left.routePath, "/etc");
  assert.equal(left.periodMonth, "2026-08");
  assert.equal(right.routePath, "/job-hours");
  assert.equal(right.jobId, "1131");
  // The left pane must not leak the right pane's job into its own record.
  assert.equal(left.jobId, null);
});

// ── Subject extraction ──────────────────────────────────────────────────────

test("a single job is promoted to jobId; a multi-select is not", () => {
  const one = buildFeedbackContext({ path: "/job-hours", params: { jobs: "1131" } }, labelFor);
  assert.equal(one.jobId, "1131");

  const many = buildFeedbackContext({ path: "/job-hours", params: { jobs: "1131,1105" } }, labelFor);
  assert.equal(many.jobId, null, "two jobs is a filter, not a subject");
  assert.equal(many.params.jobs, "1131,1105", "but the filter itself is still recorded");
});

test("the single-record `job` param wins over the multi-select `jobs`", () => {
  const ctx = buildFeedbackContext({ path: "/job-hours", params: { jobs: "1131,1105", job: "1131" } }, labelFor);
  assert.equal(ctx.jobId, "1131");
});

test("every month spelling the app uses resolves to periodMonth", () => {
  for (const key of ["month", "m", "as", "asOf"]) {
    const ctx = buildFeedbackContext({ path: "/etc", params: { [key]: "2026-08" } }, labelFor);
    assert.equal(ctx.periodMonth, "2026-08", `${key} should resolve`);
  }
});

test("a non-month date is not coerced into periodMonth", () => {
  // /job-cost-explorer's asOf can carry a full date; the queue filters on
  // periodMonth, so a half-parsed value there is worse than an absent one.
  for (const bad of ["2026-08-14", "2026", "August", "2026-13", ""]) {
    const ctx = buildFeedbackContext({ path: "/job-cost-explorer", params: { asOf: bad } }, labelFor);
    assert.equal(ctx.periodMonth, null, `${JSON.stringify(bad)} should not parse as a month`);
  }
});

test("empty filter values are dropped, so two identical views compare equal", () => {
  const a = buildFeedbackContext({ path: "/etc", params: { month: "2026-08", dept: "" } }, labelFor);
  const b = buildFeedbackContext({ path: "/etc", params: { month: "2026-08" } }, labelFor);
  assert.deepEqual(a.params, b.params);
  assert.equal(a.contextUrl, b.contextUrl);
});

// ── The return link ─────────────────────────────────────────────────────────

test("contextUrl is stable regardless of param insertion order", () => {
  assert.equal(
    buildContextUrl("/etc", { dept: "ENG", month: "2026-08" }),
    buildContextUrl("/etc", { month: "2026-08", dept: "ENG" }),
  );
});

test("contextUrl for a view with no filters is the bare path", () => {
  assert.equal(buildContextUrl("/build-readiness", {}), "/build-readiness");
});

test("every contextUrl a splittable route can produce points at a real route", () => {
  // Guards the promise the triage drawer makes with its "open the view they
  // were looking at" link: the path half must always be something the app can
  // actually route to.
  for (const r of SPLIT_ROUTES) {
    const ctx = buildFeedbackContext({ path: r.path, params: {} }, labelFor);
    assert.equal(ctx.routePath, r.path);
    assert.equal(ctx.viewLabel, r.label, `${r.path} should carry the tab bar's own label`);
    assert.equal(ctx.contextUrl, r.path);
  }
});

test("an unregistered route still captures, with a null label", () => {
  // /jobs/[id] and /admin/* are not splittable, but a user can still stand on
  // them and hit Flag. Losing the report would be worse than losing the label.
  const ctx = buildFeedbackContext({ path: "/jobs/1131", params: {} }, labelFor);
  assert.equal(ctx.routePath, "/jobs/1131");
  assert.equal(ctx.viewLabel, null);
});

test("describeContext renders filters in a stable, readable line", () => {
  assert.equal(describeContext({ month: "2026-08", dept: "ENG" }), "dept=ENG · month=2026-08");
  assert.equal(describeContext({}), "");
});
