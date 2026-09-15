import "server-only";
import { fetchProjectEstimates, fetchArForecastRows, fetchApForecastRows, fetchPoForecastRows } from "@/lib/cash-flow-totaleto";
import { buildArLines, buildApLines, buildPoLines, buildEtcLines, aggregateLines, hashLines } from "@/lib/cash-flow-normalize";
import { getLatestSnapshot, insertSnapshot, getEtcAllocations } from "@/lib/cash-flow-snapshot-store";
import { getValidProjectIds } from "@/lib/cash-flow";

// The one orchestration point: Total ETO live extraction -> normalize ->
// dedup-by-hash -> immutable snapshot (2026-08-19). Called from BOTH the
// scheduled hourly refresh and a manual "Refresh Data" click, via
// auto-sync.ts's own SYNC_SOURCES list — not a second pipeline.

export type CashFlowCaptureResult = { captured: boolean; snapshotId: number; lineCount: number; reason: string };

// ── The calendar day a snapshot is filed under (2026-09-14) ─────────────────
//
// Was `new Date(ts.toISOString().slice(0, 10))` — the UTC day. This server runs
// UTC-4, so a refresh at 20:00 or later local filed its snapshot under TOMORROW,
// and the "prior month-end" lookup (CashFlowSnapshot.snapshotDate, an indexed
// DATE column) missed the last capture of the month on the evening it was made.
//
// The day is taken in the app's own "today" convention — local server time,
// exactly as lib/etc.ts's currentMonth() does for "what month is it" — and then
// stored as midnight UTC of THAT date, because a Prisma @db.Date column keeps
// the UTC date part of the Date it is handed. Pure, so a 21:00 local timestamp
// can be checked in a test.
export function snapshotDateFor(ts: Date): Date {
  return new Date(Date.UTC(ts.getFullYear(), ts.getMonth(), ts.getDate()));
}

export async function captureCashFlowSnapshot(actorEmail: string | null): Promise<CashFlowCaptureResult> {
  const sourceRefreshTimestamp = new Date();
  const [estimates, arRows, apRows, poRows, etcAllocations, validIds] = await Promise.all([
    fetchProjectEstimates(),
    fetchArForecastRows(),
    fetchApForecastRows(),
    fetchPoForecastRows(),
    getEtcAllocations(),
    getValidProjectIds(),
  ]);

  const customerByProject = new Map(estimates.filter((e): e is typeof e & { customer: string } => !!e.customer).map((e) => [e.projectId, e.customer]));

  // Same type-gate as everywhere else in this app (job-filters.ts) — a
  // snapshot must never persist TotalETO's own test/sandbox project rows
  // into permanent history.
  const lines = aggregateLines([
    ...buildArLines(arRows.filter((r) => validIds.has(r.projectId)), customerByProject),
    ...buildApLines(apRows.filter((r) => validIds.has(r.projectId)), customerByProject),
    ...buildPoLines(poRows.filter((r) => validIds.has(r.projectId)), customerByProject),
    ...buildEtcLines(etcAllocations, customerByProject),
  ]);

  const contentHash = hashLines(lines);
  const latest = await getLatestSnapshot();

  // "Do not create duplicate snapshots if nothing has changed within the
  // same refresh cycle" — checked against the single most recent snapshot's
  // hash, never the whole history, so a genuine round-trip change (forecast
  // moves away and back to an old value) still gets its own new row rather
  // than being silently treated as a repeat of some older snapshot.
  if (latest && latest.contentHash === contentHash) {
    return { captured: false, snapshotId: latest.id, lineCount: latest.lineCount, reason: "forecast unchanged since the last snapshot" };
  }

  // Midnight UTC of today's LOCAL calendar date — the "As Of: <date>"/"prior
  // month-end" lookups key on this, not on the precise capture time.
  const snapshotDate = snapshotDateFor(sourceRefreshTimestamp);

  const snapshotId = await insertSnapshot({ snapshotDate, sourceRefreshTimestamp, createdBy: actorEmail, contentHash, lines });

  return { captured: true, snapshotId, lineCount: lines.length, reason: latest ? "forecast changed since the last snapshot" : "first snapshot" };
}
