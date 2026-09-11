import "server-only";
import sql from "mssql";
import {
  recordTotalEtoAttempt,
  redactSecrets,
  type TotalEtoStage,
} from "@/lib/totaleto-diagnostics";

// ── The ONE Total ETO connection (2026-09-01) ────────────────────────────────
//
// Written after all four Total ETO refresh sources failed at once — Parts cost,
// Parts cost actual, Jobs from TotalETO and the Cash Flow snapshot — and the
// investigation had to establish, from scratch, that they shared a cause.
//
// They did, and the code made that harder to see than it should have been: the
// identical connection config existed FOUR TIMES, in sync-totaleto.ts,
// cash-flow-totaleto.ts, cash-flow-drill.ts and job-bom.ts. Same server, same
// database, same credentials, same domain, same options — differing only in
// requestTimeout. Four copies of one dependency, so "is this one shared failure
// or four separate ones" was a question the source could not answer.
//
// It is one module now. A credential change is one edit; a failure is one
// diagnosis; and `requestTimeout` stays per-caller because those differences are
// real (a BOM query legitimately needs longer than a job list).
//
// ── The failure this was written for ────────────────────────────────────────
//
//   ConnectionError: Login failed. The login is from an untrusted domain and
//   cannot be used with Integrated authentication.          code: ELOGIN
//
// `domain: "stevendouglas"` makes tedious authenticate over NTLM as
// stevendouglas\<user> rather than with a SQL Server login, so this connection
// depends on the domain account staying valid. On 2026-09-01 it stopped: the
// 14:02 refresh pass had all four sources green, the 14:21 pass had all four
// failing, and there is no ELOGIN anywhere in the preceding week of logs.
// Verified against the server directly — the credentials in .env are rejected,
// and a plain SQL-auth attempt answers "Login failed for user 'akamuju'", which
// means the server is reachable and refusing us rather than unreachable.
//
// That is a credentials problem, not a code one. What WAS a code problem is that
// nothing said so: each source surfaced a raw mssql sentence about "Integrated
// authentication" into a toast, which reads like an app fault. classifyTotalEto
// below is what turns it into something actionable.

/** Where Total ETO lives. Hardcoded before this file existed — in four places. */
export const TOTALETO_SERVER = "SERVER-APP1.stevendouglas.local";
export const TOTALETO_DATABASE = "SDC";
const SERVER = TOTALETO_SERVER;
const DATABASE = TOTALETO_DATABASE;
const DOMAIN = "stevendouglas";

/**
 * Longest a single query may run. Per-caller because the differences are real
 * and were already in the four copies: a job list is quick, a BOM walk is not.
 */
export const TOTALETO_TIMEOUT = {
  /** Job/parts sync queries. */
  sync: 30_000,
  /** The Cash Flow forecast query set. */
  cashFlow: 60_000,
  /** A full BOM walk. */
  bom: 120_000,
} as const;

/**
 * The connection config. Reads the credentials at CALL time, not at module load,
 * so updating .env and restarting is all it takes — and so a test can see the
 * same values the app does.
 */
export function totalEtoConfig(requestTimeout: number = TOTALETO_TIMEOUT.sync): sql.config {
  return {
    server: SERVER,
    database: DATABASE,
    user: process.env.TOTALETO_DB_USER,
    password: process.env.TOTALETO_DB_PASSWORD,
    // NTLM, not a SQL login — see the header. This is why the connection depends
    // on a domain account rather than on a value only this app knows.
    domain: DOMAIN,
    port: 1433,
    options: { trustServerCertificate: true, encrypt: false },
    connectionTimeout: 15_000,
    requestTimeout,
    // ── Bounded, and idle connections handed back ────────────────────────────
    //
    // mssql's defaults are max 10 / min 0 / idle 30s. `min: 0` is the important one
    // and is kept: pools below are long-lived, so anything above zero would hold
    // connections on the SQL box for the life of the process. With zero, an idle pool
    // holds nothing and the next query reopens as needed.
    //
    // max is lowered to 5 because there are now a handful of pools (one per distinct
    // requestTimeout) rather than one: 5 x a few pools is a sane ceiling on what this
    // app can hold against Total ETO, and no query path here needs more than a
    // handful of concurrent connections (the widest fan-out in the app is 6, and it
    // is spread across pools).
    pool: { max: 5, min: 0, idleTimeoutMillis: 30_000 },
  };
}

// ── The failure taxonomy (widened 2026-09-09) ───────────────────────────────
//
// Was four values: login_rejected, unreachable, timeout, other. That was enough
// to answer "can retrying help?" and not enough to answer "what is wrong?" —
// which is the question a refresh log has to answer, because the remedies have
// nothing in common. A connect timeout is a firewall; a query timeout is a slow
// statement; an exhausted pool is us; a rejected login is a password; and a
// parameter-binding fault is a bug in this application that no amount of
// retrying, credential-rotating or network-checking will ever fix.
export type TotalEtoFailure =
  /** The server answered and refused the credentials. Someone must fix .env or the account. */
  | "login_rejected"
  /** The server name did not resolve. DNS, or a renamed host. */
  | "dns"
  /** Reached the network and it broke: reset, unreachable route, firewall drop. */
  | "network"
  /** Resolved and routed, but nothing accepted the connection — SQL Server is down. */
  | "server_unavailable"
  /** Never finished opening the connection inside connectionTimeout. */
  | "connect_timeout"
  /** Connected, but the statement outran requestTimeout. */
  | "query_timeout"
  /** Our own pool had no free connection to give inside its acquire window. */
  | "pool_exhausted"
  /**
   * A parameter could not be bound — the type constant came from a DIFFERENT
   * instance of the mssql module than the pool did. An application/bundling
   * fault, not an upstream one. See the note above withTotalEto.
   */
  | "param_binding"
  /** The server executed our statement and refused it: syntax, permission, schema. */
  | "sql_error"
  /** Rows came back and our own mapping code threw. Nothing to do with Total ETO. */
  | "transformation"
  /**
   * Total ETO answered; writing the result into THIS app's database failed. Also
   * nothing to do with Total ETO, and it used to be reported as though it were:
   * a refresh step that owns a Total ETO source has its errors described by this
   * module, so a Prisma failure in syncPartsCost's write loop came out as "Total
   * ETO query failed against SERVER-APP1" and sent the reader to the wrong system.
   */
  | "app_write"
  /** Anything else — a genuine bug in our own code, most likely. */
  | "other";

/** The failures where another attempt has a real chance of succeeding. */
const TRANSIENT: ReadonlySet<TotalEtoFailure> = new Set<TotalEtoFailure>([
  "dns",
  "network",
  "server_unavailable",
  "connect_timeout",
  "query_timeout",
  "pool_exhausted",
]);

/**
 * Whether retrying this failure can help.
 *
 * Deliberately excludes `login_rejected` (a person must change a credential),
 * `param_binding` / `transformation` / `sql_error` (our bug — retrying just
 * multiplies the log lines) and `other` (unknown, so failing visibly beats
 * hammering an upstream system three times for the same result).
 */
export function isTransientTotalEto(kind: TotalEtoFailure): boolean {
  return TRANSIENT.has(kind);
}

/** The failures that mean the POOL itself is suspect and should be rebuilt. */
const POISONS_POOL: ReadonlySet<TotalEtoFailure> = new Set<TotalEtoFailure>([
  "dns",
  "network",
  "server_unavailable",
  "connect_timeout",
  "login_rejected",
]);

/**
 * What KIND of failure this is, so a caller can say something true about it.
 *
 * The distinction that matters operationally: `login_rejected` means nothing in
 * this app will work against Total ETO until a person changes a credential, and
 * retrying on the hourly schedule cannot help. The network and timeout kinds are
 * the opposite — worth retrying, probably transient. Reporting all of them as
 * "failed" is what made a two-hour credential outage look like a flaky feed.
 *
 * `authenticated` says whether the login had already succeeded when this error
 * arrived; without it a timeout on an open connection (a slow query) and a
 * timeout while opening one (a firewall) classify identically.
 */
export function classifyTotalEto(error: unknown, context?: { authenticated?: boolean }): TotalEtoFailure {
  const code = (error as { code?: unknown } | null)?.code;
  const name = (error as { name?: unknown } | null)?.name;
  const message = error instanceof Error ? error.message : String(error);

  // ── Ours before theirs ────────────────────────────────────────────────────
  // A binding fault must never be reported as a Total ETO problem: it fails in
  // ~15ms without touching the network, and calling it "Total ETO failed" is
  // what sent a five-day investigation looking at credentials and firewalls.
  if (code === "EPARAM" || /Validation failed for parameter/i.test(message)) return "param_binding";
  if (code === "EINJECT" || code === "EARGS" || code === "EDUPEPARAM") return "param_binding";

  // Prisma, i.e. OUR database rather than Total ETO's. Recognised by the client's
  // own class names and its P#### error codes.
  if (typeof name === "string" && name.startsWith("PrismaClient")) return "app_write";
  if (typeof code === "string" && /^P\d{4}$/.test(code)) return "app_write";

  if (code === "ELOGIN" || /Login failed/i.test(message)) return "login_rejected";
  if (code === "ENOTFOUND" || /getaddrinfo/i.test(message)) return "dns";
  if (code === "ECONNREFUSED") return "server_unavailable";

  // tarn (mssql's pool) rejects an acquire with a bare TimeoutError, no code.
  if (name === "TimeoutError" || /acquir\w* a? ?connection/i.test(message)) return "pool_exhausted";

  if (code === "ETIMEOUT" || code === "ETIMEOUTREQUEST" || /timeout/i.test(message)) {
    // tedious's own two sentences, which say which side of the connection we are on:
    //   "Failed to connect to <host>:1433 in 15000ms"      -> opening
    //   "Timeout: Request failed to complete in 30000ms"   -> executing
    if (/Failed to connect to/i.test(message)) return "connect_timeout";
    if (/Request failed to complete/i.test(message)) return "query_timeout";
    return context?.authenticated ? "query_timeout" : "connect_timeout";
  }

  if (
    code === "ESOCKET" ||
    code === "ECONNRESET" ||
    code === "ECONNCLOSED" ||
    code === "EHOSTUNREACH" ||
    /socket hang up/i.test(message)
  ) {
    return "network";
  }

  // The server ran our statement and objected to it.
  if (code === "EREQUEST") return "sql_error";

  // Past the login, no driver code at all: our own mapping code threw over rows
  // that did arrive.
  if (context?.authenticated && code == null) return "transformation";

  return "other";
}

/**
 * A sentence for a refresh log or a toast. Says what is wrong, where, and who has
 * to do something about it — rather than quoting mssql at a manager.
 */
export function describeTotalEtoFailure(error: unknown, context?: { authenticated?: boolean }): string {
  const kind = classifyTotalEto(error, context);
  const raw = redactSecrets(error instanceof Error ? error.message : String(error));
  switch (kind) {
    case "login_rejected":
      return (
        `Total ETO rejected the login for "${process.env.TOTALETO_DB_USER ?? "(no user configured)"}" on ${SERVER}. ` +
        `The TOTALETO_DB_USER / TOTALETO_DB_PASSWORD in .env are no longer accepted — the domain password has changed, ` +
        `expired, or the account is locked. Retrying will not help until they are updated. (${raw})`
      );
    case "dns":
      return `Total ETO's server name (${SERVER}) did not resolve — DNS, or the host was renamed. Worth retrying. (${raw})`;
    case "network":
      return `The network connection to Total ETO (${SERVER}) broke mid-flight — cable, route or firewall. Worth retrying. (${raw})`;
    case "server_unavailable":
      return `Nothing is listening for SQL on ${SERVER}:1433 — the SQL Server service is stopped or the box is down. Worth retrying. (${raw})`;
    case "connect_timeout":
      return `Total ETO (${SERVER}) did not finish opening a connection within 15s — the server is overloaded, or a firewall is dropping the packets rather than refusing them. Worth retrying. (${raw})`;
    case "query_timeout":
      return `Total ETO (${SERVER}) accepted the connection but the query outran its time limit. Worth retrying; if it persists the statement needs looking at. (${raw})`;
    case "pool_exhausted":
      return `This app's own Total ETO connection pool had no free connection to give — too many overlapping queries, not a Total ETO fault. Worth retrying. (${raw})`;
    case "param_binding":
      return (
        `A Total ETO query could not bind its parameters. This is a fault in THIS APPLICATION, not in Total ETO — ` +
        `the login, the network and the server are all fine, and the query never reached them. It means a query built its ` +
        `parameter types from a different copy of the mssql module than the one that opened the pool ` +
        `(see lib/totaleto-connection.ts and serverExternalPackages in next.config.ts). Retrying cannot help. (${raw})`
      );
    case "sql_error":
      return `Total ETO ran the query and refused it — a schema change, a permission, or a fault in our SQL. Retrying cannot help. (${raw})`;
    case "transformation":
      return `Total ETO returned the rows; this app then failed while processing them. The connection is healthy. (${raw})`;
    case "app_write":
      return (
        `Total ETO returned the rows; writing them into this app's own database failed. ` +
        `The fault is in the app database (MySQL) or the write itself, not in Total ETO. Retrying cannot help until that is fixed. (${raw})`
      );
    default:
      // Only claim Total ETO when there is driver evidence for it. Without a code
      // this is an unrecognised error from somewhere inside a step that happens to
      // own a Total ETO source, and naming the server would send whoever reads it
      // to check a system that may be perfectly healthy.
      return (error as { code?: unknown } | null)?.code != null
        ? `Total ETO query failed against ${SERVER}. (${raw})`
        : `A Total ETO refresh step failed, with no sign that Total ETO itself was involved — the message is from this application. (${raw})`;
  }
}

// ── One long-lived pool per timeout, and never sql.connect (2026-09-03) ─────
//
// This replaces `sql.connect(config)` + `pool.close()`, which every Total ETO call
// site used and which is actively broken. Both faults are visible in
// node_modules/mssql/lib/global-connection.js:
//
//   1. `connect(config)` begins `if (!globalConnection)`. The config is therefore
//      used ONLY on the first call in the process; every later call gets the pool
//      that already exists and its config is SILENTLY DISCARDED. So
//      `sql.connect({ ...config, requestTimeout: 300000 })` did not give that query
//      300 seconds — it gave it whichever timeout won the race at startup.
//
//   2. `pool.close()` on the global pool sets `globalConnection = null` and closes
//      the pool FOR EVERY CONCURRENT USER. Any in-flight request on it fails with
//      `Error: aborted`.
//
// Fault 2 is the cause of the bug this was written for. The Monthly ETC grid's
// Left to Purchase column read $0 on every job, from
// `[parts-etc-breakout] batched parts lines failed: Error: aborted` — the 49-job
// parts-lines query takes ~3s, which is a wide window for any other Total ETO
// caller (the hourly refresh, a BOM read, another user's page) to finish and close
// the pool underneath it. A one-job query usually won that race, which is exactly
// why this looked like "only breaks with a lot of jobs".
//
// The fix is to stop sharing the GLOBAL pool and stop closing pools at all. A
// dedicated `new sql.ConnectionPool` per distinct requestTimeout, cached and kept
// open, is what a connection pool is for: honours each caller's timeout (fault 1),
// cannot be closed under a concurrent request (fault 2), and with `min: 0` holds no
// connections while idle, so nothing leaks.
//
// The cache hangs off globalThis so a dev hot-reload re-evaluating this module
// reuses the pools it already opened rather than stacking a new set on every edit
// — the same reason lib/prisma.ts does it.
//
// ── A pool belongs to the mssql instance that built it (2026-09-09) ─────────
//
// And that globalThis cache is what broke Parts cost for five days.
//
// The symptom: every MANUAL refresh reported "1 source failed: Parts cost
// (TotalETO)" while every HOURLY refresh of the same source succeeded. 59 of 80
// manual passes failed; the interval passes either side of them were green. The
// recorded error was
//
//   Total ETO query failed against SERVER-APP1.stevendouglas.local.
//   (Validation failed for parameter 'start'. r.type.validate is not a function)
//
// and it arrived in 11-28ms — before any network round trip could have happened.
// So: not the credentials, not NTLM, not DNS, not a timeout, not the pool. The
// query never left the process.
//
// The cause is that a Next build does not produce ONE copy of a bundled module.
// `mssql` was not in serverExternalPackages, so the production build carries
// THREE full copies of it (verified: three server chunks each containing mssql's
// own "SQL injection warning for param" string), and three copies of this file
// with them — one per bundle layer. The hourly pass runs in the copy loaded from
// instrumentation.ts; a Refresh Data click runs in the server-action copy.
//
// Three copies of this module, ONE globalThis pool cache. So the first pass after
// a restart (the startup refresh, from instrumentation) opened the pool, and every
// later caller got that pool — including callers whose `sql.DateTime` came from a
// different copy of mssql. mssql's getTediousType() is a switch on TYPE IDENTITY:
//
//     case TYPES.DateTime: return tds.TYPES.DateTime      // its OWN TYPES
//     ...
//     default: return type                                // <- foreign type falls here
//
// so a foreign type constant falls through to `default`, tedious then calls
// `.validate` on an mssql type object that has no such method, and the request
// dies during parameter validation. Reproduced exactly, on 2026-09-09, by loading
// mssql twice through a purged require cache: same pool, same query, same value —
// `sqlA.DateTime` succeeds in 18ms and `sqlB.DateTime` fails in 2ms with
// "Validation failed for parameter 'start'".
//
// Only parts_cost was affected because it is the only Total ETO source that binds
// TYPED parameters. parts_cost_actual, totaleto_jobs and cash_flow_snapshot pass
// no parameters at all, so they shared the mismatched pool quite happily — which
// is precisely why this looked like one flaky feed rather than a shared fault.
//
// Two changes, and both are wanted:
//
//   * `mssql` and `tedious` are in serverExternalPackages now, so Node's own
//     module cache keeps ONE instance per process. That removes the duplication
//     itself (and ~3MB of bundle).
//   * a cached pool records WHICH module instance built it, and is never handed to
//     a different one. Bundling is not something this file can police, so it stops
//     depending on it: if a future build duplicates mssql again, each copy gets its
//     own pool and stays correct instead of failing 15ms into every query.
type PoolEntry = {
  /** The mssql module instance that created this pool — compared by identity. */
  owner: typeof sql;
  pool: Promise<sql.ConnectionPool>;
};
// Keyed on requestTimeout, then on the owning module instance. Normally one entry
// per key; more only if a build duplicates mssql again.
type PoolCache = Map<number, PoolEntry[]>;
const globalForPools = globalThis as typeof globalThis & { __sdcTotalEtoPoolsV2?: PoolCache };
// V2 deliberately: the previous key held `Map<number, Promise<pool>>`, and a dev
// hot-reload landing on the old shape would read a promise as an array.
const poolCache: PoolCache = (globalForPools.__sdcTotalEtoPoolsV2 ??= new Map());

function entriesFor(requestTimeout: number): PoolEntry[] {
  const list = poolCache.get(requestTimeout);
  if (list) return list;
  const fresh: PoolEntry[] = [];
  poolCache.set(requestTimeout, fresh);
  return fresh;
}

/**
 * The shared pool for this timeout AND this module instance, opening it on first use.
 *
 * A pool that has died (network drop, server restart) is discarded and rebuilt
 * rather than handed out — otherwise one transient outage would poison every later
 * query in the process.
 */
export async function totalEtoPool(requestTimeout: number = TOTALETO_TIMEOUT.sync): Promise<sql.ConnectionPool> {
  const entries = entriesFor(requestTimeout);
  const existing = entries.find((e) => e.owner === sql);
  if (existing) {
    try {
      const pool = await existing.pool;
      if (pool.connected) return pool;
    } catch {
      // Fall through and rebuild. The rejection is already reported to whoever
      // awaited it first; a later caller should get a fresh attempt, not a replay.
    }
    dropEntry(entries, existing);
  }

  const entry: PoolEntry = { owner: sql, pool: new sql.ConnectionPool(totalEtoConfig(requestTimeout)).connect() };
  entries.push(entry);
  // A failed open must not stay cached, or the process never retries. Guarded on
  // identity so a rebuild that has already replaced this entry is not evicted.
  entry.pool.catch(() => dropEntry(entries, entry));
  return entry.pool;
}

function dropEntry(entries: PoolEntry[], entry: PoolEntry): void {
  const at = entries.indexOf(entry);
  if (at >= 0) entries.splice(at, 1);
}

/**
 * Throws away the cached pool for this timeout so the next call builds a new one.
 *
 * Called after a connection-level failure: mssql reports `pool.connected` from the
 * last thing it observed, so a pool whose server has restarted underneath it can
 * still claim to be connected and hand out dead connections indefinitely. One
 * outage must not outlive itself.
 *
 * The old pool is closed in the background rather than awaited — the caller is
 * mid-failure and has better things to wait for, and a close that itself fails on a
 * broken socket is exactly the case where this is being called.
 */
export function dropTotalEtoPool(requestTimeout: number = TOTALETO_TIMEOUT.sync): void {
  const entries = poolCache.get(requestTimeout);
  if (!entries) return;
  const mine = entries.find((e) => e.owner === sql);
  if (!mine) return;
  dropEntry(entries, mine);
  void mine.pool.then(
    (p) => p.close().catch(() => {}),
    () => {},
  );
}

/** Closes every cached pool. For a test teardown or a deliberate shutdown, not for a request. */
export async function closeTotalEtoPools(): Promise<void> {
  const all = [...poolCache.values()].flat();
  poolCache.clear();
  await Promise.allSettled(all.map(async (e) => (await e.pool).close()));
}

// ── Bounded retries, transient failures only (2026-09-09) ───────────────────
//
// lib/sync-schedule.ts has said "there is no retry policy — the interval IS the
// retry" since the hourly schedule was written, and for the hourly pass that is
// still a fair trade. It is not a fair trade for a person clicking Refresh Data:
// their pass is the only one they are going to watch, and a single dropped packet
// spends it.
//
// Three attempts, 0.5s then 2s apart. Small enough that a manual refresh which
// hits one blip still finishes inside the button's own 300s ceiling and the step
// timeout above it (45s in auto-sync.ts — three attempts of a 30s query would
// exceed that, which is correct: the step timeout is the outer bound and it fails
// the step honestly rather than letting a lane run long).
//
// Retried only for the kinds in TRANSIENT. A rejected login, a schema error or a
// parameter-binding fault is retried zero times — the answer will not change, and
// three identical failures in the log make one cause look like three.
//
// Safe to retry at all only because EVERY Total ETO call in this app is a SELECT:
// nothing here writes upstream, so a repeated attempt cannot double anything.
// Checked across all of sync-totaleto.ts, cash-flow-totaleto.ts,
// cash-flow-drill.ts, job-bom.ts and po-across-jobs.ts on 2026-09-09.
const RETRY = { attempts: 3, delaysMs: [500, 2_000] } as const;

export type TotalEtoRunOptions = {
  /**
   * Which query this is, for the diagnostic log — e.g. "parts_cost.booked_by_job".
   * Worth passing: it is what turns "Total ETO failed" into "that one statement is
   * timing out and the other eleven are fine".
   */
  feed?: string;
  requestTimeout?: number;
  /** Override the retry budget. 1 disables retrying (used by the preflight below). */
  attempts?: number;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `work` against the shared pool, with diagnostics and bounded retries.
 *
 * Deliberately does NOT close anything — see the header. `work` may safely run
 * concurrently with any other caller.
 *
 * The second argument accepts a bare number for the timeout, which is what every
 * call site passed before options existed.
 */
export async function withTotalEto<T>(
  work: (pool: sql.ConnectionPool) => Promise<T>,
  options: number | TotalEtoRunOptions = {},
): Promise<T> {
  const opts: TotalEtoRunOptions = typeof options === "number" ? { requestTimeout: options } : options;
  const requestTimeout = opts.requestTimeout ?? TOTALETO_TIMEOUT.sync;
  const feed = opts.feed ?? "unlabelled";
  const attemptsAllowed = Math.max(1, opts.attempts ?? RETRY.attempts);

  let lastError: unknown;
  for (let attempt = 1; attempt <= attemptsAllowed; attempt++) {
    const startedAt = Date.now();
    let authenticated = false;
    let queryStarted = false;

    try {
      const pool = await totalEtoPool(requestTimeout);
      // Opening the pool IS the authentication: tedious resolves, connects and
      // logs in before `connect()` settles. Past this line the credentials and
      // the network are known good for this attempt.
      authenticated = true;
      queryStarted = true;
      const value = await work(pool);
      recordTotalEtoAttempt({
        at: new Date(startedAt).toISOString(),
        feed,
        stage: "transform",
        attempt,
        attemptsAllowed,
        ms: Date.now() - startedAt,
        ok: true,
        authenticated: true,
        connectionOpened: true,
        queryStarted: true,
        queryCompleted: true,
        usedCachedData: false,
        kind: null,
        code: null,
        sqlNumber: null,
        sqlState: null,
        detail: null,
        server: SERVER,
        database: DATABASE,
        willRetry: false,
      });
      return value;
    } catch (error) {
      lastError = error;
      const kind = classifyTotalEto(error, { authenticated });
      const willRetry = attempt < attemptsAllowed && isTransientTotalEto(kind);
      const e = error as { code?: unknown; number?: unknown; state?: unknown } | null;

      recordTotalEtoAttempt({
        at: new Date(startedAt).toISOString(),
        feed,
        // Which stage this was in. `query` vs `transform` is INFERRED — `work`
        // owns both the statement and the mapping over its rows, so the only
        // evidence available is whether the driver raised the error or our own
        // code did, which is what classifyTotalEto keys "transformation" off.
        stage: totalEtoFailureStage(kind, authenticated),
        attempt,
        attemptsAllowed,
        ms: Date.now() - startedAt,
        ok: false,
        authenticated,
        connectionOpened: authenticated,
        queryStarted,
        queryCompleted: kind === "transformation",
        // The CALLER decides whether to fall back to the last good snapshot; this
        // layer only knows it did not produce a new one.
        usedCachedData: false,
        kind,
        code: e?.code == null ? null : String(e.code),
        sqlNumber: typeof e?.number === "number" ? e.number : null,
        sqlState: e?.state == null ? null : String(e.state),
        detail: describeTotalEtoFailure(error, { authenticated }),
        server: SERVER,
        database: DATABASE,
        willRetry,
      });

      // A pool whose connection broke must not be handed to the next attempt —
      // or to the next request an hour from now.
      if (POISONS_POOL.has(kind)) dropTotalEtoPool(requestTimeout);

      if (!willRetry) throw error;
      await sleep(RETRY.delaysMs[Math.min(attempt - 1, RETRY.delaysMs.length - 1)]);
    }
  }

  // Unreachable: the loop either returns or throws. Kept so the types do not need
  // a non-null assertion and so a future edit to the loop cannot fall out silently.
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Which stage a failure of this kind happened in — the field that answers "how far
 * did we get?" without the caller having to have been watching.
 *
 * `authenticated` refines only the ambiguous cases; every kind that names its own
 * stage ignores it, which is what lets a caller that never held the connection (a
 * refresh step recording that it fell back to the last good snapshot) get the same
 * answer as withTotalEto does.
 */
export function totalEtoFailureStage(kind: TotalEtoFailure, authenticated?: boolean): TotalEtoStage {
  if (kind === "app_write") return "commit";
  if (kind === "transformation") return "transform";
  if (kind === "pool_exhausted") return "connect";
  if (kind === "login_rejected" || kind === "dns" || kind === "network" || kind === "server_unavailable" || kind === "connect_timeout") {
    return "authenticate";
  }
  if (authenticated === false) return "authenticate";
  return "query";
}

/**
 * Can we log in at all? One cheap round trip, for a refresh pass to ask BEFORE it
 * runs four sources that will each fail the same way.
 *
 * Returns rather than throws: the caller wants to branch on this, not handle an
 * exception.
 *
 * ── Also the pool's pre-use validation ──────────────────────────────────────
 * `pool.connected` is mssql's opinion, formed from the last thing it observed, so
 * it can be stale. This `SELECT 1` is the only thing that actually proves a pooled
 * connection still works, and running it once at the top of the Total ETO lane is
 * what makes the four sources behind it trustworthy. A dead pool fails here, gets
 * dropped, and the sources rebuild it.
 *
 * ONE attempt, no retries: the lane's sources each retry on their own, and a
 * preflight that spent 2.5s retrying would delay every source behind it to learn
 * something the first source would have learned anyway.
 */
export async function checkTotalEtoLogin(): Promise<{ ok: true } | { ok: false; kind: TotalEtoFailure; detail: string }> {
  try {
    await withTotalEto(async (pool) => pool.request().query("SELECT 1 AS ok"), {
      feed: "preflight.select_1",
      attempts: 1,
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, kind: classifyTotalEto(error), detail: describeTotalEtoFailure(error) };
  }
}
