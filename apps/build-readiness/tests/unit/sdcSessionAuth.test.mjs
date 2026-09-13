// Unit tests for server/sdcSessionAuth.js — the shared-session verifier.
// The module snapshots SDC_SESSION_SECRET / SDC_SSO_ENABLED at load, so the
// env is set BEFORE the dynamic import. Uses jsonwebtoken only (pure crypto —
// no network, database or socket). node --test runs each file in its own
// process, so these env values do not leak into the other test files.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

const SECRET = 'unit-test-secret';
process.env.SDC_SESSION_SECRET = SECRET;
process.env.SDC_SSO_ENABLED = 'true';
const { verifySdcSession, requireSdcSession, SDC_SSO_ENABLED } = await import('../../server/sdcSessionAuth.js');

const claims = { email: 'someone@sdcautomation.com', name: 'Someone', apps: { readiness: 'viewer', scheduler: 'admin' } };
const sign = (payload, secret = SECRET) => jwt.sign(payload, secret, { expiresIn: '1h' });

function mockRes() {
  const res = { statusCode: 200, body: undefined, contentType: null };
  res.status = code => { res.statusCode = code; return res; };
  res.type = t => { res.contentType = t; return res; };
  res.json = obj => { res.body = obj; return res; };
  res.send = html => { res.body = html; return res; };
  return res;
}

describe('verifySdcSession', () => {
  test('returns the claims for a token signed with the shared secret', () => {
    const out = verifySdcSession(sign(claims));
    assert.equal(out.email, claims.email);
    assert.deepEqual(out.apps, claims.apps);
  });

  test('returns null for a missing, malformed or foreign-signed token', () => {
    assert.equal(verifySdcSession(''), null);
    assert.equal(verifySdcSession(undefined), null);
    assert.equal(verifySdcSession('not-a-jwt'), null);
    assert.equal(verifySdcSession(sign(claims, 'someone-elses-secret')), null);
  });
});

describe('requireSdcSession (SDC_SSO_ENABLED=true)', () => {
  assert.equal(SDC_SSO_ENABLED, true);
  const guard = requireSdcSession('readiness');

  test('lets a session through when it grants this app, and exposes the user on req', () => {
    const req = { cookies: { sdc_session: sign(claims) }, headers: {} };
    const res = mockRes();
    let nextCalls = 0;
    guard(req, res, () => nextCalls++);
    assert.equal(nextCalls, 1);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(req.sdcUser, { email: claims.email, name: claims.name, role: 'viewer' });
  });

  test('answers 401 JSON to an API caller with no cookie', () => {
    const req = { cookies: {}, headers: { accept: 'application/json' } };
    const res = mockRes();
    let nextCalls = 0;
    guard(req, res, () => nextCalls++);
    assert.equal(nextCalls, 0);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.code, 'SDC_SESSION_REQUIRED');
  });

  test('answers 401 HTML to a browser whose session lacks this app', () => {
    const noReadiness = sign({ ...claims, apps: { scheduler: 'admin' } });
    const req = { cookies: { sdc_session: noReadiness }, headers: { accept: 'text/html' } };
    const res = mockRes();
    guard(req, res, () => assert.fail('next() must not be called'));
    assert.equal(res.statusCode, 401);
    assert.equal(res.contentType, 'html');
    assert.match(res.body, /Sign in required/);
    assert.equal(req.sdcUser, undefined);
  });
});
