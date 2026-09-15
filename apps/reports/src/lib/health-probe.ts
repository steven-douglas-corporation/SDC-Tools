import "server-only";
import { prisma } from "@/lib/prisma";

// ── What /api/health and /health actually check (2026-09-14) ────────────────
//
// Both routes returned `{ status: "ok" }` unconditionally — a process that had
// lost its database answered exactly like a healthy one, so the SDC Tools
// launcher's tile stayed green through a MySQL outage and TROUBLESHOOTING.md had
// to warn that "/api/health returning 200 does not rule this out".
//
// One `SELECT 1` through the app's own Prisma pool is the cheapest true statement
// about the process: it proves the connection pool is alive, which is what every
// page needs. Bounded at PROBE_TIMEOUT_MS so the probe stays fast whatever the
// database is doing, and retried ONCE so a single dropped packet or pool
// checkout blip does not flap the launcher's tile — two consecutive misses is a
// real outage.
//
// The route files cannot hold this themselves: Next validates a route module's
// exports and rejects anything beyond GET/dynamic/etc., so a shared helper has to
// live here.

export const PROBE_TIMEOUT_MS = 2_000;
export const PROBE_ATTEMPTS = 2;

export type DbProbe = { ok: true; ms: number } | { ok: false; ms: number; error: string };

/**
 * Runs `attempt` under a per-try timeout, up to `attempts` times, and reports the
 * outcome rather than throwing. Pure with respect to the database — the query is
 * injected — so the retry/timeout rules are testable without one.
 */
export async function probeWithRetry(
  attempt: () => Promise<unknown>,
  opts: { timeoutMs?: number; attempts?: number } = {},
): Promise<DbProbe> {
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  const attempts = Math.max(1, opts.attempts ?? PROBE_ATTEMPTS);
  const started = Date.now();
  let lastError = "unknown";
  for (let i = 1; i <= attempts; i++) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        attempt(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`database did not answer within ${timeoutMs}ms`)), timeoutMs);
          timer.unref?.();
        }),
      ]);
      return { ok: true, ms: Date.now() - started };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return { ok: false, ms: Date.now() - started, error: lastError };
}

/** `SELECT 1` against the app database, with the timeout and single retry above. */
export function probeDatabase(): Promise<DbProbe> {
  return probeWithRetry(() => prisma.$queryRaw`SELECT 1`);
}

/**
 * The response both health routes return. 200 with db "ok" when the probe passed;
 * 503 with status "degraded" when it did not — a status a poller can act on,
 * carrying no data beyond that (these routes are public).
 */
export function healthResponse(probe: DbProbe): Response {
  const body = probe.ok
    ? { status: "ok", app: "sdc-projects-reports", db: "ok", dbMs: probe.ms }
    : { status: "degraded", app: "sdc-projects-reports", db: "unreachable", dbMs: probe.ms, detail: probe.error };
  return Response.json(body, { status: probe.ok ? 200 : 503, headers: { "cache-control": "no-store" } });
}
