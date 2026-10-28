const { app, BrowserWindow, ipcMain, screen, session, webFrameMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { BG, applyBackground, paintFrame } = require('./background');

// ── Cue Web Output (standalone) ───────────────────────────────────────────────
// Puts an external web page (e.g. a UNO / H2R / Singular overlay output URL, or
// Cue's own Remote Output link) on a chosen display as a frameless, chrome-less
// fullscreen window over a solid key colour. Same behaviour as Cue's Web Output,
// without needing Cue installed.
//
// Security: the output loads an ARBITRARY REMOTE page, so it gets no preload, a
// full sandbox, its own session partition, denied permissions, no popups and
// http(s)-only navigation.

const PARTITION = 'persist:web-output';

if (!app.requestSingleInstanceLock()) app.quit();

// ── Settings (JSON in userData) ───────────────────────────────────────────────
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
let settings = { url: '', displayBounds: null, bg: 'green', active: false, muted: true };
function loadSettings() {
  try { settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }; } catch {}
}
function saveSettings(patch) {
  settings = { ...settings, ...patch };
  try { fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); } catch {}
}

let control = null;
let win = null;
let retryTimer = null;
let status = { live: false, loading: false, error: null };

function getState() {
  return {
    url: settings.url,
    displayBounds: settings.displayBounds,
    bg: settings.bg,
    muted: settings.muted,
    openAtLogin: app.getLoginItemSettings().openAtLogin,
    displays: listDisplays(),
    ...status,
  };
}

function emit(patch) {
  status = { ...status, ...patch };
  if (control && !control.isDestroyed()) control.webContents.send('state', getState());
}

function normalizeUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch { return null; }
}

function listDisplays() {
  const primaryId = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d, i) => ({
    id: d.id,
    label: d.label || `Display ${i + 1}`,
    bounds: d.bounds,
    primary: d.id === primaryId,
  }));
}

function findDisplay(bounds) {
  if (!bounds) return null;
  return screen.getAllDisplays().find((d) =>
    d.bounds.x === bounds.x && d.bounds.y === bounds.y &&
    d.bounds.width === bounds.width && d.bounds.height === bounds.height) || null;
}

let sessionReady = false;
function getSession() {
  const ses = session.fromPartition(PARTITION);
  if (!sessionReady) {
    sessionReady = true;
    ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    ses.setPermissionCheckHandler(() => false);
  }
  return ses;
}

function clearRetry() { if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; } }

// Mid-show resilience: a network blip or renderer crash must not leave the screen
// on a dead frame — retry the load every 3s until it sticks.
function scheduleRetry() {
  clearRetry();
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (win && !win.isDestroyed() && settings.url) win.loadURL(settings.url).catch(() => {});
  }, 3000);
}

function enforceFullScreen(w, tries = 8) {
  if (!w || w.isDestroyed() || w.isFullScreen()) return;
  w.setFullScreen(true);
  if (tries > 0) setTimeout(() => enforceFullScreen(w, tries - 1), 200);
}

function closeWindow() {
  clearRetry();
  const w = win;
  win = null;
  if (w && !w.isDestroyed()) w.close();
}

function start({ url, displayBounds, bg } = {}) {
  if (url !== undefined) {
    const norm = normalizeUrl(url);
    if (!norm) return { ok: false, error: 'Enter a valid http(s) URL.' };
    saveSettings({ url: norm });
  }
  if (displayBounds !== undefined) saveSettings({ displayBounds: displayBounds || null });
  if (bg !== undefined) saveSettings({ bg: (BG[bg] || bg === 'page') ? bg : 'green' });

  if (!settings.url) return { ok: false, error: 'Enter a URL first.' };
  const display = findDisplay(settings.displayBounds);
  if (!display) return { ok: false, error: 'Choose a connected display.' };

  closeWindow();
  saveSettings({ active: true });

  const w = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    fullscreen: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: true,
    backgroundColor: BG[settings.bg] || '#000000',
    title: 'Web Output',
    webPreferences: {
      session: getSession(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  win = w;
  w.webContents.setAudioMuted(!!settings.muted);
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.webContents.on('will-navigate', (e, target) => {
    if (!/^https?:/i.test(target)) e.preventDefault();
  });
  // Esc on the output (if it has focus) takes it down — a way out when the output
  // covers the only screen.
  w.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') { e.preventDefault(); stop(); }
  });
  w.webContents.on('did-start-loading', () => { if (win === w) emit({ loading: true }); });
  // Key colour as soon as the page's DOM exists (not only once every image and
  // script has loaded), and again for each iframe that loads after (background.js).
  w.webContents.on('dom-ready', () => { if (win === w) applyBackground(w, settings.bg); });
  w.webContents.on('did-frame-finish-load', (_e, isMainFrame, processId, routingId) => {
    if (win !== w || isMainFrame) return;
    const f = webFrameMain.fromId(processId, routingId);
    if (f) paintFrame(f, settings.bg);
  });
  w.webContents.on('did-finish-load', () => {
    if (win !== w) return;
    clearRetry();
    applyBackground(w, settings.bg);
    enforceFullScreen(w);
    emit({ loading: false, error: null });
  });
  w.webContents.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
    if (win !== w || !isMainFrame || code === -3 /* ERR_ABORTED (superseded) */) return;
    emit({ loading: false, error: `${desc || 'Load failed'} (${code}) — retrying…` });
    scheduleRetry();
  });
  w.webContents.on('render-process-gone', () => {
    if (win !== w) return;
    emit({ error: 'Page crashed — reloading…' });
    scheduleRetry();
  });
  w.on('leave-full-screen', () => { if (!w.isDestroyed()) w.setFullScreen(true); });
  w.on('closed', () => {
    if (win === w) { win = null; clearRetry(); saveSettings({ active: false }); emit({ live: false, loading: false }); }
  });

  w.loadURL(settings.url).catch(() => {}); // failures surface via did-fail-load
  emit({ live: true, loading: true, error: null });
  return { ok: true };
}

function stop() {
  saveSettings({ active: false });
  closeWindow();
  emit({ live: false, loading: false, error: null });
  return { ok: true };
}

function configure({ url, displayBounds, bg, muted, openAtLogin } = {}) {
  if (url !== undefined) {
    const norm = url ? normalizeUrl(url) : '';
    if (url && !norm) return { ok: false, error: 'Enter a valid http(s) URL.' };
    saveSettings({ url: norm });
  }
  if (displayBounds !== undefined) saveSettings({ displayBounds: displayBounds || null });
  if (bg !== undefined) {
    saveSettings({ bg: (BG[bg] || bg === 'page') ? bg : 'green' });
    applyBackground(win, settings.bg);
  }
  if (muted !== undefined) {
    saveSettings({ muted: !!muted });
    if (win && !win.isDestroyed()) win.webContents.setAudioMuted(!!muted);
  }
  if (openAtLogin !== undefined) app.setLoginItemSettings({ openAtLogin: !!openAtLogin });
  emit({});
  return { ok: true };
}

function createControl() {
  control = new BrowserWindow({
    width: 560,
    height: 600,
    minWidth: 440,
    minHeight: 520,
    title: 'Cue Web Output',
    backgroundColor: '#0e1014',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  control.removeMenu();
  control.loadFile(path.join(__dirname, 'control.html'));
  control.on('closed', () => { control = null; app.quit(); });
}

app.on('second-instance', () => {
  if (control) { if (control.isMinimized()) control.restore(); control.focus(); }
});

app.whenReady().then(() => {
  loadSettings();
  ipcMain.handle('get', () => getState());
  ipcMain.handle('start', (_e, opts) => start(opts));
  ipcMain.handle('stop', () => stop());
  ipcMain.handle('reload', () => { if (win && !win.isDestroyed()) win.webContents.reloadIgnoringCache(); return { ok: true }; });
  ipcMain.handle('configure', (_e, opts) => configure(opts));

  createControl();

  // Re-open on launch if it was live when last quit.
  if (settings.active) {
    const r = start();
    if (!r.ok) emit({ live: false, error: r.error });
  }

  // A monitor dropping out and coming back (cable, sleep) re-opens the output on it.
  const onDisplaysChanged = () => {
    if (settings.active && !win && findDisplay(settings.displayBounds)) start();
    emit({});
  };
  screen.on('display-added', onDisplaysChanged);
  screen.on('display-removed', () => emit({}));
  screen.on('display-metrics-changed', () => emit({}));
});

app.on('before-quit', () => {
  // Keep `active` so the output comes back on next launch.
  clearRetry();
  const w = win;
  win = null;
  if (w && !w.isDestroyed()) w.destroy();
});

app.on('window-all-closed', () => app.quit());
