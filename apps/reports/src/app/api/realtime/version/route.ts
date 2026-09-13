import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import type { ChangeVersion } from "@/lib/change-version";

// ── "Has anything changed?", answered in one indexed read ────────────────────
//
// The cheapest honest question a tab can ask before deciding to re-render itself.
// It exists because the two obvious answers are both wrong:
//
//   * `router.refresh()` on every focus — correct, and ruinous. On Monthly ETC it
//     re-renders 4,150 cells and re-reads the database for a ~656KB payload, and in
//     this job people alt-tab to Excel and back all day. That was the old behaviour.
//   * "trust the realtime event feed" — cheap, and NOT correct today. Only the ETC
//     grid's own save path publishes change events (lib/change-log.ts is called from
//     etc-actions, monthly-report-actions and refresh-service, and nowhere else), so
//     a Projects edit, an ETC Rates change or a pool edit announces nothing at all.
//     A tab that trusted the feed would never learn about any of them.
//
// This is sound regardless of which write paths publish events, because it does not
// depend on events: every write path in the app records an AuditLog row (logAudit or
// recordChanges), so the newest audit id moves whenever anything anywhere is saved.
//
// A ROUTE, not a server action, for the same reason /api/refresh/status is: Next
// serializes server actions from one client, so a poll issued while a save is in
// flight would queue behind it and answer too late to be useful.
export const dynamic = "force-dynamic";

// The query lives here rather than in lib/change-version.ts so that module stays free
// of a `prisma` import — the browser imports its comparison helper. See the note there.
async function latestChangeVersion(): Promise<ChangeVersion> {
  try {
    const rows = await prisma.$queryRaw<{ v: bigint | number | null }[]>`SELECT MAX(id) AS v FROM AuditLog`;
    const v = rows[0]?.v;
    // An empty log means nothing has ever been saved. Reported as null, which the
    // caller treats as "cannot claim to be current" — correct, and it only happens on
    // a virgin database.
    if (v === null || v === undefined) return null;
    // MAX(id) comes back as BIGINT, which Prisma maps to a JS bigint — JSON.stringify
    // throws on those, so this must be narrowed before it reaches NextResponse.json.
    return Number(v);
  } catch {
    // Never reported as "nothing changed", or one bad read would leave a tab
    // permanently stale.
    return null;
  }
}

export async function GET() {
  const session = await auth();
  // 401 with a null version rather than an error shape: the caller's only decision is
  // "did this move", and a null can never compare equal to a real version, so a
  // signed-out tab degrades to refreshing rather than to going permanently stale.
  if (!session?.user) return NextResponse.json({ v: null }, { status: 401 });
  return NextResponse.json(
    { v: await latestChangeVersion() },
    // Never cached. A cached answer here would pin a tab to a stale version and stop
    // it ever refreshing, which is the exact bug this is meant to prevent.
    { headers: { "Cache-Control": "no-store" } },
  );
}
