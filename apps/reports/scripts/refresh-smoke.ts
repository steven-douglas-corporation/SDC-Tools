// Exercises the application-wide refresh (§25) against the REAL database: the lock, the
// run record, and the honest status. Unit tests cannot reach any of it — every property
// that matters here is a property of concurrent database state.
//
//   npx tsx --tsconfig tsconfig.scripts.json scripts/refresh-smoke.ts            # lock only
//   npx tsx --tsconfig tsconfig.scripts.json scripts/refresh-smoke.ts --run      # a real pass
//
// Without --run it does NOT pull from any upstream source: it takes the lock, checks that
// a second attempt is refused, and releases it. That half is safe to run any time.
import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { refreshAllData, currentRefresh, recentRefreshRuns } from "../src/lib/refresh-service";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// The lock is a single conditional UPDATE on RefreshLock; these drive it directly so the
// concurrency can be tested without running two real refreshes.
async function claim(holder: string): Promise<boolean> {
  const cutoff = new Date(Date.now() - 15 * 60 * 1000);
  // A JS Date, not NOW(3) — see the note in refresh-service.ts: mixing the two makes
  // every lock look stale the instant it is taken.
  const n = await prisma.$executeRaw`
    UPDATE RefreshLock SET holder = ${holder}, startedAt = ${new Date()}
     WHERE id = 1 AND (holder IS NULL OR startedAt IS NULL OR startedAt < ${cutoff})`;
  return n === 1;
}
async function release(holder: string): Promise<void> {
  await prisma.$executeRaw`UPDATE RefreshLock SET holder = NULL, startedAt = NULL WHERE id = 1 AND holder = ${holder}`;
}

async function main() {
  const before = await currentRefresh();
  console.log(`\n=== Lock (§25.10) ===`);
  check("no refresh is running to begin with", !before.running, before.since ? `held since ${before.since.toISOString()}` : "");
  if (before.running) {
    console.log("  (a refresh really is in flight — rerun in a minute)");
    return;
  }

  check("the first claim succeeds", await claim("smoke-A"));
  // The property that matters: a SECOND caller — another user, another app server, or the
  // hourly tick landing mid-click — must be refused rather than starting a parallel pass.
  check("a second claim is refused while the first holds it", (await claim("smoke-B")) === false);
  const during = await currentRefresh();
  check("currentRefresh reports it as running", during.running, during.since?.toISOString());

  // Releasing must be scoped to the holder: a stale-timeout handover must not let an old
  // holder release somebody else's lock.
  await release("smoke-B");
  check("a NON-holder cannot release the lock", (await currentRefresh()).running);
  await release("smoke-A");
  check("the holder can release it", !(await currentRefresh()).running);

  // Stale locks must clear themselves, or a killed process locks the app forever.
  await prisma.$executeRaw`UPDATE RefreshLock SET holder = 'smoke-stale', startedAt = ${new Date(Date.now() - 60 * 60 * 1000)} WHERE id = 1`;
  check("a lock older than the timeout is not reported as running", !(await currentRefresh()).running);
  check("and can be claimed by a new pass", await claim("smoke-C"));
  await release("smoke-C");

  console.log(`\n=== Refresh records (§25.11) ===`);
  const runs = await recentRefreshRuns(5);
  console.log(`  ${runs.length} recorded pass(es)`);
  for (const r of runs) {
    console.log(
      `    ${r.startedAt.toISOString().slice(0, 19)} ${r.trigger.padEnd(8)} ${r.status.padEnd(8)} ` +
        `${r.sourcesOk} ok / ${r.sourcesFailed} failed  ${r.durationMs != null ? `${r.durationMs}ms` : "(running)"} ` +
        `${r.userName ? `by ${r.userName}` : "(scheduled)"}`,
    );
  }

  if (process.argv.includes("--run")) {
    console.log(`\n=== A REAL pass (pulls from every source) ===`);
    const t0 = Date.now();
    const outcome = await refreshAllData({ trigger: "manual", userName: "refresh-smoke script" });
    console.log(`  returned in ${Date.now() - t0}ms`);
    if (!outcome.ok) {
      check(`the pass ran (reason: ${outcome.reason})`, false, "reason" in outcome ? outcome.reason : "");
    } else {
      for (const s of outcome.sources) console.log(`    ${s.status.padEnd(8)} ${s.label}: ${s.detail}`);
      // §25.7: a pass with a failed source is "partial", never a success.
      check("status matches the sources", outcome.status === (outcome.failedLabels.length === 0 ? "ok" : "partial"),
        `${outcome.status}, ${outcome.failedLabels.length} failed`);
      check("a record was written for it", (await recentRefreshRuns(1))[0]?.refreshId === outcome.refreshId);
      check("the lock was released", !(await currentRefresh()).running);
    }
  } else {
    console.log(`\n(skipped the real pass — pass --run to pull from every source)`);
  }

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}\n`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
