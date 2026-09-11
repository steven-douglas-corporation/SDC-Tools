import "server-only";

// ── What actually happened on a Total ETO attempt (2026-09-09) ───────────────
//
// Written after "1 source failed: Parts cost (TotalETO)" had been appearing on
// manual refreshes for five days with no way to tell WHICH failure it was.
//
// The refresh record already stored a sentence per source, and that sentence was
// enough to identify the cause once somebody read it out of the database — but it
// is one string, it is only written when the whole step ends, and it cannot say
// how far the attempt got. So the questions an operator actually asks could not
// be answered from it:
//
//   * did we authenticate, or never get that far?
//   * did the connection open?
//   * did the query start? did it come back?
//   * how long did it run before it broke?
//   * was this the first attempt or the third?
//   * is the number on screen from this attempt, or from the last good one?
//
// Every one of those is a different remedy — a password, a firewall, a slow
// query, an application bug — and "Total ETO failed" is the same words for all
// of them. This module records the answers, per attempt, in one line.
//
// ── Deliberately NOT a database table ───────────────────────────────────────
//
// The per-SOURCE outcome is already persisted (PowerBiFreshness.status) and so is
// the per-PASS outcome (RefreshRun.steps). This is the per-ATTEMPT layer beneath
// both, it is high-volume, and it is only ever read while diagnosing — so it goes
// to the process log (PM2 keeps it) plus a small in-memory ring for a live read.
// A new table would need a migration and a retention policy to hold data whose
// value expires in minutes.

/** How far an attempt got before it ended. The stage IS the diagnosis. */
export type TotalEtoStage =
  /** Opening the pool: DNS, TCP, then the NTLM/SQL login. */
  | "authenticate"
  /** Pool is open; taking a connection out of it for this request. */
  | "connect"
  /** The SELECT is on the wire. */
  | "query"
  /** Rows came back and our own mapping code is running over them. */
  | "transform"
  /** Writing the transformed result into the app database. */
  | "commit";

export type TotalEtoAttemptRecord = {
  /** ISO 8601, UTC. */
  at: string;
  /** Which query/feed — e.g. "parts_cost.booked_by_job". */
  feed: string;
  /** The stage the attempt was in when it succeeded or failed. */
  stage: TotalEtoStage;
  /** 1-based. `attempt` of `attemptsAllowed`. */
  attempt: number;
  attemptsAllowed: number;
  /** Wall-clock ms for THIS attempt, including the wait for a connection. */
  ms: number;
  ok: boolean;
  /** True once the login was accepted. False means we never got past the login. */
  authenticated: boolean;
  connectionOpened: boolean;
  queryStarted: boolean;
  queryCompleted: boolean;
  /**
   * Whether the CALLER went on to serve the last known-good figures instead of
   * this attempt's. Recorded because "the report is wrong" and "the report is
   * old" are different complaints and look identical without it.
   */
  usedCachedData: boolean;
  /** The classification, so the log can be filtered by cause. Null on success. */
  kind: string | null;
  /** The driver's own code — ELOGIN, ETIMEOUT, ESOCKET, EPARAM, ECONNCLOSED. */
  code: string | null;
  /** SQL Server's error number and state, when the server itself answered. */
  sqlNumber: number | null;
  sqlState: string | null;
  detail: string | null;
  server: string;
  database: string;
  /** Whether another attempt follows this one. */
  willRetry: boolean;
};

// ── Never the password ──────────────────────────────────────────────────────
//
// Driver errors do not normally quote the password, but a config object reaching
// a message would carry it, and a diagnostic that leaks a credential into a log
// PM2 keeps on disk is worse than no diagnostic. So every string that goes into
// a record passes through here first. Belt and braces, not a substitute for not
// putting it there.
//
// The ACCOUNT name is deliberately kept: "which login was refused" is the first
// thing whoever fixes a rejected login needs, and it is not a secret.
export function redactSecrets(text: string): string {
  const password = process.env.TOTALETO_DB_PASSWORD;
  if (!password || password.length < 4) return text;
  return text.split(password).join("«password»");
}

const RING_SIZE = 200;

type Ring = { records: TotalEtoAttemptRecord[] };

// On globalThis for the same reason the pool cache is: a dev hot-reload, and the
// several bundled copies of this module a Next build produces, must all append to
// ONE history. A per-copy ring would answer "what happened" differently depending
// on which copy you asked.
const globalForDiagnostics = globalThis as typeof globalThis & { __sdcTotalEtoDiagnostics?: Ring };
const ring: Ring = (globalForDiagnostics.__sdcTotalEtoDiagnostics ??= { records: [] });

/**
 * Records one attempt and logs it as a single parseable line.
 *
 * Never throws: this is instrumentation, and instrumentation that can fail the
 * thing it is watching is a liability. (The same rule recordProgress follows in
 * refresh-service.ts.)
 */
export function recordTotalEtoAttempt(record: TotalEtoAttemptRecord): void {
  try {
    const safe: TotalEtoAttemptRecord = {
      ...record,
      detail: record.detail == null ? null : redactSecrets(record.detail),
    };
    ring.records.push(safe);
    if (ring.records.length > RING_SIZE) ring.records.splice(0, ring.records.length - RING_SIZE);

    // One line, key=value, so it can be grepped out of the PM2 log by cause
    // ("kind=query_timeout") or by feed without a parser.
    const fields = [
      `at=${safe.at}`,
      `feed=${safe.feed}`,
      `stage=${safe.stage}`,
      `attempt=${safe.attempt}/${safe.attemptsAllowed}`,
      `ms=${safe.ms}`,
      `ok=${safe.ok}`,
      `auth=${safe.authenticated}`,
      `connected=${safe.connectionOpened}`,
      `queryStarted=${safe.queryStarted}`,
      `queryCompleted=${safe.queryCompleted}`,
      `cachedDataUsed=${safe.usedCachedData}`,
      `willRetry=${safe.willRetry}`,
      `server=${safe.server}/${safe.database}`,
    ];
    if (safe.kind) fields.push(`kind=${safe.kind}`);
    if (safe.code) fields.push(`code=${safe.code}`);
    if (safe.sqlNumber != null) fields.push(`sqlNumber=${safe.sqlNumber}`);
    if (safe.sqlState) fields.push(`sqlState=${safe.sqlState}`);
    const line = `[totaleto] ${fields.join(" ")}`;
    if (safe.ok) console.log(line);
    else console.error(`${line}\n[totaleto]   detail: ${safe.detail ?? "(none)"}`);
  } catch {
    /* instrumentation must never be the thing that fails */
  }
}

/**
 * Records that a refresh SOURCE gave up and left the previous snapshot in place.
 *
 * The distinction this exists to make: withTotalEto records per-QUERY attempts, and
 * a failed query is not yet a stale report — the step above it may still retry, or
 * may have nothing to show. This is the line that says the app is now serving the
 * last known-good figures for that source, which is the difference between "the
 * report is wrong" and "the report is old" and was previously nowhere at all.
 *
 * `stage`, `kind` and `ms` come from the step's own failure; every other flag is
 * unknown at this level and recorded as such rather than guessed.
 */
export function recordTotalEtoFallback(input: {
  /** The refresh source, e.g. "parts_cost". */
  feed: string;
  stage: TotalEtoStage;
  kind: string;
  ms: number;
  detail: string;
  server: string;
  database: string;
  /** True when the failure is one another pass could still fix. */
  retryable: boolean;
}): void {
  recordTotalEtoAttempt({
    at: new Date().toISOString(),
    feed: input.feed,
    stage: input.stage,
    // The step is the outermost attempt: whatever retrying happened, happened below.
    attempt: 1,
    attemptsAllowed: 1,
    ms: input.ms,
    ok: false,
    // Not observable from here — withTotalEto's own records for this feed carry it.
    authenticated: input.kind !== "login_rejected",
    connectionOpened: input.kind !== "login_rejected",
    queryStarted: false,
    queryCompleted: false,
    usedCachedData: true,
    kind: input.kind,
    code: null,
    sqlNumber: null,
    sqlState: null,
    detail: input.detail,
    server: input.server,
    database: input.database,
    willRetry: input.retryable,
  });
}

/** The recent attempt history, oldest first. For a diagnostics read, not a hot path. */
export function recentTotalEtoAttempts(limit = RING_SIZE): TotalEtoAttemptRecord[] {
  return ring.records.slice(-limit);
}

/**
 * The last attempt per feed, plus the last SUCCESSFUL one — which is what
 * distinguishes "Total ETO is current" from "Total ETO is stale and the latest
 * attempt failed" for a given feed.
 */
export function totalEtoFeedHistory(): {
  feed: string;
  lastAttempt: TotalEtoAttemptRecord;
  lastSuccess: TotalEtoAttemptRecord | null;
  consecutiveFailures: number;
}[] {
  const byFeed = new Map<string, TotalEtoAttemptRecord[]>();
  for (const r of ring.records) {
    const list = byFeed.get(r.feed) ?? [];
    list.push(r);
    byFeed.set(r.feed, list);
  }
  return [...byFeed.entries()]
    .map(([feed, list]) => {
      let consecutiveFailures = 0;
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].ok) break;
        consecutiveFailures++;
      }
      return {
        feed,
        lastAttempt: list[list.length - 1],
        lastSuccess: [...list].reverse().find((r) => r.ok) ?? null,
        consecutiveFailures,
      };
    })
    .sort((a, b) => a.feed.localeCompare(b.feed));
}
