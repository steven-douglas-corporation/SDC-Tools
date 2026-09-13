import "server-only";

// THE app's refresh schedule. Every value that needs periodic refreshing comes
// through here, on one interval, in one pass — so "how current is this number?"
// has a single answer instead of one per feed.
//
// Before this, the loop in instrumentation.ts refreshed hours and parts while the
// TotalETO job mirror and the Scheduler roster only moved when someone happened
// to press their button, which meant two ages of data on one screen and no way to
// tell which was which.
//
// ── Three rules this file exists to enforce ─────────────────────────────────
//
// 1. ONE MONTH PER PASS. The month-scoped steps are all given the same month,
//    resolved once at the top. Resolving it per step let a month roll over or get
//    locked mid-pass, leaving hours from one month beside parts from another.
//
// 2. FAILURES ARE ISOLATED. Each step gets its own try/catch. The old loop wrapped
//    hours-worked and parts in ONE try, so a hours failure silently skipped the
//    parts sync that had nothing to do with it — and parts then aged behind a
//    header reporting the hours failure only.
//
// 3. EVERY STEP STAMPS ITS OWN FRESHNESS ROW, success or failure. A step that
//    can't say when it last worked is a step whose staleness is invisible, which
//    is exactly how ~280 hours went missing for a week (DEVLOG §12).
//
// ── What is deliberately NOT on the schedule ───────────────────────────────
//
// • The ETC history and category-pool backfills. They write HISTORICAL months,
//   and unattended writes to frozen history are the one failure this app has
//   already suffered and repaired once (DEVLOG §10: a reopen plus a sync
//   corrupted archived months). They stay manual, behind a deliberate click.
// • syncQuotedFromPowerBi. Quoted hours are app-owned now — entered on the
//   Projects tab — so a periodic pull would fight the managers editing them.
// • Any locked month. A submitted month is frozen by definition; see
//   isMonthLocked. Doing nothing there is correct, and this file does NOT stamp
//   freshness for a step it skipped for that reason: claiming currency because a
//   month is frozen would be a lie by omission.

// ── The schedule itself lives in lib/sync-schedule.ts ───────────────────────
//
// SYNC_INTERVAL_MS, SYNC_SOURCES and TOTALETO_SOURCES were moved there on
// 2026-09-02 and are re-exported here so every existing importer (and the rules
// above, which describe them) keeps working. The move has one reason: this file
// is `import "server-only"` — it opens database connections and parses Lisa's
// workbook — and the Dashboard's source-health panel is a CLIENT component that
// needs the same list. Duplicating the list in the client would reintroduce
// exactly the drift the list exists to prevent: a source refreshed without being
// shown, or shown without being refreshed.
export { SYNC_INTERVAL_MS, SYNC_SOURCES, TOTALETO_SOURCES } from "@/lib/sync-schedule";
import { SYNC_SOURCES, TOTALETO_SOURCES } from "@/lib/sync-schedule";

function labelFor(source: string): string {
  return SYNC_SOURCES.find((s) => s.source === source)?.label ?? source;
}

export type SyncTrigger = "startup" | "interval" | "manual";

export type SyncStepResult = {
  // Matches the PowerBiFreshness.source row this step owns.
  source: string;
  label: string;
  status: "ok" | "failed" | "skipped";
  detail: string;
  // Wall-clock ms this step's own `run()` took. Added 2026-08-25: the pass has
  // logged only its TOTAL since it was written (~17s, every hour, all day), which
  // is enough to know the pass is slow and useless for knowing WHICH part is —
  // and the sources differ by orders of magnitude (one Excel parse vs four
  // separate Total ETO round-trips). Optimizing without this is guesswork.
  //
  // Measured, not derived from the progress callback: onProgress fires BEFORE
  // each step, so differencing its timestamps would attribute every step's cost
  // to the one after it.
  ms: number;
  // ── What KIND of failure, and whether waiting fixes it (2026-09-09) ────────
  //
  // Set for a failed Total ETO source only. Carried so the toast can stop saying
  // "the hourly schedule will retry the rest" about failures no schedule can fix:
  // a rejected login needs a password, a parameter-binding fault needs a deploy,
  // and telling a manager to wait an hour for either is how a five-day outage got
  // read as a flaky feed. See lib/totaleto-connection.ts for the taxonomy.
  //
  // Optional, and every reader treats it as such: these land in RefreshRun.steps
  // as JSON, so every row written before today has neither.
  kind?: string;
  retryable?: boolean;
};

export type SyncRunResult = {
  trigger: SyncTrigger;
  startedAt: Date;
  ms: number;
  month: string | null;
  steps: SyncStepResult[];
};

// Reports the stage now STARTING, plus every step finished so far. Called before each
// source and once at the end. Optional, and never allowed to fail a refresh — the
// hourly schedule passes nothing and behaves exactly as it did.
export type SyncProgress = (stage: string | null, done: SyncStepResult[]) => void | Promise<void>;

// ── One slow source may not hold the whole refresh (§10) ─────────────────────
//
// Every step already has its own try/catch, so a source that FAILS is isolated. A
// source that never answers was not: an upstream socket that accepts the connection
// and then goes quiet has no failure to catch, so the step waited on it forever, the
// lane behind it never ran, and the button sat on "Refreshing…" with a stage name that
// was accurate and useless.
//
// This turns "no answer" into a failure, which rule 2 already knows how to handle: the
// step records it, stamps its freshness row, and the pass carries on and reports which
// source timed out — the outcome §10 asks for, where Paylocity/ETO/Employees complete
// and only the dead source is named.
//
// 45s is deliberately far above any measured step (the slowest observed is 2.6s) and
// chosen against the button's own 300s ceiling: the longer lane holds five steps, so
// even the pathological case where every one of them times out finishes inside the
// window the UI is willing to wait, rather than being killed by it and reported as a
// dead refresh.
//
// The abandoned work is NOT cancelled — a promise cannot be. It is only stopped from
// being waited on, and whatever it eventually does is harmless: the step has already
// been recorded as failed, and every write in this pass is an idempotent upsert or a
// replace-by-key, so a late completion cannot corrupt what the next pass writes.
const STEP_TIMEOUT_MS = 45_000;

function withTimeout<T>(label: string, run: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} did not respond within ${STEP_TIMEOUT_MS / 1000}s — abandoned so the rest of the refresh could finish`)),
      STEP_TIMEOUT_MS,
    );
    // Must not hold the process open on shutdown, the same reason the lock heartbeat
    // unrefs its timer.
    timer.unref?.();
    run().then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export async function runAllSyncs(
  trigger: SyncTrigger,
  onProgress?: SyncProgress,
  // Carried so the Paylocity import record can be tied back to the pass that ran it
  // and to the person who pressed the button (§42.20). Optional, because the hourly
  // schedule has neither and must behave exactly as it did.
  attribution?: { refreshId?: string | null; userName?: string | null },
): Promise<SyncRunResult> {
  // Imported lazily, inside the function: this module is loaded from
  // instrumentation.ts, which also runs under the Edge runtime, where the Node
  // built-ins these pull in (mssql, msal's native cache, fs) cannot load at all.
  const { syncActualHours, syncHoursWorked, syncPartsCost, recordSyncSuccess, recordSyncFailure, recordSyncNote } = await import("@/lib/sync-actuals");
  const { computeCategoryPoolsLocally } = await import("@/lib/standard-pool-local");
  const { poolRefreshBlockedBy } = await import("@/lib/standard-pool-eligibility");
  const { syncFromTotalEto, syncPartsCostActual } = await import("@/lib/sync-totaleto");
  const { newImportContext, beginPaylocityImport, recordUndefinedHours, completePaylocityImport } = await import("@/lib/paylocity-import");
  const { prisma } = await import("@/lib/prisma");
  const { isMonthLocked } = await import("@/lib/etc");
  // One connection definition for every Total ETO source — see the lane below.
  const { checkTotalEtoLogin, describeTotalEtoFailure, classifyTotalEto, isTransientTotalEto, totalEtoFailureStage, TOTALETO_SERVER, TOTALETO_DATABASE } =
    await import("@/lib/totaleto-connection");
  // Records that a failed source is now serving its last known-good snapshot.
  const { recordTotalEtoFallback } = await import("@/lib/totaleto-diagnostics");

  const startedAt = new Date();
  // ── Recorded by source, reported in declaration order (2026-08-25) ────────
  //
  // Was a plain array that each step pushed to. That was the same thing as
  // "completion order" only while the pass was strictly sequential; now that the two
  // lanes below run concurrently, push order is a race and the log would reorder
  // itself between passes for no reason.
  //
  // So completion is recorded against the source, and every reader — the progress
  // callback, the log, the returned result — gets SYNC_SOURCES order, which is the
  // order the dashboard's Data Sync card already lists them in.
  const done = new Map<string, SyncStepResult>();
  const steps = () => SYNC_SOURCES.map((s) => done.get(s.source)).filter((x): x is SyncStepResult => x != null);
  const refreshId = attribution?.refreshId ?? null;
  const userName = attribution?.userName ?? null;
  // Filled in by the hours steps, written to the import record at the end (§42.20).
  const importTotals = { rowsInserted: 0, rowsUpdated: 0, rowsRemoved: 0 };
  let undefinedResult = { kpiRows: 0, kpiHours: 0 };

  // Rule 1: the month every month-scoped step below will use. Null means either
  // there are no ETC months at all or the latest one is locked — both of which
  // mean those steps must do nothing rather than guess at another month.
  let month: string | null = null;
  try {
    const latest = await prisma.etcEntry.findFirst({ orderBy: { month: "desc" }, select: { month: true } });
    if (latest) {
      const entries = await prisma.etcEntry.findMany({ where: { month: latest.month }, select: { needsReview: true } });
      month = isMonthLocked(entries) ? null : latest.month;
    }
  } catch (err) {
    console.error("[auto-sync] could not resolve the target month:", err);
  }

  // Rule 2 + 3 in one place, so no step can forget either. `stamp` is what a
  // successful step does about its freshness row: hours steps pass false because
  // they record their own (source-derived) refreshedThrough — see
  // recordSyncSuccess.
  async function step(
    source: string,
    label: string,
    stamp: boolean,
    // A string means it ran; null means there was nothing to do; { skip } means
    // it COULD not run for a stated reason — which is recorded on the freshness
    // row so the reason reaches the screen instead of only the log.
    run: () => Promise<string | null | { skip: string }>,
  ): Promise<void> {
    // Announce the stage BEFORE the work (§30). Reporting it afterwards would show the
    // step that just finished while the pass sat in the next one's external call —
    // which is the state people read as "stuck".
    try {
      await onProgress?.(label, steps());
    } catch {
      /* progress reporting must never be able to fail a refresh */
    }
    // Timed around `run()` only — not around the recordSync* write or the
    // progress callback, so a step's number is the cost of its own work and
    // stays comparable between steps.
    const t0 = Date.now();
    const took = () => Date.now() - t0;
    try {
      const detail = await withTimeout(label, run);
      if (detail === null) {
        done.set(source, { source, label, status: "skipped", detail: "nothing to do", ms: took() });
        return;
      }
      if (typeof detail === "object") {
        const ms = took();
        await recordSyncNote(source, detail.skip);
        done.set(source, { source, label, status: "skipped", detail: detail.skip, ms });
        return;
      }
      const ms = took();
      if (stamp) await recordSyncSuccess(source, new Date());
      done.set(source, { source, label, status: "ok", detail, ms });
    } catch (err) {
      const ms = took();
      // A Total ETO failure is described rather than quoted: the driver's own
      // sentence ("The login is from an untrusted domain and cannot be used with
      // Integrated authentication") reads like an application fault to whoever
      // sees the toast, and says nothing about what to do. describeTotalEtoFailure
      // names the server, the account and whether retrying can possibly help.
      // Everything else keeps its own message unchanged.
      const isTotalEto = TOTALETO_SOURCES.has(source);
      const message = isTotalEto
        ? describeTotalEtoFailure(err)
        : err instanceof Error
          ? err.message
          : String(err);
      // The classification, kept beside the sentence so the toast and the health
      // panel can act on it rather than parse it.
      const kind = isTotalEto ? classifyTotalEto(err) : undefined;
      const retryable = kind ? isTransientTotalEto(kind) : undefined;
      // Timing a FAILED step matters as much as a successful one: a source that
      // fails after a 30s socket timeout and one that fails instantly on a bad
      // credential look identical in the log without this, and only the first
      // is why the pass felt slow.
      console.error(`[auto-sync] ${label} failed after ${ms}ms:`, err);
      // ── The line that says the app is now serving stale figures ─────────────
      //
      // Every step writes nothing until its whole fetch has succeeded (see
      // syncPartsCost, which reads the entire month from Total ETO before it
      // touches a row), so a failed source leaves the LAST GOOD snapshot in place.
      // That is the correct behaviour and it was completely silent: the same
      // numbers stayed on screen, correct as of some earlier hour, with nothing
      // recording that a newer attempt had failed and they were now old.
      if (kind) {
        recordTotalEtoFallback({
          feed: source,
          stage: totalEtoFailureStage(kind),
          kind,
          ms,
          detail: message,
          server: TOTALETO_SERVER,
          database: TOTALETO_DATABASE,
          retryable: retryable === true,
        });
      }
      await recordSyncFailure(err, source);
      done.set(source, { source, label, status: "failed", detail: message, ms, kind, retryable });
    }
  }

  // ONE read of the ~19,800-row source for the whole pass. Every hours step reads
  // the same data, and reading it costs ~1s, so doing it per step threw away most of
  // a second every pass for nothing.
  //
  // Memoised rather than fetched up front, deliberately: rule 2 says a step's
  // failure must not take another step down with it. If the read throws inside
  // the first step, `cached` stays null and the second step retries it and fails
  // with its own message, exactly as when each fetched independently.
  //
  // ── Reading Lisa's workbook rather than Power BI (2026-08-05, §42) ────────
  // readHoursFeed() is the single entry point that decides the source. It reads the
  // OneDrive workbook, because the Power BI model runs DAYS behind it — July was short
  // 150.53h and August was entirely absent when measured. See lib/hours-feed.ts for
  // why there is deliberately no silent fallback to Power BI on failure: it would
  // overwrite fresh figures with stale ones, which §42.19 forbids in as many words.
  const importCtx = newImportContext({ refreshId, trigger, userName });
  let cached: Awaited<ReturnType<typeof beginPaylocityImport>> | null = null;
  const hoursImport = async () => (cached ??= await beginPaylocityImport(importCtx));
  const hoursExport = async () => (await hoursImport()).feed;

  // ── Two lanes, run concurrently (§8) ─────────────────────────────────────
  //
  // These nine steps used to run one after another, and most of them had no reason
  // to. Measured on 2026-08-25 after the punch-write fix: the pass was 7,436ms, of
  // which the hours chain accounted for 3,631ms and the five steps that know nothing
  // about hours accounted for 3,750ms. Run in sequence that is the SUM; run
  // concurrently it is the MAX, which is most of four seconds back for no change in
  // what any step does.
  //
  // ── Why two lanes and not nine parallel steps ────────────────────────────
  //
  // Because the dependencies are real, and because the concurrency that helps is
  // concurrency across DIFFERENT SYSTEMS.
  //
  // Lane A is the hours chain. Its steps genuinely depend on each other: all four read
  // the ONE parse of the Paylocity workbooks (`hoursImport`, memoised below), and
  // running them together would mean several of them racing to be the first to
  // trigger that parse — so the memoisation that saved a second per pass would be
  // defeated by the parallelism meant to save time.
  //
  // Lane B is Total ETO and the job-cost workbook. Its steps stay sequential WITHIN
  // the lane on purpose: four of them talk to the same Total ETO SQL Server over one
  // mssql pool, and firing them at once is how a fast source becomes a contended one.
  // Nothing here is trying to make Total ETO answer four questions at a time.
  //
  // So exactly one new pair of things runs at once — local Excel + MySQL against
  // remote SQL Server — which is the pair with no shared resource to contend over.
  //
  // Rule 2 (failures are isolated) is unchanged and is what makes this safe: `step`
  // catches per step and records the failure, so neither lane can reject and neither
  // can take the other down. Promise.all over two never-rejecting lanes cannot
  // reject. Rule 1 is unchanged too — `month` was resolved once, above, before either
  // lane starts, so both lanes see the same month exactly as before.
  await Promise.all([
    (async () => {
      // Hours first: they're the figures the whole app is judged on, and the parts
      // and mirror steps below are independent of them.
      await step("hours_actual", labelFor("hours_actual"), false, async () => {
        const imported = await hoursImport();
        const r = await syncActualHours(imported.feed);
        importTotals.rowsInserted = r.detailRowsWritten;
        importTotals.rowsUpdated = r.rowsUpserted;
        return (
          `${imported.feed.provenance.note} ` +
          `${r.rowsUpserted} upserted, ${r.detailRowsWritten} punch rows in ` +
          // Which buckets were rewritten and which were already correct (2026-08-25).
          // Stated because it is the number that explains the pass's duration: a refresh
          // that rewrote 3 of 1,146 buckets is fast for a REASON, and a reader comparing
          // a 4s pass against the old 17s one needs to see that reason rather than
          // wonder what was skipped.
          `${r.detailBuckets - r.detailBucketsUnchanged}/${r.detailBuckets} job-months (${r.detailBucketsUnchanged} already current` +
          // Only mentioned when it happened. A repair means something outside this sync
          // had edited the punch table and the pass corrected it — silent would be wrong,
          // but so would a permanent "0 repaired" that trains the reader to ignore it.
          `${r.detailBucketsRepaired > 0 ? `, ${r.detailBucketsRepaired} REPAIRED after drifting` : ""}), ` +
          `${r.jobsNotFound} jobs not found, ` +
          `${r.rowsSkippedOverridden} overridden preserved` +
          // §42.16: a refresh that processed the same file again must not imply new data
          // arrived. Said here so it reaches the refresh record and the completion
          // message rather than only the log.
          (imported.changed ? "" : " — SAME FILE VERSION as the last import, no new data")
        );
      });

      // ── Undefined Hours, as its own stage (§42.10, §42.14 stage 10) ───────────
      //
      // Writes the per-month totals the KPI card reads AND the punch-level rows the
      // drill-through shows, from one pass over one import, in one transaction. That is
      // what makes `KPI = sum of drill rows` structural rather than coincidental — see
      // lib/unattributed-hours.ts for the defect this replaces.
      await step("undefined_hours", labelFor("undefined_hours"), true, async () => {
        const imported = await hoursImport();
        const wb = imported.feed.provenance.workbook;
        const r = await recordUndefinedHours(imported.feed.rejected, {
          importId: importCtx.importId,
          sourceFile: wb?.fileName ?? "power_bi",
        });
        undefinedResult = { kpiRows: r.kpiRows, kpiHours: r.kpiHours };
        return `${r.kpiHours.toFixed(2)}h across ${r.kpiRows} entries counted; ${r.storedRows} rejection rows stored with reasons`;
      });

      // STARTING a month stays manual (refresh-service.ts); this only ever
      // re-derives one that is already open, and returns null when there is
      // nothing open to re-derive.
      await step("etc_prior_etc", labelFor("etc_prior_etc"), true, async () => {
        if (!month) return null;
        const { reseedOpenMonth } = await import("@/lib/etc-seeding");
        const r = await reseedOpenMonth(month);
        if (!r) return null;
        return `${r.created} rows created, ${r.updated} Prior ETC re-derived for ${month}`;
      });

      await step("etc_hours_worked", labelFor("etc_hours_worked"), false, async () => {
        if (!month) return null; // no open month — see rule notes above
        const r = await syncHoursWorked(month, (await hoursExport()).rows);
        return (
          `${r.rowsUpdated} updated, ${r.rowsSkipped} skipped` +
          // Called out rather than folded into "updated": a zeroed row means the
          // source dropped hours it used to report, which is worth noticing.
          (r.rowsZeroed > 0 ? `, ${r.rowsZeroed} zeroed (no longer in the export)` : "")
        );
      });

      // The Standard Fees pool ledger — the four PM/Warranty/MFG blocks on the ETC
      // page. Computed from the app's own data (standard-pool-local.ts), not Power
      // BI.
      //
      // It used to call syncCategoryPoolsFromPowerBi, and for the month people are
      // actually working in that could never succeed: upstream publishes ETC
      // periods roughly two months behind, so this step found no period, correctly
      // wrote nothing, and said so — every six hours, indefinitely. The panel spent
      // the whole month showing the previous month's figures "as an estimate", and
      // because no row existed for the month, the manual pulled-hours cell had
      // nowhere to save to and was read-only.
      //
      // All three drivers now come from feeds already refreshed by this same pass:
      // the prior month's closing balance (local), quoted hours for jobs starting
      // this month, and punches from the Paylocity export. The quoted-hours
      // definition was verified exact against Power BI's own measure across 32
      // cells before being trusted — see standard-pool-local.ts.
      //
      // The manual decisions — Hours being pulled this month, and Rate — are
      // preserved for any row that already exists; only the drivers and the figures
      // derived from them are rewritten. A new month's row gets the sheet's own
      // documented defaults.
      await step("standard_pools", labelFor("standard_pools"), true, async () => {
        if (!month) return null;
        // Same rule the Refresh button applies, from one definition — a submitted
        // sheet is frozen, and an archived month's pools anchor every later month's
        // starting balance.
        const blocked = await poolRefreshBlockedBy(month);
        if (blocked) return null;
        // Reuses this pass's single parse of the export rather than re-reading a
        // ~12,600-row workbook.
        const r = await computeCategoryPoolsLocally(month, (await hoursExport()).poolHours);
        // Written either way — Hours Worked is simply 0 — but a month with no
        // punches yet is stated rather than reported as a clean success, the same
        // way the old Power-BI-had-no-period case was.
        if (r.noPunchData) {
          return { skip: `${r.poolsUpserted} pools computed for ${month}, but no punches in the pool sections yet — Hours Worked is 0.` };
        }
        return `${r.poolsUpserted} pools computed locally`;
      });
    })(),

    (async () => {
      // ── ONE login check for the whole Total ETO lane (2026-09-01) ─────────
      //
      // All four sources in this lane — Parts cost, Parts cost actual, Jobs from
      // TotalETO, Cash Flow snapshot — open the SAME connection with the SAME
      // credentials (lib/totaleto-connection.ts). So when the credentials stop
      // working they do not fail independently; they fail identically, four
      // times, and the pass reports "4 sources failed" as though four things
      // were wrong.
      //
      // That is exactly what happened on 2026-09-01: the 14:02 pass had all four
      // green, the 14:21 pass had all four failing with ELOGIN, and each one had
      // separately reached the server, been refused, and quoted mssql's sentence
      // about "Integrated authentication" into the toast.
      //
      // Asking once, up front, changes three things:
      //   * the reason is diagnosed ONCE, and every source reports the same
      //     actionable sentence rather than a raw driver message
      //   * a rejected login is named as a rejected login — retrying cannot fix
      //     it, and saying "the hourly schedule will retry the rest" about it was
      //     misleading
      //   * on the failure path the four queries are not attempted at all
      //
      // Only a REJECTED LOGIN short-circuits. `unreachable` and `timeout` are
      // genuinely transient and each source still gets its own attempt — a blip
      // during the preflight must not cost a pass that would have succeeded.
      const login = await checkTotalEtoLogin();
      const blocked = login.ok === false && login.kind === "login_rejected" ? login.detail : null;
      if (blocked) console.error(`[auto-sync] Total ETO lane blocked: ${blocked}`);

      await step("parts_cost", labelFor("parts_cost"), true, async () => {
        if (blocked) throw new Error(blocked);
        if (!month) return null;
        const r = await syncPartsCost(month);
        return `${r.rowsUpserted} upserted`;
      });

      // Parts Cost Actual on the Projects grid — cumulative invoiced parts spend per
      // job, from the same TotalETO query the ETC month's "Money Spent" uses, so the
      // column and that row can't tell different stories. Manager-entered until
      // 2026-08-03; now pulled, per the policy that Jessica enters the QUOTED figures
      // and the app pulls the actuals.
      await step("parts_cost_actual", labelFor("parts_cost_actual"), true, async () => {
        if (blocked) throw new Error(blocked);
        const r = await syncPartsCostActual();
        return `${r.jobsUpdated} jobs updated, ${r.jobsNotFound} TotalETO ids with no app job`;
      });

      // Job Cost Explorer's monthly inventory snapshots (%Complete/Sales $) — reads
      // Lisa's workbook directly, same lazy-import reason as the rest of this file
      // (fs is a Node built-in the Edge-runtime instrumentation.ts import can't load).
      await step("job_cost_inventory", labelFor("job_cost_inventory"), true, async () => {
        const { syncJobCostInventorySnapshots } = await import("@/lib/job-cost-inventory-sync");
        return await syncJobCostInventorySnapshots();
      });

      // The TotalETO job mirror (customer, estimate/actual hour totals). Was
      // button-only, which is why a job's mirrored figures could sit weeks behind the
      // hours shown beside them. Manual Customer edits survive it —
      // customerManuallyEdited — so running it unattended can't overwrite a
      // manager's correction.
      await step("totaleto_jobs", labelFor("totaleto_jobs"), true, async () => {
        if (blocked) throw new Error(blocked);
        const r = await syncFromTotalEto();
        return `${r.jobsUpdated} jobs updated, ${r.skippedNoType} skipped (not app-tracked)`;
      });

      // Cash Flow Forecast snapshot — see cash-flow-capture.ts's own header for
      // the full extraction->normalize->dedup->store chain. `userName` (a manual
      // click's display name) or "system@auto-sync" (the scheduled tick) is
      // recorded as the snapshot's createdBy, matching logAudit()'s own
      // "system@auto-sync" convention for unattended runs.
      await step("cash_flow_snapshot", labelFor("cash_flow_snapshot"), true, async () => {
        if (blocked) throw new Error(blocked);
        const { captureCashFlowSnapshot } = await import("@/lib/cash-flow-capture");
        const r = await captureCashFlowSnapshot(userName ?? "system@auto-sync");
        return r.captured ? `snapshot #${r.snapshotId} captured, ${r.lineCount} lines (${r.reason})` : `no new snapshot — ${r.reason}`;
      });
    })(),
  ]);


  // The Scheduler roster's discipline grouping used to be pulled here every
  // hour by name match — retired 2026-08-13. Employee.team is now written
  // directly by Scheduler via a dedicated MySQL connection, matched by a
  // stable employee_id instead of a name; there's nothing left for a
  // scheduled step to pull. See scripts/reconcile-employee-groups.ts to
  // check the two apps still agree.

  // ── Close the Paylocity import record (§42.20) ────────────────────────────
  //
  // Only when a feed was actually read. A pass whose hours step threw never got one,
  // and beginPaylocityImport has already written the FAILURE row in that case — so
  // writing a second record here would report the same import twice, once as failed
  // and once as complete.
  if (cached) {
    await completePaylocityImport(cached, importTotals, undefinedResult).catch((err) =>
      console.error("[auto-sync] could not close the Paylocity import record:", err),
    );
  }

  const ms = Date.now() - startedAt.getTime();
  const finalSteps = steps();
  const failed = finalSteps.filter((s) => s.status === "failed");
  // One line per pass, listing every step — a log you can read at a glance to see
  // which feeds are current, instead of five unrelated lines per tick.
  console.log(
    `[auto-sync] ${trigger} pass in ${ms}ms${month ? ` (month ${month})` : " (no open month)"}: ` +
      finalSteps.map((s) => `${s.source}=${s.status}/${s.ms}ms`).join(" "),
  );

  // Slowest first, so the bottleneck is the first thing on screen rather than
  // something to be worked out by hand from nine numbers in source order.
  //
  // ── No percentages, and no "unaccounted", since the lanes overlap ─────────
  //
  // This block used to print each step's share of the pass and the pass total minus
  // the sum of the steps. Both were correct only while the steps ran one at a time.
  // With two concurrent lanes the sum of the steps EXCEEDS the wall clock, so the
  // shares added up to about 160% and "unaccounted" printed as -3,637ms — a number
  // with no meaning that would send the next reader looking for time that was never
  // lost.
  //
  // So the sum is labelled as what it now is (work done, across lanes) and set against
  // the wall clock, which is the only honest way to state both. The gap between them
  // is the concurrency win, and printing it that way makes a regression in the
  // overlap visible instead of hiding it in a percentage.
  const summed = finalSteps.reduce((s, x) => s + x.ms, 0);
  const slowest = [...finalSteps].sort((a, b) => b.ms - a.ms);
  console.log(
    `[auto-sync]   breakdown (slowest first; ${summed}ms of work across 2 concurrent lanes, ${ms}ms wall clock, ` +
      `${summed > ms ? `${summed - ms}ms saved by overlap` : "no overlap gain"}):`,
  );
  for (const s of slowest) {
    console.log(`[auto-sync]     ${String(s.ms).padStart(6)}ms  ${s.source} (${s.status})`);
  }
  // A step's own number now includes time spent waiting for the event loop while the
  // OTHER lane was doing CPU-bound work, so it is a wall-clock duration and not a
  // cost. Worth stating where the numbers are printed: measured on 2026-08-25,
  // parts_cost reads 186ms run alone and 2,188ms run beside the Paylocity Excel parse,
  // and nothing about parts_cost changed. Compare a step against ITSELF across passes,
  // not against a step in the other lane.

  for (const f of failed) console.error(`[auto-sync]   ${f.source}: ${f.detail}`);

  return { trigger, startedAt, ms, month, steps: finalSteps };
}
