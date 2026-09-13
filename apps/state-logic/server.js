/**
 * SDC State Logic Builder — Project Server
 * Storage: MySQL `sdc_statelogic` database (projects + standards tables).
 * Falls back to local JSON files if MySQL is unavailable.
 *
 * Standalone:  node server.js           (port 3131)
 *              PORT=8080 node server.js
 *
 * Embedded:    const { startServer } = require('./server.js')
 *              startServer({ port, dataDir, standardsDir, distDir })
 *
 * API:
 *   GET    /api/projects              list all projects
 *   GET    /api/projects/:filename    load a project
 *   POST   /api/projects/:filename    save / overwrite a project
 *   DELETE /api/projects/:filename    delete a project
 *
 *   POST   /api/generate              AI L5X generation: { filename | projectJson, smId }
 *                                     -> { ok, l5x, validation, reviewNotes, meta }
 *                                     503 when ANTHROPIC_API_KEY is not configured
 *   GET    /api/generate/stream       Same pipeline with LIVE PROGRESS over SSE.
 *                                     ?filename=<project.json>&smId=<sm id>
 *                                     Events: progress {pct,stage,detail},
 *                                     done {result..., savedPath}, error {error}.
 *                                     Closing the connection cancels the model stream.
 *                                     On success the L5X is also saved to
 *                                     generated/<project>/<sm>__jarvis_v<ver>__<date>.L5X
 *   POST   /api/jarvis/diagram        Describe-your-station -> project draft:
 *                                     { description, images:[{name,base64,mediaType}] }
 *                                     -> { ok, filename, summary, openQuestions, fixups, meta }
 *                                     Draft saved to projects/<name>_draft.json
 *   POST   /api/jarvis/spec           Explain-this-station -> machineSpec extraction:
 *                                     { description, images, sm:{id,name,displayName,devices,drawnSteps},
 *                                       otherSms:[{id,name,displayName}], existingSpec }
 *                                     -> { ok, spec, proposedDevices, unmentionedDeviceIds,
 *                                          questions, fixups, meta }. Stateless — nothing saved.
 *
 *   GET    /api/standards             get the entire shared standards library (array)
 *   POST   /api/standards             replace the entire library with the POST body
 *   POST   /api/standards/:id         upsert a single standard by id
 *   DELETE /api/standards/:id         remove a single standard by id
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');
const url  = require('url');
const os   = require('os');

// Load .env so standalone `node server.js` resolves STANDARDS_DIR / MYSQL_* the
// same way PM2 does. dotenv does NOT override vars already in the environment,
// so PM2's injected ecosystem env still wins in production.
require('dotenv').config({ path: path.join(__dirname, '.env') });

// SDC Tools SSO — required right after dotenv() so SDC_SESSION_SECRET /
// SDC_SSO_ENABLED (read once at module-load time inside sdcSessionAuth.js)
// see the .env values. See applySdcSessionGate() below for how these are
// wired into this file's raw http.createServer handler (there is no
// Express `app` in this file to app.use() these onto).
const cookieParser = require('cookie-parser');
const { requireSdcSession } = require('./sdcSessionAuth');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.mjs':  'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

function safeFilename(f) {
  return /^[a-zA-Z0-9_\- .]+\.json$/.test(f) ? f : null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ── SDC Tools SSO gate ──────────────────────────────────────────────────────
// This server is a plain http.createServer callback, not Express, but
// sdcSessionAuth.js's requireSdcSession() is shared verbatim across all 4
// gated SDC Tools apps and calls Express-style res.status()/.json()/
// .type()/.send(). Rather than fork that shared file for this app's
// non-Express style, we shim just those four methods onto the real
// http.ServerResponse right before invoking it — every other route in this
// file keeps using res.writeHead()/res.end() directly, untouched.
//
// Both cookie-parser and requireSdcSession() call their `next` callback
// synchronously (no I/O, verified in cookie-parser's source and in
// sdcSessionAuth.js itself), so this can be a plain synchronous gate:
// callers just check the boolean return and `return` early on false.
const parseSdcCookies = cookieParser();
const sdcSessionGate = requireSdcSession('statelogic');

function applySdcSessionGate(req, res) {
  let allowed = false;
  parseSdcCookies(req, res, () => {
    res.status = function (code) { res.statusCode = code; return res; };
    res.json = function (data) {
      const body = JSON.stringify(data);
      res.writeHead(res.statusCode || 200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(body);
    };
    res.type = function (t) { res._sdcContentType = t === 'html' ? 'text/html; charset=utf-8' : t; return res; };
    res.send = function (body) {
      res.writeHead(res.statusCode || 200, { 'Content-Type': res._sdcContentType || 'text/plain', 'Access-Control-Allow-Origin': '*' });
      res.end(body);
    };
    sdcSessionGate(req, res, () => { allowed = true; });
  });
  return allowed;
}

// ── MySQL module (lazy-loaded so server still starts without it) ──────────────
let mysqlDb = null;
let dbReady = false;

async function getDb() {
  if (!mysqlDb) {
    mysqlDb = require('./mysqlDb');
  }
  if (!dbReady) {
    await mysqlDb.ensureSchema();
    dbReady = true;
  }
  return mysqlDb;
}

// ── File-based fallback helpers (used when MySQL is unavailable) ──────────────
function fileFallbackList(dataDir) {
  const files = fs.existsSync(dataDir)
    ? fs.readdirSync(dataDir).filter(f => f.endsWith('.json'))
    : [];
  return files.map(filename => {
    try {
      const fp   = path.join(dataDir, filename);
      const stat = fs.statSync(fp);
      const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
      return {
        filename,
        name: data.name || filename.replace('.json', ''),
        lastModified: stat.mtimeMs,
        smCount: Array.isArray(data.stateMachines) ? data.stateMachines.length : 0,
      };
    } catch { return { filename, name: filename, lastModified: 0, smCount: 0 }; }
  });
}

function startServer({ port, dataDir, standardsDir, distDir } = {}) {
  const PORT_          = port         || Number(process.env.PORT)      || 3131;
  const DATA_DIR_      = dataDir      || process.env.DATA_DIR          || path.join(__dirname, 'projects');
  const STANDARDS_DIR_ = standardsDir || process.env.STANDARDS_DIR     || path.join(path.dirname(DATA_DIR_), 'standards');
  const STANDARDS_FILE_= path.join(STANDARDS_DIR_, 'standards.json');
  const DIST_DIR_      = distDir      || process.env.DIST_DIR          || path.join(__dirname, 'dist');

  // Ensure local directories exist (used as fallback storage)
  fs.mkdirSync(DATA_DIR_, { recursive: true });
  try { fs.mkdirSync(STANDARDS_DIR_, { recursive: true }); } catch (e) {
    console.warn('[standards] Could not create', STANDARDS_DIR_, '—', e.message);
  }

  // Connect to MySQL in the background; don't block server start
  getDb()
    .then(() => console.log('[MySQL] Connected — using sdc_statelogic database.'))
    .catch(e  => console.warn('[MySQL] Unavailable — using local JSON files as fallback.', e.message));

  // ── Projects ───────────────────────────────────────────────────────────────

  async function handleList(res) {
    try {
      if (dbReady) {
        const pool = (await getDb()).getPool();
        const [rows] = await pool.query(
          'SELECT filename, name, last_modified, sm_count FROM projects ORDER BY last_modified DESC'
        );
        const list = rows.map(row => ({
          filename:     row.filename,
          name:         row.name,
          lastModified: Number(row.last_modified) || 0,
          smCount:      row.sm_count || 0,
        }));
        return sendJson(res, 200, list);
      }
    } catch (e) {
      console.warn('[projects/list] MySQL failed, using files:', e.message);
    }
    sendJson(res, 200, fileFallbackList(DATA_DIR_));
  }

  async function handleLoad(res, filename) {
    const safe = safeFilename(filename);
    if (!safe) return sendJson(res, 400, { error: 'Invalid filename' });

    try {
      if (dbReady) {
        const pool = (await getDb()).getPool();
        const [rows] = await pool.query('SELECT data FROM projects WHERE filename = ?', [safe]);
        if (rows.length > 0) {
          return sendJson(res, 200, JSON.parse(rows[0].data));
        }
        return sendJson(res, 404, { error: 'Not found' });
      }
    } catch (e) {
      console.warn('[projects/load] MySQL failed, using file:', e.message);
    }

    // File fallback
    const fp = path.join(DATA_DIR_, safe);
    if (!fs.existsSync(fp)) return sendJson(res, 404, { error: 'Not found' });
    try { sendJson(res, 200, JSON.parse(fs.readFileSync(fp, 'utf8'))); }
    catch (e) { sendJson(res, 500, { error: e.message }); }
  }

  async function handleSave(req, res, filename) {
    const safe = safeFilename(filename);
    if (!safe) return sendJson(res, 400, { error: 'Invalid filename' });
    try {
      const body = await readBody(req);
      const data = JSON.parse(body); // validate JSON
      const name    = data.name || safe.replace('.json', '');
      const smCount = Array.isArray(data.stateMachines) ? data.stateMachines.length : 0;
      const now     = Date.now();

      if (dbReady) {
        try {
          const pool = (await getDb()).getPool();
          await pool.query(`
            INSERT INTO projects (filename, name, data, sm_count, last_modified)
            VALUES (?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
              name=VALUES(name), data=VALUES(data), sm_count=VALUES(sm_count),
              last_modified=VALUES(last_modified)
          `, [safe, name, body, smCount, now]);
          // Also write to local file as backup
          fs.writeFileSync(path.join(DATA_DIR_, safe), body, 'utf8');
          return sendJson(res, 200, { ok: true, filename: safe });
        } catch (e) {
          console.warn('[projects/save] MySQL failed, saving to file only:', e.message);
        }
      }

      // File fallback (also runs if MySQL is down)
      const filePath = path.join(DATA_DIR_, safe);
      if (fs.existsSync(filePath)) {
        const backupDir = path.join(DATA_DIR_, '_backups');
        if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        fs.copyFileSync(filePath, path.join(backupDir, safe.replace('.json', `__${ts}.json`)));
        const prefix = safe.replace('.json', '__');
        const backups = fs.readdirSync(backupDir).filter(f => f.startsWith(prefix)).sort().reverse();
        for (const old of backups.slice(5)) fs.unlinkSync(path.join(backupDir, old));
      }
      fs.writeFileSync(filePath, body, 'utf8');
      sendJson(res, 200, { ok: true, filename: safe });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
  }

  async function handleDelete(res, filename) {
    const safe = safeFilename(filename);
    if (!safe) return sendJson(res, 400, { error: 'Invalid filename' });

    try {
      if (dbReady) {
        const pool = (await getDb()).getPool();
        await pool.query('DELETE FROM projects WHERE filename = ?', [safe]);
        // Also delete local file if it exists
        const fp = path.join(DATA_DIR_, safe);
        if (fs.existsSync(fp)) fs.unlinkSync(fp);
        return sendJson(res, 200, { ok: true });
      }
    } catch (e) {
      console.warn('[projects/delete] MySQL failed, deleting file only:', e.message);
    }

    const fp = path.join(DATA_DIR_, safe);
    if (!fs.existsSync(fp)) return sendJson(res, 404, { error: 'Not found' });
    try { fs.unlinkSync(fp); sendJson(res, 200, { ok: true }); }
    catch (e) { sendJson(res, 500, { error: e.message }); }
  }

  // ── AI L5X Generation (agentGenerator) ─────────────────────────────────────

  /** POST /api/generate — body: { filename | projectJson, smId, options? }.
   *  Runs promptBuilder -> Claude -> validator (with self-repair) and returns
   *  { ok, l5x, validation, reviewNotes, meta }. The agentGenerator module is
   *  required lazily so the server still runs with only Node built-ins when
   *  node_modules is absent; missing ANTHROPIC_API_KEY surfaces as a 503. */
  async function handleGenerate(req, res) {
    let gen;
    try {
      gen = require('./src/lib/agentGenerator/client.js');
    } catch (e) {
      return sendJson(res, 503, {
        error: 'AI generation not available — run npm install (agentGenerator dependencies missing): ' + e.message,
      });
    }
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      let projectJson = body.projectJson;
      if (!projectJson && body.filename) {
        const safe = safeFilename(body.filename);
        if (!safe) return sendJson(res, 400, { error: 'Invalid filename' });
        const fp = path.join(DATA_DIR_, safe);
        if (!fs.existsSync(fp)) return sendJson(res, 404, { error: 'Project not found' });
        projectJson = JSON.parse(fs.readFileSync(fp, 'utf8'));
      }
      if (!projectJson) return sendJson(res, 400, { error: 'Provide filename or projectJson' });

      const result = await gen.generateL5X(projectJson, body.smId, body.options || {});
      sendJson(res, 200, result);
    } catch (e) {
      if (e && e.code === 'AI_NOT_CONFIGURED') {
        return sendJson(res, 503, { error: e.message });
      }
      sendJson(res, 500, { error: e.message });
    }
  }

  /** GET /api/generate/stream?filename=&smId= — SSE live-progress generation.
   *  One connection runs the whole pipeline: progress events stream as the
   *  model works, the final `done` event carries the full result payload
   *  (minus nothing — l5x included), and closing the connection aborts the
   *  in-flight SDK stream. On success the L5X is also written to
   *  generated/<project>/<sm>__jarvis_v<version>__<date>.L5X. */
  async function handleGenerateStream(req, res, query) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no',
    });
    const send = (event, data) => {
      try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (_) {}
    };

    let gen;
    try {
      gen = require('./src/lib/agentGenerator/client.js');
    } catch (e) {
      send('error', { error: 'AI generation not available — run npm install: ' + e.message });
      return res.end();
    }

    const abort = new AbortController();
    let clientGone = false;
    req.on('close', () => { clientGone = true; abort.abort(); });

    // Monotonic progress guard — repair rounds report inside 88-92 which
    // could otherwise step backward past the validate marker.
    let lastPct = 0;
    const onProgress = (pct, stage, detail) => {
      const p = Math.max(lastPct, Math.min(Math.round(pct * 10) / 10, 99));
      lastPct = p;
      send('progress', { pct: p, stage, detail });
    };

    try {
      const safe = safeFilename(query.filename || '');
      if (!safe) { send('error', { error: 'Invalid or missing filename' }); return res.end(); }
      const fp = path.join(DATA_DIR_, safe);
      if (!fs.existsSync(fp)) { send('error', { error: 'Project not found: ' + safe }); return res.end(); }
      const projectJson = JSON.parse(fs.readFileSync(fp, 'utf8'));

      send('progress', { pct: 2, stage: 'start', detail: `Loaded ${safe}` });
      const result = await gen.generateL5X(projectJson, query.smId || undefined, {
        onProgress, signal: abort.signal,
      });

      // Auto-save the generated program so the user always knows where it is.
      let savedPath = null;
      if (result.l5x) {
        try {
          // eslint-disable-next-line no-useless-escape -- escaped - inside a character class is harmless
          const clean = (s) => String(s || 'unnamed').replace(/[^a-zA-Z0-9_\-]/g, '_');
          const ver = result.meta?.jarvisVersion || '0';
          const date = new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '');
          const dir = path.join(__dirname, 'generated', clean(projectJson.name || safe.replace('.json', '')));
          fs.mkdirSync(dir, { recursive: true });
          savedPath = path.join(dir, `${clean(result.meta?.smName)}__jarvis_v${ver}__${date}.L5X`);
          fs.writeFileSync(savedPath, result.l5x, 'utf8');
        } catch (e) {
          console.warn('[generate] auto-save failed:', e.message);
        }
      }

      send('progress', { pct: 100, stage: 'done', detail: result.ok ? 'Generation complete' : 'Finished with validation errors' });
      send('done', { ...result, savedPath });
    } catch (e) {
      if (clientGone || (e && (e.name === 'AbortError' || e.name === 'APIUserAbortError'))) {
        // Client cancelled — nothing to report.
      } else if (e && e.code === 'AI_NOT_CONFIGURED') {
        send('error', { error: e.message });
      } else {
        send('error', { error: e.message || String(e) });
      }
    }
    res.end();
  }

  // ── JARVIS describe-your-station -> diagram draft ──────────────────────────

  /** POST /api/jarvis/diagram — body: { description, images: [{name, base64,
   *  mediaType}] }. Authors a State Logic Builder project draft via Claude,
   *  validates it, saves it to projects/<name>_draft.json, and returns
   *  { ok, filename, summary, openQuestions, fixups, meta }. */
  async function handleJarvisDiagram(req, res) {
    let author;
    try {
      author = require('./src/lib/agentGenerator/diagramAuthor.js');
    } catch (e) {
      return sendJson(res, 503, { error: 'Diagram author not available — run npm install: ' + e.message });
    }
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      if (!body.description || !String(body.description).trim()) {
        return sendJson(res, 400, { error: 'description is required' });
      }
      const result = await author.authorDiagram({
        description: body.description,
        images: Array.isArray(body.images) ? body.images : [],
        station: body.station && typeof body.station === 'object' ? body.station : null,
      });

      // Single-SM mode (Create Station flow): no draft file — the client
      // inserts the SM into its CURRENT project via store actions.
      if (body.station && body.station.name) {
        return sendJson(res, 200, {
          ok: true,
          sm: result.project.stateMachines[0],
          summary: result.summary,
          openQuestions: result.openQuestions,
          fixups: result.fixups,
          meta: result.meta,
        });
      }

      // Save the draft into the projects dir so the app can open it directly.
      const base = String(result.project.name || 'JarvisDraft')
        .replace(/[^a-zA-Z0-9_\- ]/g, '').replace(/\s+/g, '_') || 'JarvisDraft';
      let filename = `${base}_draft.json`;
      // Don't clobber an existing draft silently — suffix a counter.
      let n = 2;
      while (fs.existsSync(path.join(DATA_DIR_, filename))) {
        filename = `${base}_draft${n++}.json`;
        if (n > 50) break;
      }
      fs.writeFileSync(path.join(DATA_DIR_, filename), JSON.stringify(result.project, null, 2), 'utf8');

      sendJson(res, 200, {
        ok: true,
        filename,
        summary: result.summary,
        openQuestions: result.openQuestions,
        fixups: result.fixups,
        meta: result.meta,
      });
    } catch (e) {
      if (e && e.code === 'AI_NOT_CONFIGURED') return sendJson(res, 503, { error: e.message });
      sendJson(res, 500, { error: e.message });
    }
  }

  /** POST /api/jarvis/spec — body: { description, images, sm, otherSms,
   *  existingSpec }. Extracts a machineSpec + devices delta from a free-form
   *  station explanation. Stateless: the client renders a review screen and
   *  persists via its own store on Save. */
  async function handleJarvisSpec(req, res) {
    let author;
    try {
      author = require('./src/lib/agentGenerator/specAuthor.js');
    } catch (e) {
      return sendJson(res, 503, { error: 'Spec author not available — run npm install: ' + e.message });
    }
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      if (!body.description || !String(body.description).trim()) {
        return sendJson(res, 400, { error: 'description is required' });
      }
      const result = await author.authorSpec({
        description: body.description,
        images: Array.isArray(body.images) ? body.images : [],
        sm: body.sm && typeof body.sm === 'object' ? body.sm : {},
        otherSms: Array.isArray(body.otherSms) ? body.otherSms : [],
        existingSpec: body.existingSpec || null,
      });
      sendJson(res, 200, { ok: true, ...result });
    } catch (e) {
      if (e && e.code === 'AI_NOT_CONFIGURED') return sendJson(res, 503, { error: e.message });
      sendJson(res, 500, { error: e.message });
    }
  }

  // ── Standards Library ─────────────────────────────────────────────────────

  function readStandardsArrayFromFile() {
    try {
      if (!fs.existsSync(STANDARDS_FILE_)) return [];
      const raw = fs.readFileSync(STANDARDS_FILE_, 'utf8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }

  function writeStandardsFile(arr) {
    try { fs.mkdirSync(STANDARDS_DIR_, { recursive: true }); } catch (_) {}
    if (fs.existsSync(STANDARDS_FILE_)) {
      const backupDir = path.join(STANDARDS_DIR_, '_backups');
      try {
        fs.mkdirSync(backupDir, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        fs.copyFileSync(STANDARDS_FILE_, path.join(backupDir, `standards__${ts}.json`));
        const backups = fs.readdirSync(backupDir).filter(f => f.startsWith('standards__')).sort().reverse();
        for (const old of backups.slice(5)) { try { fs.unlinkSync(path.join(backupDir, old)); } catch (_) {} }
      } catch (e) { console.warn('[standards] backup failed:', e.message); }
    }
    const tmp = STANDARDS_FILE_ + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(arr, null, 2), 'utf8');
    fs.renameSync(tmp, STANDARDS_FILE_);
  }

  async function handleStandardsList(res) {
    try {
      if (dbReady) {
        const pool = (await getDb()).getPool();
        const [rows] = await pool.query('SELECT data FROM standards ORDER BY updated_at');
        const arr = rows.map(row => {
          try { return JSON.parse(row.data); } catch { return null; }
        }).filter(Boolean);
        return sendJson(res, 200, arr);
      }
    } catch (e) {
      console.warn('[standards/list] MySQL failed, using file:', e.message);
    }
    sendJson(res, 200, readStandardsArrayFromFile());
  }

  async function handleStandardsReplace(req, res) {
    try {
      const body   = await readBody(req);
      const parsed = JSON.parse(body);
      if (!Array.isArray(parsed)) return sendJson(res, 400, { error: 'Body must be a JSON array' });

      if (dbReady) {
        try {
          const pool = (await getDb()).getPool();
          const conn = await pool.getConnection();
          await conn.beginTransaction();
          try {
            // Replace the whole library: clear, then re-insert each entry.
            await conn.query('DELETE FROM standards');
            for (const s of parsed) {
              if (!s?.id) continue;
              await conn.query('INSERT INTO standards (id, data) VALUES (?, ?)', [s.id, JSON.stringify(s)]);
            }
            await conn.commit();
          } catch (e) { await conn.rollback(); conn.release(); throw e; }
          conn.release();
          writeStandardsFile(parsed);
          return sendJson(res, 200, { ok: true, total: parsed.length });
        } catch (e) {
          console.warn('[standards/replace] MySQL failed, writing to file only:', e.message);
        }
      }

      writeStandardsFile(parsed);
      sendJson(res, 200, { ok: true, total: parsed.length });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
  }

  async function handleStandardsUpsert(req, res, id) {
    if (!id) return sendJson(res, 400, { error: 'Missing id' });
    try {
      const body     = await readBody(req);
      const incoming = JSON.parse(body);
      if (!incoming || typeof incoming !== 'object') return sendJson(res, 400, { error: 'Body must be a JSON object' });
      incoming.id = id;

      if (dbReady) {
        try {
          const pool = (await getDb()).getPool();
          await pool.query(
            'INSERT INTO standards (id, data) VALUES (?, ?) ON DUPLICATE KEY UPDATE data=VALUES(data)',
            [id, JSON.stringify(incoming)]
          );
          // Mirror to file
          const current = readStandardsArrayFromFile();
          const idx = current.findIndex(s => s?.id === id);
          if (idx === -1) current.push(incoming); else current[idx] = incoming;
          writeStandardsFile(current);
          return sendJson(res, 200, { ok: true, id, total: current.length });
        } catch (e) {
          console.warn('[standards/upsert] MySQL failed, using file only:', e.message);
        }
      }

      const current = readStandardsArrayFromFile();
      const idx = current.findIndex(s => s?.id === id);
      if (idx === -1) current.push(incoming); else current[idx] = incoming;
      writeStandardsFile(current);
      sendJson(res, 200, { ok: true, id, total: current.length });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
  }

  async function handleStandardsDelete(res, id) {
    if (!id) return sendJson(res, 400, { error: 'Missing id' });
    try {
      if (dbReady) {
        try {
          const pool = (await getDb()).getPool();
          await pool.query('DELETE FROM standards WHERE id = ?', [id]);
          const current = readStandardsArrayFromFile();
          const next = current.filter(s => s?.id !== id);
          writeStandardsFile(next);
          return sendJson(res, 200, { ok: true, id, total: next.length });
        } catch (e) {
          console.warn('[standards/delete] MySQL failed, using file only:', e.message);
        }
      }

      const current = readStandardsArrayFromFile();
      const next = current.filter(s => s?.id !== id);
      if (next.length === current.length) return sendJson(res, 404, { error: 'Not found' });
      writeStandardsFile(next);
      sendJson(res, 200, { ok: true, id, total: next.length });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
  }

  function serveStatic(res, reqPath) {
    let fp = path.join(DIST_DIR_, reqPath === '/' ? 'index.html' : reqPath);
    if (!path.extname(fp) || !fs.existsSync(fp)) fp = path.join(DIST_DIR_, 'index.html');
    if (!fs.existsSync(fp)) { res.writeHead(404); return res.end('Not found'); }
    const content = fs.readFileSync(fp);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream', 'Content-Length': content.length });
    res.end(content);
  }

  const server = http.createServer(async (req, res) => {
    const { pathname = '/', query = {} } = url.parse(req.url || '/', true);
    const method = (req.method || 'GET').toUpperCase();

    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      return res.end();
    }

    if (pathname === '/health' && method === 'GET') {
      return sendJson(res, 200, { ok: true, storage: dbReady ? 'mysql' : 'local' });
    }

    // SDC Tools SSO gate — everything below this line requires the shared
    // sdc_session cookie once SDC_SSO_ENABLED=true (see sdcSessionAuth.js).
    // While the flag is unset/false (default today) this is a no-op, so
    // behavior is unchanged until SSO is deliberately turned on for this
    // app. The OPTIONS preflight handled above is intentionally NOT gated:
    // browsers never send cookies on a preflight request, so gating it
    // would break CORS preflight for every cross-origin call regardless of
    // login state.
    if (!applySdcSessionGate(req, res)) return; // 401 (or sign-in page) already sent

    if (pathname.startsWith('/api/projects')) {
      const rest     = pathname.slice('/api/projects'.length);
      const filename = rest.startsWith('/') ? decodeURIComponent(rest.slice(1)) : null;
      if (!filename && method === 'GET')    return handleList(res);
      if (filename  && method === 'GET')    return handleLoad(res, filename);
      if (filename  && method === 'POST')   return handleSave(req, res, filename);
      if (filename  && method === 'DELETE') return handleDelete(res, filename);
      return sendJson(res, 405, { error: 'Method not allowed' });
    }

    if (pathname === '/api/generate') {
      if (method === 'POST') return handleGenerate(req, res);
      return sendJson(res, 405, { error: 'Method not allowed' });
    }

    if (pathname === '/api/generate/stream') {
      if (method === 'GET') return handleGenerateStream(req, res, query);
      return sendJson(res, 405, { error: 'Method not allowed' });
    }

    if (pathname === '/api/jarvis/diagram') {
      if (method === 'POST') return handleJarvisDiagram(req, res);
      return sendJson(res, 405, { error: 'Method not allowed' });
    }

    if (pathname === '/api/jarvis/spec') {
      if (method === 'POST') return handleJarvisSpec(req, res);
      return sendJson(res, 405, { error: 'Method not allowed' });
    }

    if (pathname.startsWith('/api/standards')) {
      const rest = pathname.slice('/api/standards'.length);
      if (rest === '/_debug' && method === 'GET') {
        return sendJson(res, 200, {
          storage: dbReady ? 'MySQL sdc_statelogic' : 'local JSON files (fallback)',
          standardsFile: STANDARDS_FILE_,
          dbReady,
        });
      }
      const id = rest.startsWith('/') ? decodeURIComponent(rest.slice(1)) : null;
      if (!id && method === 'GET')    return handleStandardsList(res);
      if (!id && method === 'POST')   return handleStandardsReplace(req, res);
      if (id  && method === 'POST')   return handleStandardsUpsert(req, res, id);
      if (id  && method === 'DELETE') return handleStandardsDelete(res, id);
      return sendJson(res, 405, { error: 'Method not allowed' });
    }

    // Unmatched /api/* — return JSON 404 instead of silently falling through to
    // the SPA HTML, so callers get a structured error they can act on.
    if (pathname.startsWith('/api/')) {
      return sendJson(res, 404, { error: `No API route: ${method} ${pathname}` });
    }

    if (fs.existsSync(DIST_DIR_)) return serveStatic(res, pathname);

    res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><body style="font-family:sans-serif;padding:40px;background:#111;color:#eee"><h2 style="color:#f59e0b">App not built yet</h2><p>Run <b>BUILD_AND_RUN.bat</b> to build and start the server.</p></body></html>');
  });

  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      console.error('\nPort ' + PORT_ + ' is already in use.\n');
    } else {
      console.error('Server error:', err);
    }
    if (require.main === module) process.exit(1);
  });

  server.listen(PORT_, '0.0.0.0', () => {
    const ips = Object.values(os.networkInterfaces())
      .flat()
      .filter(i => i.family === 'IPv4' && !i.internal)
      .map(i => i.address);
    console.log('\n' + '='.repeat(56));
    console.log('  SDC State Logic Builder - Project Server');
    console.log('='.repeat(56));
    console.log('  Local:    http://localhost:' + PORT_);
    ips.forEach(ip => console.log('  Network:  http://' + ip + ':' + PORT_ + '  <- share with team'));
    console.log('  Projects:  ' + DATA_DIR_);
    console.log('  Standards: ' + STANDARDS_DIR_);
    console.log('  Storage:   MySQL sdc_statelogic (with local JSON fallback)');
    console.log('='.repeat(56) + '\n  Press Ctrl+C to stop.\n');
  });

  return server;
}

// Standalone mode: node server.js
if (require.main === module) {
  const server = startServer();
  process.on('SIGTERM', () => {
    console.log('[statelogic] SIGTERM — shutting down gracefully');
    server.close(() => process.exit(0));
  });
}

module.exports = { startServer };
