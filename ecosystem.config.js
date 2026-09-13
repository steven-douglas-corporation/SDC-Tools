/**
 * PM2 Ecosystem Config — SDC Tools Server
 *
 * Run on the company server PC to manage all 7 backend services.
 *
 * ── First-time setup ─────────────────────────────────────────────────────────
 *   1. Install Node.js LTS  →  https://nodejs.org
 *   2. Install PM2          →  npm install -g pm2
 *   3. Clone / pull repo    →  git clone https://github.com/steven-douglas-corporation/SDC-Tools.git
 *   4. Install all deps     →  npm install  (from repo root)
 *   5. Start all apps       →  pm2 start ecosystem.config.js
 *   6. Save + auto-start    →  pm2 save  &&  pm2 startup
 *      (follow the printed command to register the Windows service)
 *
 * ── Daily use ────────────────────────────────────────────────────────────────
 *   pm2 status              → see all apps and their status
 *   pm2 logs                → tail all logs
 *   pm2 logs sdc-scheduler      → tail one app
 *   pm2 restart all             → restart everything (e.g. after git pull)
 *   pm2 restart sdc-scheduler   → restart one app
 *
 * ── Deploy an update ─────────────────────────────────────────────────────────
 *   Automatic: sdc-updater-hub polls GitHub every 2-5 min — no manual steps needed.
 *   Manual:    git pull && npm run deploy
 *   Shell app: electron-updater checks GitHub Releases every 30 min (OTA).
 *
 * ── Environment ──────────────────────────────────────────────────────────────
 *   Each app loads its own .env file via dotenv (from its cwd).
 *   Copy .env.example → each app's folder and fill in ETO SQL / MySQL creds.
 *   Shell-launcher specific: .env at apps/shell/ (SDC_SERVER_HOST, AZURE_*).
 *
 * ── Ports (see docs/PORTS.md for the full registry incl. support ports) ──────
 *   sdc-assemblies   4001    sdc-readiness   4002
 *   sdc-scheduler    4003    sdc-statelogic  4004    sdc-calendar  4005
 *   sdc-reports      4006
 *
 *   Open these ports in Windows Firewall (inbound, TCP) for LAN access.
 *
 * ── Folder layout (2026-08 restructuring) ─────────────────────────────────────
 *   apps/assemblies, apps/build-readiness, apps/state-logic, apps/calendar,
 *   apps/shell live inside this monorepo and moved here from their old flat
 *   top-level names. SDC_Scheduler, apps/reports (then sdc-etc-planner), and tools/powerbi (then SDC-PowerBI-DEV) did
 *   NOT move — each is its own independent git repo with its own remote and
 *   deploy pipeline, so relocating them inside this monorepo wouldn't change
 *   how production gets updates for them, only the paths every reference to
 *   them here would need to keep matching. See docs/APPLICATIONS.md.
 * ─────────────────────────────────────────────────────────────────────────────
 */

module.exports = {
  apps: [

    // ── SDC Updater Hub ──────────────────────────────────────────────────────
    // Runs all 3 auto-updaters (monorepo, scheduler, statelogic) in one
    // process — see scripts/sdc-updater-hub.js for why this is safe (each
    // updater's own error handling is unchanged; only merged the OS process).
    // Replaces the old separate sdc-updater / sdc-brr-updater /
    // sdc-scheduler-updater / sdc-statelogic-updater PM2 apps.
    // The BRR updater was retired 2026-08-26 (it pulled Build Readiness from a
    // stale separate repo and wiped the app's directories); apps/build-readiness
    // is now deployed by sdc-main-updater like the other monorepo apps.
    // Electron shell gets OTA updates separately via electron-updater + release.yml.
    {
      name:          'sdc-updater-hub',
      script:        'scripts/sdc-updater-hub.js',
      cwd:           'D:\\AI Projects\\Centrailized library',
      env: {
        NODE_ENV:         'production',
        NODE_NO_WARNINGS: '1',
      },
      watch:         false,
      max_restarts:  5,
      restart_delay: 60000,
      max_memory_restart: '350M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs:    true,
    },

    // ── Assemblies Library ──────────────────────────────────────────────────
    {
      name:          'sdc-assemblies',
      script:        'server/index.js',
      cwd:           './apps/assemblies',
      env: {
        PORT:             '4001',
        NODE_ENV:         'production',
        NODE_NO_WARNINGS: '1',
        // UNC paths so PM2 (which runs in its own session) can reach the shares
        // without needing drive letters mapped in the service session.
        SHARED_BASE: '\\\\stevendouglas.local\\dfs\\Company\\Job Folder\\_Assembilies_Library_Application',
        DRIVE_N:     '\\\\stevendouglas.local\\dfs\\Company\\Job Folder',
        DRIVE_L:     '\\\\stevendouglas.local\\dfs\\Company\\Job Archive',
      },
      watch:         false,
      max_restarts:  10,
      restart_delay: 3000,
      max_memory_restart: '300M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs:    true,
    },

    // ── Build Readiness Report ───────────────────────────────────────────────
    // (its auto-updater now runs inside sdc-updater-hub, not as a separate app)
    {
      name:          'sdc-readiness',
      script:        'server/index.js',
      cwd:           './apps/build-readiness',
      env: {
        PORT:             '4002',
        NODE_ENV:         'production',
        NODE_NO_WARNINGS: '1',
        ETO_HOST:         'SERVER-APP1.stevendouglas.local',
        ETO_DATABASE:     'SDC',
        ETO_DOMAIN:       'stevendouglas',
        ETO_PORT:         '1433',
        // ETO_USER / ETO_PASSWORD: load from this app's own .env (cwd) via
        // dotenv — kept out of this git-tracked file. See .env.example.
        // (Smartsheet integration removed — superseded by SDC Scheduler's
        // /api/integration/project-dates via SCHEDULER_URL, also in its .env.)
      },
      watch:         false,
      max_restarts:  10,
      restart_delay: 3000,
      max_memory_restart: '300M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs:    true,
    },

    // ── SDC Scheduler ───────────────────────────────────────────────────────
    // NOT moved — own standalone git repo (danbelliveau2/SDC_Scheduler),
    // deliberately excluded from this monorepo's git tracking (see .gitignore).
    // (its auto-updater now runs inside sdc-updater-hub, not as a separate app)
    {
      name:          'sdc-scheduler',
      script:        'server.js',
      cwd:           './SDC_Scheduler',
      env: {
        PORT:             '4003',
        NODE_ENV:         'production',
        NODE_NO_WARNINGS: '1',
        // ── Total ETO bridge ── (ETO_USER/ETO_PASSWORD load from this app's own .env)
        ETO_HOST:         'SERVER-APP1.stevendouglas.local',
        ETO_DATABASE:     'SDC',
        ETO_PORT:         '1433',
        ETO_DOMAIN:       'stevendouglas',
        // ── Anthropic Claude assistant ──
        ANTHROPIC_API_KEY:    process.env.ANTHROPIC_API_KEY || '',
        ANTHROPIC_MODEL:      'claude-sonnet-4-6',
        ANTHROPIC_MAX_TOKENS: '1024',
        // mysqldump is not on PATH — use the full install path
        MYSQLDUMP_PATH: 'C:\\Program Files\\MySQL\\MySQL Server 9.7\\bin\\mysqldump.exe',
      },
      watch:         false,
      max_restarts:  10,
      restart_delay: 3000,
      max_memory_restart: '400M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs:    true,
    },

    // ── State Logic Builder ─────────────────────────────────────────────────
    {
      name:          'sdc-statelogic',
      script:        'server.js',
      cwd:           './apps/state-logic',
      env: {
        PORT:             '4004',
        NODE_ENV:         'production',
        NODE_NO_WARNINGS: '1',
        // UNC path so PM2 Windows Service can reach the share without N: drive mapped
        STANDARDS_DIR:    '\\\\stevendouglas.local\\dfs\\Company\\Job Folder\\AI Folder\\State Logic Diagrams\\standards',
        // DB: MySQL via mysqlDb.js (replaced the old Azure SQL path — see mysqlDb.js header)
      },
      watch:         false,
      max_restarts:  10,
      restart_delay: 3000,
      max_memory_restart: '300M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs:    true,
    },

    // ── SDC Calendar ────────────────────────────────────────────────────────
    // (its auto-updater now runs inside sdc-updater-hub too)
    {
      name:          'sdc-calendar',
      script:        'server/server.js',
      cwd:           './apps/calendar',
      env: {
        PORT:             '4005',
        NODE_ENV:         'production',
        NODE_NO_WARNINGS: '1',
        // Legacy flag (2026-08-20): no longer bypasses authentication — real
        // per-user identity now comes from the shared sdc_session cookie
        // (server/middleware/requireAuth.js). Only still skips setting up
        // express-session, which the unused standalone Azure OAuth flow
        // needed. SDC_SESSION_SECRET is read from this app's own .env, same
        // as the other 4 SDC Tools apps.
        SKIP_AUTH:        'true',
        // Update to the actual server hostname/IP so calendar links work correctly
        FRONTEND_URL:     'http://SERVER-APP1:4005',
        SERVER_IP:        'SERVER-APP1',
      },
      watch:         false,
      max_restarts:  10,
      restart_delay: 3000,
      max_memory_restart: '300M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs:    true,
    },

    // ── SDC Reports (ETC Planner) ────────────────────────────────────────────
    // Formerly its own standalone git repo (sdc-sheets), tracked here since 2026-09-03. Folded
    // in from its own previously-separate ecosystem.config.js, which had a
    // broken cwd (pointed at "D:\AI Projects\sdc-etc-planner", missing the
    // "Centrailized library" segment — fixed below). Next.js auto-loads this
    // folder's own .env (DATABASE_URL, SCHEDULER_SHARED_TOKEN, TotalETO/PowerBI
    // creds, etc.) — no need to duplicate secrets here.
    //
    // Renumbered 3010 → 4006 (2026-08-23). This requires a coordinated shell
    // release (apps/shell/electron/processManager.js's "reports" tile + a
    // version bump) before installed desktops learn the new port — until that
    // release ships and rolls out (~30 min OTA poll per client), un-updated
    // shells will health-check the old 3010 and show this tile as down.
    //
    // ⚠️  MEASURED WINDOWS BUG (2026-08-06, 3x in 20 min): `pm2 stop`,
    // `pm2 restart`, and `pm2 delete` have each reported success on this app
    // while the underlying `next start` process kept running and kept the
    // port. The replacement then crash-loops on EADDRINUSE every ~4s while the
    // OLD build keeps serving — looks fine, isn't. Prefer `npm run deploy`
    // (from inside apps/reports/), which frees the port explicitly via
    // scripts/free-port.mjs and fails loudly if something's still bound to it.
    // If you do `pm2 restart sdc-reports` by hand, check
    // `pm2 logs sdc-reports --err` for EADDRINUSE before trusting it.
    {
      name:          'sdc-reports',
      // Serves the production build in .next. Still a single node process (no
      // npm shim) — scripts/start.mjs preflights and then loads Next's own bin
      // in-process, so PM2 supervises the real server exactly as before.
      //
      // ⚠️  Do NOT point this back at 'node_modules/next/dist/bin/next'.
      // It was that until 2026-08-26, and it made PM2's entry point a file
      // inside the directory npm deletes on every install. An install
      // interrupted on 2026-08-25 20:03 removed it, and the app then
      // MODULE_NOT_FOUND crash-looped 139 times over ~12 hours with no alert.
      // scripts/start.mjs is tracked in git, so it cannot go missing that way,
      // and it reinstalls a wiped node_modules instead of dying. Full writeup
      // in that file's header.
      script:        'scripts/start.mjs',
      // Relative like every other app since 2026-09-13 (ADR 0003); the process
      // was `sdc-etc-planner` in `sdc-etc-planner/` until then.
      cwd:           './apps/reports',
      env: {
        PORT:             '4006',
        NODE_ENV:         'production',
        NODE_NO_WARNINGS: '1',
      },
      watch:         false,
      max_restarts:  10,
      // min_uptime is what makes max_restarts mean anything. Without it PM2
      // treats each 3-second crash as a fresh incident, resets the counter, and
      // retries forever — the ↺139 above. With it, a process that dies before
      // 90s counts toward the 10, after which PM2 stops and marks the app
      // `errored`: a status that looks wrong at a glance instead of one that
      // looks merely restarty. 90s (not the usual 5s) because a self-heal boot
      // legitimately spends ~60-90s inside npm ci before it ever listens.
      min_uptime:    '90s',
      // Backoff instead of a flat 3s: a genuinely broken app stops generating a
      // log line every three seconds, so the real first error stays readable
      // rather than buried under hours of identical stack traces.
      exp_backoff_restart_delay: 3000,
      // The other 6 apps have carried a memory ceiling since they were added;
      // this one never did, and it is by far the largest process — measured
      // 2026-08-25 at 236.9 MB RSS (184.8/191.0 MiB heap), roughly 5x any
      // other app here. So the one process most able to leak was the only one
      // with nothing to catch it.
      //
      // 600M is ~2.5x the measured steady state, which leaves room for the
      // hourly 9-source refresh pass (17.7s, holds the Paylocity workbook
      // parse in memory) to spike well above baseline without tripping a
      // restart mid-write. Raise it if a legitimate refresh ever trips it —
      // don't raise it to paper over an actual leak. See docs/PERFORMANCE.md
      // §1d for the baseline to compare against.
      //
      // ── Raised 600M -> 1536M (2026-08-31), which is that "legitimate refresh"
      //    case the line above reserved. It was not hypothetical: 600M was killing
      //    this app EVERY HOUR, on the hour, in production.
      //
      // Measured, sampling RSS/private bytes every 6s across a live interval pass:
      //
      //     21:04:32   198 MB RSS / 359 MB private   (steady state)
      //     21:04:38   794 MB RSS / 943 MB private   (<- the refresh)
      //     21:04:41   [auto-sync] interval pass in 6752ms ... all 9 sources ok
      //     21:04:42   [start] preflight ok - starting next on port 4006
      //     21:04:44   new PID, 178 MB               (<- pm2 had killed it)
      //
      // The pass SUCCEEDS and then the process is killed for the memory it used
      // getting there — so there is no error in the log, just a clean restart with
      // every SSE session dropped and any save still in flight lost. The same
      // signature is in the out log at 15:45, 16:45, 17:46, 18:46, 19:47 and 21:04.
      //
      // Not a leak: the replacement settles back to ~245 MB and stays there. The
      // spike is the Paylocity workbook parse (54,535 rows) plus 8 other sources
      // across 2 concurrent lanes, all resident at once for ~7 seconds.
      //
      // 1536M is ~1.6x the measured 943 MB peak — enough headroom that a slightly
      // larger workbook next month does not put us straight back here, and still
      // low enough to catch a genuine runaway (6x steady state). If this ever trips
      // again, the fix is to stop holding the whole parse in memory, NOT another
      // raise: see src/lib/paylocity-workbook.ts.
      max_memory_restart: '1536M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs:    true,
    },

  ],
};
