import "server-only";

import { randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";
import { APP_VERSION } from "@/lib/app-version";
import { logAudit } from "@/lib/audit";
import { recordChanges } from "@/lib/change-log";
// How many stages a full pass has, so progress can be reported as "3 of 7" without the
// button hard-coding a number that would silently go wrong when a source is added.
// (SYNC_SOURCES is already imported below.)
import { runAllSyncs, SYNC_SOURCES, type SyncTrigger, type SyncRunResult } from "@/lib/auto-sync";

const SYNC_SOURCE_COUNT = SYNC_SOURCES.length;

// ── ONE application-wide refresh (§25) ───────────────────────────────────────
//
// Every refresh in this app now goes through here: the `Refresh Data` button and the
// hourly schedule call the same function, with the same sources, in the same order.
// That was already half-true — lib/auto-sync.ts has been the single definition of WHAT
// gets refreshed since 2026-07-29 — and this adds the four things a shared entry point
// needs to be trustworthy:
//
//   1. A LOCK, so only one pass can run at a time across every app server (§25.10).
//      Two managers clicking together, or a click landing during the hourly tick, must
//      not both start pulling the same sources into the same rows.
//   2. A RECORD per pass — who, when, how long, which sources, what failed (§25.11).
//      PowerBiFreshness tracks each SOURCE's currency; this tracks the PASS.
//   3. A BROADCAST, so every connected browser updates without anyone reloading (§25.9).
//   4. An honest STATUS. A pass where any required source failed is not a success, and
//      the caller is told which source and whether anything was updated (§25.7).
//
// What a refresh does NOT touch is unchanged and deliberate (auto-sync.ts states the
// rules): historical months, app-owned figures (quoted hours, manager-entered New ETC,
// notes), and any locked month. §25.6 asks that manual entries survive a refresh — they
// do, because no step writes them.

// A pass that dies mid-flight (process killed, deploy) must not hold the lock forever.
//
// This is now a HEARTBEAT timeout, not a pass-duration timeout: the holder re-stamps
// `startedAt` every LOCK_HEARTBEAT_MS while it lives (see startLockHeartbeat), so this
// only has to exceed the heartbeat interval by enough to absorb a missed beat, a slow
// DB write, or the event loop being blocked by an Excel parse. It no longer has to be
// "longer than any possible pass", which is what forced it to 15 minutes and left the
// UI on "Refreshing…" for 15 minutes after every killed pass.
//
// 60s = 12 missed beats. Well clear of any observed stall, and 15x faster to recover.
const LOCK_TIMEOUT_MS = 60 * 1000;

export type RefreshOutcome =
  | {
      ok: true;
      refreshId: string;
      startedAt: string;
      completedAt: string;
      durationMs: number;
      // "ok" when every source that ran succeeded, "partial" when some failed. There is
      // no "ok" with failures — see the note on `status` below.
      status: "ok" | "partial";
      // `kind` / `retryable` are set for a failed Total ETO source only (see
      // SyncStepResult) — they are what lets the toast say whether waiting for the
      // hourly schedule can possibly help.
      sources: { source: string; label: string; status: string; detail: string; kind?: string; retryable?: boolean }[];
      failedLabels: string[];
      month: string | null;
      // Set when this refresh also STARTED a new ETC month — see the note in the body.
      seededMonth: string | null;
      // Set when starting the month was ATTEMPTED and failed for a reason other than
      // "not seedable" (2026-09-14) — a DB error, a permission check, a bug. Optional,
      // and absent on every pass where there was nothing to seed or seeding worked.
      seedingError?: string;
      // The latest work date now covered, "YYYY-MM-DD" (§43). The completion message
      // states it because the app reads Lisa's file directly while the Power BI report
      // reads a semantic model that refreshes separately — so the two are routinely at
      // different vintages, and the app is usually the fresher. Saying which day the
      // hours run through is what turns "these two reports disagree" into a fact rather
      // than a bug report.
      hoursThrough: string | null;
    }
  | { ok: false; reason: "locked"; runningSince: string | null; holder: string | null }
  | { ok: false; reason: "error"; message: string; refreshId: string };

// ── "Not seedable" is the only seeding error a refresh may swallow ──────────
//
// startMonth's guard (etc-actions.ts assertMonthSeedable) throws exactly two
// sentences for the expected, silent case — the previous month is still open, or
// the requested month is out of order. Everything else it can throw is a real
// failure (MySQL down, a permission refusal, a bug in seeding) and used to vanish
// into the same `catch {}`, so a month that failed to start looked identical to a
// month that had no reason to. Matched on the message because the guard throws
// plain Errors; the two fragments are the stable part of each sentence.
export function isNotSeedableError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /is still in progress|must be started in order/i.test(message);
}

// ── The lock ────────────────────────────────────────────────────────────────
//
// A single conditional UPDATE. MySQL applies it atomically, so exactly one caller can
// see affectedRows === 1 — which is what makes this work across processes, unlike an
// in-memory flag (this app runs one instance today, but the realtime hub has already
// taught us what "in-process state" costs when that changes; see DEVLOG §15).
//
// GET_LOCK() was the other option and is worse here: it is bound to the CONNECTION, and
// Prisma pools connections, so the release could land on a different one.
async function acquireLock(refreshId: string): Promise<{ got: boolean; holder: string | null; since: Date | null }> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - LOCK_TIMEOUT_MS);
  // ── Both sides of the comparison come from the SAME clock ──────────────────
  //
  // `startedAt` is written as a JS Date parameter, not with MySQL's NOW(3). That is not a
  // style choice: the first version used NOW(3), and the lock never held — a second
  // claimant always got it. NOW(3) is the MySQL SESSION's timezone while a JS Date is
  // sent as UTC, so on this server (UTC-4) every freshly written `startedAt` compared as
  // four hours old and instantly satisfied the stale-lock escape hatch. Found by
  // scripts/refresh-smoke.ts, which is exactly the failure a unit test cannot see.
  const claimed = await prisma.$executeRaw`
    UPDATE RefreshLock
       SET holder = ${refreshId}, startedAt = ${now}
     WHERE id = 1
       AND (holder IS NULL OR startedAt IS NULL OR startedAt < ${cutoff})`;
  if (claimed === 1) return { got: true, holder: refreshId, since: null };
  const rows = await prisma.$queryRaw<{ holder: string | null; startedAt: Date | null }[]>`
    SELECT holder, startedAt FROM RefreshLock WHERE id = 1`;
  return { got: false, holder: rows[0]?.holder ?? null, since: rows[0]?.startedAt ?? null };
}

async function releaseLock(refreshId: string): Promise<void> {
  // Scoped to OUR refreshId: if the stale-timeout already handed the lock to somebody
  // else, this must not release theirs.
  await prisma.$executeRaw`UPDATE RefreshLock SET holder = NULL, startedAt = NULL WHERE id = 1 AND holder = ${refreshId}`;
}

// ── Why the lock is a heartbeat and not just a timestamp (2026-08-25) ────────
//
// `startedAt` used to be written once, at acquisition, and the only recovery from a
// pass that died holding the lock was LOCK_TIMEOUT_MS. That made a killed pass show
// as "Refreshing…" for the whole timeout with nothing actually running — measured
// twice on 2026-08-25:
//
//   09:09:03  process boots (PM2 autorestart after free-port killed it)
//   09:09:04  it starts a refresh on startup and takes the lock
//   09:09:16  `pm2 startOrRestart` restarts it again, killing the pass 12s in
//   09:09:16 → 09:24:04  lock held by a dead process; UI says "Refreshing…"
//
// That is not a rare event: a deploy restarts the process by definition, the pass is
// ~17s, and free-port + PM2-on-Windows commonly produces a DOUBLE restart — so the
// window is hit on most deploys. §"always exit Refreshing… on success or failure"
// cannot hold with a 15-minute-only recovery.
//
// A heartbeat fixes it without needing to know whether a holder is alive: the holder
// re-stamps `startedAt` every few seconds, so "startedAt is old" comes to mean "the
// holder stopped breathing" rather than "the pass started a while ago". That lets
// LOCK_TIMEOUT_MS drop from 15 minutes to a value just above the heartbeat, and it
// stays correct if this app is ever run as more than one instance — unlike clearing
// the lock on startup, which assumes a single instance (see acquireLock's note).
const LOCK_HEARTBEAT_MS = 5_000;

function startLockHeartbeat(refreshId: string): () => void {
  const timer = setInterval(() => {
    // Scoped to our refreshId exactly like releaseLock: if the lock was already
    // stolen from us, this must not stamp — and must not resurrect our claim.
    void prisma
      .$executeRaw`UPDATE RefreshLock SET startedAt = ${new Date()} WHERE id = 1 AND holder = ${refreshId}`
      .catch((err) => {
        // A missed beat is survivable — the next one is 5s away and the timeout is
        // far wider. Never allowed to fail the refresh it is only observing.
        console.error("[refresh] lock heartbeat failed:", err);
      });
  }, LOCK_HEARTBEAT_MS);
  // Must not be a reason for the process to stay alive on shutdown.
  timer.unref?.();
  return () => clearInterval(timer);
}

// Is a refresh running right now? Used by the button to explain itself rather than
// simply failing (§25.10: "show the current refresh status").
export type RefreshProgress = {
  running: boolean;
  since: Date | null;
  // The stage now in flight — the source's own label, e.g. "Parts cost (TotalETO)".
  stage: string | null;
  // Sources finished so far, and how many there are in total, so the button can say
  // "(3 of 7)" rather than only naming a stage.
  done: number;
  total: number;
  // What each finished source did, newest last — enough for the button to name the
  // one that failed rather than reporting the pass as generically broken.
  steps: { source: string; label: string; status: string; detail: string }[];
};

export async function currentRefresh(): Promise<RefreshProgress> {
  const idle: RefreshProgress = { running: false, since: null, stage: null, done: 0, total: SYNC_SOURCE_COUNT, steps: [] };
  const rows = await prisma.$queryRaw<{ holder: string | null; startedAt: Date | null }[]>`
    SELECT holder, startedAt FROM RefreshLock WHERE id = 1`;
  const row = rows[0];
  if (!row?.holder || !row.startedAt) return idle;
  // A lock older than the timeout is abandoned — a process killed mid-pass, which is
  // exactly how the button came to sit on "Refresh running…" indefinitely.
  if (row.startedAt.getTime() < Date.now() - LOCK_TIMEOUT_MS) return idle;

  // The progress the running pass has written so far. Read separately from the lock,
  // and failure-tolerant: not knowing the stage must never make a running refresh look
  // finished.
  let stage: string | null = null;
  let steps: RefreshProgress["steps"] = [];
  try {
    const live = await prisma.$queryRaw<{ currentStage: string | null; steps: string | null }[]>`
      SELECT currentStage, steps FROM RefreshRun WHERE status = 'running' ORDER BY id DESC LIMIT 1`;
    stage = live[0]?.currentStage ?? null;
    steps = live[0]?.steps ? (JSON.parse(live[0].steps) as RefreshProgress["steps"]) : [];
  } catch (err) {
    console.error("[refresh] could not read progress:", err);
  }
  return { running: true, since: row.startedAt, stage, done: steps.length, total: SYNC_SOURCE_COUNT, steps };
}

// ── Runs that never finished (2026-08-25) ───────────────────────────────────
//
// A pass killed mid-flight leaves its RefreshRun row saying `status = 'running'` with
// a NULL completedAt, forever. Three of them were sitting in the table when this was
// written, from the double restart every deploy used to cause (see the deploy script's
// own note), and the oldest was three days old.
//
// They are not harmless. `currentRefresh` reads the newest 'running' row to name the
// stage a live pass is on, so a stale one is a stale stage waiting to be shown; the
// refresh history on the dashboard shows passes that never ended; and "did the last
// refresh work?" has no answer for the row that matters.
//
// Called only while THIS pass holds the lock, which is what makes it safe: the lock is
// exclusive, so no other pass can be legitimately running, so every other 'running'
// row is by definition abandoned. That is a stronger guarantee than any age cutoff —
// but the cutoff is applied anyway, and generously, so that a row belonging to a pass
// which somehow outlived its own lock is left alone rather than mislabelled.
async function closeAbandonedRuns(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - LOCK_TIMEOUT_MS);
    const closed = await prisma.$executeRaw`
      UPDATE RefreshRun
         SET status = 'failed',
             completedAt = ${new Date()},
             failureDetail = 'Abandoned — the process running this pass stopped before it finished. Closed by a later refresh.'
       WHERE status = 'running' AND startedAt < ${cutoff}`;
    if (closed > 0) console.warn(`[refresh] closed ${closed} abandoned run record(s) left by a killed pass`);
  } catch (err) {
    // Bookkeeping. A refresh must not fail because it could not tidy up after an
    // earlier one.
    console.error("[refresh] could not close abandoned run records:", err);
  }
}

// ── The record ──────────────────────────────────────────────────────────────

async function openRun(input: {
  refreshId: string;
  trigger: SyncTrigger;
  userId: number | null;
  userName: string | null;
  startedAt: Date;
}): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO RefreshRun (refreshId, \`trigger\`, userId, userName, startedAt, appVersion, status, steps)
    VALUES (${input.refreshId}, ${input.trigger}, ${input.userId}, ${input.userName}, ${input.startedAt},
            ${APP_VERSION}, 'running', '[]')`;
}

// ── Progress, written AS IT HAPPENS (§30) ───────────────────────────────────
//
// `steps` used to be written once, by closeRun, when the whole pass was over. So for
// the entire duration of a refresh the only thing anybody could know was "running" —
// which is exactly why the button sat on "Refreshing application data…" with no way
// to tell a slow pass from a stuck one.
//
// This writes the steps completed so far after EVERY step, plus the stage now
// starting. One small UPDATE per source (seven a run) against a single row by unique
// key — immaterial next to the external calls it is reporting on, and it is what lets
// refreshStatus() answer "Refreshing parts costs… (3 of 7)" to any tab that asks,
// including one opened halfway through somebody else's refresh.
async function recordProgress(refreshId: string, stage: string | null, steps: SyncRunResult["steps"]): Promise<void> {
  try {
    await prisma.$executeRaw`
      UPDATE RefreshRun
         SET steps = ${JSON.stringify(steps)}, currentStage = ${stage}
       WHERE refreshId = ${refreshId}`;
  } catch (err) {
    // Progress reporting must never be able to fail a refresh.
    console.error("[refresh] could not record progress:", err);
  }
}

async function closeRun(input: {
  refreshId: string;
  completedAt: Date;
  durationMs: number;
  status: "ok" | "partial" | "failed";
  steps: SyncRunResult["steps"];
  failureDetail: string | null;
}): Promise<void> {
  const ok = input.steps.filter((s) => s.status === "ok").length;
  const failed = input.steps.filter((s) => s.status === "failed").length;
  const skipped = input.steps.filter((s) => s.status === "skipped").length;
  await prisma.$executeRaw`
    UPDATE RefreshRun
       SET completedAt = ${input.completedAt}, durationMs = ${input.durationMs}, status = ${input.status},
           sourcesOk = ${ok}, sourcesFailed = ${failed}, sourcesSkipped = ${skipped},
           steps = ${JSON.stringify(input.steps)}, failureDetail = ${input.failureDetail}
     WHERE refreshId = ${input.refreshId}`;
}

export type RefreshRunRecord = {
  refreshId: string;
  trigger: string;
  userName: string | null;
  startedAt: Date;
  completedAt: Date | null;
  durationMs: number | null;
  status: string;
  sourcesOk: number;
  sourcesFailed: number;
  // The per-source outcomes this pass recorded, already parsed (2026-09-02).
  // Carried here so the Dashboard's source-health panel can say WHICH source was
  // slow or broken, and for how many passes in a row — the run row's own counts
  // only ever said how many. Never throws on a malformed value: a bad JSON blob
  // yields no per-source detail, not a failed dashboard.
  steps: { source: string; label: string; status: string; detail: string; ms?: number; kind?: string; retryable?: boolean }[];
};

// The last few passes, for the dashboard's own "when was this last refreshed" line.
export async function recentRefreshRuns(limit = 5): Promise<RefreshRunRecord[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT refreshId, \`trigger\`, userName, startedAt, completedAt, durationMs, status, sourcesOk, sourcesFailed, steps
    FROM RefreshRun ORDER BY id DESC LIMIT ${limit}`;
  return rows.map((r) => ({
    refreshId: String(r.refreshId),
    trigger: String(r.trigger),
    userName: r.userName == null ? null : String(r.userName),
    startedAt: r.startedAt as Date,
    completedAt: (r.completedAt as Date | null) ?? null,
    durationMs: r.durationMs == null ? null : Number(r.durationMs),
    status: String(r.status),
    sourcesOk: Number(r.sourcesOk ?? 0),
    sourcesFailed: Number(r.sourcesFailed ?? 0),
    steps: parseSteps(r.steps),
  }));
}

function parseSteps(raw: unknown): RefreshRunRecord["steps"] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as RefreshRunRecord["steps"]) : [];
  } catch {
    return [];
  }
}

// ── The one refresh ─────────────────────────────────────────────────────────

export async function refreshAllData(input: {
  trigger: SyncTrigger;
  userId?: number | null;
  // Present for a manual refresh, so the notification can say who (§25.9).
  userName?: string | null;
}): Promise<RefreshOutcome> {
  const refreshId = randomUUID();
  const lock = await acquireLock(refreshId);
  if (!lock.got) {
    // Not an error: a refresh IS happening, which is what the caller wanted. Reported
    // as such so the button can say "already running since 11:44" rather than failing.
    return { ok: false, reason: "locked", runningSince: lock.since?.toISOString() ?? null, holder: lock.holder };
  }

  // Started immediately after acquiring and stopped on BOTH exit paths below, so the
  // lock is only ever "breathing" for exactly as long as this pass is actually running.
  const stopHeartbeat = startLockHeartbeat(refreshId);

  // Holding the lock is proof no other pass is alive, so anything still calling itself
  // "running" is a corpse. Buried here rather than left to accumulate.
  await closeAbandonedRuns();

  const startedAt = new Date();
  try {
    await openRun({
      refreshId,
      trigger: input.trigger,
      userId: input.userId ?? null,
      userName: input.userName ?? null,
      startedAt,
    });
  } catch (err) {
    // The record failing must not stop the refresh — but it is worth knowing about.
    console.error("[refresh] could not open the run record:", err);
  }

  // ── Seeding the month a MANUAL refresh is entitled to start ───────────────
  //
  // The button this replaces did one thing runAllSyncs does not: it called seedMonth,
  // so "Refresh Data" was also how a new ETC month came into existence (the page still
  // says so: 'Refresh Data starts <month>'). Dropping that would have quietly removed
  // the only way to start a month.
  //
  // MANUAL ONLY, deliberately. Seeding writes ~450 rows and decides that a new month is
  // now open; a person clicking is making that decision, an hourly timer is not. And it
  // is still gated by assertMonthSeedable inside startMonth — months must be started in
  // order and only once the previous one is locked — so a click cannot invent a month
  // out of turn. A "not seedable" outcome is expected and silent, because on almost
  // every click there is nothing to start.
  let seededMonth: string | null = null;
  let seedingError: string | undefined;
  if (input.trigger === "manual") {
    try {
      const { startMonth } = await import("@/lib/etc-actions");
      const { nextMonth, isMonthLocked } = await import("@/lib/etc");
      const latest = await prisma.etcEntry.findFirst({ orderBy: { month: "desc" }, select: { month: true } });
      if (latest) {
        const entries = await prisma.etcEntry.findMany({ where: { month: latest.month }, select: { needsReview: true } });
        if (isMonthLocked(entries)) {
          const next = nextMonth(latest.month);
          await startMonth(next, new FormData());
          seededMonth = next;
        }
      }
    } catch (err) {
      // Not seedable (out of order, previous month still open): the normal case, and
      // not something to report as a refresh failure. ANYTHING ELSE is a real failure
      // to start a month and is surfaced — in the log, the audit row and the result —
      // rather than swallowed with it (see isNotSeedableError).
      if (!isNotSeedableError(err)) {
        seedingError = err instanceof Error ? err.message : String(err);
        console.error("[refresh] starting the next ETC month FAILED (the refresh itself continues):", err);
      }
    }
  }

  let result: SyncRunResult;
  try {
    // Progress is streamed into the run record as each source starts (§30), so a tab
    // watching this refresh — including one that did not start it — can say which
    // stage it is on instead of an indefinite "Refreshing application data…".
    result = await runAllSyncs(
      input.trigger,
      (stage, done) => recordProgress(refreshId, stage, done),
      // So the Paylocity import record can name the pass and the person (§42.20) —
      // "who refreshed, and which file version did they get" is one question.
      { refreshId, userName: input.userName ?? null },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const completedAt = new Date();
    await closeRun({
      refreshId,
      completedAt,
      durationMs: completedAt.getTime() - startedAt.getTime(),
      status: "failed",
      steps: [],
      failureDetail: message,
    }).catch(() => {});
    // Before releaseLock, so the heartbeat cannot re-stamp a lock we are giving up.
    stopHeartbeat();
    await releaseLock(refreshId);
    await logAudit({
      action: "refresh.all",
      entityType: "RefreshRun",
      entityId: refreshId,
      summary: `Application refresh FAILED to run (${input.trigger}) — ${message}`,
      metadata: { refreshId, trigger: input.trigger },
    }).catch(() => {});
    return { ok: false, reason: "error", message, refreshId };
  }

  const completedAt = new Date();
  const durationMs = completedAt.getTime() - startedAt.getTime();
  const failed = result.steps.filter((s) => s.status === "failed");
  // "partial", never "ok", when anything failed: §25.7 is explicit that a success
  // message must not appear if a required step failed, and the only way to keep that
  // promise is for the status itself to carry it.
  const status: "ok" | "partial" = failed.length === 0 ? "ok" : "partial";

  await closeRun({
    refreshId,
    completedAt,
    durationMs,
    status,
    steps: result.steps,
    failureDetail: failed.length === 0 ? null : failed.map((f) => `${f.label}: ${f.detail}`).join(" | "),
  }).catch((err) => console.error("[refresh] could not close the run record:", err));

  // Before releaseLock, so the heartbeat cannot re-stamp a lock we are giving up.
  stopHeartbeat();
  await releaseLock(refreshId);

  // ── Tell everyone (§25.9) ─────────────────────────────────────────────────
  //
  // No cellKey, so every connected tab takes the throttled route refresh
  // (LiveRefresh) — which is right: a refresh moves figures across every table,
  // not one cell.
  //
  // `system: true` since 2026-09-02: this event syncs the tabs but no longer
  // draws a notification card. It used to draw one — "Refresh for All data in
  // Application recalculated from (blank) to refreshed at 8:25 AM" — beside the
  // refresh toast that already said "All application data was refreshed
  // successfully at 8:25 AM", in plainer words, for the same single action.
  // Two cards for one thing the user did is the noise, and the fix is to stop
  // producing the second one rather than to make the stack better at holding
  // both. The audit row is unaffected: this pass is still fully recorded, it
  // just no longer interrupts anybody to say so.
  const at = completedAt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  await recordChanges(
    [
      {
        tab: "Application",
        rowRef: "All data",
        columnName: "Refresh",
        previousValue: null,
        newValue: status === "ok" ? `refreshed at ${at}` : `refreshed at ${at} with ${failed.length} failure(s)`,
        changeType: status === "ok" ? "recalculated" : "rejected",
        system: true,
        entityType: "RefreshRun",
        entityId: refreshId,
      },
    ],
    { action: input.trigger === "manual" ? "refresh.manual" : "refresh.scheduled" },
  ).catch(() => {});

  await logAudit({
    action: "refresh.all",
    entityType: "RefreshRun",
    entityId: refreshId,
    summary:
      `${input.trigger === "manual" ? `${input.userName ?? "A user"} refreshed` : "Scheduled refresh of"} all application data ` +
      `in ${Math.round(durationMs / 100) / 10}s — ${result.steps.filter((s) => s.status === "ok").length}/${SYNC_SOURCES.length} sources ok` +
      (failed.length > 0 ? `, ${failed.length} FAILED (${failed.map((f) => f.label).join(", ")})` : ""),
    metadata: { refreshId, trigger: input.trigger, month: result.month, seededMonth, seedingError, durationMs, steps: result.steps },
  }).catch(() => {});

  // Read back rather than threaded through the sync steps: `hours_actual` is the one
  // step that owns this figure, it already writes it, and a second copy passed up the
  // call chain is how two numbers that must agree eventually stop agreeing.
  let hoursThrough: string | null = null;
  try {
    const f = await prisma.powerBiFreshness.findUnique({
      where: { source: "hours_actual" },
      select: { refreshedThrough: true },
    });
    hoursThrough = f?.refreshedThrough?.toISOString().slice(0, 10) ?? null;
  } catch {
    // Cosmetic. A refresh that worked must not be reported as failed because the
    // vintage could not be read back.
  }

  return {
    ok: true,
    refreshId,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs,
    status,
    sources: result.steps.map((s) => ({ source: s.source, label: s.label, status: s.status, detail: s.detail, kind: s.kind, retryable: s.retryable })),
    failedLabels: failed.map((f) => f.label),
    month: result.month,
    seededMonth,
    ...(seedingError ? { seedingError } : {}),
    hoursThrough,
  };
}
