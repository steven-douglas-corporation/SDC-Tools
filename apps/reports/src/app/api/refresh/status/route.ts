import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { currentRefresh } from "@/lib/refresh-service";

// ── Refresh progress, as a ROUTE rather than a server action (§30) ───────────
//
// This exists because the obvious implementation does not work. `refreshStatus()` is a
// server action, and Next.js SERIALIZES server actions from one client: the polls
// queued behind the in-flight `refreshApplicationData()` and none of them ran until
// the refresh they were reporting on had already finished. Measured, not assumed — the
// button sat on "Refreshing application data…" for the full 19 seconds and then jumped
// straight to done.
//
// A route handler is not serialized against actions, so it answers while the refresh is
// still running, which is the entire point.
//
// Signed-in users only, and read-only: two indexed single-row reads, no sync work.
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ running: false, since: null, stage: null, done: 0, total: 0, steps: [] }, { status: 401 });
  const s = await currentRefresh();
  return NextResponse.json(
    { ...s, since: s.since?.toISOString() ?? null },
    // Never cached: a cached progress reading is worse than none.
    { headers: { "Cache-Control": "no-store" } },
  );
}
