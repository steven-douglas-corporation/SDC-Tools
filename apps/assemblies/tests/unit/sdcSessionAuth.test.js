/**
 * Unit tests — server/sdcSessionAuth.js: JWT verification and the feature-flag
 * gate. No database, no sockets. Env is set before the module is loaded because
 * it reads SDC_SESSION_SECRET / SDC_SSO_ENABLED at require time.
 */
'use strict';

const jwt = require('jsonwebtoken');

const SECRET = 'unit-test-secret';
process.env.SDC_SESSION_SECRET = SECRET;
delete process.env.SDC_SSO_ENABLED; // flag off → middleware must be a pass-through

const { verifySdcSession, requireSdcSession, SDC_SSO_ENABLED } = require('../../server/sdcSessionAuth');

describe('verifySdcSession', () => {
  it('returns the claims for a token signed with the shared secret', () => {
    const token = jwt.sign({ email: 'a@sdc.test', apps: { assemblies: 'editor' } }, SECRET);
    expect(verifySdcSession(token)).toMatchObject({ email: 'a@sdc.test', apps: { assemblies: 'editor' } });
  });
  it('returns null for a missing, malformed, or wrong-secret token', () => {
    expect(verifySdcSession('')).toBeNull();
    expect(verifySdcSession('not.a.jwt')).toBeNull();
    expect(verifySdcSession(jwt.sign({ email: 'x' }, 'some-other-secret'))).toBeNull();
  });
});

describe('requireSdcSession with SDC_SSO_ENABLED off', () => {
  it('exposes the flag as false and calls next() without touching the response', () => {
    expect(SDC_SSO_ENABLED).toBe(false);
    const mw = requireSdcSession('assemblies');
    const res = { status: vi.fn(), json: vi.fn(), type: vi.fn(), send: vi.fn() };
    const next = vi.fn();
    mw({ cookies: {}, headers: {} }, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});
