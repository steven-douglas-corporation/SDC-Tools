'use strict';

/**
 * scripts/sdc-updater-hub.js — runs all 3 SDC auto-updaters in one PM2 process.
 *
 * Replaces separate PM2 apps (sdc-updater, sdc-scheduler-updater,
 * sdc-statelogic-updater) with one. Each updater's own file is unchanged in
 * behavior — this just `require()`s them, which runs their existing `main()`
 * self-start and their existing trigger HTTP server, exactly as when each ran
 * standalone. Ports 4013/4014 are unaffected; nothing outside this process
 * needs to change.
 *
 * ── Why Build Readiness has no updater here (2026-08-26) ───────────────────
 * There used to be a fourth: apps/build-readiness/scripts/sdc-brr-updater.js,
 * polling the old standalone Build_Readiness_Report repo every 2 minutes. It was
 * removed, along with its dead twin server-auto-update.js, because it was a
 * live hazard rather than a deploy path:
 *
 *   • It pulled from a DIFFERENT repo than this monorepo — one last touched
 *     2026-05-20, months behind the Build Readiness code actually running
 *     here. Its own `.update-sha` already matched that repo's HEAD, so it sat
 *     dormant; a single push there would have fired it.
 *   • On firing it did not merge. It downloaded a tarball and wholesale
 *     `rmSync`-ed and replaced client/, server/routes/, server/services/,
 *     server/lib/ and tests/ — every directory Build Readiness is developed
 *     in — reverting the app to May and destroying any uncommitted work in
 *     the prod tree with it.
 *   • It was redundant. sdc-main-updater.js does NOT list apps/build-readiness
 *     in its PROTECTED_PREFIXES, so it already checks that app's files out
 *     from origin/master and already restarts sdc-readiness. Two updaters
 *     owned the same directory, from two different sources of truth.
 *
 * The one thing the removed updater did that sdc-main-updater did not was
 * rebuild the Vite client bundle; that was folded into sdc-main-updater's own
 * build step in the same change, so retiring this lost nothing.
 *
 * Port 4012 (its manual trigger) is now free. Deploy Build Readiness the same
 * way as Assemblies and Calendar: push to origin/master and let
 * sdc-main-updater pick it up, or POST its trigger.
 *
 * Why this is safe to merge: each updater's `checkAndUpdate()` already
 * wraps its real work in try/catch and never lets a routine failure (network
 * error, git conflict, build failure) escape as a rejected promise — it logs
 * and returns. The only way one updater could take down the others is a truly
 * unforeseen bug reaching the top-level `main().catch()` in that file; each of
 * those was changed to only `process.exit()` when run standalone
 * (`require.main === module`), so under this hub they just log instead.
 * The `unhandledRejection` handler below is a second safety net for anything
 * that still slips through — it logs and keeps the process (and the other
 * three updaters' schedules) alive rather than crashing everything.
 *
 * Run via PM2:  pm2 start ecosystem.config.js --only sdc-updater-hub
 */

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] [updater-hub] ${msg}`);
}

process.on('unhandledRejection', (err) => {
  log(`Caught an unhandled rejection from one of the updaters (process stays up): ${err && err.stack || err}`);
});

log('Starting all 3 updaters in one process...');

require('./sdc-main-updater.js');
require('../SDC_Scheduler/scripts/server-auto-update.js');
require('../apps/state-logic/scripts/server-auto-update.js');

log('All 3 updaters started (assemblies/readiness/calendar/vendor monorepo, scheduler, statelogic).');
