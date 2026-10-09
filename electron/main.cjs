const path = require('node:path');
const { URL, pathToFileURL } = require('node:url');
const {
  app,
  BrowserWindow,
  Menu,
  nativeImage,
  Notification,
  powerMonitor,
  session,
  Tray
} = require('electron');
const { registerIpcHandlers, createScheduler } = require('./ipc.cjs');

app.enableSandbox();

const isDev = Boolean(process.env.ELECTRON_RENDERER_URL);
const appRoot = path.resolve(__dirname, '..');
const startedWithBackgroundFlag = process.argv.includes('--background');
const hasSingleInstanceLock = app.requestSingleInstanceLock();

let mainWindow = null;
let tray = null;
let runtime = null;
let automation = null;
let unsubscribeStore = null;
let isQuitting = false;
let backgroundNoticeShown = false;
let loginItemSignature = '';

if (!hasSingleInstanceLock) {
  app.quit();
}

function getState() {
  return runtime?.store?.get?.() || { folders: [], settings: {} };
}

function automaticBackupConfigured(state = getState()) {
  return Boolean(state.settings?.autoBackup || state.settings?.watchChanges);
}

function showNotification(title, body) {
  if (!Notification.isSupported()) return;
  new Notification({ title, body, silent: false }).show();
}

function hardenWindow(win) {
  const expectedDevOrigin = isDev ? new URL(process.env.ELECTRON_RENDERER_URL).origin : '';
  const expectedFilePath = pathToFileURL(path.join(appRoot, 'dist', 'index.html')).pathname;

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });

  win.webContents.on('will-navigate', (event, targetUrl) => {
    try {
      const parsed = new URL(targetUrl);
      const allowed = isDev
        ? parsed.origin === expectedDevOrigin
        : parsed.protocol === 'file:' && parsed.pathname === expectedFilePath;
      if (!allowed) event.preventDefault();
    } catch {
      event.preventDefault();
    }
  });
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow({ showOnReady: true });
    return;
  }

  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createWindow({ showOnReady = true } = {}) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (showOnReady) showMainWindow();
    return mainWindow;
  }

  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1040,
    minHeight: 700,
    title: 'Smart Backup v2.0',
    show: false,
    backgroundColor: '#f5f7fb',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false
    }
  });

  mainWindow = win;
  hardenWindow(win);

  win.on('close', (event) => {
    const keepRunning = getState().settings?.runInBackground !== false;
    if (isQuitting || !keepRunning) return;

    event.preventDefault();
    win.hide();
    updateTray();

    if (!backgroundNoticeShown) {
      backgroundNoticeShown = true;
      showNotification(
        'Cloud Backup is still running',
        'Automatic backups and folder monitoring continue in the system tray. Use the tray menu to exit completely.'
      );
    }
  });

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  if (isDev) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  win.once('ready-to-show', () => {
    if (showOnReady) win.show();
  });

  return win;
}

function trayIcon() {
  const iconPath = path.join(appRoot, 'assets', 'tray-icon.png');
  const image = nativeImage.createFromPath(iconPath);
  return image.isEmpty() ? nativeImage.createEmpty() : image.resize({ width: 16, height: 16 });
}

async function runBackupFromTray() {
  const state = getState();
  if (!state.folders?.length) {
    showNotification('Cloud Backup', 'Add at least one protected folder before starting a backup.');
    return;
  }
  if (runtime.engine.running) return;

  updateTray('Backup running');
  try {
    const result = await runtime.engine.run({ trigger: 'manual' });
    showNotification(
      'Backup completed',
      `${result.uploaded} uploaded, ${result.skipped} unchanged, ${result.failed} interrupted.`
    );
  } catch (error) {
    showNotification('Backup failed', error.message);
  } finally {
    updateTray();
  }
}

function updateTray(temporaryStatus = '') {
  if (!tray || !runtime || !automation) return;

  const state = getState();
  const paused = automation.isPaused();
  const configured = automaticBackupConfigured(state);
  const running = Boolean(runtime.engine.running);
  const status = temporaryStatus || (
    running
      ? 'Backup running'
      : paused
        ? 'Automatic backups paused'
        : configured
          ? 'Automatic backups active'
          : 'Automatic backups not configured'
  );

  tray.setToolTip(`Cloud Backup App — ${status}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: 'Open Cloud Backup',
      click: showMainWindow
    },
    {
      label: status,
      enabled: false
    },
    { type: 'separator' },
    {
      label: 'Back up now',
      enabled: Boolean(state.folders?.length) && !running,
      click: () => {
        runBackupFromTray().catch((error) => showNotification('Backup failed', error.message));
      }
    },
    {
      label: paused ? 'Resume automatic backups' : 'Pause automatic backups',
      enabled: configured,
      click: () => {
        automation.setPaused(!paused);
        updateTray();
      }
    },
    { type: 'separator' },
    {
      label: 'Exit',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]));
}

function createTray() {
  if (tray) return tray;
  tray = new Tray(trayIcon());
  tray.on('click', showMainWindow);
  tray.on('double-click', showMainWindow);
  updateTray();
  return tray;
}

function loginLaunchCommand() {
  const executablePath = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  const args = app.isPackaged
    ? ['--background']
    : [appRoot, '--background'];
  return { executablePath, args };
}

function applyLoginItemSettings(state = getState()) {
  if (process.platform !== 'win32') return;

  const enabled = Boolean(state.settings?.launchAtLogin);
  const { executablePath, args } = loginLaunchCommand();
  const signature = JSON.stringify({ enabled, executablePath, args });
  if (signature === loginItemSignature) return;

  app.setLoginItemSettings({
    openAtLogin: enabled,
    path: executablePath,
    args
  });
  loginItemSignature = signature;
}

function handleAutomationEvent(payload) {
  updateTray();
  const timestamp = new Date().toLocaleString();
  const eventName = String(payload.type || 'event').replaceAll('-', ' ').toUpperCase();
  const line = `[${timestamp}] [${eventName}] ${payload.message || ''}`;

  if (payload.type === 'error') console.error(line);
  else console.log(line);

  if (payload.type === 'automation-complete') {
    showNotification('Automatic backup completed', payload.message);
  } else if (payload.type === 'error') {
    showNotification('Cloud Backup needs attention', payload.message);
  }
}

if (hasSingleInstanceLock) {
  app.on('second-instance', () => showMainWindow());

  app.whenReady().then(async () => {
    runtime = registerIpcHandlers(() => mainWindow?.webContents);
    automation = createScheduler(runtime, handleAutomationEvent, () => mainWindow?.webContents);

    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
      callback(false);
    });
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      const headers = {
        ...details.responseHeaders,
        'Cross-Origin-Opener-Policy': ['same-origin'],
        'X-Content-Type-Options': ['nosniff']
      };
      if (!isDev) {
        headers['Content-Security-Policy'] = [
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
        ];
      }
      callback({ responseHeaders: headers });
    });

    const state = getState();
    applyLoginItemSettings(state);
    unsubscribeStore = runtime.store.subscribe((nextState) => {
      applyLoginItemSettings(nextState);
      updateTray();
    });

    createTray();

    const startHidden = Boolean(
      startedWithBackgroundFlag &&
      state.settings.runInBackground !== false &&
      state.settings.startMinimized !== false
    );
    createWindow({ showOnReady: !startHidden });

    powerMonitor.on('resume', () => {
      automation.sync(getState());
      updateTray();
    });

    app.on('activate', showMainWindow);
  });
}

app.on('before-quit', () => {
  isQuitting = true;
  automation?.stop();
  unsubscribeStore?.();
  unsubscribeStore = null;
});

app.on('will-quit', () => {
  tray?.destroy();
  tray = null;
});

app.on('window-all-closed', () => {
  const keepRunning = getState().settings?.runInBackground !== false;
  if (!keepRunning && process.platform !== 'darwin') app.quit();
});
