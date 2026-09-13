require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');
const config = require('./config/paths');
const dbService = require('./services/db.service');
const assembliesRouter = require('./routes/assemblies');
const syncRouter = require('./routes/sync');

const app = express();
const PORT = config.PORT;

// ─── Logging ──────────────────────────────────────────────────────────────────
const logFile = path.join(config.SHARED_BASE, 'sdc-library.log');
const logStream = fs.createWriteStream(logFile, { flags: 'a' });

function logger(msg, level = 'INFO') {
    const line = `[${new Date().toISOString()}] [${level}] ${msg}\n`;
    process.stdout.write(line);
    try { logStream.write(line); } catch (_) {}
}

// ─── Security: Localhost + LAN only ──────────────────────────────────────────
// Allow 127.0.0.1, ::1, and private LAN ranges (192.168.x, 10.x, 172.16-31.x)
app.use((req, res, next) => {
    const raw = req.socket.remoteAddress || '';
    const ip = raw.replace('::ffff:', '');
    const isLocalhost = ip === '127.0.0.1' || ip === '::1';
    const isLAN = /^192\.168\./.test(ip) || /^10\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
    if (!isLocalhost && !isLAN) {
        logger(`Blocked request from ${ip} ${req.method} ${req.url}`, 'WARN');
        return res.status(403).json({ error: 'Access denied' });
    }
    next();
});

// ─── Security: Simple in-memory rate limiter ──────────────────────────────────
// 300 req/min for regular routes, 10 req/min for sensitive auth routes
const rateCounts = new Map();
setInterval(() => rateCounts.clear(), 60_000);

function rateLimit(maxPerMin) {
    return (req, res, next) => {
        const key = req.path;
        const count = (rateCounts.get(key) || 0) + 1;
        rateCounts.set(key, count);
        if (count > maxPerMin) {
            logger(`Rate limit hit: ${req.method} ${req.path}`, 'WARN');
            return res.status(429).json({ error: 'Too many requests — please slow down.' });
        }
        next();
    };
}

// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use(cors({ origin: config.ALLOWED_ORIGIN }));

// ─── Cookies (required to read the SDC Tools "sdc_session" cookie) ───────────
app.use(cookieParser());

// ─── Body parsing (capped at 1 MB to prevent memory exhaustion) ───────────────
app.use(express.json({ limit: '1mb' }));

// ─── Request logger (DEBUG only, never logs auth headers) ────────────────────
app.use((req, _res, next) => {
    if (process.env.DEBUG) logger(`${req.method} ${req.url}`);
    next();
});

// ─── Health check (used by Electron shell to detect readiness) ────────────────
app.get('/health', (_req, res) => res.json({ ok: true, service: 'assemblies' }));

// ─── SDC Tools centralized session ───────────────────────────────────────────
// Requires the shared "sdc_session" cookie (minted by SDC Scheduler's central
// SSO after Azure AD login) on everything below this line. No-op until
// SDC_SSO_ENABLED=true is set — see server/sdcSessionAuth.js.
app.use(require('./sdcSessionAuth').requireSdcSession('assemblies'));

// ─── API Routes ───────────────────────────────────────────────────────────────
app.use('/api/assemblies', rateLimit(300), assembliesRouter);
app.use('/api/sync',       rateLimit(60),  syncRouter);

// ─── Static: thumbnails ───────────────────────────────────────────────────────
app.use('/thumbnails', express.static(config.THUMB_DIR));

// ─── Generic error handler ────────────────────────────────────────────────────
// MUST come before static/catch-all so API errors still return JSON.
// Never expose err.message or stack to the client.
app.use((err, _req, res, _next) => {
    logger(`Unhandled error: ${err.message}\n${err.stack}`, 'ERROR');
    // Pass through meaningful 4xx codes (e.g. 413 from body-parser) without leaking internals
    const status = err.status || err.statusCode;
    if (status && status >= 400 && status < 500) {
        return res.status(status).json({ error: err.message || 'Bad request' });
    }
    res.status(500).json({ error: 'Internal server error' });
});

// ─── React frontend (production) ──────────────────────────────────────────────
const clientDist = path.join(config.ROOT, 'client', 'dist');
app.use(express.static(clientDist));
app.get('*', (_req, res) => {
    const indexPath = path.join(clientDist, 'index.html');
    res.sendFile(indexPath, (err) => {
        if (err) {
            logger('Failed to serve index.html', 'ERROR');
            res.status(404).json({ error: 'Not found' });
        }
    });
});

// ─── Exportable entry point (used by Electron in-process execution) ──────────
// Module-scoped so the EADDRINUSE retry in the uncaughtException handler below
// can reach the same http.Server instance.
let server = null;
function startServer({ port } = {}) {
    const p = port || PORT;
    server = app.listen(p, '0.0.0.0', () => {
        logger(`[assemblies] Running at http://0.0.0.0:${p}`);
        logger(`Database: MySQL — ${process.env.MYSQL_DATABASE || 'sdc_assemblies'}@${process.env.MYSQL_HOST || 'localhost'}`);

        dbService.getCounts()
            .then(({ globalTotal }) => logger(`Database OK — ${globalTotal} records.`))
            .catch(e => logger(`Database check FAILED: ${e.message}`, 'ERROR'));

        ['N', 'L'].forEach(drive => {
            const drivePath = config.DRIVES[drive];
            if (!fs.existsSync(drivePath)) {
                logger(`WARNING: ${drive}: drive not accessible at "${drivePath}".`, 'WARN');
            }
        });

        scheduleDailyBackup();
    });
    server.on('error', err => logger(`[assemblies] Server error: ${err.message}`, 'ERROR'));
    return server;
}

if (require.main === module) startServer();
module.exports = { startServer, app };

// ─── Automated Daily Backup ───────────────────────────────────────────────────
function scheduleDailyBackup() {
    const now = new Date();
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);
    const msUntilMidnight = midnight - now;

    setTimeout(async () => {
        try {
            const dest = await dbService.backup();
            logger(`Daily backup completed: ${dest}`);
        } catch (e) {
            logger(`Daily backup failed: ${e.message}`, 'ERROR');
        }
        scheduleDailyBackup(); // schedule next day
    }, msUntilMidnight);

    logger(`Next automatic backup in ${Math.round(msUntilMidnight / 3_600_000)}h.`);
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────
function shutdown(signal) {
    logger(`${signal} received — shutting down gracefully.`);
    try { dbService.close(); } catch (_) {}
    process.exit(0);
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
    logger(`Uncaught exception: ${err.message}\n${err.stack}`, 'ERROR');
    if (err.code === 'EADDRINUSE') {
        // Port still held by the previous process (e.g. after pm2 reload).
        // Wait 10 s for the old process to be killed, then retry binding.
        // Do NOT call process.exit() here — that triggers pm2 to restart
        // immediately into the same conflict, causing a crash loop.
        logger(`Port ${PORT} in use — waiting 10 s for old process to release it, then retrying…`, 'WARN');
        setTimeout(() => {
            logger(`Retrying bind on port ${PORT}…`, 'INFO');
            // server was created by app.listen() but never successfully bound.
            // Calling listen() again on the same server object is safe in Node.js
            // after an EADDRINUSE — no need to close() first.
            if (server) {
                server.listen(PORT, '0.0.0.0');
            } else {
                server = app.listen(PORT, '0.0.0.0');
            }
        }, 10000);
        return;
    }
    // For all other uncaught errors keep alive — Electron relies on this process
});
process.on('unhandledRejection', (reason) => {
    logger(`Unhandled rejection: ${reason}`, 'ERROR');
});
