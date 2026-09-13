// Lightweight liveness probe for the SDC Tools launcher / desktop shell, which
// polls each app's health path to show a running/stopped status. Public — it's
// exempt from the NextAuth middleware in proxy.ts and returns no data beyond a
// status string, so it can be hit without a session.
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ status: "ok", app: "sdc-projects-reports" });
}
