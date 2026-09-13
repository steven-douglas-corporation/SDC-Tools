// ── WHAT the refresh pass covers, and how often ─────────────────────────────
//
// Split out of lib/auto-sync.ts on 2026-09-02, unchanged. That file is
// `import "server-only"` — it holds the runner, which opens database connections
// and reads Lisa's workbook — but this list is not server-only knowledge: the
// Dashboard's data-source health panel is a client component and has to render
// one row per scheduled source. Importing auto-sync there is impossible, and
// copying the list there would recreate precisely the drift the list exists to
// prevent (a source refreshed without being shown, or shown without being
// refreshed). So the DECLARATION lives here, with no runtime dependencies at
// all, and both sides import it.
//
// auto-sync.ts re-exports all three names, so every existing importer is
// unaffected and its own rules still read as written.

// EVERY HOUR (§25.4, 2026-08-04 — was every 6 hours). The pass measures in seconds
// against sources that publish continuously, so six hours of spacing was six hours of
// avoidable staleness; an hour keeps the figures close to live without turning the
// upstream systems into a polling target. There is still no retry policy — the interval
// IS the retry, which is now four times more forgiving of a single failed pass.
export const SYNC_INTERVAL_MS = 1 * 60 * 60 * 1000;

// Every source this pass refreshes, in the order it runs them. Declared once and
// read by BOTH the runner below and the dashboard's Data Sync card, so a source
// can never be refreshed without being listed, or listed without being
// refreshed — which is how the TotalETO mirror came to be button-only while
// appearing beside feeds that were on a schedule.
//
// `monthScoped` marks the steps that only touch the latest open ETC month, since
// "last refreshed" means something different for those: they are deliberately
// idle while the month is locked.
export const SYNC_SOURCES = [
  // "Paylocity workbook" again since 2026-08-05 (§42): hours are read from Lisa's
  // OneDrive file rather than from the Power BI model, because the model runs days
  // behind it. Naming the road matters when somebody is deciding where to go and look
  // at why a figure is stale — and the answer is now "the file", not "the model".
  { source: "hours_actual", label: "Actual hours (Paylocity workbook)", monthScoped: false },
  // Its own stage rather than a silent part of the one above, so a manager watching a
  // refresh sees "Calculating Undefined Hours…" (§42.15) — and so the totals and the
  // punch rows behind them are written together (§42.10-42.12).
  { source: "undefined_hours", label: "Undefined hours", monthScoped: false },
  // Re-applies the seeding rule to the open month's HOURS rows, the same way
  // parts_cost below re-applies it to the money row. Added 2026-09-01: without it
  // the hours half of a month was frozen at the instant the month was started,
  // while the parts half re-derived hourly — so a job quoted (or created) after
  // that instant had no ETC row for its quoted departments at all, and August
  // 2026 showed three jobs at Prior ETC 0 beside a correct six-figure Parts
  // Cost. See reseedOpenMonth in lib/etc-actions.ts.
  //
  // Runs BEFORE etc_hours_worked deliberately: seeding creates the quoted rows at
  // the right opening figure, so the hours step then only has to fill them in
  // rather than invent them.
  { source: "etc_prior_etc", label: "ETC Prior ETC (quotes and carry-forward)", monthScoped: true },
  { source: "etc_hours_worked", label: "ETC hours worked", monthScoped: true },
  { source: "parts_cost", label: "Parts cost (TotalETO)", monthScoped: true },
  // The Projects grid's Parts Cost Actual column. Not month-scoped: it is a
  // cumulative running total per job, and it covers Complete jobs too — those are
  // the ones whose parts spend is finished.
  { source: "parts_cost_actual", label: "Parts cost actual (TotalETO)", monthScoped: false },
  // Lisa's monthly inventory workbook (Job Cost Explorer's %Complete/Sales $
  // snapshots) — see lib/job-cost-inventory-sync.ts. Not month-scoped: it
  // covers every month-end sheet the workbook has, not just the latest one,
  // and upserts are keyed per month so an older snapshot is never touched by
  // a newer file arriving.
  { source: "job_cost_inventory", label: "Job Cost inventory (monthly file)", monthScoped: false },
  { source: "standard_pools", label: "Standard Fees pools", monthScoped: true },
  // Same wording as the dashboard's long-standing "Jobs from TotalETO" button,
  // which triggers this exact sync. Two names for one feed is precisely the
  // confusion this list exists to prevent.
  { source: "totaleto_jobs", label: "Jobs from TotalETO", monthScoped: false },
  // Cash Flow Forecast's immutable history (2026-08-19) — the one place a new
  // snapshot gets captured, so "every refresh preserves a version" holds for
  // BOTH the hourly schedule and a manual Refresh Data click, with no second
  // pipeline. Not month-scoped: it always captures the live Total ETO
  // forecast regardless of the ETC month's lock state — a locked ETC month
  // has nothing to do with whether AR/AP/PO due dates moved today.
  { source: "cash_flow_snapshot", label: "Cash Flow Forecast (TotalETO)", monthScoped: false },
] as const;

/**
 * The sources that talk to Total ETO. They share one connection
 * (lib/totaleto-connection.ts), so they share one failure mode — which is why the
 * lane checks the login once and why their errors are described from one place.
 */
export const TOTALETO_SOURCES = new Set(["parts_cost", "parts_cost_actual", "totaleto_jobs", "cash_flow_snapshot"]);
