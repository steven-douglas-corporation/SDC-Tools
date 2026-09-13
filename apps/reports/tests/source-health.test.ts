import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSourceHealth, familyFor, sortByUrgency, STALE_AFTER_MS, type RunInput } from "../src/lib/source-health";
import { SYNC_SOURCES, SYNC_INTERVAL_MS } from "../src/lib/sync-schedule";

// The rules the Dashboard's data-source health panel renders. They live in a pure
// function precisely so they can be asserted here rather than eyeballed on a page
// that only looks wrong on the day something is actually broken.

const NOW = new Date("2026-09-02T12:00:00Z");
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

function fresh(source: string, opts: { checkedAt?: Date; status?: string | null } = {}) {
  return { source, checkedAt: opts.checkedAt ?? minsAgo(5), refreshedThrough: null, status: opts.status ?? null };
}

function run(steps: RunInput["steps"], opts: { completedAt?: Date } = {}): RunInput {
  const at = opts.completedAt ?? minsAgo(5);
  return {
    startedAt: at,
    completedAt: at,
    userName: "Abhi Kamuju",
    trigger: "manual",
    durationMs: 6800,
    status: "ok",
    sourcesOk: steps.filter((s) => s.status === "ok").length,
    sourcesFailed: steps.filter((s) => s.status === "failed").length,
    steps,
  };
}

const ALL_FRESH = SYNC_SOURCES.map((s) => fresh(s.source));

test("every scheduled source appears exactly once, whether or not it has a freshness row", () => {
  const report = buildSourceHealth({ freshness: [], runs: [], now: NOW });
  assert.equal(report.sources.length, SYNC_SOURCES.length);
  assert.deepEqual(
    report.sources.map((s) => s.source),
    SYNC_SOURCES.map((s) => s.source),
  );
  // No row at all is "never run", NOT stale and NOT healthy: it is unproven.
  assert.ok(report.sources.every((s) => s.state === "never"));
});

test("a healthy pass reads healthy, with the schedule's own counts intact", () => {
  const report = buildSourceHealth({ freshness: ALL_FRESH, runs: [], now: NOW });
  assert.equal(report.summary.failed, 0);
  assert.equal(report.summary.stale, 0);
  assert.equal(report.summary.healthy, SYNC_SOURCES.length);
  assert.equal(report.summary.tone, "ok");
  assert.equal(report.summary.headline, `All ${SYNC_SOURCES.length} sources healthy`);
});

// ── The bug this whole rebuild exists for ───────────────────────────────────
// A pass that never runs leaves every freshness row untouched: status null, so
// the old card painted it green forever. Age alone has to be able to raise an
// alarm.
test("a source nobody has refreshed goes stale on age alone, with no failure recorded", () => {
  const old = fresh("parts_cost", { checkedAt: new Date(NOW.getTime() - STALE_AFTER_MS - 60_000) });
  const report = buildSourceHealth({ freshness: [old], runs: [], now: NOW });
  const parts = report.sources.find((s) => s.source === "parts_cost")!;
  assert.equal(parts.state, "stale");
  assert.equal(parts.failure, null, "nothing failed — it simply was not refreshed");
  assert.ok(parts.overdueBy! > 0);
  assert.equal(report.summary.tone, "warn");
});

test("one missed pass is not stale — the threshold is two intervals plus grace", () => {
  const recentEnough = fresh("parts_cost", { checkedAt: new Date(NOW.getTime() - SYNC_INTERVAL_MS - 60_000) });
  const report = buildSourceHealth({ freshness: [recentEnough], runs: [], now: NOW });
  assert.equal(report.sources.find((s) => s.source === "parts_cost")!.state, "healthy");
});

test("a failure outranks age, and names the family so one incident does not read as four", () => {
  const rows = [
    fresh("parts_cost", { status: "Failed: workbook unavailable", checkedAt: new Date(NOW.getTime() - STALE_AFTER_MS - 1) }),
    fresh("totaleto_jobs", { status: "Failed: login rejected" }),
    ...ALL_FRESH.filter((r) => r.source !== "parts_cost" && r.source !== "totaleto_jobs"),
  ];
  const report = buildSourceHealth({ freshness: rows, runs: [], now: NOW });
  assert.equal(report.summary.failed, 2);
  assert.equal(report.summary.stale, 0, "a failed source is reported as failed, not double-counted as stale");
  assert.equal(report.summary.tone, "bad");
  assert.equal(report.summary.headline, "2 sources failed");
  assert.deepEqual(report.summary.troubledFamilies, ["Total ETO"]);
});

test("a stated WAIT is not a failure", () => {
  const rows = [fresh("job_cost_inventory", { status: "Waiting: August workbook not published yet" })];
  const report = buildSourceHealth({ freshness: rows, runs: [], now: NOW });
  const s = report.sources.find((x) => x.source === "job_cost_inventory")!;
  assert.equal(s.state, "waiting");
  assert.equal(s.failure, null);
  assert.equal(s.waiting, "Waiting: August workbook not published yet");
});

test("per-source duration, result text and last success come from the run steps", () => {
  const runs = [
    run([{ source: "hours_actual", label: "Actual hours (Paylocity workbook)", status: "ok", detail: "482 rows", ms: 4210 }]),
  ];
  const report = buildSourceHealth({ freshness: ALL_FRESH, runs, now: NOW });
  const hours = report.sources.find((s) => s.source === "hours_actual")!;
  assert.equal(hours.lastDurationMs, 4210);
  assert.equal(hours.detail, "482 rows");
  assert.deepEqual(hours.lastSuccessAt, minsAgo(5));
  assert.deepEqual(
    hours.history.map((h) => h.outcome),
    ["ok"],
  );
});

test("a repeated failure is distinguishable from a first one", () => {
  const step = (status: string) => [{ source: "parts_cost", label: "Parts cost (TotalETO)", status, detail: "", ms: 900 }];
  const runs = [
    run(step("failed"), { completedAt: minsAgo(5) }),
    run(step("failed"), { completedAt: minsAgo(65) }),
    run(step("ok"), { completedAt: minsAgo(125) }),
  ];
  const report = buildSourceHealth({ freshness: ALL_FRESH, runs, now: NOW });
  const parts = report.sources.find((s) => s.source === "parts_cost")!;
  assert.equal(parts.failStreak, 2);
  assert.deepEqual(parts.lastSuccessAt, minsAgo(125));
  assert.deepEqual(parts.lastFailureAt, minsAgo(5));
});

test("the source being refreshed right now reads as refreshing", () => {
  const report = buildSourceHealth({
    freshness: ALL_FRESH,
    runs: [],
    running: { running: true, since: minsAgo(1), stage: "Parts cost (TotalETO)", done: 4, total: SYNC_SOURCES.length },
    now: NOW,
  });
  assert.equal(report.sources.find((s) => s.source === "parts_cost")!.state, "refreshing");
  assert.equal(report.summary.tone, "busy");
  assert.match(report.summary.headline, /Refresh in progress/);
});

test("a refresh in progress does not paint the panel calm while a source is failing", () => {
  const rows = [fresh("totaleto_jobs", { status: "Failed: login rejected" }), ...ALL_FRESH.filter((r) => r.source !== "totaleto_jobs")];
  const report = buildSourceHealth({
    freshness: rows,
    runs: [],
    running: { running: true, since: minsAgo(1), stage: "Parts cost (TotalETO)", done: 4, total: SYNC_SOURCES.length },
    now: NOW,
  });
  assert.equal(report.summary.tone, "bad");
  assert.equal(report.summary.headline, "1 source failed");
});

test("families name the system each source shares a failure mode with", () => {
  assert.equal(familyFor("hours_actual"), "Paylocity");
  assert.equal(familyFor("parts_cost"), "Total ETO");
  assert.equal(familyFor("cash_flow_snapshot"), "Total ETO");
  assert.equal(familyFor("job_cost_inventory"), "Monthly file");
  assert.equal(familyFor("standard_pools"), "App-owned");
  // Every scheduled source gets one — no source can render without a tag.
  for (const s of SYNC_SOURCES) assert.ok(familyFor(s.source));
});

test("sorting puts what needs acting on first", () => {
  const rows = [
    fresh("hours_actual"),
    fresh("parts_cost", { status: "Failed: workbook unavailable" }),
    fresh("totaleto_jobs", { checkedAt: new Date(NOW.getTime() - STALE_AFTER_MS - 1) }),
  ];
  const report = buildSourceHealth({ freshness: rows, runs: [], now: NOW });
  const ordered = sortByUrgency(report.sources.filter((s) => rows.some((r) => r.source === s.source)));
  assert.deepEqual(
    ordered.map((s) => s.state),
    ["failed", "stale", "healthy"],
  );
});
