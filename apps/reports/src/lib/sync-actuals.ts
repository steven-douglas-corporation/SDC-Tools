// ── Writers for this app's own synced actuals ──────────────────────────────
//
// Renamed from sync-powerbi.ts on 2026-08-24. The name predated the hours
// migration and had become simply false. Nothing here reads Power BI — no DAX,
// no powerbi-client import. Actual hours come from the Paylocity workbooks via
// readHoursFeed, parts cost from Total ETO via sync-totaleto, and the rest is
// this file's own sync bookkeeping. The old name kept sending readers to Power
// BI to explain numbers that never came from there. DEVLOG entries and commits
// before that date still say sync-powerbi.ts.

import { createHash } from "crypto";

import { prisma } from "@/lib/prisma";
import { VALID_JOB_TYPES, etcActiveJobFilter } from "@/lib/job-filters";
import { ETC_TRACKED_CODES, PARTS_COST_SECTION, JOB_DASHBOARD_HOURS_CODES, mapPunchToColumns } from "@/lib/sections";
import { calcHoursLeft, round2, isMonthLocked, latestPriorEtcByKey, priorEtcForMonth, redrivenDraft, monthWindowUtc, startsInMonth } from "@/lib/etc";
import { getPartsCostBookedByJob, getUnclassifiedFlaggedSpend } from "@/lib/sync-totaleto";
import { isDerivedPartsDraft } from "@/lib/parts-breakout-scope";
import {
  hoursByJobSection,
  latestWorkDate,
  type HoursImportIssue,
  type JobHoursRow,
  type PoolHoursByMonth,
} from "@/lib/job-hours-source";
import { readHoursFeed } from "@/lib/hours-feed";
import { classifyPunch } from "@/lib/paylocity-standard-rules";

// One read of the hours feed, shared by the two syncs that use it. Exported so a
// caller running both (auto-sync's pass, the ETC Refresh Data button) can fetch
// once and hand the same object to each.
export type HoursExport = { rows: JobHoursRow[]; issues: HoursImportIssue[]; poolHours: PoolHoursByMonth };

// Actual hours worked per job per month, upserted into JobMonthlyActualHours
// (the job-level rollup the dashboard / job detail use), summed across every
// tracked section.
//
// Sourced from the Paylocity Excel files in the OneDrive folder, via readHoursFeed
// — the one hours entry point. Power BI is not an hours source anywhere in the app
// (2026-08-21); see hours-feed.ts for why the model path and its code->column
// resolver were both removed rather than kept as a fallback.
//
// Covers EVERY job the hours were booked to, Complete and Active alike — the job
// lookup below filters on nothing but the job ids present in the feed.
//
// `prefetched` lets a caller that also runs syncHoursWorked hand both functions
// the SAME read. That read parses every Paylocity workbook in the OneDrive folder,
// so sharing it saves real work. (It was described here as "~18 DAX round-trips"
// until 2026-08-24 — a leftover from the Power BI era; this file makes no DAX call.)
// Omit it and this fetches its own copy, so no caller is obliged to care.
export async function syncActualHours(prefetched?: HoursExport): Promise<{
  rowsUpserted: number;
  jobsNotFound: number;
  rowsSkippedOverridden: number;
  detailRowsWritten: number;
  // Buckets whose stored contents were already exactly what this pass would have
  // written, so they were not rewritten. Reported rather than hidden: this is the
  // difference between "the refresh did nothing" and "the refresh confirmed nothing
  // changed", and only the second one is true.
  detailBucketsUnchanged: number;
  // Buckets whose stored rows had drifted from what the digest claimed, and were
  // rewritten from the source. Normally 0; anything else means something outside this
  // sync had edited the punch table, and the pass healed it.
  detailBucketsRepaired: number;
  detailBuckets: number;
}> {
  // Falls back to readHoursFeed (the Paylocity Excel files) rather than the Power BI
  // model (2026-08-21) — Power BI is no longer an hours source anywhere.
  const { rows } = prefetched ?? (await readHoursFeed());
  // Undefined hours are NOT recorded here any more (2026-08-05, §42.14 stage 10).
  // They moved to their own refresh step — lib/paylocity-import.ts recordUndefinedHours
  // — for two reasons: it writes the punch-level rows as well as the totals, in one
  // transaction, which is what makes the KPI and its drill-through reconcile by
  // construction; and it is a stage a manager watching a refresh should see named
  // ("Calculating Undefined Hours…") rather than buried inside "Actual hours".
  // Sum only the codes JobMonthlyActualHours has always modeled (2026-08-17,
  // widened 2026-08-21 — see JOB_DASHBOARD_HOURS_CODES's own comment). Service,
  // Spare Parts, Engineering "Other", and now any raw code the standard mapping
  // has never seen, have no SECTIONS row at all, unlike PM/Warranty/Manufacturing
  // — so letting them into this sum would grow JobMonthlyActualHours (Job
  // detail's "Actual Hours by Month") while the Job Hour Details dashboard and
  // Projects grid, which only ever iterate the 17 SECTIONS codes, stayed blind to
  // why. Excluding them here keeps every one of those pages byte-identical to
  // today; JobHoursDetail (below) still gets every row, unfiltered — that is the
  // whole point of the allow-list being an explicit set rather than a complement
  // of exclusions that a future unmapped code could slip past.
  // Rows are RAW now (2026-08-21 — storage stopped folding/splitting). This function
  // still needs the ETC grid's fixed-column figure, so it folds each raw punch via
  // mapPunchToColumns here, at aggregation time, exactly as the reader used to do
  // before pushing it into the row list. Nothing is stored folded any more — this
  // fold exists only in memory, only for this one total.
  const byJobMonth = new Map<string, number>(); // `${jobId}::${YYYY-MM}` -> hours
  for (const r of rows) {
    for (const col of mapPunchToColumns(r.section, r.hours)) {
      if (!JOB_DASHBOARD_HOURS_CODES.has(col.section)) continue;
      const monthStr = `${r.year}-${String(r.month).padStart(2, "0")}`;
      const key = `${r.jobId}::${monthStr}`;
      byJobMonth.set(key, (byJobMonth.get(key) ?? 0) + col.hours);
    }
  }

  let rowsUpserted = 0;
  let jobsNotFound = 0;
  let rowsSkippedOverridden = 0;

  // Prefetch the whole working set in two queries instead of two per key: this
  // loop spans EVERY job × EVERY month the feed holds (18 months of
  // history), so the old per-key job.findUnique + overridden findUnique meant
  // thousands of serial round-trips per Refresh — multi-minute, timeout-prone.
  // ── Resolved from EVERY row, not just allow-listed ones (2026-08-21 fix) ──
  //
  // This used to derive the job list from `byJobMonth`, which is filtered by
  // JOB_DASHBOARD_HOURS_CODES. That map is then handed to syncJobHoursDetail, which
  // skips any row whose job is absent from it — so a job whose punches ALL fall
  // outside the allow-list resolved to nothing and lost every one of its punch rows,
  // silently. Measured on 2026-08-21: jobs 955 and 993 held zero JobHoursDetail rows
  // while carrying real hours in the source, and job 953 held only a single stale row.
  //
  // That is the same "standardization decides existence" defect the ingestion fix
  // closed in mapPunchToColumns, reintroduced one layer up through the job map. The
  // allow-list is a scoping rule for the ROLLUP (JobMonthlyActualHours, which feeds
  // Job detail's "Actual Hours by Month") and must not decide whether a punch is
  // stored at all — JobHoursDetail is the audit record and has to hold every
  // job-attributed punch, mapped or not.
  const jobIdStrs = [...new Set(rows.map((r) => r.jobId))];
  const jobRows = await prisma.job.findMany({ where: { jobId: { in: jobIdStrs } }, select: { id: true, jobId: true } });
  const jobByJobId = new Map(jobRows.map((j) => [j.jobId, j]));
  // Mirrors the legacy "Actual Hours Override" tab: a manually corrected month
  // must not be silently clobbered by the next sync.
  const overriddenRows = await prisma.jobMonthlyActualHours.findMany({
    where: { jobId: { in: jobRows.map((j) => j.id) }, overridden: true },
    select: { jobId: true, month: true },
  });
  const overriddenSet = new Set(overriddenRows.map((o) => `${o.jobId}::${o.month}`));

  // ── Write only the rollups whose figure actually moved (2026-08-25) ───────
  //
  // This loop was 954 sequential upserts per pass — one round-trip per (job, month) —
  // and on a normal refresh almost every one of them wrote the same number back. Same
  // finding as the punch rows below, one grain up.
  //
  // So the current values are read once, in one query, and only a genuine difference
  // is written. `source` is part of the comparison, not just `actualHours`: a row
  // still labelled "power_bi" from the pre-Paylocity era has to be rewritten even
  // when its figure happens to match, which is the self-healing the note below
  // describes.
  const existingRows = await prisma.jobMonthlyActualHours.findMany({
    where: { jobId: { in: jobRows.map((j) => j.id) } },
    select: { jobId: true, month: true, actualHours: true, source: true },
  });
  const existing = new Map(existingRows.map((e) => [`${e.jobId}::${e.month}`, e]));

  // The rows this pass confirmed, whether or not their figure moved — see the bulk
  // `syncedAt` stamp after the loop.
  const confirmed: { jobId: number; month: string }[] = [];

  for (const [key, hours] of byJobMonth) {
    const [jobId, monthStr] = key.split("::");
    const job = jobByJobId.get(jobId);
    if (!job) {
      jobsNotFound++;
      continue;
    }
    if (overriddenSet.has(`${job.id}::${monthStr}`)) {
      rowsSkippedOverridden++;
      continue;
    }

    confirmed.push({ jobId: job.id, month: monthStr });
    const prior = existing.get(`${job.id}::${monthStr}`);
    // Compared through the Decimal column's own precision, not on the raw float:
    // `hours` is a JS number summed from punches and the column is Decimal(10,2), so
    // 130.44999999999999 and the stored 130.45 are the same value and must not read
    // as a change. Comparing Number(prior.actualHours) against `hours` directly would
    // rewrite most rows every pass and defeat the whole point.
    if (prior && prior.source === "paylocity_excel" && Number(prior.actualHours) === round2(hours)) continue;

    await prisma.jobMonthlyActualHours.upsert({
      where: { jobId_month: { jobId: job.id, month: monthStr } },
      // `source` is written on UPDATE as well as CREATE, deliberately. Rows created
      // during the Power BI era kept source="power_bi" forever while their actualHours
      // were being overwritten from Paylocity on every sync, so the one column that
      // answers "where did this number come from" was lying about 939 of them.
      // Writing it here lets the label self-heal on the next Refresh Data, and leaves
      // it as "power_bi" only on rows this sync genuinely never touches — the pre-feed
      // legacy months, which really are Power BI.
      update: { actualHours: hours, syncedAt: new Date(), source: "paylocity_excel" },
      create: { jobId: job.id, month: monthStr, actualHours: hours, source: "paylocity_excel" },
    });
    rowsUpserted++;
  }

  // ── The freshness stamp still has to advance (§43) ────────────────────────
  //
  // Monthly ETC reads MAX(JobMonthlyActualHours.syncedAt) as its "hours last synced"
  // line. Skipping the unchanged upserts above would have frozen that timestamp, so
  // the page would have reported hours as hours old immediately after a refresh that
  // had just confirmed them current — trading a slow refresh for a lying header.
  //
  // `syncedAt` means "this figure was verified against the source at this time", and
  // that is true of every row the loop reached, changed or not. One updateMany stamps
  // the whole confirmed set in a single round-trip, so the honest timestamp costs one
  // statement rather than the 954 it used to ride along with.
  if (confirmed.length > 0) {
    const now = new Date();
    await prisma.jobMonthlyActualHours.updateMany({
      where: { OR: confirmed.map((c) => ({ jobId: c.jobId, month: c.month })) },
      data: { syncedAt: now },
    });
  }

  const detail = await syncJobHoursDetail(rows, jobByJobId);

  await syncHoursRefreshedThrough(rows);

  return {
    rowsUpserted,
    jobsNotFound,
    rowsSkippedOverridden,
    detailRowsWritten: detail.written,
    detailBucketsUnchanged: detail.unchanged,
    detailBucketsRepaired: detail.repaired,
    detailBuckets: detail.buckets,
  };
}

// Punch-level rows behind those rollups — one per employee/day/job/section —
// feeding the in-app Hours Detail drill (the Power BI drillthrough page's
// equivalent). Same `rows` the rollups were summed from, so the drill can never
// disagree with the total you clicked to open it.
//
// Replace-by-(job, month) rather than upsert-per-row: at ~13k rows an upsert
// apiece is thousands of round-trips, and a month present in the feed is wholly
// described by it, so deleting and re-inserting that month is both faster and
// self-healing (a punch deleted upstream disappears here too, which an
// upsert-only pass would leave behind forever).
//
// Months absent from the feed are left untouched. With one authoritative Paylocity
// file per punch year (paylocity-sources.ts) the feed now spans 2025 onward, so in
// practice every month it covers is rewritten each pass. The rule stays because
// "absent" must never mean "delete" — a failed or partial read would otherwise
// erase history. The visible cost is that punches deleted upstream linger until
// their month is rewritten from a file that still covers it.
export async function syncJobHoursDetail(
  rows: JobHoursRow[],
  jobByJobId: Map<string, { id: number; jobId: string }>,
  // Provenance label stored on each row. Defaults to the Paylocity Excel files, which
  // is now the only hours source; scripts writing the same replace-by-(job, month)
  // shape from somewhere else pass their own label rather than inheriting a wrong one.
  source = "paylocity_excel",
): Promise<{ written: number; unchanged: number; repaired: number; buckets: number }> {
  // job pk + month -> the rows for it
  const byJobMonth = new Map<string, { jobPk: number; month: string; rows: JobHoursRow[] }>();
  for (const r of rows) {
    const job = jobByJobId.get(r.jobId);
    if (!job) continue; // counted as jobsNotFound by the caller already
    const month = `${r.year}-${String(r.month).padStart(2, "0")}`;
    const key = `${job.id}::${month}`;
    const bucket = byJobMonth.get(key);
    if (bucket) bucket.rows.push(r);
    else byJobMonth.set(key, { jobPk: job.id, month, rows: [r] });
  }

  // ── What each bucket WOULD contain, before deciding to write it ───────────
  //
  // The payload is built for every bucket either way — it is pure in-memory work over
  // rows already parsed, and it is what the digest has to be taken over. Only the
  // WRITE is conditional.
  const planned = [...byJobMonth.values()].map(({ jobPk, month, rows: monthRows }) => {
    // Collapse to the true punch grain before writing: the export is already one row
    // per employee/day/job/raw-pair, but a person can book the same raw pair twice in
    // a day (two separate punches). `section` IS the raw pair now (2026-08-21), so it
    // alone is the whole key — no fold, no split, nothing else can collide on it.
    const merged = new Map<
      string,
      {
        section: string;
        workDate: Date;
        employeeId: string;
        hours: number;
        rawSection: string;
        rawFunction: string;
        travelHours: number;
        travelKnown: boolean;
      }
    >();
    for (const r of monthRows) {
      const day = new Date(Date.UTC(r.date.getUTCFullYear(), r.date.getUTCMonth(), r.date.getUTCDate()));
      const k = `${r.section}::${day.toISOString().slice(0, 10)}::${r.employeeId}`;
      // ── Travel is stored as HOURS, not as a label (2026-08-28) ────────────
      //
      // The Job Hours Report keeps Travel inside its own group-by grain, so a day
      // split between a travel site and Concord stays two rows there. This table's
      // grain is (job, section, date, employee) and its unique key says so, so the
      // two collapse into one row here and a single `travel` label would have to
      // pick a winner — silently dropping or inventing travel hours either way.
      //
      // Storing the travel PORTION of the row's hours sidesteps the grain mismatch
      // entirely: SUM(travelHours) equals the report's `Hours Actual Travel`
      // (SUM of hours WHERE Travel = "Travel") whatever the grain does, because
      // both are summing the same underlying punch hours.
      //
      // travelKnown separates "this export had no Travel column" from "nobody
      // travelled". Null reaches the UI as a dash; 0 reaches it as a real zero.
      const isTravel = r.travel === "Travel";
      const known = r.travel !== undefined && r.travel !== "";
      const cur = merged.get(k);
      if (cur) {
        cur.hours += r.hours;
        if (isTravel) cur.travelHours += r.hours;
        cur.travelKnown ||= known;
      } else
        merged.set(k, {
          section: r.section,
          workDate: day,
          employeeId: r.employeeId,
          hours: r.hours,
          rawSection: r.rawSection,
          rawFunction: r.rawFunction,
          travelHours: isTravel ? r.hours : 0,
          travelKnown: known,
        });
    }

    const data = [...merged.values()].map((m) => {
      // The approved Section+Function rule book, applied ONCE here and stored as
      // real columns — this is what makes every page's Group By a plain SQL
      // GROUP BY rather than a per-page recomputation. Pure function of the raw
      // pair, so re-running this write with an updated rule book (via a resync)
      // is the only thing that ever changes it — never a page-level guess.
      const c = classifyPunch(m.rawSection, m.rawFunction);
      return {
        jobId: jobPk,
        section: m.section,
        month,
        workDate: m.workDate,
        employeeId: m.employeeId,
        hours: round2(m.hours),
        rawSection: m.rawSection,
        rawFunction: m.rawFunction,
        standardDepartment: c.department,
        standardTaskDescription: c.taskDescription,
        mappingStatus: c.mappingStatus,
        travelHours: m.travelKnown ? round2(m.travelHours) : null,
        source,
      };
    });

    return { jobPk, month, data, digest: digestBucket(data) };
  });

  // ── Rewrite only the buckets that actually moved (2026-08-25) ─────────────
  //
  // This loop used to run one delete-then-insert transaction per bucket
  // unconditionally. Measured on the live database: 1,146 buckets, 28,972 rows,
  // 10.5s — 84% of the hours step and 60% of the entire 17.4s refresh — and twelve of
  // the twenty months it rewrote are closed 2025 history whose source workbook has not
  // been saved since 2026-06-03. The overwhelming majority of that work deleted rows
  // and inserted byte-identical replacements.
  //
  // The skip is decided by a digest of the payload ABOVE, which includes every column
  // that would be written — the classifyPunch outputs among them. So this cannot go
  // stale against a rule-book change: a different classification is a different
  // payload is a different digest is a rewrite. See the JobHoursBucket model.
  //
  // digestBucket() lists its fields EXPLICITLY rather than hashing the payload object,
  // so "includes every column" is a promise the next person has to keep by hand: a new
  // column on the write above must also be added to the digest, or every bucket skips
  // and the column silently keeps its default forever. Exactly that happened when
  // travelHours was added (2026-08-28) — the backfill reported 0 rows written.
  //
  // What is deliberately NOT skipped: a bucket with no stored digest. "Unknown" is
  // treated as changed, so the first pass after this deploy, after a manual repair
  // script, or on a brand-new job writes exactly as it always did.
  //
  // This does NOT weaken the §42.5 rule that an unchanged FILE is still re-imported.
  // That rule exists because the file is not the only input — a job created since the
  // last pass turns JOB_NOT_FOUND rows into attributable hours, and a reopened month
  // needs its hours written again. Both of those change the payload of the buckets
  // they affect, so both still write. What is skipped here is only work whose result
  // is provably identical, decided per bucket rather than per file.
  const jobPks = [...new Set(planned.map((p) => p.jobPk))];
  // One read of the whole working set, not one per bucket — the same reason the job
  // and overridden lookups above are batched.
  const stored = new Map<string, string>();
  if (jobPks.length > 0) {
    const digests = await prisma.jobHoursBucket.findMany({
      where: { jobId: { in: jobPks } },
      select: { jobId: true, month: true, digest: true },
    });
    for (const d of digests) stored.set(`${d.jobId}::${d.month}`, d.digest);
  }

  // ── The digest is not allowed to be the only witness ──────────────────────
  //
  // A digest says what the last WRITE intended. It cannot see the table, so on its own
  // it would trust a claim about rows that may since have been changed by something
  // else — a repair script, a hand-run UPDATE, a half-applied migration. The old
  // unconditional rewrite was self-healing against all of that for free, and giving
  // that up to make the pass fast would be trading correctness for speed.
  //
  // Caught by scripts/tmp-correct.ts during this change, not reasoned about
  // afterwards: with the digest as sole witness, a row edited behind the sync's back
  // survived every subsequent pass instead of being repaired on the next one.
  //
  // So the stored rows get a say too, in ONE grouped aggregate over the whole table
  // rather than a read per bucket — count and total hours per (job, month). A bucket
  // is skipped only when the digest matches AND the rows on disk still have the shape
  // that digest was computed over. Either witness disagreeing means rewrite.
  //
  // Cost: one indexed GROUP BY (~60ms against 29k rows) per pass, against the 10.5s of
  // delete-and-reinsert it replaces.
  const onDisk = new Map<string, { rows: number; hours: number }>();
  {
    const agg = await prisma.$queryRaw<{ jobId: number; month: string; n: bigint; h: unknown }[]>`
      SELECT jobId, month, COUNT(*) AS n, COALESCE(SUM(hours), 0) AS h
        FROM JobHoursDetail
       GROUP BY jobId, month`;
    for (const a of agg) onDisk.set(`${a.jobId}::${a.month}`, { rows: Number(a.n), hours: Number(a.h) });
  }

  let written = 0;
  let unchanged = 0;
  let repaired = 0;
  for (const { jobPk, month, data, digest } of planned) {
    const key = `${jobPk}::${month}`;
    if (stored.get(key) === digest) {
      // The digest matches, so the SOURCE has not moved. Now check the table agrees
      // with it before trusting the skip. Totals are compared at the column's own
      // Decimal(10,2) precision — the stored sum is exact to the cent, so the intended
      // one has to be rounded the same way rather than compared as a raw float.
      const disk = onDisk.get(key);
      const wantRows = data.length;
      const wantHours = round2(data.reduce((t, d) => t + d.hours, 0));
      if (disk && disk.rows === wantRows && round2(disk.hours) === wantHours) {
        unchanged++;
        continue;
      }
      // The digest claimed a state the rows are not in. Fall through and rewrite,
      // which restores the bucket to the source — and say so, because a bucket that
      // needed repairing is worth knowing about rather than silently fixing.
      repaired++;
      console.warn(
        `[sync-actuals] job ${jobPk} ${month}: stored punch rows disagree with the digest ` +
          `(on disk ${disk ? `${disk.rows} rows/${round2(disk.hours)}h` : "absent"}, expected ${wantRows} rows/${wantHours}h) — rewriting from the source`,
      );
    }
    await prisma.$transaction([
      prisma.jobHoursDetail.deleteMany({ where: { jobId: jobPk, month } }),
      prisma.jobHoursDetail.createMany({ data }),
      // In the SAME transaction as the rows, so the digest can never claim a state the
      // rows are not in. A crash between the two would otherwise leave a digest saying
      // "already written" over rows that were deleted and never replaced — silently
      // missing punches, which the skip would then preserve on every later pass
      // instead of healing.
      prisma.jobHoursBucket.upsert({
        where: { jobId_month: { jobId: jobPk, month } },
        update: { digest, rows: data.length, syncedAt: new Date() },
        create: { jobId: jobPk, month, digest, rows: data.length },
      }),
    ]);
    written += data.length;
  }
  return { written, unchanged, repaired, buckets: planned.length };
}

// The digest the skip decision rests on: sha256 over every column of every row the
// bucket would contain, in punch-grain order.
//
// Sorted explicitly rather than relying on Map insertion order — that order follows
// the order rows happen to appear in the workbook, so an identical bucket exported in
// a different row order would otherwise digest differently and force a pointless
// rewrite. Sorting on the unique key (section, workDate, employeeId) is exactly the
// grain the @@unique constraint declares, so it is total.
//
// `hours` is stringified via toFixed(2) to match the Decimal(10,2) column: 8 and 8.00
// are the same stored value and must be the same digest.
function digestBucket(
  data: {
    section: string;
    workDate: Date;
    employeeId: string;
    hours: number;
    rawSection: string;
    rawFunction: string;
    standardDepartment: string;
    standardTaskDescription: string;
    mappingStatus: string;
    travelHours: number | null;
    source: string;
  }[],
): string {
  const lines = data
    .map((d) =>
      [
        d.section,
        d.workDate.toISOString().slice(0, 10),
        d.employeeId,
        d.hours.toFixed(2),
        d.rawSection,
        d.rawFunction,
        d.standardDepartment,
        d.standardTaskDescription,
        d.mappingStatus,
        // Null and 0 must hash differently — "no Travel column in this export" and
        // "measured zero travel" are different facts, and a change between them has
        // to force a rewrite. "" vs "0.00" does that; String(null) would not.
        d.travelHours === null ? "" : d.travelHours.toFixed(2),
        d.source,
      ].join("\u0001"),
    )
    .sort();
  const h = createHash("sha256");
  // The row count first, so a bucket that is a strict prefix of another cannot
  // collide with it on the concatenated text alone.
  h.update(`${lines.length}\n`);
  for (const l of lines) h.update(`${l}\n`);
  return h.digest("hex");
}

// Drop the cached digests for a set of jobs (or all of them), so the next refresh
// rewrites those buckets from the source instead of trusting the cache.
//
// For anything that writes or deletes JobHoursDetail rows behind syncJobHoursDetail's
// back — purge-stale-hours-rows.ts, the resync utilities. Editing rows without doing
// this leaves a digest asserting a state the table is no longer in, and the skip would
// then preserve the damage on every subsequent pass rather than healing it.
export async function invalidateJobHoursDigests(jobIds?: number[]): Promise<number> {
  // Two calls rather than one with a conditional argument: deleteMany's argument type
  // makes `where` required once it is present at all, so the ternary does not narrow.
  const r =
    jobIds == null
      ? await prisma.jobHoursBucket.deleteMany()
      : await prisma.jobHoursBucket.deleteMany({ where: { jobId: { in: jobIds } } });
  return r.count;
}

// Actual hours worked per job PER SECTION for `month`, overwriting
// EtcEntry.hoursWorked directly — the per-department grain the ETC grid
// needs. Always overwrites on refresh; "Hours Worked" is meant to always
// reflect the source, not be independently typed in.
//
// Source is Power BI's `Hours Actual` (job-hours-source.ts). It was the
// OneDrive-synced Paylocity workbook from 2026-07-19 until 2026-08-03; the two
// were verified to agree by job/section to the hundredth (May 2026, 127/127, and
// again across all of 2026 before the switch back).
//
// When there are hours in a tracked section the job has no entry for (work
// charged to a section that was never quoted, so startMonth didn't seed it),
// the entry is CREATED rather than the hours silently dropped. Prior ETC for
// these comes from the one shared rule — priorEtcForMonth — exactly as seeding
// would have given it: the latest earlier month's New ETC, or the quote when this
// is the job's first ETC month, or 0 when there is genuinely neither.
// `prefetchedRows` — see syncActualHours: one parse shared between the two.
// Raw rows -> ETC-grid-column rows, in memory. The 10-311 split (one raw row becomes
// two) happens HERE, not in storage — see mapPunchToColumns in sections.ts for the
// exact fold/split rules this reuses.
function foldRowsToEtcColumns(rows: JobHoursRow[]): JobHoursRow[] {
  const out: JobHoursRow[] = [];
  for (const r of rows) {
    for (const col of mapPunchToColumns(r.section, r.hours)) {
      out.push({ ...r, section: col.section, hours: col.hours });
    }
  }
  return out;
}

export async function syncHoursWorked(
  month: string,
  prefetchedRows?: JobHoursRow[],
): Promise<{ rowsUpdated: number; rowsSkipped: number; rowsZeroed: number }> {
  // Re-checked here, not just trusted from the caller's earlier check — this
  // sync does one DB round-trip per row, so it can run long enough for a
  // manager to Submit and Lock this exact month mid-sync. A locked month is
  // frozen history (same rule as the submission path / syncPowerBiForEtc)
  // and must never be rewritten by a background refresh.
  const monthEntriesAtStart = await prisma.etcEntry.findMany({ where: { month }, select: { needsReview: true } });
  const monthStartedAtStart = monthEntriesAtStart.length > 0;
  if (monthStartedAtStart && isMonthLocked(monthEntriesAtStart)) {
    return { rowsUpdated: 0, rowsSkipped: 0, rowsZeroed: 0 };
  }

  const [year, monthNum] = month.split("-").map(Number);
  const allRows = prefetchedRows ?? (await readHoursFeed()).rows;
  // Rows are RAW (2026-08-21) — fold each one onto its ETC grid column(s) here, in
  // memory, before summing. hoursByJobSection itself does no folding; it just sums
  // whatever `section` it is given, so this is the one place that turns "raw punches"
  // into "what the fixed 17-column ETC grid shows", without storing the fold anywhere.
  const spentByKey = hoursByJobSection(foldRowsToEtcColumns(allRows), year, monthNum);

  // Resolve every job once, up front (one query), instead of the same
  // job.findUnique repeated per section row. The per-row EtcEntry reads below
  // stay live on purpose — they guard against this exact month being locked /
  // a row being submitted mid-sync, and must not be served from a stale snapshot.
  const jobIdStrs = [...new Set([...spentByKey.keys()].map((k) => k.split("::")[0]))];
  const jobRows = await prisma.job.findMany({
    where: { jobId: { in: jobIdStrs } },
    // startDate and the quote come along so a row CREATED below opens at the same
    // figure seeding would have given it — see the note at the creation site.
    select: {
      id: true,
      jobId: true,
      status: true,
      completeDate: true,
      type: true,
      startDate: true,
      estimatedHours: { select: { section: true, quotedHours: true } },
    },
  });
  const jobByJobId = new Map(jobRows.map((j) => [j.jobId, j]));

  // EVERY earlier month, not prevMonth — the correction latestPriorEtcByKey was
  // written to make, applied here too so this path cannot answer "what does this
  // row open at" differently from seedMonth, the cascade, reopenMonth and
  // syncPartsCost. One query for the whole loop.
  const priorEntries = await prisma.etcEntry.findMany({
    where: { month: { lt: month }, jobId: { in: jobRows.map((j) => j.id) } },
    select: { jobId: true, section: true, month: true, newEtc: true },
  });
  const priorByKey = latestPriorEtcByKey(priorEntries);

  let rowsUpdated = 0;
  let rowsSkipped = 0;

  for (const [key, hours] of spentByKey) {
    const [jobId, section] = key.split("::");
    if (!ETC_TRACKED_CODES.has(section)) continue; // ignore codes the ETC grid doesn't track

    const job = jobByJobId.get(jobId);
    if (!job) {
      rowsSkipped++;
      continue;
    }

    const entry = await prisma.etcEntry.findUnique({
      where: { jobId_section_month: { jobId: job.id, section, month } },
    });

    if (!entry) {
      // Unquoted-section hours: create the entry so the work is visible, but
      // only for jobs the grid actually shows, only once the month has been
      // started, and only when there are real hours to show. Also refuses to
      // add a fresh needsReview row into a month that's already fully locked
      // — that would silently "unlock" it (isMonthLocked requires every
      // entry to be reviewed) behind the manager's back.
      const qualifies =
        job.status === "Active" && job.completeDate === null && VALID_JOB_TYPES.includes(job.type as (typeof VALID_JOB_TYPES)[number]);
      if (!monthStartedAtStart || !qualifies || hours === 0) {
        rowsSkipped++;
        continue;
      }

      // Re-checked per-row, right before creating: monthStartedAtStart is a
      // top-of-function snapshot, and this loop can run long enough for the
      // month to have been fully locked since — a fresh needsReview:true row
      // would silently "unlock" it the moment it lands.
      const monthEntriesNow = await prisma.etcEntry.findMany({ where: { month }, select: { needsReview: true } });
      if (isMonthLocked(monthEntriesNow)) {
        rowsSkipped++;
        continue;
      }

      // The SHARED rule (priorEtcForMonth), not a local guess. This used to read
      // the immediately preceding month alone and fall through to a hardcoded 0 —
      // wrong in both of the ways the rest of the app had already been fixed for:
      //
      //   • prevMonth only, so a job that skipped a period reopened at 0 instead
      //     of resuming from where its ETC actually left off (latestPriorEtcByKey).
      //   • no quote fallback at all, so a punch landing on a job whose FIRST ETC
      //     month this is created the row at 0 against a real quote. That is how
      //     job 1163 came to show Prior 0 on 10-211/10-312/10-313 in August 2026
      //     against quotes of 1,770 / 490 / 630 — the row did not exist when
      //     August was seeded, so this path invented it, and this path did not
      //     know the rule.
      //
      // A job with genuinely nothing quoted and no history still opens at 0, which
      // is correct and is what this branch was originally written for.
      const startsThisMonth = startsInMonth(job.startDate, month);
      const priorEtc = priorEtcForMonth({
        startsThisMonth,
        carried: priorByKey.get(`${job.id}-${section}`),
        quoted: Number(job.estimatedHours.find((q) => q.section === section)?.quotedHours ?? 0),
      });

      await prisma.etcEntry.create({
        data: {
          jobId: job.id,
          section,
          month,
          priorEtc,
          hoursWorked: hours,
          hoursLeftCalc: round2(calcHoursLeft(priorEtc, hours)),
          newEtc: priorEtc,
          needsReview: true,
        },
      });
      rowsUpdated++;
      continue;
    }

    // Re-checked per-row: this specific entry could have been submitted
    // (needsReview -> false) since the loop started, even if the month as a
    // whole wasn't locked yet at the top-of-function check.
    if (!entry.needsReview) {
      rowsSkipped++;
      continue;
    }

    const priorEtc = Number(entry.priorEtc);
    // newEtc is deliberately NOT written here — it's manager-entered
    // (submitMonth falls back to the suggestion only at submission time).
    // Hours Left is always the plain Prior ETC − Hours Worked difference.
    await prisma.etcEntry.update({
      where: { id: entry.id },
      data: {
        hoursWorked: hours,
        hoursLeftCalc: round2(calcHoursLeft(priorEtc, hours)),
      },
    });
    rowsUpdated++;
  }

  // Rows the export no longer accounts for.
  //
  // The loop above only visits keys PRESENT in the export, so a (job, section)
  // whose hours moved away upstream — a booking reassigned to another job, or
  // deleted — is never revisited and keeps its last synced value forever.
  // Measured live 2026-07-31: job 1104 held 8.00h and job 1145 1.68h that the
  // export had already dropped. Small individually, but the error is
  // one-directional (it can only inflate) and compounds every month.
  //
  // "Hours Worked always reflects the source, it is never independently typed
  // in" is the rule this restores. The main loop only ever enforced it in the
  // direction of hours appearing, never hours going away.
  //
  // GUARDED on the export actually covering this month. `spentByKey` is empty
  // when the rolling window has moved past `month`, or when the fetch returned
  // nothing usable — and zeroing every row on that basis would wipe the month's
  // hours wholesale. Absence of the month from the export is not evidence that
  // nobody worked; it is evidence the export cannot answer the question.
  let rowsZeroed = 0;
  if (spentByKey.size > 0) {
    const candidates = await prisma.etcEntry.findMany({
      where: {
        month,
        needsReview: true, // never touch a submitted row, same rule as above
        hoursWorked: { not: 0 },
      },
      select: { id: true, section: true, priorEtc: true, job: { select: { jobId: true } } },
    });

    for (const entry of candidates) {
      // Parts Cost is dollars from TotalETO and owned by syncPartsCost; the
      // hours export knows nothing about it and must never zero it.
      if (entry.section === PARTS_COST_SECTION) continue;
      if (!ETC_TRACKED_CODES.has(entry.section)) continue;
      if (spentByKey.has(`${entry.job.jobId}::${entry.section}`)) continue; // still in the export

      const priorEtc = Number(entry.priorEtc);
      await prisma.etcEntry.update({
        where: { id: entry.id },
        // newEtc deliberately untouched, exactly as in the update above — it is
        // manager-entered, and a source correction must not silently rewrite it.
        data: { hoursWorked: 0, hoursLeftCalc: round2(calcHoursLeft(priorEtc, 0)) },
      });
      rowsZeroed++;
    }
  }

  // Its own freshness record, separate from "hours_actual".
  //
  // Those two syncs read the same file but write different things, and they
  // fail independently: syncActualHours can succeed (stamping hours_actual as
  // healthy) while this one throws, leaving the ETC grid stale behind a header
  // that says everything is fine. That gap is precisely how the numbers aged
  // unnoticed, so the grid's own hours get their own record.
  //
  // Deliberately NOT recorded on the locked-month early return above: doing
  // nothing because a month is frozen is correct behaviour, not a fresh sync,
  // and stamping it would report currency this function never established.
  await recordSyncSuccess("etc_hours_worked", latestWorkDate(allRows));

  return { rowsUpdated, rowsSkipped, rowsZeroed };
}

// "Parts Cost" — a real block in the sheet (Prior ETC / Money Spent Month /
// Money Left / New ETC / Diff, in dollars, no Engineering/Shop split).
// Modeled as an EtcEntry row with section = PARTS_COST_SECTION rather than a
// new table, since the shape matches the hours departments exactly.
//
// Money Spent Month comes DIRECTLY from TotalETO now (getPartsCostBookedByJob,
// the AP-document basis — see §41 below), not Power BI, and it removes the
// last PBI/gateway dependency for the live month. Prior ETC is the app's own prior-
// month confirmed New ETC (the authoritative running balance now that the
// monthly review lives in the app); no prior entry -> opens at 0.
// Creates the row if it doesn't exist yet (unlike the hours sync, which only
// updates existing rows) since Parts Cost has no EstimatedHours-seeded
// counterpart from startMonth().
export async function syncPartsCost(month: string): Promise<{ rowsUpserted: number }> {
  // Same re-check as syncHoursWorkedFromPowerBi: a locked month must never be
  // rewritten, even if it got locked after the caller's own check but before
  // (or during) this function's run.
  const monthEntriesAtStart = await prisma.etcEntry.findMany({ where: { month }, select: { needsReview: true } });
  if (monthEntriesAtStart.length > 0 && isMonthLocked(monthEntriesAtStart)) {
    return { rowsUpserted: 0 };
  }

  // One definition of "which dates are this month", shared and tested — see
  // monthWindowUtc. Half-open [start, endExclusive), UTC.
  const { start: monthStart, endExclusive: monthEndExclusive } = monthWindowUtc(month);
  // §41: the AP-document basis, reconciled to the Total ETO report — see
  // getPartsCostBookedByJob for the date, the amount, the sign rule and the measured
  // reasons Extra Costs stay out. This SUPERSEDES §30's purchased-date basis
  // (getPartsCostPurchasedByJob), which was internally consistent but $30,117 away from
  // the business's own report for July 2026, and off by multiples on individual jobs.
  //
  // getPartsCostSpentByJob is still used, but only by Profitability's "Parts
  // Purchased" column (src/lib/job-cost-source.ts), which is a lifetime
  // committed-spend measure and a different question. (Corrected 2026-08-15,
  // audit finding: this comment previously said "the Projects grid's
  // cumulative Parts Cost Actual column" — stale since 2026-08-10, when
  // syncPartsCostActual switched that column to getPartsActualByJob instead.)
  const booked = await getPartsCostBookedByJob(monthStart, monthEndExclusive);
  const spentByJobId = booked.net;
  // An AP line with no ProjectID belongs to nobody and would silently vanish. Surfaced in
  // the sync log rather than reassigned (§41.6); it was 0 lines for July 2026.
  if (booked.unmatchedLines > 0) {
    console.warn(
      `[parts-cost] ${month}: ${booked.unmatchedLines} AP line(s) totalling ` +
        `${booked.unmatchedAmount.toFixed(2)} carry no ProjectID and are in NO job's Money Spent.`,
    );
  }

  // ── Flagged spend nobody has classified (2026-09-04) ──────────────────────
  //
  // `APDocDoNotExport` means "do not export to Sage again", and it covers both
  // Sage-first purchases (already paid, should count) and ETO-side corrections (must
  // never count). Only vendors on SAGE_FIRST_VENDORS count; everything else keeps the
  // old behaviour of being excluded.
  //
  // That default is safe and it is also invisible, which is the problem: a new company
  // card would understate cost indefinitely with nothing to say a decision was never
  // made. Naming them every refresh is what turns "quietly wrong for months" into a
  // line in the sync log. Reported only — the classification is accounting's call.
  //
  // Wrapped: this is a diagnostic, and a diagnostic must never be what fails a sync.
  try {
    const unclassified = await getUnclassifiedFlaggedSpend(monthStart, monthEndExclusive);
    if (unclassified.length > 0) {
      const total = unclassified.reduce((a, u) => a + u.amount, 0);
      console.warn(
        `[parts-cost] ${month}: ${unclassified.length} vendor(s) bill on never-exported AP ` +
          `documents and are NOT counted as spend (${total.toFixed(2)} net). Each is either a ` +
          `Sage-first purchase or an ETO-side correction — see SAGE_FIRST_VENDORS in ` +
          `lib/sync-totaleto.ts and scripts/audit-sage-first-vendors.ts:`,
      );
      for (const u of unclassified) {
        console.warn(`[parts-cost]   ${u.amount.toFixed(2).padStart(14)}  ${String(u.lines).padStart(4)} lines  ${u.vendor}`);
      }
    }
  } catch (e) {
    console.warn(`[parts-cost] ${month}: could not check for unclassified flagged vendors:`, e);
  }

  // costQuoted comes along now: it is the Parts Cost Quoted column on the
  // Projects tab, and it is what a job's FIRST parts month opens at.
  const jobs = await prisma.job.findMany({ where: etcActiveJobFilter, select: { id: true, jobId: true, costQuoted: true, startDate: true } });

  // Prior ETC = the app's own prior-month confirmed Parts New ETC (same chain
  // rule as hours and pools). NO prior entry -> the job's Parts Cost Quoted from
  // the Projects tab, which is the parts equivalent of what seeding already does
  // for hours (quoted hours when there is no ETC history — see seedMonth).
  //
  // It used to open at 0, on the reasoning that "a brand-new job's Parts New ETC
  // is manager-entered anyway". That was wrong twice over (found 2026-08-03):
  // Parts Cost Quoted IS the manager's entry, typed on the Projects tab; and
  // because the loop below skips any job with no balance and no spend, a job
  // starting this month got NO PARTS ROW AT ALL — nothing to plan, nothing to
  // review. Measured on July: 1164 ($1,336,100 quoted), 1165 ($50,000) and 1166
  // ($101,220) all had a quote on Projects and no parts row here.
  // EVERY earlier month, not just previousMonth (fixed 2026-08-04) — the same
  // correction latestPriorEtcByKey already made for hours, still outstanding
  // here. A job with no parts row in the immediately preceding month fell
  // through to `costQuoted` and REOPENED AT ITS FULL ORIGINAL QUOTE, wiping out
  // however far its parts balance had actually been worked down.
  //
  // Measured on July 2026: job 1105 had spent its parts budget down to a
  // confirmed 0 by May and had no June row, so July opened it at $636,234 —
  // a phantom balance larger than any real figure on the page. Job 979 was the
  // same at $8,600 (April confirmed 0). The `.has` check below reads as "a job
  // that confirmed 0 has finished buying and must not be reopened at its
  // quote", which was exactly right and exactly one month too short-sighted.
  const priorMonthParts = await prisma.etcEntry.findMany({
    where: { month: { lt: month }, section: PARTS_COST_SECTION },
    select: { jobId: true, section: true, month: true, newEtc: true },
  });
  const latestPartsByKey = latestPriorEtcByKey(priorMonthParts);

  let rowsUpserted = 0;

  // One PARTS_COST row per active job that has either an opening balance or
  // money spent this month — skip the all-zero jobs (nothing to show), same
  // spirit as the history backfill's skip rule.
  for (const job of jobs) {
    // A job whose Start Date falls IN this month opens at its quote, whatever the
    // chain says — the same rule seedMonth applies to hours, so both halves of a
    // job's first month agree. See the note there (jobs 1159/1160).
    const startsThisMonth = startsInMonth(job.startDate, month);
    // `undefined`, not `?? 0`: a job whose latest parts month genuinely
    // confirmed 0 has finished buying, and must NOT be reopened at its original
    // quote. Same precedence as hours — priorEtcForMonth in lib/etc.ts.
    const priorEtc = priorEtcForMonth({
      startsThisMonth,
      carried: latestPartsByKey.get(`${job.id}-${PARTS_COST_SECTION}`),
      quoted: Number(job.costQuoted ?? 0),
    });
    const moneySpent = spentByJobId.get(job.jobId) ?? 0;

    const existing = await prisma.etcEntry.findUnique({
      where: { jobId_section_month: { jobId: job.id, section: PARTS_COST_SECTION, month } },
      select: { needsReview: true, priorEtc: true, newEtcDraft: true },
    });

    if (existing) {
      // Re-checked per-row, same reason as syncHoursWorkedFromPowerBi: this
      // entry could have been submitted since the loop started.
      if (!existing.needsReview) continue;
    } else {
      if (priorEtc === 0 && moneySpent === 0) continue; // nothing worth a row yet
      // A brand-new needsReview:true row would silently "unlock" an otherwise
      // fully-locked month — refuse if the month is locked right now.
      const monthEntriesNow = await prisma.etcEntry.findMany({ where: { month }, select: { needsReview: true } });
      if (isMonthLocked(monthEntriesNow)) continue;
    }

    await prisma.etcEntry.upsert({
      where: { jobId_section_month: { jobId: job.id, section: PARTS_COST_SECTION, month } },
      // newEtc deliberately not written — same manager-entered rule as hours.
      update: {
        priorEtc,
        hoursWorked: moneySpent,
        hoursLeftCalc: round2(calcHoursLeft(priorEtc, moneySpent)),
        // A draft that merely echoed the suggestion from the OLD Prior ETC moves
        // with it (see redrivenDraft). This is where the stale zeros came from:
        // July's parts cells were saved while their Prior was still 0, and the
        // 0 outlived the figure it was derived from.
        //
        // Only written when this run actually read the row. If `existing` is null
        // the update branch can still fire — a concurrent writer created the row
        // between the read and here — and touching a draft this run never saw
        // would be guessing.
        //
        // And never on a breakout month, where the draft is DERIVED from Left to
        // Invoice + Left to Purchase rather than typed: redriving it would leave the
        // stored New ETC unequal to the two halves stored beside it, which the grid
        // would go on rendering correctly while the export and next month's Prior ETC
        // read the redriven figure. See isDerivedPartsDraft.
        ...(existing && !isDerivedPartsDraft(month, PARTS_COST_SECTION)
          ? {
              newEtcDraft: redrivenDraft({
                draft: existing.newEtcDraft != null ? Number(existing.newEtcDraft) : null,
                oldPriorEtc: Number(existing.priorEtc),
                newPriorEtc: priorEtc,
                hoursWorked: moneySpent,
              }),
            }
          : {}),
      },
      create: {
        jobId: job.id,
        section: PARTS_COST_SECTION,
        month,
        priorEtc,
        hoursWorked: moneySpent,
        hoursLeftCalc: round2(calcHoursLeft(priorEtc, moneySpent)),
        newEtc: priorEtc,
        needsReview: true,
      },
    });
    rowsUpserted++;
  }

  return { rowsUpserted };
}

// How current the underlying Paylocity feed itself is (distinct from when the app last
// asked) — the freshness figure managers see, rendered on the Monthly ETC header as
// "Hours through <date>". The latest Work Date in Lisa's workbook (the direct
// equivalent of the old [Hours Refreshed Thru] measure). Takes the already-fetched rows
// so it doesn't re-read the file.
//
// This is the figure that explains the §43 report: the app reads the file, the Power BI
// report reads a semantic model that refreshes separately, so the two are routinely at
// different vintages and the app is usually ahead. Measured 2026-08-05 — file through
// 08-04, model through 07-31, worth 138.83h of July Engineering alone.
async function syncHoursRefreshedThrough(rows: JobHoursRow[]): Promise<void> {
  const refreshedThrough = latestWorkDate(rows);
  if (!refreshedThrough) return;

  await prisma.powerBiFreshness.upsert({
    where: { source: "hours_actual" },
    // status: null clears any previously recorded failure — this pull just
    // proved the feed is healthy again.
    update: { refreshedThrough: new Date(refreshedThrough), checkedAt: new Date(), status: null },
    create: { source: "hours_actual", refreshedThrough: new Date(refreshedThrough) },
  });
}

// Marks a sync source healthy. `status: null` clears any recorded failure —
// this run just proved the path works again.
//
// Exported for auto-sync.ts, which stamps the sources whose own sync function
// has no natural "refreshed through" date of its own (parts, TotalETO jobs, the
// Scheduler roster) and passes the moment of the successful read. The hours
// sources deliberately stamp themselves instead: their refreshedThrough is the
// latest WORK DATE in the export, which says how current the data is rather than
// when we last asked — re-stamping those with `now` would throw that away.
export async function recordSyncSuccess(source: string, refreshedThrough: Date | null): Promise<void> {
  if (!refreshedThrough) return; // refreshedThrough is required; nothing to claim
  try {
    await prisma.powerBiFreshness.upsert({
      where: { source },
      update: { refreshedThrough, checkedAt: new Date(), status: null },
      create: { source, refreshedThrough },
    });
  } catch (err) {
    console.error(`[sync] could not record ${source} freshness: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// recordImportIssues() lived here until 2026-08-05. It wrote HoursImportIssue — the
// per-month/label TOTALS the KPI card reads — and nothing else, which is precisely why
// the drill-through had to recompute the punch rows from the source and could disagree
// with the card.
//
// Its replacement is recordUndefinedHours() in lib/paylocity-import.ts, which writes
// the totals AND the punch rows from one pass in one transaction. See §42.9-42.12 and
// the header of lib/unattributed-hours.ts.

// Records that an hours sync FAILED, so the staleness is visible in the app
// instead of only in a console log nobody reads. Without this, a broken feed
// leaves the last good "Hours Refreshed Thru" date sitting in the ETC header
// looking authoritative while the numbers behind it quietly age (exactly what
// happened 2026-07-24..29 — see job-hours-source.ts).
//
// Deliberately update-only, never create: refreshedThrough is required and a
// failed pull has no date to put there. If the row doesn't exist yet the feed
// has simply never succeeded, and there's no stale figure to warn about.
// Best-effort — a logging failure must never mask the original sync error.
// Records that a source is BLOCKED on something upstream rather than broken.
// The distinction is the point: a red "failed" for data the source has simply
// not published yet trains people to ignore red, while a green "ok" for a step
// that wrote nothing is the silent staleness this whole file exists to prevent.
// Readers key off the "Failed:" prefix, so this deliberately does not use it.
export async function recordSyncNote(source: string, note: string): Promise<void> {
  try {
    await prisma.powerBiFreshness.updateMany({
      where: { source },
      data: { status: `Waiting: ${note.slice(0, 300)}`, checkedAt: new Date() },
    });
  } catch (err) {
    console.error(`[sync] could not record ${source} note: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function recordSyncFailure(err: unknown, source = "hours_actual"): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  try {
    await prisma.powerBiFreshness.updateMany({
      where: { source },
      data: { status: `Failed: ${message.slice(0, 300)}`, checkedAt: new Date() },
    });
  } catch (writeErr) {
    // Best-effort, so still non-fatal — but NOT silent. A bare `catch {}` here
    // hid a real bug for weeks: `status` was varchar(191) while this writes up
    // to 308 chars, so every failure threw "value too long for the column's
    // type" and vanished. The header kept showing a confident last-good date
    // while the numbers aged, which is the exact outcome this function exists
    // to prevent. Widened to @db.Text 2026-07-31; the log stays so that if this
    // path ever breaks again it says so instead of pretending to work.
    console.error(
      `[sync] could not record the hours-sync failure (the failure itself is reported separately): ${
        writeErr instanceof Error ? writeErr.message : String(writeErr)
      }`
    );
  }
}
