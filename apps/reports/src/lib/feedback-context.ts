// ── What the user was looking at when they hit Flag ─────────────────────────
//
// This is the whole reason feedback lives inside Reports instead of in an app
// of its own. "Left to Invoice is wrong" is unactionable; "Left to Invoice on
// job 1131, Monthly ETC, August 2026, shows 41,200 and should be 0" is a
// ten-minute fix. The difference is entirely this file.
//
// Dependency-free (no React, no Prisma) like permissions.ts and split-view.ts,
// so tests/feedback-context.test.ts can prove the rules below under
// `tsx --test` rather than leaving them observable only by clicking.
//
// ══ THE TRAP, and why the caller must hand us the PANE's url ════════════════
//
// Do NOT call this with usePathname()/useSearchParams(). Read the caller-side
// note in FeedbackButton.tsx too, because this is the one defect this feature
// is most likely to ship with, and it is invisible in development:
//
//   plain page   /etc?month=2026-08            -> path "/etc",   params {month}
//   workspace    /w?t=t1~/etc&t1.month=2026-08 -> path "/w",     params {t: "...", "t1.month": "..."}
//   split view   /split?l=/etc&l.month=2026-08 -> path "/split", params {l: "...", "l.month": "..."}
//
// Only the first is what anyone meant. A naive implementation captures
// routePath "/w" and a param bag full of namespaced keys for every person who
// uses tabs — and it looks perfect when you test it on a single-pane page,
// which is how it reaches production.
//
// The app already solved this for every other in-pane control: usePaneUrl()
// (components/PaneUrlProvider.tsx) returns the PANE's own path and its
// de-namespaced params, and degrades to plain-page behaviour when there is no
// provider. That hook is the contract for this function's input. This module
// deliberately does no URL decoding of its own — a second copy of that
// decoding is precisely the drift split-view.ts's own header warns about.

/** Exactly what usePaneUrl() yields, narrowed to what context capture needs. */
export type PaneLocation = {
  /** The page's own route — "/etc" even when the document is at "/w". */
  path: string;
  /** The page's own params, already de-namespaced. */
  params: Record<string, string>;
};

export type FeedbackContext = {
  routePath: string;
  /** The same word the tab bar uses for this route, or null for an unregistered one. */
  viewLabel: string | null;
  params: Record<string, string>;
  /** A link that puts a triager exactly where the submitter was standing. */
  contextUrl: string;
  /** Denormalized so the triage grid can filter and the DB can index — see the schema note. */
  jobId: string | null;
  periodMonth: string | null;
  employeeKey: string | null;
};

// ── Which param means "job", "month", "employee" ────────────────────────────
//
// Transcribed from SPLIT_ROUTES in split-view.ts, which is itself asserted
// against the real `searchParams:` types by tests/split-view.test.ts. NOT
// guessed — that file's header records that the first draft of its own table
// got six of twelve param names wrong that way, and every one of those bugs
// presented as "my filters vanished".
//
// The pages genuinely disagree about spelling, and that disagreement is
// history rather than something to fix here:
//
//   job      /job-hours takes both `jobs` (multi-select) and `job` (deep link);
//            /hours and /tm take `jobs`. /quoted has NO job param — it filters
//            by customer/type/status — so flagging a Projects row captures the
//            filters, and the record is typed in. That is the gap the phase-2
//            per-cell flag closes.
//   month    /etc takes `month`, the dashboard takes `m`, /cash-flow takes `as`,
//            /job-cost-explorer takes `asOf`. All four are listed; the format
//            guard below is what keeps `asOf` from landing in periodMonth when
//            it carries a full date rather than a month.
//   employee /hours takes `employees` (multi-select); the dashboard's Data
//            Quality tab takes `dqEmp`. There is no singular `employee`
//            anywhere, which is why one is not listed.
//
// Order matters: the first key present wins, so the more specific single-record
// param is listed before the multi-select one.
const JOB_KEYS = ["job", "jobs"] as const;
const MONTH_KEYS = ["month", "m", "as", "asOf"] as const;
const EMPLOYEE_KEYS = ["dqEmp", "employees"] as const;

/** First non-empty value among `keys`, or null. */
function firstOf(params: Record<string, string>, keys: readonly string[]): string | null {
  for (const k of keys) {
    const v = params[k];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return null;
}

// A multi-select param carries "1131,1105" and a single deep link carries
// "1131". One value is a subject; several are a filter, not a record anyone
// can file a complaint against — so only a single value is promoted to the
// indexed `jobId`/`employeeKey` columns. The full list is still preserved
// verbatim in `params`, so nothing is lost either way.
function singleValue(raw: string | null): string | null {
  if (!raw) return null;
  return raw.includes(",") ? null : raw;
}

// "2026-08" — the shape MonthlyReportSubmission.month, CashFlowSnapshotLine
// .forecastMonth and the ETC grid all already use. Anything else (a full date,
// a quarter, a garbled param) is left null rather than coerced into a column
// the queue filters on.
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function normalizeMonth(raw: string | null): string | null {
  if (!raw) return null;
  return MONTH_RE.test(raw) ? raw : null;
}

/**
 * Build the href that returns a triager to the submitter's exact view.
 *
 * Deliberately the PLAIN single-pane form ("/etc?month=2026-08"), never the
 * /w or /split URL the submitter happened to be in. Two reasons: a workspace
 * URL encodes that person's other seven tabs, which is both noise and a small
 * privacy leak into a record other people read; and a plain route href is what
 * the split-view machinery can re-namespace, which is what lets a triager open
 * this in the right-hand pane next to the feedback queue.
 */
export function buildContextUrl(path: string, params: Record<string, string>): string {
  const qs = new URLSearchParams();
  // Sorted, so the same view always produces the same string — two people
  // flagging the same screen should produce comparable rows, and an unsorted
  // bag would make that depend on object key order.
  for (const key of Object.keys(params).sort()) {
    const value = params[key];
    if (typeof value === "string" && value !== "") qs.set(key, value);
  }
  const query = qs.toString();
  return query ? `${path}?${query}` : path;
}

/**
 * The one context builder. `labelFor` is injected rather than imported so this
 * module stays free of split-view.ts (which pulls in the whole route table);
 * callers pass `(p) => splitRoute(p)?.label ?? null`.
 */
export function buildFeedbackContext(
  location: PaneLocation,
  labelFor: (path: string) => string | null = () => null,
): FeedbackContext {
  const routePath = location.path || "/";
  // Drop empty values here so `params` on the record means "filters that were
  // actually set". A bag full of `dept: ""` would make two identical views
  // look different in the queue.
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(location.params ?? {})) {
    if (typeof v === "string" && v.trim() !== "") params[k] = v;
  }

  return {
    routePath,
    viewLabel: labelFor(routePath),
    params,
    contextUrl: buildContextUrl(routePath, params),
    jobId: singleValue(firstOf(params, JOB_KEYS)),
    periodMonth: normalizeMonth(firstOf(params, MONTH_KEYS)),
    employeeKey: singleValue(firstOf(params, EMPLOYEE_KEYS)),
  };
}

/**
 * A one-line human rendering of the captured filters, for the drawer's
 * read-only context chips and the grid's tooltip: `month=2026-08 · dept=ENG`.
 * Empty string when nothing was set, so callers can fall back to the view name
 * alone rather than printing a stray separator.
 */
export function describeContext(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join(" · ");
}
