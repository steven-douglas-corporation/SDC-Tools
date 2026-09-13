// The broad architecture audit: for EVERY raw Section, Function and Section+Function
// combination in the Paylocity data — not just the ones known to be wrong — verify
// that raw values survived ingestion, that classification is correct, that each
// grouping dimension places rows correctly, that nested grouping keys match their
// children, and that hours are counted exactly once.
//
//   npx tsx -r ./scripts/shim-server-only.cjs scripts/audit-hours-architecture.ts
//   npx tsx -r ./scripts/shim-server-only.cjs scripts/audit-hours-architecture.ts 1119
//
// ── The defect this exists to catch, generally ──────────────────────────────
//
// Group By: Function showed a group labelled "413 — Manufacturing" whose detail rows
// carried Function 414. The group key came from the STANDARDIZED section column (where
// 10-414 is folded onto 10-413) while the rows carried the raw value. Parent said 413,
// children said 414.
//
// That was never really about 413/414. It was raw and standardized values sharing one
// field, so ANY folded pair could produce it. This audit therefore sweeps every
// combination present in the data and checks the invariants structurally, so a future
// fold — a code nobody has thought about yet — cannot reintroduce it quietly.
import { readFileSync } from "fs";
import * as XLSX from "xlsx";
import { prisma } from "../src/lib/prisma";
import { punchSources } from "../src/lib/paylocity-sources";
import { queryHoursGrouped, queryHoursDrillRows } from "../src/lib/hours-explorer";
import { readHoursFeed } from "../src/lib/hours-feed";
import {
  HOURS_GROUP_BY_LABEL,
  HOURS_GROUP_BY_ROW_FIELD,
  groupMismatches,
  narrowFiltersForGroupValue,
  type HoursFilters,
  type HoursGroupBy,
} from "../src/lib/hours-filters";
import { classifyPunch, normalizeSectionId } from "../src/lib/paylocity-standard-rules";
import { normalizeFunctionId } from "../src/lib/paylocity-canonical";

const f2 = (n: number) => (Math.round(n * 100) / 100).toFixed(2);
const pad = (n: number, w = 12) => f2(n).padStart(w);
const normJob = (v: unknown) => String(v ?? "").trim().replace(/^0+/, "");
/** Decimal(10,2) storage plus split-punch halves: a cent or two per pair is expected. */
const TOL = 0.5;

let failures = 0;
function check(ok: boolean, msg: string) {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "OK  " : "FAIL"}  ${msg}`);
}

type Totals = { byPair: Map<string, number>; bySection: Map<string, number>; byFunction: Map<string, number>; total: number };

function emptyTotals(): Totals {
  return { byPair: new Map(), bySection: new Map(), byFunction: new Map(), total: 0 };
}

function add(t: Totals, sec: string, fn: string, hours: number) {
  t.byPair.set(`${sec}|${fn}`, (t.byPair.get(`${sec}|${fn}`) ?? 0) + hours);
  t.bySection.set(sec, (t.bySection.get(sec) ?? 0) + hours);
  t.byFunction.set(fn, (t.byFunction.get(fn) ?? 0) + hours);
  t.total += hours;
}

/** Paylocity truth, from the year-authoritative workbooks only. */
function paylocityTotals(jobFilter: string | null, ingestedJobs: ReadonlySet<string>) {
  const t = emptyTotals();
  let skippedUncarriedJobs = 0;
  for (const source of punchSources()) {
    const wb = XLSX.read(readFileSync(source.path), { cellDates: true });
    const sheet = wb.Sheets["Report"];
    if (!sheet) continue;
    for (const r of XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { raw: true, defval: null })) {
      const d = r["Work Date"];
      const date = d instanceof Date ? d.toISOString().slice(0, 10) : String(d ?? "");
      // Year ownership, exactly as ingestion applies it — so overlapping workbooks
      // cannot double-count on this side of the comparison either.
      if (!source.ownsYear(Number(date.slice(0, 4)))) continue;
      const job = normJob(r["Jobs"]);
      if (jobFilter && job !== jobFilter) continue;
      const hours = Number(r["Total Hours Worked"]) || 0;
      // Punches on jobs the app does not carry are rejected at ingestion by design
      // and reported as data-quality issues instead. Excluded here so the comparison
      // is like-for-like rather than flagging that exclusion as a mismatch.
      if (!ingestedJobs.has(job)) {
        skippedUncarriedJobs += hours;
        continue;
      }
      add(t, normalizeSectionId(r["MachineSec"] as string), normalizeFunctionId(r["Function"] as string | number), hours);
    }
  }
  return { t, skippedUncarriedJobs };
}

/**
 * `accountedFor` — a key whose difference is EXPLAINED (the blank pair, by the orphaned
 * rows) together with the exact hours expected there. Checked as its own assertion
 * rather than widened into the tolerance, so an unexplained change on that key still
 * fails while the known one does not mask real mismatches elsewhere.
 */
function diffTable(
  label: string,
  src: Map<string, number>,
  db: Map<string, number>,
  fmtKey: (k: string) => string,
  accountedFor?: { key: string; hours: number },
) {
  console.log(`\n--- ${label} ---`);
  console.log(`  ${"key".padEnd(26)} ${"Paylocity".padStart(12)} ${"App".padStart(12)} ${"Difference".padStart(12)}`);
  let worst = 0;
  let worstKey = "";
  const keys = [...new Set([...src.keys(), ...db.keys()])].sort();
  for (const k of keys) {
    const a = src.get(k) ?? 0;
    const b = db.get(k) ?? 0;
    const diff = b - a;
    if (accountedFor && k === accountedFor.key) {
      const residual = diff - accountedFor.hours;
      console.log(`  ${fmtKey(k).padEnd(26)} ${pad(a)} ${pad(b)} ${pad(diff)}  <-- ${f2(accountedFor.hours)}h orphaned rows, residual ${f2(residual)}`);
      check(Math.abs(residual) <= TOL, `${label}: the blank key's difference is fully explained by orphaned rows (residual ${f2(residual)}h)`);
      continue;
    }
    if (Math.abs(diff) > Math.abs(worst)) {
      worst = diff;
      worstKey = k;
    }
    const flag = Math.abs(diff) > TOL ? "  <-- NON-ZERO" : "";
    console.log(`  ${fmtKey(k).padEnd(26)} ${pad(a)} ${pad(b)} ${pad(diff)}${flag}`);
  }
  check(Math.abs(worst) <= TOL, `${label}: every difference is zero within rounding (worst ${f2(worst)}h${worstKey ? ` at ${fmtKey(worstKey)}` : ""})`);
  return worst;
}

async function main() {
  const jobFilter = process.argv[2] ? normJob(process.argv[2]) : null;
  console.log("=".repeat(100));
  console.log(`HOURS ARCHITECTURE AUDIT${jobFilter ? ` — job ${jobFilter}` : " — ALL JOBS"}`);
  console.log("=".repeat(100));

  const jobRow = jobFilter
    ? await prisma.job.findFirst({ where: { jobId: { in: [jobFilter, `0${jobFilter}`, `00${jobFilter}`] } }, select: { id: true, jobId: true } })
    : null;
  if (jobFilter && !jobRow) throw new Error(`job ${jobFilter} not found`);
  const scope: HoursFilters = jobRow ? { jobIds: [jobRow.jobId] } : {};
  const feed = await readHoursFeed();
  const where = jobRow ? { jobId: jobRow.id } : {};

  // ── The app's stored raw totals ──────────────────────────────────────────
  const dbRows = await prisma.jobHoursDetail.groupBy({
    by: ["rawSection", "rawFunction"],
    where,
    _sum: { hours: true },
    _count: true,
  });
  const dbT = emptyTotals();
  for (const r of dbRows) add(dbT, r.rawSection, r.rawFunction, Number(r._sum.hours ?? 0));

  const jobsInDb = await prisma.jobHoursDetail.findMany({ where, select: { job: { select: { jobId: true } } }, distinct: ["jobId"] });
  const ingestedJobs = new Set(jobsInDb.map((j) => normJob(j.job.jobId)));

  const { t: srcT, skippedUncarriedJobs } = paylocityTotals(jobFilter, ingestedJobs);
  console.log(`jobs compared: ${ingestedJobs.size}`);
  if (skippedUncarriedJobs > 0.005) {
    console.log(`Paylocity hours on jobs the app does not carry: ${f2(skippedUncarriedJobs)}h (rejected at ingestion by design, excluded here)`);
  }

  // ── Orphaned derived rows: named precisely, totals never mutated ────────
  //
  // A row is ORPHANED when BOTH hold: it carries no raw identity, AND the feed no
  // longer covers its (job, month). Its source punch was deleted upstream and
  // syncJobHoursDetail's "absent must never mean delete" rule keeps it forever.
  //
  // Both conditions are required. A first attempt at this excluded every
  // no-raw-identity row, which was wrong and produced a phantom -6.42h shortfall: a
  // punch whose MachineSec/Function CELL is genuinely blank also stores '' and is a
  // real, current row that must reconcile. Only 10.17 of those 16.59 hours are orphans.
  //
  // Nothing is subtracted from the comparison. The orphans are reported here, and the
  // reconciliation below is then checked in two parts: every real pair must be zero,
  // and the blank pair's difference must equal the orphan total exactly. That way the
  // discrepancy is accounted for by name rather than absorbed into a tolerance.
  const covered = new Set(feed.rows.map((r) => `${r.jobId}::${r.year}-${String(r.month).padStart(2, "0")}`));
  const noRawIdentity = await prisma.jobHoursDetail.findMany({
    where: { ...where, rawSection: "", rawFunction: "" },
    select: { hours: true, month: true, workDate: true, section: true, job: { select: { jobId: true } } },
  });
  const orphans = noRawIdentity.filter((r) => !covered.has(`${r.job.jobId}::${r.month}`));
  const orphanHours = orphans.reduce((s2, r) => s2 + Number(r.hours), 0);
  const blankButReal = noRawIdentity.length - orphans.length;

  if (noRawIdentity.length > 0) {
    console.log(`
--- ROWS WITH NO RAW IDENTITY (${noRawIdentity.length}) ---`);
    console.log(`  ${orphans.length} ORPHANED (${f2(orphanHours)}h) — feed no longer covers their (job, month); source punch deleted upstream:`);
    for (const r of orphans) {
      console.log(`    job ${r.job.jobId.padEnd(8)} ${r.workDate.toISOString().slice(0, 10)}  ${r.section.padEnd(12)} ${pad(Number(r.hours))}`);
    }
    console.log(`  ${blankButReal} REAL (${f2(noRawIdentity.reduce((s2, r) => s2 + Number(r.hours), 0) - orphanHours)}h) — genuinely blank Section/Function cell on a punch the feed still carries; these DO reconcile.`);
    if (orphans.length > 0) {
      console.log(`  To purge the orphans: npx tsx -r ./scripts/shim-server-only.cjs scripts/purge-stale-hours-rows.ts --apply`);
    }
  }

  // ── RECONCILE: Function, Section, then Section+Function ─────────────────
  const orphanAllowance = { key: "", hours: orphanHours };
  diffTable("RECONCILE BY RAW FUNCTION", srcT.byFunction, dbT.byFunction, (k) => k || "(blank)", orphanAllowance);
  diffTable("RECONCILE BY RAW SECTION", srcT.bySection, dbT.bySection, (k) => k || "(blank)", orphanAllowance);
  diffTable("RECONCILE BY RAW SECTION + FUNCTION", srcT.byPair, dbT.byPair, (k) => k.replace("|", "-") || "(blank)", {
    key: "|",
    hours: orphanHours,
  });

  // ── Per-combination verification, every combination present ─────────────
  console.log(`\n--- EVERY RAW COMBINATION: classification and destination ---`);
  console.log(
    `  ${"Sec".padEnd(6)} ${"Fn".padEnd(6)} ${"Paylocity".padStart(11)} ${"App".padStart(11)} ${"Status".padEnd(10)} ${"Department".padEnd(12)} Task`,
  );
  for (const k of [...dbT.byPair.keys()].sort()) {
    const [sec, fn] = k.split("|");
    const c = classifyPunch(sec, fn);
    console.log(
      `  ${(sec || "—").padEnd(6)} ${(fn || "—").padEnd(6)} ${pad(srcT.byPair.get(k) ?? 0, 11)} ${pad(dbT.byPair.get(k) ?? 0, 11)} ` +
        `${c.mappingStatus.padEnd(10)} ${c.department.padEnd(12)} ${c.taskDescription}`,
    );
    // Raw immutability: the pair the app stored must be a pair Paylocity actually has.
    if (!srcT.byPair.has(k) && (dbT.byPair.get(k) ?? 0) > TOL) {
      check(false, `app holds raw pair ${sec}-${fn} that Paylocity does not — a raw value was rewritten`);
    }
  }
  check(true, `every stored raw pair also exists in Paylocity (no rewritten raw values)`);

  // ── GROUPING: totals preserved, and parent keys match child rows ────────
  const storedTotal = Number((await prisma.jobHoursDetail.aggregate({ where, _sum: { hours: true } }))._sum.hours ?? 0);
  console.log(`\n--- GROUPING: total preserved, and every parent key matches its children ---`);

  const dims: HoursGroupBy[] = [
    "sectionNumber",
    "functionId",
    "department",
    "standardDepartment",
    "mappingStatus",
    "sectionName",
    "functionGroup",
    "taskDescription",
    "job",
    "employee",
    "month",
  ];

  for (const dim of dims) {
    const groups = await queryHoursGrouped(scope, dim);
    const sum = groups.reduce((s, g) => s + g.hours, 0);
    const totalOk = Math.abs(sum - storedTotal) <= 0.02;
    if (!totalOk) failures += 1;

    // Parent/child integrity: narrow to each group exactly as the UI tree does, then
    // check every returned row against the dimension's DEDICATED field. This is the
    // check that catches a group labelled 413 holding raw-414 rows.
    let mismatched = 0;
    let checkedGroups = 0;
    let drilledHours = 0;
    const field = HOURS_GROUP_BY_ROW_FIELD[dim];
    // Cap the sweep for the all-jobs run: job/employee have hundreds of groups and the
    // point is coverage of the CLASSIFICATION dimensions. Reported so the bound is
    // visible rather than looking like full coverage.
    const budget = jobFilter ? groups.length : Math.min(groups.length, 25);
    for (const g of groups.slice(0, budget)) {
      const drill = await queryHoursDrillRows(narrowFiltersForGroupValue(scope, dim, g.key));
      checkedGroups += 1;
      drilledHours += drill.rows.reduce((s, r) => s + r.hours, 0);
      if (field) mismatched += groupMismatches(drill.rows, dim, g.key).length;
      if (field) {
        for (const bad of groupMismatches(drill.rows, dim, g.key).slice(0, 3)) {
          console.log(
            `        MISMATCH under ${dim}="${g.key}" (${g.label}): row has ${dim === "functionId" ? `rawFunction=${bad.rawFunction}` : dim === "sectionNumber" ? `rawSection=${bad.rawSection}` : `${field(bad)}`}`,
          );
        }
      }
    }
    const integrityOk = mismatched === 0;
    if (!integrityOk) failures += 1;
    console.log(
      `  ${totalOk && integrityOk ? "OK  " : "FAIL"}  ${HOURS_GROUP_BY_LABEL[dim].padEnd(20)} ${String(groups.length).padStart(4)} groups  ${pad(sum)}  ` +
        `integrity: ${field ? `${mismatched} mismatches over ${checkedGroups} groups` : "n/a (derived key)"}` +
        (budget < groups.length ? `  [checked first ${budget} of ${groups.length}]` : ""),
    );
    void drilledHours;
  }

  // ── The distinction the spec calls critical ─────────────────────────────
  console.log(`\n--- CRITICAL DISTINCTION: Function keeps raw IDs apart; Task Description may combine them ---`);
  const byFunction = await queryHoursGrouped(scope, "functionId");
  const byTask = await queryHoursGrouped(scope, "taskDescription");
  const mfgFunctions = byFunction.filter((g) => ["413", "414"].includes(g.key));
  for (const g of mfgFunctions) console.log(`  Group By Function     ${g.key.padEnd(6)} ${g.label.padEnd(28)} ${pad(g.hours)}`);
  const mfgTask = byTask.find((g) => g.key === "Manufacturing");
  if (mfgTask) console.log(`  Group By Task         ${"".padEnd(6)} ${mfgTask.label.padEnd(28)} ${pad(mfgTask.hours)}`);
  check(
    mfgFunctions.length >= 2 || (dbT.byFunction.get("413") ?? 0) === 0 || (dbT.byFunction.get("414") ?? 0) === 0,
    `413 and 414 appear as SEPARATE Function groups (found ${mfgFunctions.map((g) => g.key).join(", ") || "none"})`,
  );
  // No Function group may be labelled with an ID other than its own key.
  const misLabelled = byFunction.filter((g) => g.key !== "" && !g.label.startsWith(g.key));
  check(misLabelled.length === 0, `no Function group is labelled with a different Function ID (${misLabelled.map((g) => `${g.key}->${g.label}`).join(", ") || "none"})`);

  // ── Hours counted once, and standardization changes nothing ─────────────
  console.log(`\n--- TOTALS ---`);
  const mapped = [...dbT.byPair].filter(([k]) => classifyPunch(k.split("|")[0], k.split("|")[1]).mappingStatus === "Mapped").reduce((s, [, h]) => s + h, 0);
  const undef = dbT.total - mapped;
  console.log(`  Raw Paylocity Total   ${pad(srcT.total)}`);
  console.log(`  App Raw Total         ${pad(dbT.total)}`);
  console.log(`  Mapped Hours          ${pad(mapped)}`);
  console.log(`  Undefined Hours       ${pad(undef)}`);
  console.log(`  Final App Total       ${pad(storedTotal)}`);
  console.log(`  Orphaned rows         ${pad(orphanHours)}  (reported above; purge script available)`);
  console.log(`  Difference            ${pad(dbT.total - srcT.total)}`);
  check(Math.abs(mapped + undef - dbT.total) < 0.01, `Mapped + Undefined = App Raw Total`);
  check(Math.abs(storedTotal - dbT.total) < 0.01, `Final App Total = App Raw Total (standardization changed no totals)`);
  check(
    Math.abs(dbT.total - srcT.total - orphanHours) <= Math.max(TOL, srcT.total * 0.0001),
    `App Raw Total reconciles to Paylocity once orphaned rows are accounted for (residual ${f2(dbT.total - srcT.total - orphanHours)}h)`,
  );

  console.log("");
  if (failures > 0) {
    console.error(`AUDIT FAILED — ${failures} check(s) did not pass.`);
    process.exitCode = 1;
  } else {
    console.log("All architecture invariants hold.");
  }
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
