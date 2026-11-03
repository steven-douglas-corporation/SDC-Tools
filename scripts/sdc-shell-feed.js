'use strict';

/**
 * scripts/sdc-shell-feed.js — internal update feed for the desktop shell.
 * Runs inside sdc-updater-hub.
 *
 * Installed shells check THIS server for updates (electron-updater, generic
 * provider) instead of GitHub Releases, so the repo can be private and the
 * installer — which bundles apps/shell/.env — never has to be public.
 *
 * Two jobs:
 *   1. SYNC  — every few minutes, read the newest GitHub Release (the one
 *              release.yml still publishes) and copy its latest.yml, installer
 *              and blockmap into FEED_DIR. Uses the same read-only token as
 *              sdc-main-updater.js. The installer's sha512 is checked against
 *              latest.yml BEFORE the feed is switched, and latest.yml is
 *              written last, so a client never sees a yml that points at a
 *              missing or half-written installer.
 *   2. SERVE — a tiny read-only HTTP server on FEED_PORT for those files.
 *
 * Env (all optional):
 *   SDC_FEED_DIR          where files live          (default D:\SDC-Updates)
 *   SDC_FEED_PORT         listen port               (default 4015)
 *   SDC_GIT_CREDENTIALS   git credential-store file (default C:/ProgramData/sdc-git/credentials)
 *   SDC_FEED_REPO         owner/repo                (default steven-douglas-corporation/SDC-Tools)
 */

const fs     = require('fs');
const path   = require('path');
const http   = require('http');
const crypto = require('crypto');

const REPO        = process.env.SDC_FEED_REPO || 'steven-douglas-corporation/SDC-Tools';
const FEED_DIR    = process.env.SDC_FEED_DIR  || 'D:\\SDC-Updates';
const FEED_PORT   = Number(process.env.SDC_FEED_PORT) || 4015;
const CRED_FILE   = process.env.SDC_GIT_CREDENTIALS || 'C:/ProgramData/sdc-git/credentials';
const SYNC_EVERY  = 5 * 60 * 1000;
const ALERT_AFTER_FAILURES = 3;
const SERVED = /^[A-Za-z0-9._-]+\.(yml|exe|blockmap)$/;

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] [shell-feed] ${msg}`);
}

// Same token the git credential helper uses: a line like https://user:TOKEN@github.com
// Returns null when there is no file, which still works while the repo is public.
function readToken() {
  try {
    const line = fs.readFileSync(CRED_FILE, 'utf8').split(/\r?\n/).find(l => l.includes('@github.com'));
    const m = line && line.match(/^https:\/\/[^:]+:([^@]+)@github\.com/);
    return m ? decodeURIComponent(m[1]) : null;
  } catch { return null; }
}

function ghHeaders(accept) {
  const h = { 'User-Agent': 'sdc-shell-feed', Accept: accept };
  const token = readToken();
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function download(asset, dest) {
  const res = await fetch(asset.url, {
    headers: ghHeaders('application/octet-stream'),
    redirect: 'follow',
    signal: AbortSignal.timeout(10 * 60 * 1000),
  });
  if (!res.ok) throw new Error(`download ${asset.name}: HTTP ${res.status}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

function sha512b64(file) {
  return crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64');
}

function readState() {
  try { return JSON.parse(fs.readFileSync(path.join(FEED_DIR, 'feed-state.json'), 'utf8')); }
  catch { return {}; }
}

let consecutiveFailures = 0;
let syncing = false;

async function sync() {
  if (syncing) return;
  syncing = true;
  try {
    fs.mkdirSync(FEED_DIR, { recursive: true });
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: ghHeaders('application/vnd.github+json'),
      signal: AbortSignal.timeout(60 * 1000),
    });
    if (!res.ok) throw new Error(`releases/latest: HTTP ${res.status}`);
    const rel = await res.json();

    if (readState().tag === rel.tag_name) { consecutiveFailures = 0; return; }

    const byName = n => rel.assets.find(a => a.name === n);
    const yml    = byName('latest.yml');
    const exe    = rel.assets.find(a => /\.exe$/.test(a.name));
    const map    = rel.assets.find(a => /\.exe\.blockmap$/.test(a.name));
    if (!yml || !exe) throw new Error(`release ${rel.tag_name} is missing latest.yml or the installer`);

    const tmp = path.join(FEED_DIR, '.incoming');
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp);

    await download(yml, path.join(tmp, 'latest.yml'));
    await download(exe, path.join(tmp, exe.name));
    if (map) await download(map, path.join(tmp, map.name));

    // latest.yml carries the installer's sha512 (base64). Refuse a mismatch.
    const ymlText = fs.readFileSync(path.join(tmp, 'latest.yml'), 'utf8');
    const want = (ymlText.match(/^\s*sha512:\s*(\S+)/m) || [])[1];
    if (!want || want !== sha512b64(path.join(tmp, exe.name))) {
      throw new Error(`release ${rel.tag_name}: installer sha512 does not match latest.yml, feed NOT updated`);
    }

    // Installer and blockmap first, latest.yml last (the switch).
    for (const f of [exe.name, map && map.name].filter(Boolean)) {
      fs.renameSync(path.join(tmp, f), path.join(FEED_DIR, f));
    }
    fs.renameSync(path.join(tmp, 'latest.yml'), path.join(FEED_DIR, 'latest.yml'));
    fs.writeFileSync(path.join(FEED_DIR, 'feed-state.json'), JSON.stringify({ tag: rel.tag_name, at: new Date().toISOString() }));
    fs.rmSync(tmp, { recursive: true, force: true });

    // Keep only the current installer; clients that are mid-download of an older one are rare.
    for (const f of fs.readdirSync(FEED_DIR)) {
      if (/\.exe(\.blockmap)?$/.test(f) && !f.startsWith(exe.name)) fs.rmSync(path.join(FEED_DIR, f), { force: true });
    }

    consecutiveFailures = 0;
    log(`feed updated to ${rel.tag_name} (${exe.name})`);
  } catch (err) {
    consecutiveFailures++;
    log(`sync failed (${consecutiveFailures} in a row): ${err.message}`);
    if (consecutiveFailures === ALERT_AFTER_FAILURES) {
      log('ALERT: the shell update feed cannot reach GitHub, so new desktop releases are NOT reaching users.');
    }
  } finally {
    syncing = false;
  }
}

function serve(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
  const name = decodeURIComponent((req.url || '').split('?')[0]).replace(/^\/+/, '');
  if (!SERVED.test(name)) { res.writeHead(404).end(); return; }
  const file = path.join(FEED_DIR, name);
  let stat;
  try { stat = fs.statSync(file); } catch { res.writeHead(404).end(); return; }

  const type = name.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream';
  let start = 0, end = stat.size - 1, status = 200;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range && (range[1] || range[2])) {          // differential downloads use Range
    start = range[1] ? Number(range[1]) : Math.max(0, stat.size - Number(range[2]));
    end   = range[1] && range[2] ? Math.min(Number(range[2]), end) : end;
    if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }).end(); return; }
    status = 206;
  }
  const headers = {
    'Content-Type': type,
    'Content-Length': end - start + 1,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
  };
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
  res.writeHead(status, headers);
  if (req.method === 'HEAD') { res.end(); return; }
  fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
}

function main() {
  const server = http.createServer(serve);
  server.on('error', err => log(`feed server error: ${err.message}`));
  server.listen(FEED_PORT, '0.0.0.0', () => log(`serving ${FEED_DIR} on port ${FEED_PORT}`));
  sync();
  setInterval(sync, SYNC_EVERY);
}

main();
