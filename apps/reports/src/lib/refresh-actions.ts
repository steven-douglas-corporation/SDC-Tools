"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { refreshAllData, currentRefresh, type RefreshOutcome } from "@/lib/refresh-service";

// The `Refresh Data` button's server action (§25.2).
//
// ── Authorization (§25.12) ───────────────────────────────────────────────────
//
// Signed in is the bar, checked here. There is deliberately no password: this app has
// ONE shared team password and no role hierarchy (the role gates were removed on
// 2026-08-02 — see DEVLOG §10's note on gates nobody can reach), so a second secret in
// front of a read-only data pull would be theatre. It also cannot be leaked to the
// browser, which the old dropdown's password field could.
//
// A refresh only ever PULLS from upstream systems into app tables. It cannot destroy a
// manager's work — no step writes an app-owned figure (auto-sync.ts states which) — so
// "any signed-in user may run it" is the right level, and the audit record says who did.
export async function refreshApplicationData(): Promise<RefreshOutcome> {
  const session = await auth();
  const user = session?.user as { id?: string; name?: string | null; email?: string | null } | undefined;
  if (!user) {
    return { ok: false, reason: "error", message: "Not signed in.", refreshId: "" };
  }

  const outcome = await refreshAllData({
    trigger: "manual",
    userId: user.id ? Number(user.id) : null,
    userName: user.name?.trim() || user.email?.split("@")[0] || "A user",
  });

  // Every page that renders refreshed figures. The client also gets a realtime event
  // (see refresh-service.ts) so OTHER users' tabs update without reloading; this is what
  // makes the clicking user's own pages current the moment the action resolves.
  if (outcome.ok) {
    revalidatePath("/");
    revalidatePath("/etc");
    revalidatePath("/quoted");
    revalidatePath("/job-hours");
    revalidatePath("/employees");
  }
  return outcome;
}

// Used by the button on mount to say "a refresh is already running" instead of offering
// a click that will simply be refused (§25.10).
// Polled by the button while a refresh is in flight (§30), so "Refreshing application
// data…" becomes "Refreshing parts costs… (3 of 7)". Deliberately cheap: two indexed
// single-row reads, no sync work of its own.
export type RefreshStatus = {
  running: boolean;
  since: string | null;
  stage: string | null;
  done: number;
  total: number;
  steps: { source: string; label: string; status: string; detail: string }[];
};

export async function refreshStatus(): Promise<RefreshStatus> {
  const session = await auth();
  const idle: RefreshStatus = { running: false, since: null, stage: null, done: 0, total: 0, steps: [] };
  if (!session?.user) return idle;
  const s = await currentRefresh();
  return { ...s, since: s.since?.toISOString() ?? null };
}
