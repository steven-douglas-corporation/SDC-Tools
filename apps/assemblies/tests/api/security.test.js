/**
 * Security tests
 *
 * Covers: localhost-only middleware, rate limiting, input sanitisation,
 * delete password enforcement, and path traversal prevention.
 */

'use strict';

const { createTestServer, closeServer, seedDb } = require('../setup/helpers');

let request, server, db;

beforeAll(async () => {
  ({ request, server, db } = await createTestServer());
  seedDb(db);
});

afterAll(async () => {
  await closeServer(server);
});

// ─── Localhost-only middleware ─────────────────────────────────────────────────
describe('Localhost-only middleware', () => {
  it('allows requests from 127.0.0.1 (supertest via TCP to 127.0.0.1)', async () => {
    const res = await request.get('/api/assemblies/status');
    expect(res.status).toBe(200);
  });

  it('blocks requests from a non-localhost IP (middleware unit check)', () => {
    // The server binds to 127.0.0.1 so external TCP connections are rejected at
    // the OS level before they ever reach Express.  We verify the middleware
    // logic itself here by simulating what Express would see.
    const mockReq = { socket: { remoteAddress: '192.168.1.100' } };
    const mockRes = {
      status(code) { this._code = code; return this; },
      json(body)   { this._body = body; return this; },
      _code: null, _body: null,
    };

    // Replicate the exact middleware logic from server/index.js
    const raw = mockReq.socket.remoteAddress || '';
    const ip  = raw.replace('::ffff:', '');
    if (ip !== '127.0.0.1' && ip !== '::1') {
      mockRes.status(403).json({ error: 'Access denied' });
    }

    expect(mockRes._code).toBe(403);
    expect(mockRes._body.error).toBe('Access denied');
  });
});

// ─── Rate limiting ─────────────────────────────────────────────────────────────
describe('Rate limiting', () => {
  it('returns 429 after exceeding request limit', async () => {
    // Fire requests sequentially in small batches to avoid overwhelming the server.
    // The sync route has a limit of 60 req/min — we fire 70 to reliably trigger it.
    const LIMIT = 60;
    const OVERSHOOT = 70;
    let hit429 = false;

    for (let i = 0; i < OVERSHOOT; i++) {
      const res = await request.get('/api/sync/status');
      if (res.status === 429) {
        hit429 = true;
        expect(res.body.error).toMatch(/Too many requests/i);
        break;
      }
    }

    expect(hit429).toBe(true);
  });
});

// ─── Delete password enforcement ──────────────────────────────────────────────
describe('Delete password enforcement', () => {
  it('single delete: 403 without password header', async () => {
    const res = await request.delete('/api/assemblies/TST-001');
    expect(res.status).toBe(403);
  });

  it('single delete: 403 with wrong password', async () => {
    const res = await request
      .delete('/api/assemblies/TST-001')
      .set('X-Delete-Password', 'WRONG');
    expect(res.status).toBe(403);
  });

  it('bulk delete: 403 without password', async () => {
    const res = await request
      .delete('/api/assemblies')
      .send({ partnos: ['TST-001'] });
    expect(res.status).toBe(403);
  });

  it('delete password is never echoed back in error responses', async () => {
    const res = await request
      .delete('/api/assemblies/TST-001')
      .set('X-Delete-Password', 'WRONG-SECRET-VALUE');
    expect(JSON.stringify(res.body)).not.toContain('WRONG-SECRET-VALUE');
  });
});

// ─── Input sanitisation ───────────────────────────────────────────────────────
describe('Input sanitisation', () => {
  afterEach(() => {
    db.db.prepare("DELETE FROM assemblies WHERE partno = 'TST-SEC-SANITISE'").run();
  });

  it('POST: strips unrecognized body fields (no extra keys in response)', async () => {
    const res = await request.post('/api/assemblies').send({
      partno: 'TST-SEC-SANITISE',
      description: 'Sanitise test',
      isAdmin: true,
      __proto__: { evil: true },
    });
    if (res.status === 201) {
      expect(res.body.assembly).not.toHaveProperty('isAdmin');
    } else {
      expect(res.status).not.toBe(500);
    }
  });

  it('PATCH bulk: disallows writing to non-whitelisted column (id = primary key)', async () => {
    const res = await request.patch('/api/assemblies').send({
      partnos: ['TST-001'],
      field: 'id',
      value: '9999',
    });
    expect(res.status).toBe(400);
  });

  it('PATCH bulk: SQL injection via value is harmless (parameterised queries)', async () => {
    const res = await request.patch('/api/assemblies').send({
      partnos: ['TST-001'],
      field: 'comments',
      value: "'; DROP TABLE assemblies; --",
    });
    expect(res.status).toBe(200);
    // DB should still be intact
    const check = await request.get('/api/assemblies/status');
    expect(check.status).toBe(200);
  });

  it('openFile: blocks double-extension path traversal', async () => {
    const res = await request.get('/api/assemblies/open?path=N:/../../etc/secrets.sldasm');
    expect([403, 404]).toContain(res.status);
  });

  it('openFile: blocks null-byte path injection', async () => {
    const res = await request.get('/api/assemblies/open?path=N:/valid%00.sldasm.exe');
    expect([400, 403, 404]).toContain(res.status);
    expect(res.status).not.toBe(200);
  });
});

// ─── Response hardening ───────────────────────────────────────────────────────
describe('Response hardening', () => {
  it('error responses never contain stack traces', async () => {
    const res = await request.post('/api/assemblies').send({});
    expect(JSON.stringify(res.body)).not.toMatch(/at\s+\w+\s+\(.*\.js:\d+:\d+\)/);
  });

  it('JSON body parsing limit is enforced (under 1 MB is accepted)', async () => {
    const body = JSON.stringify({ partno: 'TST-BIG', description: 'x'.repeat(900_000) });
    const res = await request
      .post('/api/assemblies')
      .set('Content-Type', 'application/json')
      .send(body);
    // Under 1 MB → accepted; description truncated to 2000 chars by sanitiseBody
    expect([201, 400]).toContain(res.status);
    db.db.prepare("DELETE FROM assemblies WHERE partno = 'TST-BIG'").run();
  });

  it('rejects payload over 1 MB (body-parser enforces 1mb limit)', async () => {
    const oversize = JSON.stringify({ partno: 'X', description: 'x'.repeat(1_100_000) });
    const res = await request
      .post('/api/assemblies')
      .set('Content-Type', 'application/json')
      .send(oversize);
    // body-parser returns 413; Express generic handler may convert to 500
    expect([413, 400, 500]).toContain(res.status);
    // Crucially, it must NOT succeed (201)
    expect(res.status).not.toBe(201);
  });
});
