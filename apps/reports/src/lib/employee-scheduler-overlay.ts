import "server-only";
import { fetchSchedulerTeam } from "@/lib/scheduler-db";
import { normalizeName } from "@/lib/sync-scheduler-team";

export type SchedulerOverlay = {
  isLead: boolean;
  specialty: string | null;
  sortOrder: number | null;
};

// isLead/specialty/sortOrder are real Scheduler columns (team_members.is_lead,
// .specialty, .sort_order) — not decoration. Reports has no columns of its own
// for any of these (they're Scheduler's to own and edit), so this is a live,
// read-only overlay keyed by the same nickname/case/whitespace-insensitive
// name match sync-scheduler-team.ts's own reconciliation already uses —
// reused rather than re-derived, so this can't disagree with "Reconcile with
// Scheduler" about who's who.
//
// Fails soft: an unreachable Scheduler DB returns an empty map, so a card
// simply shows no star/specialty rather than breaking the page — matching
// every other Scheduler-dependent read in this app (see
// fetchSchedulerProjectJobNumbers's own note).
export async function fetchSchedulerOverlay(): Promise<Map<string, SchedulerOverlay>> {
  try {
    const team = await fetchSchedulerTeam(true); // include inactive — a card's inactive rows should still show their star/specialty
    const map = new Map<string, SchedulerOverlay>();
    for (const m of team) {
      const key = normalizeName(m.name);
      if (!map.has(key)) map.set(key, { isLead: m.isLead, specialty: m.specialty, sortOrder: m.sortOrder });
    }
    return map;
  } catch {
    return new Map();
  }
}
