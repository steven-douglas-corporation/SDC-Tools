import "server-only";
import { getSchedulerBaseUrl } from "@/lib/scheduler-link";
import { withTimeoutOrNull } from "@/lib/with-timeout";

export type SchedulerPushResult = { ok: boolean; reason?: string };

// The write half of Add Member — the read half (fetchSchedulerTeam,
// fetchSchedulerPlaceholders) goes through the read-only SCHEDULER_DATABASE_URL
// connection, but that connection is deliberately read-only (a dedicated
// MySQL user, enforced by convention — see scheduler-db.ts), so creating a
// row has to go over HTTP to a route Scheduler itself owns and writes
// through, the same shape as revokeSchedulerSession/syncPasswordHashToScheduler
// in scheduler-link.ts (SCHEDULER_SHARED_TOKEN bearer, time-boxed, best-effort).
//
// Called AFTER the local Reports Employee row already exists — employeeId is
// what lets Scheduler's team_members.employee_id point back at it, the same
// column Scheduler's OWN UI populates when a drag-assign links an existing
// ETC person (see SDC_Scheduler routes/team.js).
//
// Deliberately does not throw: a person who couldn't be pushed to Scheduler
// still exists in Reports (the more important half already committed) — the
// caller decides how to tell the user the Scheduler half didn't take.
export async function pushTeamMemberToScheduler(
  employeeId: number,
  name: string,
  disciplineCode: string,
): Promise<SchedulerPushResult> {
  const token = process.env.SCHEDULER_SHARED_TOKEN;
  if (!token) return { ok: false, reason: "Scheduler integration is not configured." };

  const result = await withTimeoutOrNull(
    "Scheduler add-member push",
    5000,
    async () => {
      const res = await fetch(`${getSchedulerBaseUrl()}/api/integration/team-members`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name, discipline: disciplineCode, employeeId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error ?? `Scheduler returned ${res.status}`);
      }
      return true;
    },
    (e) => console.error("pushTeamMemberToScheduler failed:", e),
  );

  return result ? { ok: true } : { ok: false, reason: "Couldn't reach the Scheduler." };
}
