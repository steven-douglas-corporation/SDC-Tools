/**
 * SDC Tools centralized session (shell side).
 *
 * After auth.js's own Azure AD login succeeds, this exchanges the Microsoft
 * ID token for one signed-in session that works across all 5 sub-apps. This
 * module never signs anything itself — it is only a courier for a token
 * Scheduler already signed server-side (see
 * Centrailized library/SDC_Scheduler/routes/ssoCentral.js). The shell must
 * never hold a signing secret: it's an app installed on every employee's
 * desktop, and anything embedded in it can be extracted.
 *
 * The cookie is set for the bare host (no Domain attribute), so it applies
 * across every port on that host automatically — cookies are never
 * port-scoped. All 5 sub-app BrowserWindows use Electron's default session,
 * so they see it with zero per-window wiring.
 */
const { session } = require('electron');

// Failure-path logging only. Kept deliberately: when a suite session can't be
// established the user just sees "sign in again" with no other clue, and this
// is the one place that knows why.
function _diag(msg) { console.warn(`[sdcSession] ${msg}`); }

const SERVER_HOST = process.env.SDC_SERVER_HOST || 'localhost';
const SCHEDULER_PORT = 4003;
const EXCHANGE_URL = `http://${SERVER_HOST}:${SCHEDULER_PORT}/api/auth/entra-exchange`;
const COOKIE_URL = `http://${SERVER_HOST}`;
const SESSION_TTL_SECONDS = 12 * 60 * 60;

let _lastApps = null;
let _lastSchedulerToken = null;
let _lastSdcSession = null;

/** Call this once after a successful login (fresh or silently-restored). */
async function establishSdcSession(idToken) {
  if (!idToken) return { success: false, error: 'No Microsoft ID token available.' };

  let body;
  try {
    const res = await fetch(EXCHANGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken }),
    });
    body = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { success: false, error: body.error || `Central sign-in failed (HTTP ${res.status}).` };
    }
  } catch (err) {
    return { success: false, error: 'Could not reach the SDC Tools sign-in service: ' + err.message };
  }

  const expirationDate = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const ses = session.defaultSession;
  await Promise.all([
    ses.cookies.set({
      url: COOKIE_URL, name: 'sdc_session', value: body.sdcSession,
      httpOnly: true, sameSite: 'lax', expirationDate,
    }),
    // Not httpOnly — Scheduler's own frontend still runs its existing
    // localStorage-based Bearer-token flow (unchanged, see its CLAUDE.md:
    // "NEVER remove or simplify auth.js JWT logic"); a small addition to
    // custom-public/app-local.js reads this via document.cookie once to
    // seed that flow, exactly as if the user had just logged in normally.
    ses.cookies.set({
      url: COOKIE_URL, name: 'scheduler_token', value: body.schedulerToken,
      httpOnly: false, sameSite: 'lax', expirationDate,
    }),
  ]);

  _lastApps = body.apps || null;
  _lastSchedulerToken = body.schedulerToken || null;
  _lastSdcSession = body.sdcSession || null;
  return { success: true, apps: body.apps, user: body.user };
}

// Guarantees a live session exists, establishing one on demand if the
// fire-and-forget startup call hasn't landed (or failed). Returns true when
// tokens are available.
//
// This exists because the startup establish is deliberately NOT awaited — so
// the launcher window appears instantly rather than waiting on the network.
// The cost was that opening an app before that call finished found no cookie
// and fell back to that app's own login form: the "why am I asked to sign in
// again after restarting SDC Tools" bug. Anything that needs the session now
// asks for it here instead of assuming startup already did the work.
async function ensureSession() {
  if (_lastSchedulerToken && _lastSdcSession) return true;
  try {
    const auth = require('./auth');
    const status = await auth.getAuthStatus();
    if (!status.isAuthenticated || !status.idToken) {
      _diag('not signed into Microsoft (or MSAL returned no ID token) — cannot establish a suite session.');
      return false;
    }
    const result = await establishSdcSession(status.idToken);
    if (!result.success) {
      _diag(`could not establish a suite session: ${result.error}`);
      return false;
    }
    return Boolean(_lastSchedulerToken && _lastSdcSession);
  } catch (err) {
    _diag(`establishing a suite session threw: ${err.message}`);
    return false;
  }
}

// Writes the session cookies against ONE app's exact origin (e.g.
// "http://SERVER-APP1:4003") immediately before that window loads.
//
// Previously these were written once, against a bare "http://<host>" URL, at
// login time only. Cookies aren't port-scoped so that *should* reach every
// app — but it made every window depend on a single earlier write having
// succeeded, with no way to notice or recover if it hadn't. Setting them
// per-origin, per-open, right before loadURL(), removes both the race and any
// host-normalization ambiguity, and costs nothing: it's the same two cookies.
async function applySessionCookies(originUrl) {
  if (!_lastSdcSession || !_lastSchedulerToken) return false;
  const expirationDate = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const ses = session.defaultSession;
  try {
    await Promise.all([
      ses.cookies.set({
        url: originUrl, name: 'sdc_session', value: _lastSdcSession,
        httpOnly: true, sameSite: 'lax', expirationDate,
      }),
      // Not httpOnly — Scheduler's own frontend reads this via document.cookie
      // (see its public/index.html) to seed the existing localStorage-based
      // Bearer flow, which stays unchanged.
      ses.cookies.set({
        url: originUrl, name: 'scheduler_token', value: _lastSchedulerToken,
        httpOnly: false, sameSite: 'lax', expirationDate,
      }),
    ]);
    return true;
  } catch (err) {
    _diag(`could not set session cookies for ${originUrl}: ${err.message}`);
    return false;
  }
}

/** Call this from the shell's own sign-out — invalidates access to all 5 apps at once. */
async function clearSdcSession() {
  const ses = session.defaultSession;
  await Promise.all([
    ses.cookies.remove(COOKIE_URL, 'sdc_session'),
    ses.cookies.remove(COOKIE_URL, 'scheduler_token'),
    // Reports (apps/reports) isn't one of the 5 apps sharing sdc_session —
    // it's a real independent NextAuth session, established via the
    // mint-etc-sso bridge in openAppWindow(). Its cookie is non-secure and
    // host-only (same host, no Domain attribute), so it lives in this same
    // cookie jar under COOKIE_URL — clearing it here is what makes "sign out
    // of SDC Tools" actually sign out of Reports too, not just leave its
    // separate session running until it expires on its own.
    ses.cookies.remove(COOKIE_URL, 'authjs.session-token'),
  ]);
  _lastApps = null;
  _lastSchedulerToken = null;
  _lastSdcSession = null;
}

/** Per-app roles/flags from the last successful exchange — for launcher tile filtering. */
function getLastApps() {
  return _lastApps;
}

// Mints a fresh 60s hand-off token via Scheduler's existing mint-etc-sso
// endpoint (SDC_Scheduler/routes/auth.js) — the SAME bridge Scheduler↔Reports
// already uses for its own "open this job in Reports" links. Minted lazily,
// right when the Reports window is about to open, since the token is
// deliberately short-lived. Returns null on any failure (not yet logged into
// Scheduler, Scheduler unreachable) — callers must fall back to a plain
// (unauthenticated) open rather than fail the whole window.
async function mintEtcSsoHopToken() {
  await ensureSession();
  if (!_lastSchedulerToken) return null; // ensureSession already logged why
  try {
    const res = await fetch(`http://${SERVER_HOST}:${SCHEDULER_PORT}/api/auth/mint-etc-sso`, {
      headers: { Authorization: `Bearer ${_lastSchedulerToken}` },
    });
    if (res.status === 401 || res.status === 403) {
      // The cached Scheduler token was rejected — most likely its
      // token_version was bumped server-side since we minted it. Drop it and
      // re-exchange once rather than falling through to a second login form.
      _lastSchedulerToken = null;
      _lastSdcSession = null;
      if (await ensureSession()) return mintEtcSsoHopToken();
      return null;
    }
    if (!res.ok) {
      _diag(`Reports hand-off unavailable (HTTP ${res.status}) — opening its own login instead.`);
      return null;
    }
    const body = await res.json().catch(() => null);
    return body && body.token ? body.token : null;
  } catch (err) {
    _diag(`Reports hand-off request failed: ${err.message}`);
    return null;
  }
}

module.exports = {
  establishSdcSession,
  clearSdcSession,
  getLastApps,
  mintEtcSsoHopToken,
  ensureSession,
  applySessionCookies,
};
