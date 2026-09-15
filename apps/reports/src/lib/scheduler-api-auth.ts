import { createHmac, timingSafeEqual } from "node:crypto";

// Shared-secret guard for the read-only integration endpoints the SDC_Scheduler
// app calls server-to-server (job list + job detail). This is deliberately
// separate from the NextAuth session used by the browser UI: the scheduler is a
// Node service, not a logged-in user, so it authenticates with a bearer token.
//
// Fail-closed: if SCHEDULER_SHARED_TOKEN is not configured, these endpoints
// refuse every request (503) rather than exposing job data unauthenticated.
// That keeps them dormant and harmless until the integration is deliberately
// switched on by setting the env var on BOTH apps.

// Constant-time comparison over same-length digests — the same shape as
// button-password.ts's matchesButtonPassword. A plain `===` short-circuits at
// the first differing character, so how long it takes leaks how much of the
// secret matched; hashing both sides first also means the comparison length
// never depends on what the caller sent (timingSafeEqual throws on a length
// mismatch, so the two inputs must be equalised before it runs).
export function secretsMatch(presented: string, expected: string): boolean {
  const a = createHmac("sha256", "cmp").update(presented).digest();
  const b = createHmac("sha256", "cmp").update(expected).digest();
  return timingSafeEqual(a, b);
}

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
  if (!token || !secretsMatch(token, expected)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}
