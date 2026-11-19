import { after } from "next/server";
import { secretsMatch } from "@/lib/scheduler-api-auth";
import { currentRefresh, recentRefreshRuns, refreshAllData } from "@/lib/refresh-service";

// ── Start a refresh without a browser ───────────────────────────────────────
//
// The same pass the Refresh Data button runs (lib/refresh-service.ts), started by
// an HTTP call: it pulls Paylocity's files from SFTP into the warehouse first
// (lib/warehouse-ingest.ts), then refreshes every source from there. For a script,
// a scheduled job or another app that needs the figures current now.
//
//   POST /api/integration/refresh          starts it and answers 202 at once
//   POST /api/integration/refresh?wait=1   answers when it has finished, with the outcome
//   POST /api/integration/refresh?pull=0   the same, minus the SFTP pull (the load's own call)
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

export async function POST(req: Request) {
  const no = denied(req);
  if (no) return no;

  const params = new URL(req.url).searchParams;
  // pull=0: refresh from what the warehouse holds, without starting its Paylocity
  // load first. The load itself calls this after copying new files (see
  // tools/data-warehouse/ingest/paylocity_ingest.py), and must not restart itself.
  const pullFiles = params.get("pull") !== "0";
  const userName = pullFiles ? "API request" : "Warehouse load";

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
  if (now.running) {
    return Response.json(
      { started: false, running: true, since: now.since?.toISOString() ?? null, stage: now.stage },
      { status: 409, headers: noStore },
    );
  }

  after(async () => {
    try {
      const outcome = await refreshAllData({ trigger: "api", userName, pullFiles });
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
