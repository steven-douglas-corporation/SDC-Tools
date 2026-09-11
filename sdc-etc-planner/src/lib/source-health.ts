import { SYNC_SOURCES, SYNC_INTERVAL_MS, TOTALETO_SOURCES } from "@/lib/sync-schedule";

// ── Data-source health, computed in one place (2026-09-02) ──────────────────
//
// The Dashboard's Refresh Schedule used to render straight from two raw inputs —
// the PowerBiFreshness rows and the last RefreshRun — and every judgement about
// what those meant was made inline in JSX: a feed "failed" if its status string
// started with "Failed:", and that was the whole model. Two things were therefore
// invisible on a panel whose only job is to say whether the figures can be
// trusted:
//
//   1. STALENESS WITHOUT FAILURE. A pass that never ran (process down, box
//      rebooted, hourly timer dead) leaves every freshness row exactly as it was:
//      status null, dot green, "Aug 6, 2:04 PM" in small grey text. The card said
//      healthy for as long as you cared to look. The interval is a promise — a
//      source that has not been checked in over two intervals has broken it, and
//      that is now its own state, computed here from `checkedAt` rather than from
//      anything upstream has to remember to tell us.
//   2. WHICH source, and for how long. RefreshRun.steps has held per-source
//      status, detail and milliseconds since §25/§30, and nothing read it. It is
//      read here, across the last several passes, so a source can show its own
//      duration, its own last success, and whether this is its first bad pass or
//      its fifth.
//
// Pure and side-effect-free on purpose: the caller does the reads (the Dashboard
// already batches them), this decides what they mean, and tests/source-health.test.ts
// exercises the rules directly. If the banner, the summary and a source row ever
// disagreed, one of them would be lying — so all three are derived from this one
// function.

export type SourceState =
  /** Last attempt threw. Figures from it are aging behind an error. */
  | "failed"
  /** Nothing failed, but the schedule has not run for this source in far too long. */
  | "stale"
  /** Healthy; upstream simply has not published the data yet (a stated WAIT). */
  | "waiting"
  /** Being refreshed by the pass in flight right now. */
  | "refreshing"
  /** Refreshed on schedule, no error. */
  | "healthy"
  /** On the schedule but has never recorded a pass. */
  | "never";

/**
 * Which system a source reads from. Grouped, because these share failure modes:
 * when Total ETO is down, four sources go red together and that is ONE incident,
 * not four — and the panel should let you see that in one glance.
 */
export type SourceFamily = "Total ETO" | "Paylocity" | "Monthly file" | "App-owned";

const FAMILY_OVERRIDES: Record<string, SourceFamily> = {
  hours_actual: "Paylocity",
  job_cost_inventory: "Monthly file",
};

export function familyFor(source: string): SourceFamily {
  if (FAMILY_OVERRIDES[source]) return FAMILY_OVERRIDES[source];
  if (TOTALETO_SOURCES.has(source)) return "Total ETO";
  // Everything left is computed by this app from data already in its own database
  // (undefined hours, the ETC seeding and hours steps, the Standard Fees pools).
  return "App-owned";
}

// A source is stale once it has missed TWO scheduled passes, plus a few minutes
// of grace. Not one: a single missed pass is routine (a deploy, a slow upstream
// call that overran the window), and a panel that cries stale every time a
// restart lands teaches people to ignore amber — the same reason a failure and a
// stated WAIT are not the same colour here. Two intervals is the point at which
// "the schedule is running" stops being a reasonable assumption.
export const STALE_AFTER_MS = SYNC_INTERVAL_MS * 2 + 5 * 60 * 1000;

export type FreshnessInput = { source: string; checkedAt: Date; refreshedThrough: Date | null; status: string | null };

export type RunInput = {
  startedAt: Date;
  completedAt: Date | null;
  userName: string | null;
  trigger: string;
  durationMs: number | null;
  status: string;
  sourcesOk: number;
  sourcesFailed: number;
  steps: { source: string; label: string; status: string; detail: string; ms?: number; kind?: string; retryable?: boolean }[];
};

export type RunningInput = { running: boolean; since: Date | null; stage: string | null; done: number; total: number };

export type HistoryPoint = { at: Date; outcome: "ok" | "failed" | "skipped" };

export type SourceHealth = {
  source: string;
  label: string;
  family: SourceFamily;
  monthScoped: boolean;
  state: SourceState;
  /** When the schedule last touched this source, successfully or not. */
  checkedAt: Date | null;
  /** How far through time the data itself reaches ("data thru 2026-08-31"). */
  refreshedThrough: Date | null;
  /** "Failed: …" text as the pass recorded it, or null. */
  failure: string | null;
  /** A stated WAIT — the source is fine, upstream has not published yet. */
  waiting: string | null;
  /** What the last pass's step said it did ("482 rows upserted"). */
  detail: string | null;
  /** Wall-clock ms this source's own step took on the last pass that ran it. */
  lastDurationMs: number | null;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  /** Newest first, one entry per recent pass that included this source. */
  history: HistoryPoint[];
  /** How many consecutive recent passes have failed for this source. */
  failStreak: number;
  // ── Whether waiting fixes it (2026-09-09) ─────────────────────────────────
  //
  // Set for a failed Total ETO source; see SyncStepResult.kind. A panel that
  // says "failed" and nothing else invites the one response that cannot work —
  // press it again — which is what happened for five days when the cause was a
  // parameter-binding bug in this app rather than anything upstream.
  /** The classification of the last failure, e.g. "query_timeout". */
  failureKind: string | null;
  /** False when another attempt provably cannot help (a credential, a bug, a schema change). */
  failureRetryable: boolean | null;
  /** When the hourly schedule should next touch it. */
  nextRefreshAt: Date | null;
  /** ms overdue, for a source past its window; null when it is inside it. */
  overdueBy: number | null;
};

export type HealthSummary = {
  total: number;
  healthy: number;
  waiting: number;
  stale: number;
  failed: number;
  refreshing: number;
  never: number;
  /** The worst state present — what the panel's tone and headline are built from. */
  tone: "ok" | "warn" | "bad" | "busy";
  headline: string;
  /** Families with at least one failed or stale source, e.g. ["Total ETO"]. */
  troubledFamilies: SourceFamily[];
};

export type SourceHealthReport = {
  summary: HealthSummary;
  sources: SourceHealth[];
  lastRun: {
    completedAt: Date | null;
    startedAt: Date;
    userName: string | null;
    trigger: string;
    durationMs: number | null;
    sourcesOk: number;
    sourcesFailed: number;
  } | null;
  running: { since: Date | null; stage: string | null; done: number; total: number } | null;
  intervalMs: number;
};

export function buildSourceHealth(input: {
  freshness: FreshnessInput[];
  runs: RunInput[];
  running?: RunningInput | null;
  now?: Date;
}): SourceHealthReport {
  const now = input.now ?? new Date();
  const runs = input.runs; // newest first, as recentRefreshRuns returns them
  const byFreshness = new Map(input.freshness.map((r) => [r.source, r]));
  const live = input.running?.running ? input.running : null;
  // The step now in flight is reported by NAME (recordProgress writes the
  // SYNC_SOURCES label), so the source actually being worked on reads as
  // refreshing rather than as whatever it was an hour ago.
  const liveLabel = live?.stage ?? null;

  const sources: SourceHealth[] = SYNC_SOURCES.map((feed) => {
    const row = byFreshness.get(feed.source);
    const status = row?.status ?? null;
    const failure = status?.startsWith("Failed:") ? status : null;
    const waiting = status && !failure ? status : null;
    const checkedAt = row?.checkedAt ?? null;

    const history: HistoryPoint[] = [];
    let lastSuccessAt: Date | null = null;
    let lastFailureAt: Date | null = null;
    let lastDurationMs: number | null = null;
    let detail: string | null = null;
    let failureKind: string | null = null;
    let failureRetryable: boolean | null = null;
    for (const run of runs) {
      const step = run.steps.find((s) => s.source === feed.source);
      if (!step) continue;
      const at = run.completedAt ?? run.startedAt;
      const outcome = step.status === "ok" ? "ok" : step.status === "failed" ? "failed" : "skipped";
      history.push({ at, outcome });
      if (lastDurationMs == null && typeof step.ms === "number") lastDurationMs = step.ms;
      if (detail == null && step.detail) detail = step.detail;
      if (outcome === "ok" && !lastSuccessAt) lastSuccessAt = at;
      if (outcome === "failed" && !lastFailureAt) {
        lastFailureAt = at;
        failureKind = step.kind ?? null;
        failureRetryable = step.retryable ?? null;
      }
    }
    let failStreak = 0;
    for (const h of history) {
      if (h.outcome !== "failed") break;
      failStreak += 1;
    }

    const age = checkedAt ? now.getTime() - checkedAt.getTime() : null;
    const overdueBy = age != null && age > STALE_AFTER_MS ? age - SYNC_INTERVAL_MS : null;
    const nextRefreshAt = checkedAt ? new Date(checkedAt.getTime() + SYNC_INTERVAL_MS) : null;

    // Order matters, and it is the order of consequence: a failure is the thing
    // to act on even if the row is also old; a source nobody has ever run is not
    // "stale", it is unproven.
    const state: SourceState = !row
      ? "never"
      : failure
        ? "failed"
        : liveLabel === feed.label
          ? "refreshing"
          : overdueBy != null
            ? "stale"
            : waiting
              ? "waiting"
              : "healthy";

    return {
      source: feed.source,
      label: feed.label,
      family: familyFor(feed.source),
      monthScoped: feed.monthScoped,
      state,
      checkedAt,
      refreshedThrough: row?.refreshedThrough ?? null,
      failure,
      waiting,
      detail,
      lastDurationMs,
      lastSuccessAt,
      lastFailureAt,
      history,
      failStreak,
      failureKind,
      failureRetryable,
      nextRefreshAt,
      overdueBy,
    };
  });

  const count = (s: SourceState) => sources.filter((x) => x.state === s).length;
  const failed = count("failed");
  const stale = count("stale");
  const never = count("never");
  const waiting = count("waiting");
  const refreshing = count("refreshing");
  const healthy = count("healthy");

  const troubled = new Set<SourceFamily>();
  for (const s of sources) if (s.state === "failed" || s.state === "stale") troubled.add(s.family);

  // A failure outranks a refresh in progress: a pass being underway is not a
  // reason to paint the panel calm while four sources are red.
  const tone: HealthSummary["tone"] =
    failed > 0 ? "bad" : stale > 0 || never > 0 ? "warn" : live || refreshing > 0 ? "busy" : waiting > 0 ? "warn" : "ok";

  const parts: string[] = [];
  if (failed > 0) parts.push(`${failed} source${failed === 1 ? "" : "s"} failed`);
  if (stale > 0) parts.push(`${stale} stale`);
  if (never > 0) parts.push(`${never} never run`);
  if (waiting > 0) parts.push(`${waiting} waiting on upstream`);
  const headline =
    parts.length > 0
      ? parts.join(" · ")
      : live
        ? `Refresh in progress — ${live.done}/${live.total} sources done`
        : `All ${sources.length} sources healthy`;

  const last = runs[0] ?? null;

  return {
    summary: {
      total: sources.length,
      healthy,
      waiting,
      stale,
      failed,
      refreshing,
      never,
      tone,
      headline,
      troubledFamilies: [...troubled],
    },
    sources,
    lastRun: last
      ? {
          completedAt: last.completedAt,
          startedAt: last.startedAt,
          userName: last.userName,
          trigger: last.trigger,
          durationMs: last.durationMs,
          sourcesOk: last.sourcesOk,
          sourcesFailed: last.sourcesFailed,
        }
      : null,
    running: live ? { since: live.since, stage: live.stage, done: live.done, total: live.total } : null,
    intervalMs: SYNC_INTERVAL_MS,
  };
}

/** Failed first, then stale/never, then waiting, then healthy — problems first. */
export const STATE_ORDER: Record<SourceState, number> = { failed: 0, stale: 1, never: 2, waiting: 3, refreshing: 4, healthy: 5 };

export function sortByUrgency(sources: SourceHealth[]): SourceHealth[] {
  return [...sources].sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.label.localeCompare(b.label));
}
