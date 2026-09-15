// Liveness probe for the SDC Tools launcher / desktop shell, which polls each
// app's health path to show a running/stopped status. Public — it's exempt from
// the NextAuth middleware in proxy.ts and returns no data beyond a status string,
// so it can be hit without a session.
//
// Since 2026-09-14 it is a READINESS probe too: one `SELECT 1` through the app's
// Prisma pool, 2s budget, one retry, and 503 `{ status: "degraded", db:
// "unreachable" }` when the database is not answering — see lib/health-probe.ts.
// Before that it returned 200 unconditionally, so a process that had lost MySQL
// looked exactly like a healthy one.
import { probeDatabase, healthResponse } from "@/lib/health-probe";

export const dynamic = "force-dynamic";

export async function GET() {
  return healthResponse(await probeDatabase());
}
