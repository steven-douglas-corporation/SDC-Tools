require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, dialog, globalShortcut, Notification, shell } = require('electron');
const path = require('path');
const fs   = require('fs');
const processManager = require('./processManager');
const auth           = require('./auth');
const sdcSession     = require('./sdcSession');

// ── Single instance lock ────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  return;
}
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

// ── Auto-updater (production only) ──────────────────────────────────────────
// Design (mirrors Dan's state_logic_builder approach):
//   • autoDownload = true    — download silently in background, no prompt needed
//   • autoInstallOnAppQuit = false — prevents the double-NSIS-trigger bug
//     (April 2026 incident). Install only fires via explicit quitAndInstall().
//   • Check on launch + every 2 minutes.
let autoUpdater;
if (!process.env.SKIP_AUTO_UPDATE) {
  try {
    ({ autoUpdater } = require('electron-updater'));
    autoUpdater.autoDownload         = true;  // silent background download
    autoUpdater.autoInstallOnAppQuit = false; // explicit install only (safety)
    autoUpdater.logger = { info: console.log, warn: console.warn, error: console.error, debug: () => {} };
  } catch (e) {
    console.warn('[updater] electron-updater not available:', e.message);
  }
}

const isDev = !app.isPackaged;

let mainWindow = null;
let tray = null;
const appWindows = new Map();

// ── Windows taskbar identity + single-instance ownership ────────────────────
// Two separate defects used to combine into "clicking the SDC Tools taskbar
// icon flickers and never brings the window back":
//
//  1. No single-instance lock. Any second launch by Windows — a pinned
//     taskbar/Start shortcut clicked while the launcher was hidden to tray, the
//     login item, a double-clicked desktop icon — started a SECOND process
//     that ran the whole whenReady path: another BrowserWindow (so another
//     taskbar button), another Tray, and another processManager.startAll()
//     that then fought the first instance for ports 4001-4005. The new window
//     grabbed focus, its servers failed to bind, and what the user saw was the
//     flicker / duplicate-window / focus-bouncing behaviour.
//
//  2. No AppUserModelID. electron-builder's NSIS shortcut is stamped with the
//     appId (com.sdc.tools), but the running process never claimed that same
//     id, so Windows did not treat the live window as belonging to the pinned
//     shortcut. Activating the shortcut therefore always meant "launch", never
//     "restore that window" — which is why the taskbar could not be used to
//     get back to a running SDC Tools at all.
//
// The two have to be fixed together: the AUMID is what makes Windows route the
// activation into this process, and the lock is what makes that activation
// land on the existing window instead of a fresh one. Keep this string
// identical to `appId` in electron-builder.yml.
const APP_USER_MODEL_ID = 'com.sdc.tools';
app.setAppUserModelId(APP_USER_MODEL_ID);

const _gotInstanceLock = app.requestSingleInstanceLock();
if (!_gotInstanceLock) {
  // The primary instance receives 'second-instance' and reveals itself; this
  // process must leave WITHOUT creating a window, a tray icon or any child
  // servers. app.quit() is wrong here: it would run before-quit →
  // performQuit() → processManager.stopAll(), tearing down the PRIMARY
  // instance's app servers. Exit outright instead.
  app.exit(0);
}

// ── Notification store ────────────────────────────────────────────────────────
const notificationStore = [];
let notifIdSeq = 0;

function pushNotification({ source, type, title, body, icon }) {
  const n = { id: ++notifIdSeq, source, type, title, body, icon: icon || '🔔', timestamp: Date.now(), read: false };
  notificationStore.unshift(n);
  if (notificationStore.length > 100) notificationStore.pop();
  mainWindow?.webContents.send('notifications-updated', notificationStore);
  _broadcastToAppWindows('notifications-updated', notificationStore);
  // Native OS toast
  if (Notification.isSupported()) {
    const toast = new Notification({ title, body, silent: false });
    toast.show();
  }
  return n;
}

const APP_WINDOW_SIZES = {
  assemblies: { width: 1280, height: 800 },
  readiness:  { width: 1400, height: 900 },
  scheduler:  { width: 1400, height: 900 },
  statelogic: { width: 1440, height: 900 },
  calendar:   { width: 1440, height: 900 },
};

// ── Per-app title-bar icons ───────────────────────────────────────────────────
// Icons live in shell/build/icons/<appId>.png — bundled into the asar via
// electron-builder.yml files[] so the same relative path works in dev and prod.
function _getAppIcon(appId) {
  try {
    const p = path.join(__dirname, '../build/icons', `${appId}.png`);
    return fs.existsSync(p) ? nativeImage.createFromPath(p) : null;
  } catch (_) { return null; }
}

// ── Window bounds persistence ─────────────────────────────────────────────────
const _settingsFile = () => path.join(app.getPath('userData'), 'window-settings.json');
function _loadSettings() {
  try { return JSON.parse(fs.readFileSync(_settingsFile(), 'utf8')); } catch (_) { return {}; }
}
function _saveSettings(data) {
  try { fs.writeFileSync(_settingsFile(), JSON.stringify(data, null, 2)); } catch (_) {}
}

// ── Window lifecycle tracing ────────────────────────────────────────────────
// A show/hide/focus loop is invisible in a screen recording but obvious in an
// ordered event log, so every shell-owned window can emit one. Off by default
// (it is noisy); set SDC_WINDOW_TRACE=1 to turn it on in a production install,
// and it is always on in dev. Lines land in the same sdc-tools-diagnostics.log
// as the load/crash lines, so a restore glitch and a renderer crash can be read
// against each other in timestamp order.
const WINDOW_TRACE = process.env.SDC_WINDOW_TRACE === '1' || isDev;
const _TRACED_EVENTS = [
  'ready-to-show', 'show', 'hide', 'focus', 'blur',
  'minimize', 'restore', 'maximize', 'unmaximize', 'close', 'closed',
];

// Which SDC window the user was actually last using. Restoring has to land
// them there — if they were in Reports → Job Hour Details, "switch back to SDC
// Tools" means that window, not the launcher home screen.
let _lastActiveWindowId = null;

/**
 * Wire the focus tracking (always) and the event trace (when enabled) onto a
 * window. Every window the shell creates goes through this, so the log covers
 * the launcher and all six app windows with one format.
 */
function attachWindowLifecycle(label, win) {
  const id = win.id;
  win.on('focus', () => { _lastActiveWindowId = id; });
  if (!WINDOW_TRACE) return;
  for (const ev of _TRACED_EVENTS) {
    win.on(ev, () => {
      // isDestroyed() guard: 'closed' fires after the native window is gone and
      // any state query on it would throw.
      const state = win.isDestroyed()
        ? 'destroyed'
        : `visible=${win.isVisible()} min=${win.isMinimized()} focus=${win.isFocused()}`;
      logDiagnostic(`window:${label}`, ev, `id=${id} ${state}`);
    });
  }
}

/**
 * The one and only "bring this window back" path. Tray, global shortcuts and
 * Windows taskbar activation (via 'second-instance') all funnel through here so
 * there is a single restore order and no chance of two callers racing each
 * other into a show/hide flicker.
 *
 * The order is deliberate:
 *   isMinimized() → restore()   un-minimizes; does not resize or recreate
 *   !isVisible()  → show()      re-adds the taskbar button after a tray-hide
 *   focus()                     actually raises it to the foreground
 *
 * The existing window object is always reused. Nothing here destroys or
 * recreates a window, so the loaded child app, its route and its scroll
 * position survive a restore untouched.
 */
function revealWindow(win) {
  if (!win || win.isDestroyed()) return false;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
  return true;
}

/**
 * What a Windows taskbar click on SDC Tools should do: return the user to the
 * SDC window they were last in, falling back to the launcher.
 */
function revealLastActive() {
  const last = _lastActiveWindowId != null ? BrowserWindow.fromId(_lastActiveWindowId) : null;
  if (last && !last.isDestroyed() && revealWindow(last)) return;
  if (revealWindow(mainWindow)) return;
  // Only reachable if the launcher window was genuinely destroyed (not merely
  // hidden to tray) — recreating it is then the only way a taskbar click can
  // still do something useful.
  logDiagnostic('window:shell', 'reveal-recreate', 'no live window to restore');
  createMainWindow();
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 680,
    minWidth: 800,
    minHeight: 560,
    title: 'SDC Tools',
    backgroundColor: '#0d0d1a',
    frame: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  attachWindowLifecycle('shell', mainWindow);
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Minimize to tray instead of closing the launcher
  mainWindow.on('close', (e) => {
    if (tray) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    for (const [, win] of appWindows) {
      if (!win.isDestroyed()) win.close();
    }
    appWindows.clear();
  });
}

function createTray() {
  const trayIconPath = path.join(__dirname, '../build/icon.ico');
  const icon = fs.existsSync(trayIconPath)
    ? nativeImage.createFromPath(trayIconPath).resize({ width: 16, height: 16 })
    : nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip('SDC Tools');
  _rebuildTrayMenu();
  // Single click is the Windows expectation for a tray icon; double-click is
  // kept for anyone used to it. Both go through the same reveal path.
  tray.on('click',        () => revealLastActive());
  tray.on('double-click', () => revealLastActive());
}

function _rebuildTrayMenu() {
  if (!tray) return;
  const status = processManager.getStatus();
  const appItems = Object.values(status).map(app => ({
    label: `${app.emoji || '▶'}  ${app.name}`,
    enabled: app.status === 'running',
    click: () => openAppWindow(app.id),
  }));
  tray.setContextMenu(Menu.buildFromTemplate([
    // Explicitly the launcher, not revealLastActive() — this menu item names
    // the launcher, so it must show the launcher even if a child app was last.
    { label: 'Show Launcher', click: () => revealWindow(mainWindow) },
    { type: 'separator' },
    ...appItems,
    { type: 'separator' },
    { label: 'Quit', click: () => performQuit() },
  ]));
}

let isQuitting = false;
let pendingUpdate = false;   // true after update is downloaded & user confirmed install
let _lastUpdateStatus = null; // cached for newly-opened app windows
// One notification per distinct version, not one per 2-minute check —
// checkForUpdates() keeps re-reporting the SAME available/downloaded version
// on every poll until it's actually installed, and neither event is a
// one-time "just happened" signal on its own.
let _lastNotifiedAvailableVersion = null;
let _lastNotifiedDownloadedVersion = null;

async function performQuit() {
  if (isQuitting) return;
  isQuitting = true;
  try { globalShortcut.unregisterAll(); } catch (_) {}
  await processManager.stopAll();
  tray?.destroy();
  if (pendingUpdate && autoUpdater) {
    autoUpdater.quitAndInstall(false, true);
  } else {
    app.exit(0);
  }
}

// ── Central diagnostic log for the whole platform (2026-08-24) ─────────────
//
// One file, one format, for every blank-screen/crash signal the shell can see:
// a child app window failing to load, a renderer process dying, and — via the
// `log-client-error` IPC channel below — an unhandled error inside the shell's
// OWN React UI. Previously the only such logging lived inside openAppWindow and
// so could never record a failure of the shell itself.
//
// Deliberately a plain append-only file rather than a service: this has to work
// when the network is the thing that is broken, which is exactly when these
// lines are worth reading.
//
// Nothing here is shown to the user — the recovery UIs carry their own short,
// non-technical wording. This file is for whoever diagnoses afterwards, so it
// records what is needed to place a failure (which app, what happened, when)
// and deliberately NOT session tokens: any token-ish query param is redacted.
const DIAG_LOG = path.join(__dirname, '..', 'sdc-tools-diagnostics.log');

function _redact(text) {
  return String(text == null ? '' : text)
    .replace(/([?&](?:token|sso|code|id_token|access_token)=)[^&\s]+/gi, '$1REDACTED')
    // eslint-disable-next-line no-control-regex -- CR/LF are the point: one diagnostic entry per line, so embedded newlines are flattened
    .replace(/[\u000d\u000a]+/g, ' ');
}

function logDiagnostic(source, event, detail) {
  const line = `[${new Date().toISOString()}] [${source}] ${event}${detail ? ` :: ${_redact(detail)}` : ''}`;
  try {
    fs.appendFileSync(DIAG_LOG, line + '\u000a');
  } catch (_) { /* logging must never be the reason something fails to recover */ }
  // Also to the shell's own stdout, so a dev console shows it live.
  console.warn(line);
}

/**
 * @param appId one of processManager's config ids
 * @param deepPath optional path+query to open INSIDE that app, e.g.
 *   "/?job=1127&view=schedule". Added 2026-08-28 so one app can hand another a
 *   deep link and have it open in the shell rather than in an external browser
 *   — see the setWindowOpenHandler note below for what used to happen instead.
 *   Only a path is accepted, never a full URL: the shell owns every app's
 *   origin, and taking one from a renderer would let an embedded page point a
 *   shell window anywhere.
 */
async function openAppWindow(appId, deepPath) {
  const status = processManager.getStatus();
  const appInfo = status[appId];

  if (!appInfo) return { error: 'Unknown app' };
  if (appInfo.status !== 'running') return { error: 'Server not ready yet' };

  // Reject anything that is not a same-origin path — "//evil.com" and
  // "https://…" both parse as an origin change once appended.
  const safePath =
    typeof deepPath === 'string' && deepPath.startsWith('/') && !deepPath.startsWith('//')
      ? deepPath
      : null;

  if (appWindows.has(appId)) {
    const existing = appWindows.get(appId);
    if (!existing.isDestroyed()) {
      revealWindow(existing);
      // Already open: navigate the EXISTING window to the deep link rather than
      // just focusing it, which is what "open job 1127 in the Scheduler" has to
      // mean when the Scheduler is already showing some other project.
      if (safePath) await existing.loadURL(`${appInfo.url}${safePath}`).catch(() => {});
      return { success: true };
    }
    appWindows.delete(appId);
  }

  // Restore saved bounds, fall back to defaults
  const defaults = APP_WINDOW_SIZES[appId] || { width: 1280, height: 800 };
  const saved    = (_loadSettings()[appId] || {});
  const bounds   = {
    width:  saved.width  || defaults.width,
    height: saved.height || defaults.height,
    ...(saved.x != null ? { x: saved.x } : {}),
    ...(saved.y != null ? { y: saved.y } : {}),
  };

  const icon = _getAppIcon(appId);

  const win = new BrowserWindow({
    ...bounds,
    minWidth: 800,
    minHeight: 600,
    title: appInfo.name,
    backgroundColor: '#ffffff',
    show: false,
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'appPreload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,  // safe — appPreload only uses require('electron'), not Node built-ins
    },
  });

  // Reports (apps/reports) isn't one of the 5 apps with a shared session
  // cookie — it has its own separate NextAuth login. It already has a
  // purpose-built bridge FROM Scheduler for exactly this (its own
  // "open this job in Reports" links use it); drive that same bridge here
  // instead of building new cross-app trust. A cap on the mint call keeps a
  // genuinely unreachable Scheduler from stalling the window — on any
  // failure this just falls back to the bare URL, i.e. Reports' own login
  // form, never worse than before this existed. 6s (was 2s) — a real LAN
  // round trip to a Scheduler that's mid-restart or briefly busy shouldn't
  // read as "unreachable" and silently drop back to a separate login.
  // Guarantee the suite session exists and is written against THIS app's exact
  // origin before the window loads — rather than trusting that the
  // fire-and-forget startup establish already ran. This is what makes
  // "restart SDC Tools, open an app" not ask for a second login.
  await sdcSession.ensureSession();
  await sdcSession.applySessionCookies(appInfo.url);

  let targetUrl = safePath ? `${appInfo.url}${safePath}` : appInfo.url;
  if (appId === 'reports') {
    const hop = await Promise.race([
      sdcSession.mintEtcSsoHopToken(),
      // 12s: mintEtcSsoHopToken may now do TWO round trips (establish the
      // Scheduler session on demand, then mint the hop token) when the
      // fire-and-forget startup establish hasn't landed yet.
      new Promise(resolve => setTimeout(() => {
        console.warn('[main] mint-etc-sso timed out after 12s — opening Reports\' own login instead.');
        resolve(null);
      }, 12000)),
    ]).catch(() => null);
    if (hop) targetUrl = `${appInfo.url}/api/auth/sso?token=${encodeURIComponent(hop)}&next=/`;
  }

  // Without this, Electron's default behavior for any target="_blank" link
  // (e.g. Reports' "open this job in Scheduler" link) is to silently deny
  // the new-window request — the click does nothing, no error, no window.
  // Hand it to the OS's default browser instead, same as a normal web page.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // ── An app window must never sit on an unexplained blank screen ──────────
  //
  // backgroundColor: '#ffffff' above is literally what a user sees when nothing
  // ever paints, and until 2026-08-24 there was no handler for the events that
  // mean "nothing will paint". Any load failure — refused connection, a redirect
  // to a dead port, a timeout — left a permanently white window with no error
  // and no way back except closing and reopening it, which is exactly the
  // complaint that was reported.
  //
  // This applies to EVERY app, not just Reports. The failure mode has nothing to
  // do with which backend is behind the window, and the other five are equally
  // capable of being mid-restart when someone clicks their tile.
  //
  // The three events that each produce a blank window, and each need catching:
  //   * did-fail-load        — the page never loaded (server down, bad redirect)
  //   * render-process-gone  — the renderer crashed AFTER loading; the window
  //                            keeps its size and title and goes white
  //   * unresponsive         — the renderer is wedged in a loop; not blank
  //                            forever, but indistinguishable to the user
  //
  // The recovery page is self-contained (inline styles, a plain link back to the
  // app URL) so it cannot itself fail to render, and it names the actual error
  // instead of apologising vaguely. The link is a normal navigation, so "Try
  // again" works without IPC or a preload.
  // Routed through the central logger so a child-app failure and a shell-UI
  // failure land in the same file, same format, in timestamp order — which is
  // what makes "the Reports window went white at 09:53" answerable.
  const _logLoadError = (line) => logDiagnostic(appId, line);

  function _showRecoveryPage(heading, detail) {
    // Retrying goes to appInfo.url, NOT targetUrl: a targetUrl carrying a
    // one-time SSO hop token would fail on a second use (the assertion carries a
    // single-use nonce), so retrying with it would reliably fail the second time.
    // The bare URL lands on the app's own session or its login form.
    const html = `<!doctype html><meta charset="utf-8">
      <body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
                   background:#f5f6f8;font-family:'Segoe UI',system-ui,sans-serif;color:#2b2b2b;padding:2rem">
        <div style="max-width:30rem;background:#fff;border:1px solid #d9d9d9;border-radius:.75rem;
                    padding:1.75rem;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.08)">
          <h1 style="margin:0 0 .5rem;font-size:1.0625rem;color:#061d39">${heading}</h1>
          <p style="margin:0 0 1.25rem;font-size:.875rem;line-height:1.55">${detail}</p>
          <a href="${appInfo.url}" style="display:inline-block;background:#1574c4;color:#fff;
             border-radius:.5rem;padding:.5rem 1rem;font-size:.875rem;font-weight:600;text-decoration:none">
            Try again</a>
          <p style="margin:1rem 0 0;font-size:.75rem;color:#8a8a8a">
            If this keeps happening, the server may be restarting — wait a moment and try again.
            Details are logged to apps/shell/sdc-tools-diagnostics.log.</p>
        </div>
      </body>`;
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  }

  win.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    // Sub-frame and sub-resource failures do not blank the window, and
    // ERR_ABORTED (-3) is what a superseded navigation reports — treating either
    // as fatal would replace a perfectly good page with an error card.
    if (!isMainFrame || errorCode === -3) return;
    _logLoadError(`did-fail-load ${errorCode} "${errorDescription}" url=${validatedURL}`);
    _showRecoveryPage(
      `${appInfo.name} could not be reached`,
      `The app did not respond (<code>${errorDescription}</code>). Nothing was lost.`,
    );
  });

  win.webContents.on('render-process-gone', (event, details) => {
    _logLoadError(`render-process-gone reason=${details.reason} exitCode=${details.exitCode}`);
    _showRecoveryPage(
      `${appInfo.name} stopped unexpectedly`,
      `The window’s display process ended (<code>${details.reason}</code>). Reopening it should recover.`,
    );
  });

  win.webContents.on('unresponsive', () => {
    _logLoadError('renderer reported unresponsive');
  });

  attachWindowLifecycle(appId, win);

  win.loadURL(targetUrl);
  // ready-to-show is the right moment to reveal the window, but it is not
  // guaranteed to arrive: a load that fails outright can leave it unfired, and
  // then `show: false` means there is no window for the recovery page above to
  // appear in — the click on the tile just does nothing. This backstop shows the
  // window regardless after 10s, so a failure is always something the user can
  // SEE and act on rather than silence.
  let _shown = false;
  const _reveal = () => { if (!_shown && !win.isDestroyed()) { _shown = true; win.show(); } };
  win.once('ready-to-show', _reveal);
  const _revealTimer = setTimeout(_reveal, 10_000);
  win.on('closed', () => clearTimeout(_revealTimer));

  // Push update status so app sidebar shows "Up to date!" immediately
  win.webContents.once('did-finish-load', () => {
    win.webContents.send('app-update-status', _lastUpdateStatus ?? 'up-to-date');
  });

  // Unsaved-changes guard via beforeunload
  win.webContents.on('will-prevent-unload', (e) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['Leave', 'Stay'],
      defaultId: 1,
      cancelId: 1,
      message: 'You have unsaved changes. Leave without saving?',
    });
    if (choice === 0) e.preventDefault();
  });

  // Persist window bounds on close
  win.on('close', () => {
    if (!win.isMinimized() && !win.isMaximized()) {
      const b = win.getBounds();
      const settings = _loadSettings();
      settings[appId] = { x: b.x, y: b.y, width: b.width, height: b.height };
      _saveSettings(settings);
    }
  });

  win.on('closed', () => appWindows.delete(appId));
  win.setMenuBarVisibility(false);

  appWindows.set(appId, win);
  return { success: true };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Broadcast a channel+payload to every open app window. */
function _broadcastToAppWindows(channel, payload) {
  for (const [, win] of appWindows) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

// ── App-window IPC: native file dialogs ──────────────────────────────────────
// These mirror the standalone State Logic Builder's IPC handlers so that
// appPreload.js can expose window.electronAPI identically.

ipcMain.handle('app-save-file', async (e, { fileName, content }) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: fileName,
    filters: [
      { name: 'JSON File',  extensions: ['json'] },
      { name: 'L5X File',   extensions: ['L5X', 'l5x'] },
      { name: 'All Files',  extensions: ['*'] },
    ],
  });
  if (canceled || !filePath) return { success: false };
  try {
    fs.writeFileSync(filePath, content, 'utf8');
    return { success: true, filePath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('app-save-file-direct', async (_, { filePath, content }) => {
  try {
    fs.writeFileSync(filePath, content, 'utf8');
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('app-open-file', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    filters: [{ name: 'JSON Files', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths.length) return { success: false };
  try {
    const content = fs.readFileSync(filePaths[0], 'utf8');
    return { success: true, filePath: filePaths[0], content };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('app-check-for-updates', (e) => {
  // The app sidebar ignores the return value — it waits for an 'app-update-status'
  // event via onUpdateStatus(). Fire it back immediately with the cached status.
  const status = _lastUpdateStatus ?? 'up-to-date';
  e.sender.send('app-update-status', status);
  return status;
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createMainWindow();
  createTray();

  processManager.on('status-change', status => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('status-change', status);
    }
    _rebuildTrayMenu(); // keep quick-open items in sync with running state
  });

  processManager.on('log', ({ id, line }) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('app-log', { id, line });
    }
  });

  processManager.startAll();

  // ── Centralized SDC Tools session ─────────────────────────────────────────
  // If the shell restarted with a still-valid MSAL cache, silently
  // re-establish the cross-app session too — no login prompt on a normal
  // restart. If nothing is cached yet, this is a no-op (getAuthStatus()
  // returns isAuthenticated:false and there's no idToken to exchange); the
  // user logs in via LoginScreen, which drives the same exchange through the
  // auth-login handler below.
  auth.getAuthStatus().then(status => {
    if (status.isAuthenticated && status.idToken) {
      sdcSession.establishSdcSession(status.idToken).catch(err =>
        console.warn('[sdcSession] startup re-establish failed:', err.message));
    }
  });

  // Keep the internal session fresh while the shell stays open, well before
  // its 12h expiry — mirrors the existing auto-updater interval just below.
  setInterval(() => {
    auth.getAuthStatus().then(status => {
      if (status.isAuthenticated && status.idToken) {
        sdcSession.establishSdcSession(status.idToken).catch(err =>
          console.warn('[sdcSession] periodic refresh failed:', err.message));
      }
    });
  }, 60 * 60 * 1000);

  // Start notification polling — first run after 15 s (let apps boot), then every 60 s
  setTimeout(() => {
    pollAppNotifications();
    setInterval(pollAppNotifications, 60 * 1000);
  }, 15000);

  // ── Auto-updater wiring ────────────────────────────────────────────────────
  if (autoUpdater && !isDev) {
    autoUpdater.on('checking-for-update', () => {
      mainWindow?.webContents.send('update-status', { phase: 'checking' });
    });

    autoUpdater.on('update-available', (info) => {
      mainWindow?.webContents.send('update-status', { phase: 'available', version: info.version });
      // autoDownload=true means the download starts automatically — no user action needed
      if (_lastNotifiedAvailableVersion !== info.version) {
        _lastNotifiedAvailableVersion = info.version;
        pushNotification({
          source: 'shell', type: 'update', icon: '🆕',
          title:  `🆕 SDC Tools v${info.version} available`,
          body:   'Downloading update in the background…',
        });
      }
    });

    autoUpdater.on('update-not-available', () => {
      const payload = { phase: 'none' };
      _lastUpdateStatus = 'up-to-date'; // State Logic Builder sidebar format
      mainWindow?.webContents.send('update-status', payload);
      _broadcastToAppWindows('app-update-status', 'up-to-date');
    });

    autoUpdater.on('download-progress', ({ percent }) => {
      mainWindow?.webContents.send('update-status', { phase: 'downloading', percent: Math.round(percent) });
    });

    autoUpdater.on('update-downloaded', (info) => {
      const payload = { phase: 'ready', version: info.version };
      _lastUpdateStatus = 'restarting';
      mainWindow?.webContents.send('update-status', payload);
      _broadcastToAppWindows('app-update-status', 'restarting');
      // Notify the user — install happens when they click "Restart" or naturally quit
      if (_lastNotifiedDownloadedVersion !== info.version) {
        _lastNotifiedDownloadedVersion = info.version;
        pushNotification({
          source: 'shell', type: 'update', icon: '✅',
          title:  `✅ SDC Tools v${info.version} ready`,
          body:   'Update downloaded. Click "Restart & Install" in the launcher.',
        });
      }
    });

    autoUpdater.on('error', (err) => {
      console.error('[updater] Error:', err.message);
      mainWindow?.webContents.send('update-status', { phase: 'error', message: err.message });
    });

    // Check on launch, then every 2 minutes
    autoUpdater.checkForUpdates().catch(e => console.warn('[updater] Check failed:', e.message));
    setInterval(() => {
      autoUpdater.checkForUpdates().catch(e => console.warn('[updater] Periodic check failed:', e.message));
    }, 2 * 60 * 1000);
  }

  // ── IPC handlers ──────────────────────────────────────────────────────────
  // ── Notification IPC ──────────────────────────────────────────────────────
  ipcMain.handle('show-notification',     (_, opts) => pushNotification(opts));
  ipcMain.handle('get-notifications',     ()        => notificationStore);
  ipcMain.handle('dismiss-notification',  (_, id)   => {
    const i = notificationStore.findIndex(n => n.id === id);
    if (i !== -1) notificationStore.splice(i, 1);
    mainWindow?.webContents.send('notifications-updated', notificationStore);
    return true;
  });
  ipcMain.handle('clear-notifications',   ()        => {
    notificationStore.length = 0;
    mainWindow?.webContents.send('notifications-updated', notificationStore);
    return true;
  });
  ipcMain.handle('mark-notifications-read', ()      => {
    notificationStore.forEach(n => { n.read = true; });
    mainWindow?.webContents.send('notifications-updated', notificationStore);
    return true;
  });

  // ── Auth IPC ───────────────────────────────────────────────────────────────
  ipcMain.handle('auth-get-status', () => auth.getAuthStatus());
  ipcMain.handle('auth-login',      async () => {
    const result = await auth.login();
    if (!result.success) return result;
    const sdcResult = await sdcSession.establishSdcSession(result.idToken);
    if (!sdcResult.success) {
      // Microsoft login worked but the suite-wide session didn't — surface
      // this distinctly rather than silently leaving every sub-app unable to
      // authenticate. LoginScreen shows result.error either way.
      return { success: false, error: 'Signed into Microsoft, but SDC Tools sign-in failed: ' + sdcResult.error };
    }
    return { ...result, apps: sdcResult.apps };
  });
  ipcMain.handle('auth-logout',     async () => {
    await sdcSession.clearSdcSession();
    return auth.logout();
  });
  // Per-app roles/flags from the last successful exchange (fresh login or the
  // silent startup restore) — lets the launcher filter tiles by what the
  // server would actually allow. Never the only enforcement: each app's own
  // sdcSessionAuth.js gate is what actually matters; this is UI convenience.
  ipcMain.handle('get-sdc-apps', () => sdcSession.getLastApps());

  ipcMain.handle('get-status',   () => processManager.getStatus());
  ipcMain.handle('get-logs',     (_, appId) => processManager.getLogs(appId));
  // The shell's own React UI reporting an unhandled error / rejection /
  // boundary catch (2026-08-24). Same log file as child-app failures, so one
  // timeline covers the whole platform. `invoke` rather than `send` so the
  // renderer can await the write before it reloads itself — otherwise a
  // recovery reload can race the log line and lose the only record of why.
  ipcMain.handle('log-client-error', (_evt, payload = {}) => {
    const { source = 'shell-ui', event = 'error', detail = '' } = payload || {};
    // Source and event come from the renderer, so they are length-capped:
    // a runaway string should not be able to bloat the log file.
    logDiagnostic(String(source).slice(0, 40), String(event).slice(0, 200), String(detail).slice(0, 2000));
    return true;
  });
  ipcMain.handle('open-app',     (_, appId, deepPath) => openAppWindow(appId, deepPath));
  ipcMain.handle('retry-app',    (_, appId) => processManager.restart(appId));
  ipcMain.handle('stop-all',     () => processManager.stopAll());
  ipcMain.handle('restart-all',  () => processManager.restartAll());
  ipcMain.handle('stop-app',     (_, appId) => processManager.stop(appId));
  ipcMain.handle('restart-app',  (_, appId) => processManager.restart(appId));
  ipcMain.handle('sync-status',  () => processManager.syncStatus());

  // Update: download is automatic (autoDownload=true). Install on user confirm.
  ipcMain.handle('check-for-updates', () => {
    if (autoUpdater && !isDev) {
      autoUpdater.checkForUpdates().catch(e => console.warn('[updater] Manual check failed:', e.message));
    }
  });
  ipcMain.handle('update-download', () => {
    // No-op — kept for UI compatibility. Download starts automatically.
  });
  ipcMain.handle('update-install', async () => {
    pendingUpdate = true;
    await performQuit();
  });
  ipcMain.handle('get-app-version',  () => app.getVersion());
  ipcMain.handle('get-server-host',  () => _serverHost);

  // Manually trigger an upstream update check for apps that have dedicated updaters
  ipcMain.handle('trigger-update', (_, appId) => {
    const TRIGGER_PORTS = { readiness: 4012, scheduler: 4013, statelogic: 4014 };
    const port = TRIGGER_PORTS[appId];
    if (!port) return { error: 'No updater for this app' };
    return new Promise((resolve) => {
      const req = require('http').request(
        { host: _serverHost, port, path: '/trigger', method: 'POST' },
        (res) => resolve({ ok: res.statusCode === 202 })
      );
      req.on('error', (e) => resolve({ error: e.message }));
      req.end();
    });
  });

  // ── Window controls ───────────────────────────────────────────────────────
  ipcMain.handle('window-minimize', () => mainWindow?.minimize());
  ipcMain.handle('window-maximize', () => {
    if (mainWindow?.isMaximized()) mainWindow.unmaximize();
    else mainWindow?.maximize();
  });
  ipcMain.handle('window-close', () => mainWindow?.close());

  // ── Startup with Windows ───────────────────────────────────────────────────
  ipcMain.handle('get-launch-on-startup', () => {
    return app.getLoginItemSettings().openAtLogin;
  });
  ipcMain.handle('set-launch-on-startup', (_, enable) => {
    app.setLoginItemSettings({ openAtLogin: enable, openAsHidden: true });
    return app.getLoginItemSettings().openAtLogin;
  });

  // ── Global keyboard shortcuts ──────────────────────────────────────────────
  // Ctrl+1–4 open each app; Ctrl+0 shows the launcher.
  const appOrder = Object.keys(processManager.configs); // ['assemblies','readiness','scheduler','statelogic']
  appOrder.forEach((id, i) => {
    globalShortcut.register(`CommandOrControl+${i + 1}`, () => {
      // openAppWindow reveals the app window itself; the launcher only needs
      // restoring so the shortcut still works when it is hidden to tray.
      revealWindow(mainWindow);
      openAppWindow(id);
    });
  });
  globalShortcut.register('CommandOrControl+0', () => {
    revealWindow(mainWindow);
  });
});

// ── Notification polling ──────────────────────────────────────────────────────
// Polls each app's /api/notifications/pending every 60 s and fires native toasts
// for upcoming calendar events. Also watches for app crashes.
const _serverHost = process.env.SDC_SERVER_HOST || 'localhost';
const APP_NOTIFICATION_ENDPOINTS = {
  calendar: `http://${_serverHost}:4005/api/notifications/pending?window=30`,
};
const firedReminders = new Set();
const lastAppState   = {};
// Prune firedReminders daily so it doesn't grow unbounded
setInterval(() => firedReminders.clear(), 24 * 60 * 60 * 1000);

async function pollAppNotifications() {
  // 1. Calendar upcoming events
  try {
    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), 5000);
    const res  = await fetch(APP_NOTIFICATION_ENDPOINTS.calendar, { signal: controller.signal });
    clearTimeout(timeout);
    if (res.ok) {
      const events = await res.json();
      if (Array.isArray(events)) {
        for (const ev of events) {
          const key = `cal_${ev.id}_${Math.floor((ev.minsUntil ?? 0) / 5)}`; // de-dup per 5-min bucket
          if (!firedReminders.has(key)) {
            firedReminders.add(key);
            pushNotification({
              source: 'calendar',
              type:   'reminder',
              icon:   '📅',
              title:  `📅 ${ev.title}`,
              body:   `Starting in ${ev.minsUntil} min${ev.location ? ' — ' + ev.location : ''}`,
            });
          }
        }
      }
    }
  } catch { /* calendar not running or timed out — silently skip */ }

  // 2. App crash detection
  const status = processManager.getStatus();
  for (const [id, s] of Object.entries(status)) {
    const prev = lastAppState[id];
    lastAppState[id] = s.status;
    if (prev && prev !== 'crashed' && s.status === 'crashed') {
      pushNotification({
        source: 'shell',
        type:   'crash',
        icon:   '⚠️',
        title:  `⚠️ ${s.name} stopped`,
        body:   'The app crashed unexpectedly. Click Retry in the launcher.',
      });
    }
    if (prev === 'crashed' && s.status === 'running') {
      pushNotification({
        source: 'shell',
        type:   'info',
        icon:   '✅',
        title:  `✅ ${s.name} recovered`,
        body:   'The app restarted successfully.',
      });
    }
  }
}

// Windows routes a pinned-shortcut / Start-menu / login-item activation of an
// already-running SDC Tools into this event (that is what the AUMID above buys
// us) instead of letting a competing second process start. Restoring the
// existing window here is what makes the taskbar a reliable way back.
app.on('second-instance', (_event, argv) => {
  logDiagnostic('window:shell', 'second-instance', argv.join(' '));
  revealLastActive();
});

// macOS dock-click equivalent. The shell only ships for Windows today, but the
// handler costs nothing and keeps the reveal path complete.
app.on('activate', () => revealLastActive());

app.on('window-all-closed', () => {
  // Don't quit — tray keeps the app alive
});

app.on('before-quit', async (e) => {
  if (isQuitting) return;
  e.preventDefault();
  await performQuit();
});

process.on('unhandledRejection', (reason) => {
  console.error('[main] Unhandled rejection:', reason);
});
