import { after } from "next/server";
import { secretsMatch } from "@/lib/scheduler-api-auth";
import { currentRefresh, recentRefreshRuns, refreshAllData } from "@/lib/refresh-service";
import { apiCallerName, busyAnswerForLoad } from "@/lib/warehouse-ingest-outcome";

// ── Start a refresh without a browser ───────────────────────────────────────
//
// The same pass the Refresh Data button runs (lib/refresh-service.ts), started by
// an HTTP call: it pulls Paylocity's files from SFTP into the warehouse first
// (lib/warehouse-ingest.ts), then refreshes every source from there. For a script,
// a scheduled job or another app that needs the figures current now.
//
//   POST /api/integration/refresh          starts it and answers 202 at once
//   POST /api/integration/refresh?wait=1   answers when it has finished, with the outcome
//   POST /api/integration/refresh?pull=0   the same, minus the SFTP pull (the load's own call).
//                                          If a refresh is already running that may have read
//                                          the warehouse too early, one more is queued behind it
//   Header X-Refresh-Caller: <name>        who is asking, for the refresh record and audit log
//   GET  /api/integration/refresh          is one running, and how did the last one go
//
// Bearer-guarded like every /api/integration/* route (proxy.ts exempts the prefix
// from the browser session), but with its OWN token, REFRESH_API_TOKEN: the
// Scheduler's token lets that app read jobs, and should not also let it start loads.
// Unset means the endpoint refuses everything (503), the same fail-closed rule as
// SCHEDULER_SHARED_TOKEN.
//
// It can only do what any signed-in user's click does, with one thing less: it never
// starts a new ETC month. That stays a person's decision.
export const dynamic = "force-dynamic";

function denied(req: Request): Response | null {
  const expected = process.env.REFRESH_API_TOKEN?.trim();
  if (!expected) return Response.json({ error: "refresh_api_not_configured" }, { status: 503 });
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token || !secretsMatch(token, expected)) return Response.json({ error: "unauthorized" }, { status: 401 });
  return null;
}

const noStore = { "Cache-Control": "no-store" };

// A refresh queued behind the one now running. In memory, and that is enough: the
// app is one process, and if it restarts before the follow-up runs, the refresh it
// does on startup reads the same files.
let followUpQueued = false;
const FOLLOW_UP_RETRY_MS = 3_000;
// Longer than any pass is allowed to take (the button's own ceiling is 5 minutes).
const FOLLOW_UP_GIVE_UP_MS = 10 * 60_000;

/** Runs a no-pull refresh as soon as the lock is free, trying until it gets it. */
async function refreshWhenFree(userName: string) {
  const deadline = Date.now() + FOLLOW_UP_GIVE_UP_MS;
  for (;;) {
    const outcome = await refreshAllData({ trigger: "api", userName, pullFiles: false });
    if (outcome.ok || outcome.reason !== "locked" || Date.now() >= deadline) return outcome;
    await new Promise((r) => setTimeout(r, FOLLOW_UP_RETRY_MS));
  }
}

export async function POST(req: Request) {
  const no = denied(req);
  if (no) return no;

  const params = new URL(req.url).searchParams;
  // pull=0: refresh from what the warehouse holds, without starting its Paylocity
  // load first. The load itself calls this after copying new files (see
  // tools/data-warehouse/ingest/paylocity_ingest.py), and must not restart itself.
  const pullFiles = params.get("pull") !== "0";
  // Recorded on the refresh run and in the audit log, so "who asked for this?" has
  // an answer: the warehouse load sends "paylocity_ingest", a script its own name.
  const userName = apiCallerName(req.headers.get("x-refresh-caller") ?? params.get("caller"));

  if (params.get("wait") === "1") {
    const outcome = await refreshAllData({ trigger: "api", userName, pullFiles });
    const status = outcome.ok ? 200 : outcome.reason === "locked" ? 409 : 500;
    return Response.json(outcome, { status, headers: noStore });
  }

  // Answered before anything starts, so the caller is not told "started" about a
  // pass that the lock or the dev switch is about to refuse.
  if (process.env.SDC_DEV_DISABLE_SYNC === "1") {
    return Response.json({ started: false, error: "refresh_disabled_in_this_environment" }, { status: 503, headers: noStore });
  }
  const now = await currentRefresh();
  // ── The load has new files, and a refresh is already running ──────────────
  //
  // "Busy" is only a safe answer when the running refresh is the one waiting on
  // this load. A startup or hourly pass that overlapped the load may have read the
  // warehouse before the files landed, and telling the load "not needed" then
  // would strand them until the next hourly pass. So one more refresh is queued
  // behind the running one (busyAnswerForLoad has the rule).
  if (now.running && !pullFiles && busyAnswerForLoad(now.stage) === "queue_follow_up") {
    // One follow-up is enough however many loads ask: it reads everything the
    // warehouse holds when it runs.
    if (!followUpQueued) {
      followUpQueued = true;
      after(async () => {
        try {
          const outcome = await refreshWhenFree(userName);
          if (!outcome.ok) console.error(`[refresh-api] the queued refresh did not run: ${outcome.reason}`);
        } catch (err) {
          console.error("[refresh-api] the queued refresh could not run:", err);
        } finally {
          followUpQueued = false;
        }
      });
    }
    return Response.json({ started: false, queued: true, stage: now.stage }, { status: 202, headers: noStore });
  }
  if (now.running) {
    return Response.json(
      { started: false, running: true, since: now.since?.toISOString() ?? null, stage: now.stage },
      { status: 409, headers: noStore },
    );
  }

  after(async () => {
    try {
      // The load's call keeps trying if another pass takes the lock in the moment
      // between the check above and here; its files must not wait an hour for that.
      const outcome = pullFiles ? await refreshAllData({ trigger: "api", userName, pullFiles }) : await refreshWhenFree(userName);
      if (!outcome.ok) console.error(`[refresh-api] the refresh did not run: ${outcome.reason}`);
    } catch (err) {
      console.error("[refresh-api] the refresh could not run:", err);
    }
  });
  return Response.json({ started: true, status: "GET /api/integration/refresh" }, { status: 202, headers: noStore });
}

export async function GET(req: Request) {
  const no = denied(req);
  if (no) return no;
  const [now, runs] = await Promise.all([currentRefresh(), recentRefreshRuns(1)]);
  const last = runs[0] ?? null;
  return Response.json(
    {
      running: now.running,
      since: now.since?.toISOString() ?? null,
      stage: now.stage,
      done: now.done,
      total: now.total,
      lastRun: last && {
        refreshId: last.refreshId,
        trigger: last.trigger,
        status: last.status,
        startedAt: last.startedAt.toISOString(),
        completedAt: last.completedAt?.toISOString() ?? null,
        durationMs: last.durationMs,
        sourcesOk: last.sourcesOk,
        sourcesFailed: last.sourcesFailed,
        failed: last.steps.filter((s) => s.status === "failed").map((s) => ({ source: s.source, label: s.label, detail: s.detail })),
      },
    },
    { headers: noStore },
  );
}
