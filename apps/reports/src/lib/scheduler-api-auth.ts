// Shared-secret guard for the read-only integration endpoints the SDC_Scheduler
// app calls server-to-server (job list + job detail). This is deliberately
// separate from the NextAuth session used by the browser UI: the scheduler is a
// Node service, not a logged-in user, so it authenticates with a bearer token.
//
// Fail-closed: if SCHEDULER_SHARED_TOKEN is not configured, these endpoints
// refuse every request (503) rather than exposing job data unauthenticated.
// That keeps them dormant and harmless until the integration is deliberately
// switched on by setting the env var on BOTH apps.

export function checkSchedulerToken(req: Request): Response | null {
  const expected = process.env.SCHEDULER_SHARED_TOKEN;
  if (!expected) {
    return Response.json(
      { error: "integration_not_configured" },
      { status: 503 },
    );
  }
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  // Constant-time-ish compare: length check first, then char compare. The
  // token is a shared secret, not user input, so this is belt-and-suspenders.
  if (token.length !== expected.length || token !== expected) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}
