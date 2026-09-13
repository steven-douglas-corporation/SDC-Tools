// The app's global "something was saved" marker, and the rule for comparing two
// readings of it.
//
// ── Why the audit log is the right source ────────────────────────────────────
//
// A tab that wants to know whether it is stale has to ask about EVERY table it
// renders — jobs, EtcEntry, EstimatedHours, CategoryPool, ExecutionRate,
// StandardSheetSetting, Employee. Asking each one for its MAX(updatedAt) would be
// half a dozen queries and would still miss any table added later.
//
// AuditLog already sits behind all of them: every write path in the app records a row
// (through logAudit, or through recordChanges which does both the row and the realtime
// event). So its newest id moves when anything anywhere is saved, and it moves exactly
// once per save batch. One indexed read on a primary key, no joins.
//
// This is deliberately COARSE — it says "something changed", not "your rows changed".
// That is the correct trade for the caller: the decision it feeds is whether to
// re-render at all, and a false positive costs one render the app used to do
// unconditionally, while a false negative would leave a tab stale. Erring toward
// "refresh" is the safe direction.
//
// Not a timestamp: MAX(id) on an auto-increment primary key cannot go backwards, is
// immune to clock skew between the app and the database, and needs no index beyond the
// one the primary key already provides.
//
// ── No database import in this file, on purpose ──────────────────────────────
//
// The comparison below runs in the BROWSER (components/LiveRefresh.tsx), and the query
// runs on the server (app/api/realtime/version/route.ts). Importing `prisma` here to
// keep the pair together would drag the database client into the client bundle — so
// the query lives in the route, which is the only place that needs it, and this module
// stays pure and unit-testable.

export type ChangeVersion = number | null;

/**
 * Whether a tab holding `seen` should re-read the route.
 *
 * The interesting behaviour is the asymmetry around `null`, which is what keeps an
 * unreadable, unauthenticated or never-yet-taken reading on the safe side.
 */
export function changeVersionMoved(seen: ChangeVersion, latest: ChangeVersion): boolean {
  // Never synced: this tab has no baseline to compare against, so it cannot claim to
  // be current.
  if (seen === null) return true;
  // Could not read the marker (query failed, 401, malformed body). Refresh rather
  // than assume nothing happened.
  if (latest === null) return true;
  // EQUAL is the only "you are current" answer — deliberately `!==` rather than
  // `latest > seen`. The log is append-only, so MAX(id) cannot decrease: a lower
  // reading means the marker was misread, not that the world went backwards, and a
  // misread must not be trusted as proof of currency. `>` would have returned "you
  // are current" for exactly that case.
  return latest !== seen;
}
