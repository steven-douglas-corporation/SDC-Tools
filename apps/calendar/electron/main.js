// ── SDC Calendar — Electron main process ─────────────────────
const { app, BrowserWindow, ipcMain, safeStorage, shell, utilityProcess } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

const API_PORT = process.env.PORT || 3001;
const API_URL = `http://localhost:${API_PORT}`;
// Provide your hosted Express Web Server URL here to enable Thin Client Mode
const CENTRAL_SERVER_URL = process.env.CENTRAL_SERVER_URL || '';

const TOKEN_FILE = () => path.join(app.getPath('userData'), 'ss_token.enc');

let serverProcess = null;
let mainWindow = null;
let targetURL = API_URL;

function isRemoteAvailable(url) {
  return new Promise((resolve) => {
    const client = url.startsWith('https') ? require('https') : require('http');
    const req = client.get(url, { timeout: 1500 }, (res) => {
      resolve(res.statusCode >= 200 && res.statusCode < 400);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

// ── Spawn the Express backend ─────────────────────────────────
// Check if the server is already running on the target port
function isPortInUse() {
  return new Promise((resolve) => {
    http.get(`${API_URL}/api/health`, (res) => {
      resolve(res.statusCode === 200);
    }).on('error', () => resolve(false));
  });
}

function startServer() {
  // eslint-disable-next-line no-async-promise-executor -- resolve() is also called from the utilityProcess event callbacks below; converting to a plain async function is a follow-up
  return new Promise(async (resolve) => {
    if (CENTRAL_SERVER_URL) {
      console.log('[main] Probing central deployment: ' + CENTRAL_SERVER_URL);
      const centralOnline = await isRemoteAvailable(CENTRAL_SERVER_URL);
      if (centralOnline) {
        console.log('[main] Central deployment is ONLINE — bridging connections.');
        targetURL = CENTRAL_SERVER_URL;
        return resolve();
      } else {
        console.warn('[main] Central deployment is OFFLINE — falling back to offline capabilities.');
      }
    }

    // If something is already listening on port 3001, use it as-is
    const alreadyRunning = await isPortInUse();
    if (alreadyRunning) {
      console.log('[main] Server already running on port ' + API_PORT + ' — skipping spawn');
      return resolve();
    }

    const serverScript = path.join(__dirname, '..', 'server', 'server.js');
    const serverDir = path.join(__dirname, '..', 'server');

    // Use utilityProcess.fork to safely run background Node execution without absolute spaces constraints
    serverProcess = utilityProcess.fork(serverScript, [], {
      cwd: serverDir,
      stdio: 'pipe'
    });

    serverProcess.stdout.on('data', d => process.stdout.write('[server] ' + d));
    serverProcess.stderr.on('data', d => process.stderr.write('[server] ' + d));
    serverProcess.on('exit', code => {
      if (code !== 0 && code !== null) {
        console.error(`[main] Server exited with code ${code}`);
      }
    });

    // Poll /api/health until the Express server is ready
    let attempts = 0;
    const poll = () => {
      attempts++;
      if (attempts > 40) {
        console.warn('[main] Server slow to start — opening window anyway');
        return resolve();
      }
      http.get(`${API_URL}/api/health`, (res) => {
        if (res.statusCode === 200) {
          console.log('[main] Server ready');
          resolve();
        } else {
          setTimeout(poll, 400);
        }
      }).on('error', () => setTimeout(poll, 400));
    };
    setTimeout(poll, 800);
  });
}

// ── Create the browser window ─────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 640,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
    title: 'SDC Centralized Calendar',
    icon: path.join(__dirname, '..', 'frontend', 'icons', 'sdc-calendar-icon-C.ico'),
    backgroundColor: '#ffffff',
    show: false, // reveal only when ready — avoids white flash
  });

  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    console.log(`[Renderer Console] ${message} (${sourceId}:${line})`);
  });

  mainWindow.webContents.openDevTools();

  // Serve calendar UI from central hub or local fallback daemon
  mainWindow.loadURL(targetURL);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  // Open external links in the system browser, not inside Electron
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Hide the native menu bar (calendar has its own nav)
  mainWindow.setMenuBarVisibility(false);

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── IPC: Smartsheet token via OS-level safeStorage ───────────
ipcMain.handle('ss-token-save', (_e, token) => {
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('OS encryption not available on this machine');
    }
    fs.writeFileSync(TOKEN_FILE(), safeStorage.encryptString(token));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('ss-token-get', () => {
  try {
    const f = TOKEN_FILE();
    if (!fs.existsSync(f)) return null;
    if (!safeStorage.isEncryptionAvailable()) return null;
    return safeStorage.decryptString(fs.readFileSync(f));
  } catch {
    return null;
  }
});

ipcMain.handle('ss-token-clear', () => {
  try {
    const f = TOKEN_FILE();
    if (fs.existsSync(f)) fs.unlinkSync(f);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('app-version', () => app.getVersion());

// ── App lifecycle ─────────────────────────────────────────────
app.whenReady().then(async () => {
  await startServer();
  createWindow();

  // macOS: re-open window when dock icon is clicked and no windows exist
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  killServer();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', killServer);

function killServer() {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
}
