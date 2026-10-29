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
// `display` is the chosen monitor as { label, bounds }. It is matched by label (the
// monitor's own name, e.g. "DELL P2419H" / "ATEM Mini") because Windows hands out new
// display ids, and often new positions, when a monitor is unplugged and plugged back in.
// Bounds are only a tie-break between identical monitors and a fallback when a
// display reports no name.
let settings = { url: '', display: null, bg: 'green', active: false, muted: true };
function loadSettings() {
  try { settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }; } catch {}
  // 1.0.x saved bounds only. Keep them as the fallback; the label is filled in the
  // next time the output opens on that display.
  if (!settings.display && settings.displayBounds) settings.display = { label: null, bounds: settings.displayBounds };
  delete settings.displayBounds;
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
    displayId: findDisplay(settings.display)?.id ?? null,
    displayLabel: settings.display?.label || null,
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

const sameBounds = (a, b) => !!a && !!b &&
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

function describeDisplay(d) {
  return { label: d.label || null, bounds: { ...d.bounds } };
}

// Resolve the saved display against what is connected now: by label first, then
// (several monitors with the same name) exact bounds, same resolution, nearest
// position. Without a label, exact bounds only.
function findDisplay(target) {
  if (!target) return null;
  const all = screen.getAllDisplays();
  const b = target.bounds;
  const named = target.label ? all.filter((d) => d.label === target.label) : [];
  if (named.length === 1) return named[0];
  if (named.length > 1) {
    if (!b) return named[0];
    const exact = named.find((d) => sameBounds(d.bounds, b));
    if (exact) return exact;
    const sized = named.filter((d) => d.bounds.width === b.width && d.bounds.height === b.height);
    const pool = sized.length ? sized : named;
    const dist = (d) => Math.hypot(d.bounds.x - b.x, d.bounds.y - b.y);
    return pool.reduce((best, d) => (dist(d) < dist(best) ? d : best));
  }
  return all.find((d) => sameBounds(d.bounds, b)) || null;
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

const waitingMessage = () => `Waiting for ${settings.display?.label || 'the display'} to reconnect…`;

function closeWindow() {
  clearRetry();
  const w = win;
  win = null;
  if (w && !w.isDestroyed()) w.close();
}

function start({ url, display, bg } = {}) {
  if (url !== undefined) {
    const norm = normalizeUrl(url);
    if (!norm) return { ok: false, error: 'Enter a valid http(s) URL.' };
    saveSettings({ url: norm });
  }
  if (display !== undefined) saveSettings({ display: display || null });
  if (bg !== undefined) saveSettings({ bg: (BG[bg] || bg === 'page') ? bg : 'green' });

  if (!settings.url) return { ok: false, error: 'Enter a URL first.' };
  const target = findDisplay(settings.display);
  if (!target) return { ok: false, error: 'Choose a connected display.' };

  closeWindow();
  // Refresh the stored label + bounds from the live display (fills in the label for
  // settings saved by 1.0.x, and keeps the tie-break bounds current).
  saveSettings({ active: true, display: describeDisplay(target) });

  const w = new BrowserWindow({
    x: target.bounds.x,
    y: target.bounds.y,
    width: target.bounds.width,
    height: target.bounds.height,
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

function configure({ url, display, bg, muted, openAtLogin } = {}) {
  if (url !== undefined) {
    const norm = url ? normalizeUrl(url) : '';
    if (url && !norm) return { ok: false, error: 'Enter a valid http(s) URL.' };
    saveSettings({ url: norm });
  }
  if (display !== undefined) saveSettings({ display: display || null });
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
  // If its display isn't plugged in yet, wait for it (handled below) instead of failing.
  if (settings.active) {
    const r = start();
    if (!r.ok && settings.url && settings.display) emit({ live: true, error: waitingMessage() });
    else if (!r.ok) emit({ live: false, error: r.error });
  }

  // A monitor dropping out and coming back (cable, sleep, ATEM power cycle):
  // - gone: take the output down (but stay `active`) rather than let Windows shove
  //   the fullscreen window onto another screen, usually the operator's;
  // - back (new id, maybe a new position): re-open on it, found again by label;
  // - moved while live: re-open where the display now is.
  // Windows fires several events while it rebuilds the layout, so settle first.
  let displayTimer = null;
  const onDisplaysChanged = () => {
    clearTimeout(displayTimer);
    displayTimer = setTimeout(() => {
      displayTimer = null;
      if (!settings.active) return emit({});
      const target = findDisplay(settings.display);
      if (!target) {
        if (win) closeWindow();
        return emit({ live: true, loading: false, error: waitingMessage() });
      }
      const onTarget = win && !win.isDestroyed() &&
        screen.getDisplayMatching(win.getBounds()).id === target.id &&
        sameBounds(settings.display?.bounds, target.bounds);
      if (!onTarget) {
        const r = start();
        if (!r.ok) emit({ live: false, error: r.error });
      } else emit({});
    }, 750);
  };
  screen.on('display-added', onDisplaysChanged);
  screen.on('display-removed', onDisplaysChanged);
  screen.on('display-metrics-changed', onDisplaysChanged);
});

app.on('before-quit', () => {
  // Keep `active` so the output comes back on next launch.
  clearRetry();
  const w = win;
  win = null;
  if (w && !w.isDestroyed()) w.destroy();
});

app.on('window-all-closed', () => app.quit());
