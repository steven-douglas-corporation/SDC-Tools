// Acceptance test for the Total ETO refresh path (2026-09-09).
//
//   npx tsx --tsconfig tsconfig.scripts.json scripts/totaleto-acceptance.ts
//   npx tsx --tsconfig tsconfig.scripts.json scripts/totaleto-acceptance.ts --run
//   npx tsx --tsconfig tsconfig.scripts.json scripts/totaleto-acceptance.ts --run --passes 5
//
// Without --run it makes NO writes and starts no refresh: it reports each Total ETO
// source's health, proves the connection and the parameter binding, and reconciles the
// stored Parts Cost snapshot against Total ETO live. That half is safe at any time.
//
// With --run it also drives the real application refresh — the same entry point the
// Refresh Data button and the hourly schedule use — several times, back to back, and
// once twice at the same instant.
//
// ── The failure this exists to catch ────────────────────────────────────────
//
// For five days every MANUAL refresh reported "1 source failed: Parts cost (TotalETO)"
// while every HOURLY refresh of the same source succeeded — 59 of 80 manual passes.
// The cause was three bundled copies of mssql sharing one pool cache, so a typed
// parameter bound against a pool another copy had built died in ~15ms with
// "Validation failed for parameter 'start'". See lib/totaleto-connection.ts.
//
// Nothing in the unit suite could see it: it needs a real connection, a real pool, and
// two module instances. Hence a script, and hence the checks below being the specific
// ones they are — a plain "did the refresh work" would have passed throughout, because
// the hourly pass never stopped working.
import "dotenv/config";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "../src/lib/prisma";
import { refreshAllData, currentRefresh, recentRefreshRuns } from "../src/lib/refresh-service";
import { checkTotalEtoLogin, classifyTotalEto, describeTotalEtoFailure } from "../src/lib/totaleto-connection";
import { recentTotalEtoAttempts } from "../src/lib/totaleto-diagnostics";
import { getPartsCostBookedByJob } from "../src/lib/sync-totaleto";
import { TOTALETO_SOURCES } from "../src/lib/sync-schedule";
import { monthWindowUtc, isMonthLocked } from "../src/lib/etc";
import { PARTS_COST_SECTION } from "../src/lib/sections";

const RUN = process.argv.includes("--run");
const PASSES = Number(process.argv[process.argv.indexOf("--passes") + 1]) || 3;
// Which build to inspect. The live one by default; --dist lets a verification build
// (NEXT_DIST_DIR=.next-verify) be checked before it is deployed over the live one.
const DIST = process.argv.includes("--dist") ? process.argv[process.argv.indexOf("--dist") + 1] : ".next";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): boolean {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
  return ok;
}

const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function openMonth(): Promise<string | null> {
  // The same rule runAllSyncs applies, from the same helpers: a locked month is
  // frozen and no step touches it, so there is nothing to reconcile there either.
  const latest = await prisma.etcEntry.findFirst({ orderBy: { month: "desc" }, select: { month: true } });
  if (!latest) return null;
  const entries = await prisma.etcEntry.findMany({ where: { month: latest.month }, select: { needsReview: true } });
  return isMonthLocked(entries) ? null : latest.month;
}

// ── 0. ONE copy of mssql in the build that actually runs ────────────────────
//
// The check that would have caught the five-day outage, and the only one here that
// can: everything else in this script runs under tsx, where Node's require cache
// guarantees a single mssql instance no matter what the production bundle does. So
// the bundle has to be inspected as an artifact.
//
// The marker is mssql's own error string, which appears exactly once per copy of the
// library. Three chunks carried it on 2026-09-09; one is correct.
function checkBundle(distDir: string): void {
  console.log(`\n=== Bundled copies of mssql in ${distDir}/server ===`);
  const root = join(process.cwd(), distDir, "server");
  if (!existsSync(root)) {
    console.log(`  skip  no build at ${root} — run "npm run build" first`);
    return;
  }
  const MARKER = "SQL injection warning for param";
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      // .map files carry the same string as embedded source and would double every count.
      else if (entry.name.endsWith(".js") && readFileSync(full, "utf8").includes(MARKER)) hits.push(full);
    }
  };
  walk(root);
  check("mssql is bundled at most once", hits.length <= 1, `${hits.length} copies`);
  for (const h of hits) console.log(`      ${h.slice(root.length + 1)}`);
  if (hits.length > 1) {
    console.log(`      More than one copy means a pool built by one of them can be handed a`);
    console.log(`      parameter type from another — the exact fault this file was written for.`);
    console.log(`      "mssql" and "tedious" must be in serverExternalPackages (next.config.ts).`);
  }
}

// ── 1. Where each Total ETO source stands right now ─────────────────────────
//
// Printed first and never asserted on: this is the context every other result has
// to be read against. A parts_cost row whose status still says "Failed:" while its
// last successful pass was 40 minutes ago is stale, not broken, and those are
// different problems with different urgencies.
async function reportHealth(): Promise<void> {
  console.log(`\n=== Source health ===`);
  const rows = await prisma.powerBiFreshness.findMany();
  const runs = await recentRefreshRuns(20);
  for (const source of [...TOTALETO_SOURCES].sort()) {
    const row = rows.find((r) => r.source === source);
    const steps = runs.map((r) => ({ at: r.completedAt ?? r.startedAt, step: r.steps.find((s) => s.source === source) })).filter((x) => x.step);
    const lastOk = steps.find((x) => x.step!.status === "ok");
    const lastFail = steps.find((x) => x.step!.status === "failed");
    const streak = (() => {
      let n = 0;
      for (const x of steps) {
        if (x.step!.status !== "failed") break;
        n++;
      }
      return n;
    })();
    console.log(`  ${source}`);
    console.log(`      last checked   ${row?.checkedAt?.toISOString() ?? "never"}`);
    console.log(`      last success   ${lastOk?.at.toISOString() ?? "not in the last 20 passes"}`);
    console.log(`      last failure   ${lastFail?.at.toISOString() ?? "none in the last 20 passes"}${streak > 0 ? `  (failing ${streak} pass(es) in a row)` : ""}`);
    console.log(`      stored status  ${row?.status ?? "(clear)"}`);
    if (lastFail?.step?.kind) {
      console.log(`      cause          ${lastFail.step.kind}${lastFail.step.retryable === false ? " (retrying cannot fix this)" : ""}`);
    }
  }
}

// ── 2. Authentication, connection, and the parameter binding ────────────────
async function checkConnection(month: string | null): Promise<void> {
  console.log(`\n=== Connection ===`);
  const t0 = Date.now();
  const login = await checkTotalEtoLogin();
  if (!check("authenticates and opens a connection", login.ok, `${Date.now() - t0}ms`)) {
    console.log(`      ${login.ok === false ? login.detail : ""}`);
    return;
  }

  // The regression check. getPartsCostBookedByJob is THE query that failed for five
  // days, and it failed on `.input("start", sql.DateTime, ...)` rather than on
  // anything the login above can prove — so a green connection is not evidence and
  // this has to run the real statement.
  console.log(`\n=== Parameter binding (the five-day failure) ===`);
  if (!month) {
    console.log("  skip  no open ETC month, so there is no month window to bind");
    return;
  }
  const { start, endExclusive } = monthWindowUtc(month);
  const t1 = Date.now();
  try {
    const booked = await getPartsCostBookedByJob(start, endExclusive);
    const total = [...booked.net.values()].reduce((a, b) => a + b, 0);
    check(
      `binds @start/@end and returns ${month} spend`,
      booked.net.size > 0,
      `${booked.net.size} jobs, ${money(total)} net, ${Date.now() - t1}ms`,
    );
  } catch (error) {
    const kind = classifyTotalEto(error);
    check(`binds @start/@end and returns ${month} spend`, false, `${kind} after ${Date.now() - t1}ms`);
    console.log(`      ${describeTotalEtoFailure(error)}`);
    if (kind === "param_binding") {
      console.log(`      ^^ THIS IS THE REGRESSION. Two mssql instances are sharing one pool again:`);
      console.log(`         check serverExternalPackages in next.config.ts and the owner tag in`);
      console.log(`         lib/totaleto-connection.ts.`);
    }
  }
}

// ── 3. Overlapping refreshes must not both run ──────────────────────────────
//
// Two managers clicking together, or a click landing on the hourly tick. The lock is
// a single conditional UPDATE (refresh-service.ts), so the property to prove is that
// the second caller is REFUSED and told what is already running — not that it queues,
// and certainly not that it starts a second pass pulling the same sources into the
// same rows.
async function checkSingleFlight(): Promise<void> {
  console.log(`\n=== Overlapping refreshes (single-flight) ===`);
  const [a, b] = await Promise.all([
    refreshAllData({ trigger: "manual", userName: "acceptance-A" }),
    refreshAllData({ trigger: "manual", userName: "acceptance-B" }),
  ]);
  const outcomes = [a, b];
  const ran = outcomes.filter((o) => o.ok);
  const refused = outcomes.filter((o) => !o.ok && o.reason === "locked");
  check("exactly one of two simultaneous refreshes runs", ran.length === 1, `${ran.length} ran, ${refused.length} refused as locked`);
  check("the refused one says a refresh is already running", refused.length === 1, refused[0] && !refused[0].ok && refused[0].reason === "locked" ? `since ${refused[0].runningSince}` : "");
  const pass = ran[0];
  if (pass?.ok) reportPass("simultaneous pass", pass);
}

function reportPass(label: string, outcome: Extract<Awaited<ReturnType<typeof refreshAllData>>, { ok: true }>): void {
  const totalEto = outcome.sources.filter((s) => TOTALETO_SOURCES.has(s.source));
  const bad = totalEto.filter((s) => s.status === "failed");
  check(
    `${label}: all ${totalEto.length} Total ETO sources succeeded`,
    bad.length === 0,
    `${outcome.durationMs}ms, status ${outcome.status}`,
  );
  for (const f of bad) console.log(`      ${f.label}: [${f.kind ?? "unclassified"}] ${f.detail}`);
}

// ── 4. Repeated manual refreshes, back to back ──────────────────────────────
//
// The shape of the original complaint: click Refresh Data, get a failure, click
// again, get the same failure. One pass proving healthy proves nothing about that —
// the hourly pass was healthy throughout the outage. Several in a row is the test.
async function checkRepeatedRefreshes(): Promise<void> {
  console.log(`\n=== ${PASSES} manual refreshes in a row ===`);
  for (let i = 1; i <= PASSES; i++) {
    const outcome = await refreshAllData({ trigger: "manual", userName: `acceptance-${i}` });
    if (!outcome.ok) {
      check(`pass ${i} ran`, false, outcome.reason === "locked" ? `refused: already running since ${outcome.runningSince}` : outcome.message);
      continue;
    }
    reportPass(`pass ${i}`, outcome);
  }
}

// ── 5. The stored snapshot must equal Total ETO, job for job ────────────────
//
// syncPartsCost fetches the WHOLE month from Total ETO before it writes a single
// row, so a failed fetch writes nothing and the previous month's figures survive
// intact — that is the atomicity the refresh already has, and this is what proves it
// held: every job's stored Money Spent equals what Total ETO says right now.
//
// A disagreement here is one of exactly two things, and the output distinguishes
// them: a job whose stored figure is stale (the last successful pass predates a new
// AP document — expected, and bounded by the hourly interval), or a job the pass
// wrote WRONG (which is the serious one).
async function checkSnapshotIntegrity(month: string | null): Promise<void> {
  console.log(`\n=== Stored Parts Cost vs Total ETO live ===`);
  if (!month) {
    console.log("  skip  no open ETC month");
    return;
  }
  const { start, endExclusive } = monthWindowUtc(month);
  let live: Map<string, number>;
  try {
    live = (await getPartsCostBookedByJob(start, endExclusive)).net;
  } catch (error) {
    check("could read Total ETO to compare against", false, describeTotalEtoFailure(error));
    return;
  }

  const stored = await prisma.etcEntry.findMany({
    where: { month, section: PARTS_COST_SECTION },
    select: { hoursWorked: true, job: { select: { jobId: true } } },
  });
  const drifted: { jobId: string; stored: number; live: number }[] = [];
  for (const row of stored) {
    const jobId = row.job.jobId;
    const a = Number(row.hoursWorked ?? 0);
    const b = live.get(jobId) ?? 0;
    if (Math.abs(a - b) > 0.005) drifted.push({ jobId, stored: a, live: b });
  }
  check(
    `every stored ${month} Parts Cost row matches Total ETO`,
    drifted.length === 0,
    `${stored.length} rows compared${drifted.length ? `, ${drifted.length} differ` : ""}`,
  );
  for (const d of drifted.slice(0, 15)) {
    console.log(`      job ${d.jobId}: stored ${money(d.stored)} vs live ${money(d.live)}  (delta ${money(d.live - d.stored)})`);
  }
  if (drifted.length > 15) console.log(`      … and ${drifted.length - 15} more`);
  if (drifted.length > 0) {
    console.log(`      A difference is EXPECTED if AP documents were posted since the last`);
    console.log(`      successful parts_cost pass — that is ordinary staleness, bounded by the`);
    console.log(`      hourly interval. Run with --run and compare again: anything still`);
    console.log(`      differing after a successful pass is a genuine snapshot fault.`);
  }
}

// ── 6. What the attempts actually did ───────────────────────────────────────
function reportDiagnostics(): void {
  const attempts = recentTotalEtoAttempts();
  console.log(`\n=== Total ETO attempts recorded in this process (${attempts.length}) ===`);
  for (const a of attempts) {
    console.log(
      `  ${a.at}  ${a.ok ? "ok    " : "FAILED"} ${a.feed.padEnd(38)} ` +
        `stage=${a.stage.padEnd(12)} attempt=${a.attempt}/${a.attemptsAllowed} ${String(a.ms).padStart(6)}ms ` +
        `auth=${a.authenticated ? "y" : "n"} conn=${a.connectionOpened ? "y" : "n"} ` +
        `qStart=${a.queryStarted ? "y" : "n"} qDone=${a.queryCompleted ? "y" : "n"} cached=${a.usedCachedData ? "y" : "n"}` +
        (a.kind ? `  kind=${a.kind}` : "") +
        (a.code ? ` code=${a.code}` : "") +
        (a.sqlNumber != null ? ` sqlNumber=${a.sqlNumber}` : ""),
    );
  }
}

async function main() {
  const month = await openMonth();
  console.log(`Open ETC month: ${month ?? "(none — every month-scoped step is idle)"}`);

  checkBundle(DIST);
  await reportHealth();
  await checkConnection(month);

  if (RUN) {
    const before = await currentRefresh();
    if (before.running) {
      console.log(`\n  A refresh is already in flight (since ${before.since?.toISOString()}, stage "${before.stage}").`);
      console.log(`  Skipping the refresh half so this script does not just measure the lock.`);
    } else {
      await checkSingleFlight();
      await checkRepeatedRefreshes();
    }
  } else {
    console.log(`\n=== Refresh passes ===`);
    console.log("  skip  pass --run to drive real refreshes (writes to the app database)");
  }

  await checkSnapshotIntegrity(month);
  reportDiagnostics();

  console.log(`\n${failures === 0 ? "PASS — every check succeeded." : `FAIL — ${failures} check(s) failed.`}`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
