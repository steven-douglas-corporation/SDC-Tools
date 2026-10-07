'use strict';

/**
 * scripts/sdc-main-updater.js — SDC Tools monorepo server updater
 *
 * Every CHECK_INTERVAL_MS it:
 *   1. Fetches the latest commit SHA on master from GitHub API
 *   2. Compares with the local git HEAD
 *   3. If remote is ahead:
 *        a. git fetch origin
 *        b. Diff changed files between local HEAD and remote
 *        c. Selectively checkout only files this updater owns
 *           (skips paths managed by sdc-scheduler-updater / sdc-statelogic-updater)
 *        d. git reset --soft origin/master  — advances HEAD, leaves per-app dirs intact
 *        e. npm install  (only if package.json changed)
 *        f. Build Assemblies Library frontend  (only if its files changed)
 *        g. pm2 restart sdc-assemblies sdc-readiness sdc-calendar
 *
 * Protected paths — never overwritten (managed by per-app updaters):
 *   SDC_Scheduler/public/, db.js, .gitignore, ARROW_ROUTING_RULES.md
 *     → managed by sdc-scheduler-updater  (danbelliveau2/SDC_Scheduler)
 *   apps/state-logic/src/, public/, index.html
 *     → managed by sdc-statelogic-updater (danbelliveau2/state_logic_builder)
 *
 * Run via PM2:
 *   pm2 start ecosystem.config.js --only sdc-updater
 */

const https        = require('https');
const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');

const GITHUB_OWNER      = 'steven-douglas-corporation';
const GITHUB_REPO       = 'SDC-Tools';
const GITHUB_BRANCH     = 'master';
const CHECK_INTERVAL_MS = 5 * 60 * 1000;   // 5 minutes
const REPO_DIR          = path.join(__dirname, '..');

// Paths managed by per-app updaters — never overwrite these from the monorepo git tree.
// Each entry is a prefix; any changed file whose path starts with a prefix is skipped.
const PROTECTED = [
  'SDC_Scheduler/public/',
  'SDC_Scheduler/db.js',
  'SDC_Scheduler/.gitignore',
  'SDC_Scheduler/ARROW_ROUTING_RULES.md',
  'apps/state-logic/src/',
  'apps/state-logic/public/',
  'apps/state-logic/index.html',
];

// ─── helpers ─────────────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] [sdc-updater] ${msg}`);
}

function run(cmd, opts = {}) {
  return execSync(cmd, { cwd: REPO_DIR, stdio: 'pipe', ...opts }).toString().trim();
}

function getLocalHead() {
  try { return run('git rev-parse HEAD'); }
  catch { return null; }
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'SDC-Tools-MainUpdater/2.0',
        'Accept':     'application/vnd.github.v3+json',
      },
    }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302)
        return fetchJson(res.headers.location).then(resolve).catch(reject);
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse failed: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

function fetchJsonWithRetry(url, retries = 3, delayMs = 10000) {
  return fetchJson(url).catch(err => {
    if (retries <= 0) throw err;
    log(`Network error (${err.message}) — retrying in ${delayMs / 1000}s… (${retries} left)`);
    return new Promise(res => setTimeout(res, delayMs))
      .then(() => fetchJsonWithRetry(url, retries - 1, delayMs));
  });
}

function isProtected(file) {
  return PROTECTED.some(p => file === p || file.startsWith(p));
}

// ─── update flow ─────────────────────────────────────────────────────────────

let isUpdating = false;

async function checkAndUpdate() {
  if (isUpdating) return;

  const localSha = getLocalHead();
  log(`Checking for updates… (local HEAD: ${localSha ? localSha.slice(0, 7) : 'unknown'})`);

  let remoteSha;
  try {
    const data = await fetchJsonWithRetry(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/commits/${GITHUB_BRANCH}`
    );
    remoteSha = data.sha;
  } catch (e) {
    log(`GitHub API error: ${e.message}`);
    return;
  }

  if (!remoteSha) { log('Could not read remote SHA.'); return; }
  log(`Remote HEAD: ${remoteSha.slice(0, 7)}`);

  if (localSha === remoteSha) { log('Already up to date.'); return; }

  log(`Updates available (${localSha ? localSha.slice(0, 7) : '?'} → ${remoteSha.slice(0, 7)}). Pulling selectively…`);
  isUpdating = true;

  try {
    // 1. Fetch latest refs from remote
    run('git fetch origin');

    // 1b. Only sync when the remote is strictly AHEAD of us.
    //
    //     getLocalHead() vs remote SHA (step 0) only tells us the two DIFFER,
    //     not which way. If local HEAD carries commits the remote does not
    //     have - someone working on a feature branch in this tree, or a local
    //     commit not yet pushed - then "different" means we are AHEAD, and
    //     syncing walks us backwards with two destructive effects:
    //
    //       * step 4 diffs HEAD against the remote, sees every file those
    //         local commits ADDED as absent from the remote, fails to check
    //         it out, and falls into the "deleted in remote" branch, which
    //         fs.unlinkSync()s the file off disk;
    //       * step 5 then moves the branch ref back with git reset --soft.
    //
    //     That is real data loss, and it happened: on 2026-08-25 this deleted
    //     a feature branch's new files and reset its ref (log line
    //     "Updates available (5d0f69f -> 4c7995a). Pulling selectively...").
    //     The commit survived only because git keeps unreferenced objects.
    //
    //     merge-base --is-ancestor exits non-zero when HEAD is NOT an
    //     ancestor of the remote, i.e. exactly the ahead/diverged case.
    try {
      run(`git merge-base --is-ancestor HEAD origin/${GITHUB_BRANCH}`);
    } catch {
      log('Local HEAD is ahead of or diverged from ' +
          `origin/${GITHUB_BRANCH} - skipping update so local work is not destroyed.`);
      isUpdating = false;
      return;
    }

    // 2. List all files that changed between local HEAD and remote
    let changedFiles = [];
    try {
      const diffOut = run(`git diff --name-only HEAD origin/${GITHUB_BRANCH}`);
      changedFiles = diffOut.split('\n').map(f => f.trim()).filter(Boolean);
    } catch {
      log('Could not diff against HEAD — treating as full monorepo update.');
    }

    // 3. Split into monorepo-owned vs per-app-updater-owned
    const monorepoFiles = changedFiles.filter(f => !isProtected(f));
    const skippedCount  = changedFiles.length - monorepoFiles.length;
    if (skippedCount > 0) {
      log(`Skipping ${skippedCount} file(s) in per-app-updater dirs (scheduler/statelogic).`);
    }

    // 4. Selectively checkout only monorepo-owned files from remote
    let checkedOut = 0;
    for (const file of monorepoFiles) {
      try {
        run(`git checkout origin/${GITHUB_BRANCH} -- "${file}"`);
        checkedOut++;
      } catch {
        // File was deleted in remote — remove locally
        try {
          fs.unlinkSync(path.join(REPO_DIR, file));
          log(`  Deleted: ${file}`);
        } catch { /* already gone */ }
      }
    }
    if (checkedOut > 0) log(`Checked out ${checkedOut} monorepo file(s).`);

    // 5. Advance HEAD to remote SHA without touching working tree.
    //    Per-app-updater files in SDC_Scheduler/ and apps/state-logic/ are preserved as-is.
    run(`git reset --soft origin/${GITHUB_BRANCH}`);
    log(`HEAD → ${remoteSha.slice(0, 7)}`);

    // 6. Install deps only if package.json changed
    //    --include=dev (2026-10-04): pm2 runs everything with NODE_ENV=production, and
    //    under that npm install SKIPS and PRUNES devDependencies. The builds below need
    //    them (Vite, TypeScript types), so a dependency change used to break the next build.
    if (monorepoFiles.some(f => f === 'package.json' || f === 'package-lock.json')) {
      log('package.json changed — running npm install…');
      run('npm install --include=dev');
    }

    // 7. Rebuild any owned app whose frontend sources changed.
    //
    //    Both of these serve a Vite bundle out of client/dist, which is
    //    gitignored — so checking the SOURCE out in step 4 is only half a
    //    deploy. Without the build the app keeps serving the previous bundle
    //    and the change is invisible to users, which is exactly the failure
    //    seen on 2026-08-25 (apps/assemblies served a 2026-06-08 bundle,
    //    carrying the pre-brand blue, while its source on disk was current).
    //
    //    Build Readiness was added here on 2026-08-26, when
    //    apps/build-readiness/scripts/sdc-brr-updater.js was retired — see
    //    sdc-updater-hub.js for why it had to go. Rebuilding the client was
    //    the one useful thing that updater did, so it moved here rather than
    //    being lost; without it, retiring it would have traded a destructive
    //    updater for a silently stale bundle.
    //    Calendar joined on 2026-09-13: its Vite build (`build:web`, into dist/)
    //    had never run on the server, so production was serving the legacy
    //    in-browser-Babel frontend/ the whole time. `script` is per entry because
    //    Calendar's plain `build` is the Electron installer, not the web bundle.
    const FRONTEND_BUILDS = [
      { prefix: 'apps/assemblies/', name: 'Assemblies Library', script: 'build' },
      { prefix: 'apps/build-readiness/', name: 'Build Readiness', script: 'build' },
      { prefix: 'apps/calendar/', name: 'Calendar', script: 'build:web' },
    ];
    for (const { prefix, name, script } of FRONTEND_BUILDS) {
      if (!monorepoFiles.some(f => f.startsWith(prefix))) continue;
      log(`${name} changed — rebuilding frontend…`);
      // Non-fatal: a build failure must not abort the deploy before step 8's
      // restart, or a server-side fix would be stranded by an unrelated
      // frontend error. The app keeps its previous bundle and the failure is
      // logged loudly.
      try {
        run(`npm run ${script} --prefix ${prefix.slice(0, -1)}`);
      } catch (buildErr) {
        log(`  ${name} frontend build FAILED: ${buildErr.message} — serving the previous bundle.`);
      }
    }

    // 7b. The Reports app (apps/reports, pm2 `sdc-reports`) — its own step, because it is not a
    //     Vite bundle and cannot be deployed the same way (2026-09-03, added when
    //     the app moved into this repo).
    //
    //     Three things make it different from the two above:
    //
    //       • It is a Next.js app. Its build output is gitignored, so checking source
    //         out in step 4 is only half a deploy — and a stale build against fresh
    //         source is worse than a stale Vite bundle, because the server reads that
    //         directory at request time.
    //       • It owns a Prisma schema. `prisma migrate deploy` has to run BEFORE the
    //         build, and `prisma generate` cannot run at all while the app is up:
    //         PM2 holds query_engine-windows.dll.node and the rename fails EPERM,
    //         leaving a ~21 MB orphaned .tmp file behind each time.
    //       • Its `next build` cannot write to the directory the running server reads.
    //
    //     Until 2026-10-07 the answer to all three was the same: STOP the app, then
    //     migrate, generate and build, then start — about 60 s with nobody on it for
    //     every change. Now (see apps/reports/scripts/deploy-lib.mjs for the design):
    //
    //       fast  — source-only change. The app KEEPS RUNNING while it is built into the
    //               spare build directory (.next-a / .next-b); then a stop → free-port →
    //               switch → start of a few seconds, with a health check and an automatic
    //               rollback to the previous build if the new one does not come up. A
    //               build that fails leaves the running app untouched.
    //       full  — package.json / lockfile / Prisma schema or migrations changed. These
    //               still need the app stopped (an install rewrites node_modules the app
    //               holds open; generate hits the EPERM above; a migration should not run
    //               under code that predates it), so the original order is kept:
    //               stop → install → migrate → generate → build → start. The build now goes
    //               into the spare directory too, so a failed build restarts the app on
    //               the build that was already serving.
    //
    //     Run FROM the app's own directory rather than with --schema/--prefix from the
    //     repo root: Prisma resolves DATABASE_URL from the .env beside the schema, and
    //     `next build` needs that same .env plus the app's own node_modules. This is the
    //     cwd `npm run deploy` uses too, and both go through scripts/deploy.mjs, so the
    //     updater and a manual deploy do the identical thing.
    if (monorepoFiles.some(f => f.startsWith('apps/reports/'))) {
      const reportsDir = path.join(REPO_DIR, 'apps', 'reports');
      const inApp = { cwd: reportsDir };
      // The mode rule lives next to the code it describes (and is unit-tested there);
      // it is imported rather than copied so the two cannot drift. Dynamic import
      // because deploy-lib.mjs is an ES module and this file is CommonJS.
      let mode = 'full';
      try {
        const { pathToFileURL } = require('url');
        const lib = await import(pathToFileURL(path.join(reportsDir, 'scripts', 'deploy-lib.mjs')).href);
        mode = lib.reportsDeployMode(monorepoFiles);
      } catch (modeErr) {
        // Unknown means the slow, safe path — never the fast one.
        log(`  Could not read the Reports deploy mode (${modeErr.message}) — using the full stop-first deploy.`);
      }

      if (mode === 'fast') {
        log('Reports app changed (source only) — building beside the running app, then switching…');
        let built = false;
        try {
          run('node scripts/deploy.mjs build', inApp);
          built = true;
        } catch (buildErr) {
          // The app was never stopped, so it is still serving its previous build.
          log(`  Reports build FAILED: ${buildErr.message}`);
          log('  Reports is still running on its previous build — fix and re-push.');
        }
        if (built) {
          try {
            run('node scripts/deploy.mjs activate', inApp);
          } catch (activateErr) {
            // activate exits non-zero for a rollback too: the app is then up on the old
            // build, but the deploy did not take and must not read as success.
            log(`  Reports switch did not complete: ${activateErr.message}`);
            log('  Check `pm2 list` and `pm2 logs sdc-reports --err` — the app may be on its previous build, or down.');
          }
        }
      } else {
        log('Reports app changed (dependencies, schema or migrations) — stopping it for install + migrate + generate + build…');
        let built = false;
        try {
          // Stop first, and tolerate it not being registered yet.
          try {
            run('pm2 stop sdc-reports');
          } catch (stopErr) {
            log(`  pm2 stop warning: ${stopErr.message} — continuing.`);
          }
          // Dependencies first (2026-09-13): a Dependabot merge changes package.json
          // and the lockfile, and nothing else here installed them — the build then
          // compiled against whatever node_modules already held. Only when the
          // package files moved.
          if (monorepoFiles.some(f => f === 'apps/reports/package.json' || f === 'apps/reports/package-lock.json')) {
            log('  Reports dependencies changed — npm install…');
            // --include=dev (2026-10-04): under pm2's NODE_ENV=production a plain install
            // pruned every devDependency (@types/react and the rest), and `next build`'s
            // type check then failed — Reports was down after PR #81 added `pg`.
            run('npm install --include=dev --no-audit --no-fund', inApp);
          }
          // migrate deploy, not migrate dev: it applies pending migrations without
          // prompting and never invents one from schema drift.
          run('npx prisma migrate deploy', inApp);
          run('npx prisma generate', inApp);
          run('node scripts/deploy.mjs build', inApp);
          built = true;
        } catch (reportsErr) {
          // Loud, and NOT fatal: the app must still come back up rather than being left
          // stopped by a failed deploy. The failed build went into the spare directory,
          // so `restart` brings it back on the build that was already serving.
          log(`  Reports app deploy FAILED: ${reportsErr.message}`);
          log('  It will be restarted on its previous build — fix and re-push.');
        }
        try {
          // `activate` switches to the finished build and rolls back if it does not come up.
          run(built ? 'node scripts/deploy.mjs activate' : 'node scripts/deploy.mjs restart', inApp);
        } catch (startErr) {
          log(`  Reports start FAILED: ${startErr.message} — MANUAL START REQUIRED.`);
        }
      }
    }

    // 8. Restart only the apps this updater owns.
    //    sdc-scheduler and sdc-statelogic have their own per-app updaters.
    //
    //    sdc-reports is deliberately absent: step 7b already stopped and started
    //    it around its own migrate/generate/build sequence. Restarting it again here
    //    would be a second, pointless outage — and if 7b's start failed, this would
    //    paper over that failure instead of leaving the loud log line visible.
    log('Restarting owned apps (assemblies, readiness, calendar)…');
    execSync(
      'pm2 restart sdc-assemblies sdc-readiness sdc-calendar --update-env',
      { cwd: REPO_DIR, stdio: 'inherit' }
    );

    // 9. Ensure sdc-scheduler-repo-sync is running (start if not yet registered).
    try {
      execSync('pm2 describe sdc-scheduler-repo-sync', { stdio: 'pipe' });
    } catch {
      log('Starting sdc-scheduler-repo-sync for the first time…');
      execSync(
        `pm2 start "${REPO_DIR}/ecosystem.config.js" --only sdc-scheduler-repo-sync`,
        { cwd: REPO_DIR, stdio: 'inherit' }
      );
      execSync('pm2 save --force', { cwd: REPO_DIR, stdio: 'pipe' });
    }

    const newHead = getLocalHead();
    log(`Deploy complete. Now at: ${newHead ? newHead.slice(0, 7) : 'unknown'}`);

  } catch (e) {
    log(`Update failed: ${e.message}`);
    if (e.stack) log(e.stack.split('\n').slice(1, 3).join(' '));
  } finally {
    isUpdating = false;
  }
}

// ─── entry point ─────────────────────────────────────────────────────────────

async function main() {
  log('SDC Tools monorepo server updater started (v2 — selective checkout)');
  log(`Watching: https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/tree/${GITHUB_BRANCH}`);
  log(`Check interval: ${CHECK_INTERVAL_MS / 60000} min`);
  log('Owns: assemblies (4001)  readiness (4002)  calendar (4005)');
  log('Per-app updaters: sdc-scheduler-updater → 4003 | sdc-statelogic-updater → 4004');

  await checkAndUpdate();
  setInterval(checkAndUpdate, CHECK_INTERVAL_MS);
}

// When required by the updater hub (multiple updaters sharing one process),
// a fatal error here must not process.exit() — that would kill the other
// updaters too. Standalone (`node sdc-main-updater.js`), keep exiting so PM2
// can restart just this one.
main().catch(e => {
  log(`Fatal: ${e.message}`);
  if (require.main === module) process.exit(1);
});
