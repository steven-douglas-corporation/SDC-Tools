import "server-only";
import { randomUUID } from "crypto";

// ── What a drill-through says when its upstream is down (2026-09-01) ────────
//
// Reported as a bug on the Monthly ETC page: expanding a job under "Parts spent"
// printed
//
//   "An error occurred in the Server Components render. The specific message is
//    omitted in production builds to avoid leaking sensitive details. A digest
//    property is included on this error instance..."
//
// straight into the table. That paragraph is Next.js's production redaction, and
// it is what the CLIENT receives whenever an unhandled error escapes a Server
// Action. The client half was already correct — it caught the rejection and
// rendered `error.message` in its own error line — so the app degraded exactly as
// designed and then displayed a sentence about React internals.
//
// The real error was `ConnectionError: Login failed. The login is from an
// untrusted domain and cannot be used with Integrated authentication` (ELOGIN):
// the Total ETO SQL Server credentials had stopped working. Nothing about that is
// a rendering problem, and nothing about that paragraph tells anybody so.
//
// So an action that reaches an external system catches its own failures, logs the
// real one server-side with enough context to debug it, and throws something a
// person can act on. tm-drill-actions.ts already did this (`withDrillLogging`);
// this is that helper extracted so the ETC drills use the same implementation
// rather than a second copy that drifts.
//
// ── Why the message names the system ────────────────────────────────────────
//
// "Couldn't load this detail" is honest but leaves a manager unable to tell a
// transient blip from a broken integration — and this failure lasted hours and
// affected four sync sources at once. Naming Total ETO, and saying the figures
// already on the page are unaffected, is the difference between "the app is
// broken" and "one integration is down". It leaks nothing: that the app reads
// Total ETO is visible in the UI copy on several pages already.

/** Upstream systems a drill can be waiting on, for the message it produces. */
export type DrillUpstream = "totaleto" | "powerbi" | "local";

const UPSTREAM_LABEL: Record<DrillUpstream, string> = {
  totaleto: "Total ETO",
  powerbi: "Power BI",
  local: "the application database",
};

/**
 * True for the failure shapes that mean "the upstream did not answer or refused
 * us", as opposed to a bug in our own query. Kept deliberately narrow — anything
 * unrecognised gets the generic message, because guessing "it's just the network"
 * about a real defect is how a defect stays hidden.
 */
function isUpstreamUnreachable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string") {
    // mssql/tedious: ELOGIN is a rejected login (bad or expired credentials),
    // ETIMEOUT/ESOCKET/ECONNREFUSED/ECONNRESET are the connection never landing.
    if (["ELOGIN", "ETIMEOUT", "ESOCKET", "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EHOSTUNREACH"].includes(code)) {
      return true;
    }
  }
  return /ConnectionError|Login failed|ETIMEOUT|ECONNREFUSED|getaddrinfo|socket hang up/i.test(error.message);
}

/**
 * Runs a drill query, and on failure logs the real error and throws a short one.
 *
 * The thrown message is what the user sees, so it carries a request id: a report
 * of "detail ref abc123 failed" points straight at one log line, which is the
 * only way to debug an intermittent failure without shipping stack traces to the
 * browser.
 */
export async function withDrillErrors<T>(params: {
  /** Which drill, for the log line. */
  metric: string;
  /** What it was asked for — job, month, date range. Logged, never shown. */
  context: Record<string, unknown>;
  upstream: DrillUpstream;
  run: () => Promise<T>;
}): Promise<T> {
  const requestId = randomUUID();
  const startedAt = Date.now();
  try {
    return await params.run();
  } catch (error) {
    // The FULL error, server-side only. A raw mssql/DAX error can be startlingly
    // detailed about a schema or a connection string, which is exactly why Next
    // redacts it — but a log file is not a browser.
    console.error("[drill] query failed", {
      requestId,
      metric: params.metric,
      upstream: params.upstream,
      ...params.context,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? { name: error.name, message: error.message, code: (error as { code?: unknown }).code, stack: error.stack } : String(error),
    });
    const label = UPSTREAM_LABEL[params.upstream];
    throw new Error(
      isUpstreamUnreachable(error)
        ? `${label} is not responding, so this detail can't be loaded right now. The figures already on the page are unaffected. (ref ${requestId})`
        : `Couldn't load this detail. (ref ${requestId})`,
    );
  }
}
