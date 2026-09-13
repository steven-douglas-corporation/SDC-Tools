// Record-level reconciliation of the raw Paylocity sources against the approved
// Section+Function rule book. Run with:
//
//   npx tsx scripts/reconcile-paylocity-standard.ts            # whole file
//   npx tsx scripts/reconcile-paylocity-standard.ts 1119       # one job, with the audit table
//
// ── Why this script exists ──────────────────────────────────────────────────
//
// Written 2026-08-21 after a reported 23-hour gap on job 1119 between an Excel
// PivotTable over the Paylocity punch export and the figure this app showed. The
// gap was real but not a bug: the two sides were reading DIFFERENT FILES at
// different grains. This script makes that comparison mechanical and repeatable
// so the next such report takes minutes, not an afternoon.
//
//   "Punch Detail - Jobs (NNNNN).xls"   one row per punch; has `Regular Duration
//                                       (Hours)` and `OT1 Duration (Hours)` as
//                                       SEPARATE columns; covers whatever range
//                                       was requested when it was exported.
//
//   Current_Job_Hours.xlsx              what the app actually reads. Pre-aggregated
//                                       per employee/day/job/section, with ONE
//                                       duration column, `Total Hours Worked`,
//                                       which equals Regular + OT1. Current year
//                                       only.
//
// So a pivot on `Regular Duration` alone will always read LOW against the app by
// exactly the OT1 hours, and a pivot over a wider date range will read HIGH by
// whatever falls outside the current-year file. Both are reported separately
// below rather than netted, because netting them is how the two effects hid each
// other in the original report.
//
// It deliberately imports the real classifier rather than re-stating the rules,
// so this script cannot drift from what the app does.
import { readFileSync, readdirSync } from "fs";
import path from "path";
import * as XLSX from "xlsx";
import {
  RECONCILIATION_BUCKETS,
  bucketHours,
  classifyPunch,
  normalizeSectionId,
  totalOf,
  type BucketTotals,
} from "../src/lib/paylocity-standard-rules";
import { normalizeFunctionId } from "../src/lib/paylocity-canonical";

const APP_SOURCE =
  process.env.JOB_HOURS_LOCAL_PATH?.trim() ||
  "C:/Users/akamuju/OneDrive - Steven Douglas Corp/SDC- Power BI Integration - Job Hours Report/Job Hours From Paylocity/Current_Job_Hours.xlsx";

const r2 = (n: number) => Math.round(n * 100) / 100;
const f2 = (n: number) => r2(n).toFixed(2);
const pad = (n: number, w = 10) => f2(n).padStart(w);

/** Job numbers are written three ways across the sources ("1119", "01119", 1119). */
const normJob = (v: unknown) => String(v ?? "").trim().replace(/^0+/, "");

type Punch = {
  job: string;
  date: string;
  employee: string;
  section: string;
  fn: string;
  /** Regular only — what an Excel pivot on `Regular Duration (Hours)` sums. */
  regular: number;
  /** Regular + OT1 — what the app's `Total Hours Worked` holds. */
  total: number;
};

const asDate = (v: unknown) =>
  v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? "").slice(0, 10);

// ── Source A: the punch-detail export (raw, one row per punch) ──────────────
//
// Header row is not row 1 — the export carries a company/report/date-range
// banner above it — so the header is located by content rather than by index,
// which also means a future export that gains or loses a banner line still parses.
function readPunchDetail(file: string): Punch[] {
  const wb = XLSX.read(readFileSync(file), { cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: null });

  const norm = (h: unknown) => String(h ?? "").replace(/\s+/g, " ").trim();
  const headerAt = grid.findIndex((row) => row?.some((c) => norm(c) === "Regular Duration (Hours)"));
  if (headerAt < 0) throw new Error(`${file}: no "Regular Duration (Hours)" column found`);
  const header = grid[headerAt].map(norm);
  const col = (name: string) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`${file}: missing column "${name}"`);
    return i;
  };
  const C = {
    last: col("Last Name"),
    first: col("Preferred / First Name"),
    date: col("Work Date"),
    reg: col("Regular Duration (Hours)"),
    ot: col("OT1 Duration (Hours)"),
    job: col("Jobs"),
    fn: col("Function"),
    sec: col("MachineSec"),
  };

  const out: Punch[] = [];
  for (let i = headerAt + 1; i < grid.length; i++) {
    const row = grid[i];
    if (!row) continue;
    // Group/subtotal rows carry no Jobs value. Guarded rather than assumed: a
    // blank-Jobs row that DOES carry hours would be silently dropped here, so
    // that case is counted and reported instead.
    const job = normJob(row[C.job]);
    const regular = Number(row[C.reg]) || 0;
    const total = regular + (Number(row[C.ot]) || 0);
    if (!job) {
      if (regular || total) droppedBlankJob.push({ line: i + 1, hours: total });
      continue;
    }
    out.push({
      job,
      date: asDate(row[C.date]),
      employee: `${String(row[C.last] ?? "").trim()}, ${String(row[C.first] ?? "").trim()}`,
      section: normalizeSectionId(row[C.sec] as string),
      fn: normalizeFunctionId(row[C.fn] as string | number),
      regular,
      total,
    });
  }
  return out;
}

const droppedBlankJob: { line: number; hours: number }[] = [];

// ── Source B: Current_Job_Hours.xlsx — what the app actually reads ──────────
function readAppSource(file: string): Punch[] {
  const wb = XLSX.read(readFileSync(file), { cellDates: true });
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[wb.SheetNames[0]], {
    raw: true,
    defval: null,
  });
  return rows.map((r) => {
    // One duration column here, already Regular+OT1 — so `regular` is genuinely
    // unavailable from this file and is reported as the same value rather than
    // silently invented as something smaller.
    const hours = Number(r["Total Hours Worked"]) || 0;
    return {
      job: normJob(r["Jobs"]),
      date: asDate(r["Work Date"]),
      employee: String(r["Employee Id"] ?? ""),
      section: normalizeSectionId(r["MachineSec"] as string),
      fn: normalizeFunctionId(r["Function"] as string | number),
      regular: hours,
      total: hours,
    };
  });
}

function findPunchDetail(): string | null {
  const hits = readdirSync(process.cwd()).filter((f) => /^Punch Detail.*\.xls$/i.test(f));
  return hits.length ? path.join(process.cwd(), hits[0]) : null;
}

// ── Reporting helpers ───────────────────────────────────────────────────────

function buckets(rows: Punch[], hours: (p: Punch) => number): BucketTotals {
  return bucketHours(rows, (r) => r.section, (r) => r.fn, hours);
}

function printBuckets(label: string, rows: Punch[], hours: (p: Punch) => number) {
  const t = buckets(rows, hours);
  const raw = rows.reduce((s, r) => s + hours(r), 0);
  console.log(`\n${label}`);
  for (const b of RECONCILIATION_BUCKETS) {
    const share = raw ? ((100 * t[b]) / raw).toFixed(1) : "0.0";
    console.log(`  ${b.padEnd(12)} ${pad(t[b])}  ${share.padStart(5)}%`);
  }
  console.log(`  ${"TOTAL".padEnd(12)} ${pad(totalOf(t))}`);
  // The acceptance criterion, asserted rather than eyeballed.
  const drift = Math.abs(totalOf(t) - raw);
  console.log(
    `  identity PM+Eng+Shop+Undefined = raw : ${drift < 1e-6 ? "OK" : `FAILED (drift ${drift})`} (raw ${f2(raw)})`,
  );
  if (drift >= 1e-6) process.exitCode = 1;
}

function groupSum(rows: Punch[], key: (p: Punch) => string, hours: (p: Punch) => number) {
  const m = new Map<string, number>();
  for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + hours(r));
  return m;
}

function printUndefinedRanking(rows: Punch[], hours: (p: Punch) => number, limit = 25) {
  const undef = rows.filter((r) => classifyPunch(r.section, r.fn).department === "Undefined");
  const byPair = [...groupSum(undef, (r) => `${r.section}-${r.fn}`, hours)].sort((a, b) => b[1] - a[1]);
  console.log(`\n  Undefined by raw Section-Function (top ${limit} of ${byPair.length}):`);
  for (const [pair, h] of byPair.slice(0, limit)) {
    const reason = classifyPunch(pair.split("-")[0], pair.split("-")[1]).undefinedReason;
    const jobs = new Set(undef.filter((r) => `${r.section}-${r.fn}` === pair).map((r) => r.job));
    console.log(`   ${pair.padEnd(12)} ${pad(h)}  ${String(reason).padEnd(18)} ${jobs.size} job(s)`);
  }
  const shown = byPair.slice(0, limit).reduce((s, [, h]) => s + h, 0);
  const all = byPair.reduce((s, [, h]) => s + h, 0);
  if (byPair.length > limit) console.log(`   ${"(remainder)".padEnd(12)} ${pad(all - shown)}`);
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  const jobFilter = process.argv[2] ? normJob(process.argv[2]) : null;

  const appAll = readAppSource(APP_SOURCE);
  const punchFile = findPunchDetail();
  const punchAll = punchFile ? readPunchDetail(punchFile) : [];

  console.log("=".repeat(78));
  console.log("PAYLOCITY STANDARDIZATION RECONCILIATION");
  console.log("=".repeat(78));
  console.log(`app source   : ${APP_SOURCE}`);
  console.log(`punch detail : ${punchFile ?? "(none found in cwd — raw-vs-app comparison skipped)"}`);
  if (jobFilter) console.log(`job filter   : ${jobFilter}`);
  if (droppedBlankJob.length) {
    console.log(
      `WARNING: ${droppedBlankJob.length} punch-detail row(s) carried hours but no Jobs value ` +
        `(${f2(droppedBlankJob.reduce((s, d) => s + d.hours, 0))}h) — these are excluded`,
    );
  }

  const app = jobFilter ? appAll.filter((r) => r.job === jobFilter) : appAll;
  const punch = jobFilter ? punchAll.filter((r) => r.job === jobFilter) : punchAll;

  // ── Step 1/2: raw ingestion and raw Function totals ──────────────────────
  if (punch.length) {
    const reg = punch.reduce((s, r) => s + r.regular, 0);
    const tot = punch.reduce((s, r) => s + r.total, 0);
    const dates = punch.map((r) => r.date).sort();
    console.log(`\n--- RAW PUNCH DETAIL (${punch.length} punches, ${dates[0]} -> ${dates[dates.length - 1]}) ---`);
    console.log(`  SUM Regular Duration (Hours)   ${pad(reg)}   <- what an Excel pivot on Regular sums`);
    console.log(`  SUM OT1 Duration (Hours)       ${pad(tot - reg)}   <- EXCLUDED by such a pivot, INCLUDED by the app`);
    console.log(`  SUM Regular + OT1              ${pad(tot)}   <- the app's "Total Hours Worked" basis`);

    console.log(`\n  raw Function -> Regular | Regular+OT1`);
    const byReg = groupSum(punch, (r) => r.fn, (r) => r.regular);
    const byTot = groupSum(punch, (r) => r.fn, (r) => r.total);
    for (const fn of [...byReg.keys()].sort()) {
      console.log(`   ${fn.padEnd(6)} ${pad(byReg.get(fn)!)} ${pad(byTot.get(fn)!)}`);
    }

    console.log(`\n  raw Section-Function -> Regular | Regular+OT1 | rule-book destination`);
    const pReg = groupSum(punch, (r) => `${r.section}-${r.fn}`, (r) => r.regular);
    const pTot = groupSum(punch, (r) => `${r.section}-${r.fn}`, (r) => r.total);
    for (const key of [...pReg.keys()].sort()) {
      const [s, f] = key.split("-");
      const c = classifyPunch(s, f);
      const dest = c.department === "Undefined" ? `Undefined (${c.undefinedReason})` : `${c.department} / ${c.taskDescription}`;
      console.log(`   ${key.padEnd(10)} ${pad(pReg.get(key)!)} ${pad(pTot.get(key)!)}  ${dest}`);
    }

    printBuckets("  RULE BOOK APPLIED (punch detail, Regular+OT1):", punch, (r) => r.total);

    // ── Step 5/6/7: where the two sources genuinely differ ────────────────
    const appDates = app.map((r) => r.date).sort();
    const cut = appDates[0];
    if (cut) {
      const outside = punch.filter((r) => r.date < cut);
      console.log(`\n--- WHY THE TWO SOURCES DIFFER (not a bug — different files) ---`);
      console.log(`  app source covers ${cut} -> ${appDates[appDates.length - 1]}`);
      console.log(`  punch rows BEFORE that window : ${outside.length} (${f2(outside.reduce((s, r) => s + r.total, 0))}h)`);
      console.log(`    ^ held in the DB from an earlier backfill, absent from the current-year file`);
      const inWindow = punch.filter((r) => r.date >= cut);
      console.log(`  OT1 inside the window         : ${f2(inWindow.reduce((s, r) => s + (r.total - r.regular), 0))}h`);
      console.log(`    ^ the app counts these; a Regular-only pivot does not`);
      const appTot = app.reduce((s, r) => s + r.total, 0);
      const punchInTot = inWindow.reduce((s, r) => s + r.total, 0);
      console.log(`  app source total in window    : ${f2(appTot)}`);
      console.log(`  punch total in window         : ${f2(punchInTot)}`);
      console.log(`  residual (export vintage lag) : ${f2(appTot - punchInTot)}`);
      console.log(`    ^ punches recorded after the punch export was taken`);
    }
  }

  // ── The app source, under the rule book ──────────────────────────────────
  console.log(`\n--- APP SOURCE (${app.length} rows) ---`);
  printBuckets("  RULE BOOK APPLIED (app source, Total Hours Worked):", app, (r) => r.total);
  printUndefinedRanking(app, (r) => r.total, jobFilter ? 50 : 25);

  // ── Step 3: the per-punch audit table (single job only — it is long) ─────
  if (jobFilter) {
    console.log(`\n--- AUDIT TABLE, job ${jobFilter} (app source) ---`);
    console.log(
      `  ${"Employee".padEnd(10)} ${"Date".padEnd(11)} ${"Hours".padStart(7)} ${"RawSec".padEnd(7)} ${"RawFn".padEnd(6)} ${"Department".padEnd(12)} ${"FunctionGroup".padEnd(24)} ${"Task".padEnd(24)} Status`,
    );
    const sorted = [...app].sort((a, b) => a.date.localeCompare(b.date) || a.employee.localeCompare(b.employee));
    for (const p of sorted) {
      const c = classifyPunch(p.section, p.fn);
      console.log(
        `  ${p.employee.padEnd(10)} ${p.date.padEnd(11)} ${f2(p.total).padStart(7)} ${p.section.padEnd(7)} ${p.fn.padEnd(6)} ${c.department.padEnd(12)} ${c.functionGroup.padEnd(24)} ${c.taskDescription.padEnd(24)} ${c.mappingStatus}`,
      );
    }
  }

  console.log("");
}

main();
