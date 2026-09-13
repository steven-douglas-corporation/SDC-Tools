/**
 * scripts/server-auto-update.js — SUPERSEDED, DO NOT START
 *
 * ── Read this before running it (2026-09-04) ─────────────────────────────────
 *
 * This is not the updater in use. The live one is `sdc-updater-hub` (see
 * ecosystem.config.js), which runs scripts/sdc-main-updater.js for the monorepo plus
 * the Scheduler and State Logic updaters in one process. This file is referenced by
 * nothing.
 *
 * It is kept because it documents the original design, and it is marked because
 * starting it would actively break the Reports app. Its only deploy step is
 * `npm run deploy`, which is `build:apps && pm2 startOrRestart` — and `build:apps`
 * builds apps/assemblies and apps/state-logic ONLY. Reports (apps/reports, 4006)
 * is a Next.js app with its own Prisma schema: it needs `prisma migrate deploy`, then
 * `prisma generate` with the app STOPPED (the running process holds a lock on the
 * query engine DLL), then `next build`. sdc-main-updater.js does exactly that in its
 * step 7b. This file would pull new Reports source and restart the process on a stale
 * build.
 *
 * The app list in the header below is also out of date: it predates Reports and
 * PowerBI joining the monorepo.
 *
 * Mirrors the Electron shell's electron-updater behaviour for the PM2-hosted
 * backend services. Every CHECK_INTERVAL_MS it:
 *
 *   1. Fetches the latest commit SHA on master from GitHub API
 *   2. Compares with the local git HEAD
 *   3. If the remote is ahead: git pull → npm run deploy
 *      (deploy = build all React frontends + pm2 restart all)
 *
 * This covers ALL server-hosted apps automatically:
 *   assemblies (4001)  readiness (4002)  scheduler (4003)
 *   statelogic (4004)  calendar  (4005)
 *
 * The SDC Tools Electron shell gets OTA updates separately via electron-updater
 * + GitHub Actions release workflow (release.yml) — no action needed here.
 *
 * Run via PM2:
 *   pm2 start ecosystem.config.js --only sdc-updater
 */

'use strict';

const https    = require('https');
const { execSync } = require('child_process');
const path     = require('path');

const GITHUB_OWNER      = 'steven-douglas-corporation';
const GITHUB_REPO       = 'SDC-Tools';
const GITHUB_BRANCH     = 'master';
const CHECK_INTERVAL_MS = 5 * 60 * 1000;   // 5 minutes
const REPO_DIR          = path.join(__dirname, '..');

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
        'User-Agent': 'SDC-Tools-ServerUpdater/1.0',
        'Accept':     'application/vnd.github.v3+json',
      },
    }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchJson(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse failed: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

// ─── update flow ─────────────────────────────────────────────────────────────

let isUpdating = false;

async function checkAndUpdate() {
  if (isUpdating) return;   // don't overlap runs

  const localSha = getLocalHead();
  log(`Checking for updates… (local HEAD: ${localSha ? localSha.slice(0, 7) : 'unknown'})`);

  let remoteSha;
  try {
    const data = await fetchJson(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/commits/${GITHUB_BRANCH}`
    );
    remoteSha = data.sha;
  } catch (e) {
    log(`GitHub API error: ${e.message}`);
    return;
  }

  if (!remoteSha) { log('Could not read remote SHA.'); return; }
  log(`Remote HEAD: ${remoteSha.slice(0, 7)}`);

  if (localSha === remoteSha) {
    log('Already up to date.');
    return;
  }

  log(`Updates available (${localSha ? localSha.slice(0, 7) : '?'} → ${remoteSha.slice(0, 7)}). Pulling…`);
  isUpdating = true;

  try {
    // 1. Pull latest code (reset to remote — avoids merge conflicts)
    run('git fetch origin');
    run(`git reset --hard origin/${GITHUB_BRANCH}`);
    log('git pull complete.');

    // 2. Install any new/updated npm deps across the workspace
    log('Running npm install…');
    run('npm install');

    // 3. Build all React frontends + restart all PM2 apps
    log('Running npm run deploy (build + pm2 restart all)…');
    execSync('npm run deploy', {
      cwd:   REPO_DIR,
      stdio: 'inherit',   // show build output in pm2 logs
    });

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
  log('SDC Tools server auto-updater started');
  log(`Watching: https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/tree/${GITHUB_BRANCH}`);
  log(`Check interval: ${CHECK_INTERVAL_MS / 60000} min`);
  log('Covers: assemblies (4001)  readiness (4002)  scheduler (4003)  statelogic (4004)  calendar (4005)');
  log('Electron shell gets OTA updates separately via electron-updater + GitHub Actions.');

  await checkAndUpdate();
  setInterval(checkAndUpdate, CHECK_INTERVAL_MS);
}

main().catch(e => { log(`Fatal: ${e.message}`); process.exit(1); });
