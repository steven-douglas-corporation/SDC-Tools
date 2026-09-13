// processManager.js is the one electron/ module that never requires `electron`
// (only node:http + node:events), so it can be exercised directly under
// node:test. The module exports a singleton; a fresh instance per test comes
// from its constructor so SDC_SERVER_HOST changes are observed (configs are
// cached lazily on first access).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const singleton = require('../../electron/processManager.js');
const ProcessManager = singleton.constructor;

const APP_IDS = ['assemblies', 'readiness', 'scheduler', 'statelogic', 'calendar', 'reports'];

function withHost(host, fn) {
  const prev = process.env.SDC_SERVER_HOST;
  if (host === undefined) delete process.env.SDC_SERVER_HOST;
  else process.env.SDC_SERVER_HOST = host;
  try {
    return fn(new ProcessManager());
  } finally {
    if (prev === undefined) delete process.env.SDC_SERVER_HOST;
    else process.env.SDC_SERVER_HOST = prev;
  }
}

describe('_buildConfigs (server host -> app URLs)', () => {
  test('builds http://<SDC_SERVER_HOST>:<port> for every app', () => {
    withHost('SERVER-APP1', (pm) => {
      const cfg = pm.configs;
      assert.deepEqual(Object.keys(cfg).sort(), [...APP_IDS].sort());
      for (const id of APP_IDS) {
        assert.equal(cfg[id].id, id);
        assert.equal(cfg[id].url, `http://SERVER-APP1:${cfg[id].port}`);
        assert.ok(cfg[id].healthPath.startsWith('/'), `${id} healthPath is absolute`);
      }
      assert.equal(cfg.assemblies.port, 4001);
      assert.equal(cfg.reports.port, 4006);
      assert.equal(cfg.calendar.healthPath, '/api/health');
    });
  });

  test('falls back to localhost when SDC_SERVER_HOST is unset', () => {
    withHost(undefined, (pm) => {
      assert.equal(pm.configs.scheduler.url, 'http://localhost:4003');
    });
  });

  test('caches the config object after first access', () => {
    withHost('a', (pm) => {
      const first = pm.configs;
      process.env.SDC_SERVER_HOST = 'b';
      assert.equal(pm.configs, first);
      assert.equal(pm.configs.scheduler.url, 'http://a:4003');
    });
  });
});

describe('getStatus / _setStatus', () => {
  test('reports every app as stopped before monitoring starts', () => {
    withHost('h', (pm) => {
      const status = pm.getStatus();
      assert.deepEqual(Object.keys(status).sort(), [...APP_IDS].sort());
      for (const id of APP_IDS) {
        assert.equal(status[id].status, 'stopped');
        assert.equal(status[id].url, `http://h:${status[id].port}`);
        assert.equal(typeof status[id].name, 'string');
        assert.deepEqual(Object.keys(status[id].windowSize), ['width', 'height']);
      }
    });
  });

  test('_setStatus updates the snapshot and emits status-change with the full map', () => {
    withHost('h', (pm) => {
      const emitted = [];
      pm.on('status-change', (s) => emitted.push(s));
      pm._setStatus('scheduler', 'running');
      assert.equal(pm.getStatus().scheduler.status, 'running');
      assert.equal(pm.getStatus().calendar.status, 'stopped');
      assert.equal(emitted.length, 1);
      assert.equal(emitted[0].scheduler.status, 'running');
      assert.equal(Object.keys(emitted[0]).length, APP_IDS.length);
    });
  });
});

describe('_log / getLogs (ring buffer)', () => {
  test('returns [] for an app with no log lines', () => {
    withHost('h', (pm) => assert.deepEqual(pm.getLogs('nope'), []));
  });

  test('appends lines in order and emits log events', () => {
    withHost('h', (pm) => {
      const events = [];
      pm.on('log', (e) => events.push(e));
      pm._log('scheduler', 'one');
      pm._log('scheduler', 'two');
      assert.deepEqual(pm.getLogs('scheduler'), ['one', 'two']);
      assert.deepEqual(events, [
        { id: 'scheduler', line: 'one' },
        { id: 'scheduler', line: 'two' },
      ]);
    });
  });

  test('keeps only the newest 50 lines per app', () => {
    withHost('h', (pm) => {
      for (let i = 0; i < 60; i++) pm._log('calendar', `line ${i}`);
      const logs = pm.getLogs('calendar');
      assert.equal(logs.length, 50);
      assert.equal(logs[0], 'line 10');
      assert.equal(logs.at(-1), 'line 59');
      assert.deepEqual(pm.getLogs('scheduler'), []);
    });
  });
});

describe('_ping (health check)', () => {
  let server;
  let base;
  before(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/health') return res.writeHead(200).end('ok');
      if (req.url === '/down') return res.writeHead(503).end('down');
      if (req.url === '/missing') return res.writeHead(404).end('nope');
      res.writeHead(500).end('boom');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => new Promise((r) => server.close(r)));

  test('resolves true for a 2xx health response', async () => {
    const pm = new ProcessManager();
    assert.equal(await pm._ping(base, '/health'), true);
  });

  test('treats any status below 500 as up (a 404 is still a live server)', async () => {
    const pm = new ProcessManager();
    assert.equal(await pm._ping(base, '/missing'), true);
  });

  test('resolves false for a 5xx response', async () => {
    const pm = new ProcessManager();
    assert.equal(await pm._ping(base, '/down'), false);
    assert.equal(await pm._ping(base, '/'), false);
  });

  test('resolves false (never rejects) when nothing is listening', async () => {
    const pm = new ProcessManager();
    const closed = http.createServer();
    await new Promise((r) => closed.listen(0, '127.0.0.1', r));
    const port = closed.address().port;
    await new Promise((r) => closed.close(r));
    assert.equal(await pm._ping(`http://127.0.0.1:${port}`, '/health'), false);
  });

  test('defaults the path to "/" when healthPath is empty', async () => {
    const pm = new ProcessManager();
    assert.equal(await pm._ping(base, ''), false); // "/" -> 500 on this fixture
    assert.equal(await pm._ping(base, undefined), false);
  });
});
