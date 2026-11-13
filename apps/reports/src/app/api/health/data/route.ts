// Data freshness, per scheduled source (2026-11-13).
//
// /api/health answers "is the app up?" for the SDC Tools launcher: one SELECT 1, and
// a 503 when MySQL is gone. It deliberately says nothing about the DATA, because a
// stale feed is not a down app — reporting it there would show the whole app as
// stopped while it is serving pages fine. This is the other question, "can the
// figures be trusted right now?", for anything that wants to watch it.
//
// Always 200; the answer is in the body. Public like /api/health (proxy.ts exempts
// the whole api/health prefix), so it carries states and dates only, never the
// recorded error text, which can name servers and accounts.
import { prisma } from "@/lib/prisma";
import { SYNC_SOURCES } from "@/lib/sync-schedule";

export const dynamic = "force-dynamic";

type State = "ok" | "failed" | "waiting" | "never";

export async function GET() {
  let rows: { source: string; status: string | null; refreshedThrough: Date; checkedAt: Date }[];
  try {
    rows = await prisma.powerBiFreshness.findMany({
      where: { source: { in: SYNC_SOURCES.map((s) => s.source) } },
      select: { source: true, status: true, refreshedThrough: true, checkedAt: true },
    });
  } catch {
    return Response.json({ status: "unknown", sources: [] }, { headers: { "Cache-Control": "no-store" } });
  }
  const bySource = new Map(rows.map((r) => [r.source, r]));
  const sources = SYNC_SOURCES.map((s) => {
    const r = bySource.get(s.source);
    const state: State = !r ? "never" : r.status?.startsWith("Failed:") ? "failed" : r.status ? "waiting" : "ok";
    return {
      source: s.source,
      label: s.label,
      state,
      refreshedThrough: r?.refreshedThrough ?? null,
      checkedAt: r?.checkedAt ?? null,
    };
  });
  const status = sources.some((s) => s.state === "failed") ? "degraded" : "ok";
  return Response.json({ status, sources }, { headers: { "Cache-Control": "no-store" } });
}
