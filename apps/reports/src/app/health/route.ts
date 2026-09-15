// `/health` alias for the canonical /api/health probe.
//
// Every other app in the suite answers `/health` (assemblies, readiness,
// statelogic) and Calendar answers both; Reports answered only `/api/health`.
// Whatever polls this suite uniformly was therefore hitting a route INSIDE
// proxy.ts's auth matcher, so each poll 307'd to /login instead of returning a
// status — 112 of them in a two-minute sample on 2026-08-24, which was the bulk
// of this app's error-log volume. Answering both paths makes Reports behave like
// its siblings regardless of which path a caller picked.
//
// Must stay listed in proxy.ts's matcher exclusions alongside `api/health`, or
// it goes straight back to redirecting to the login form.
//
// Same database probe as /api/health (lib/health-probe.ts) — the two paths must
// never disagree about whether the app is up.
import { probeDatabase, healthResponse } from "@/lib/health-probe";

export const dynamic = "force-dynamic";

export async function GET() {
  return healthResponse(await probeDatabase());
}
