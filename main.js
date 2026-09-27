// Zoon Player — Electron main process.
// Starts the local library server, then shows it in a frameless window styled
// like the Zune 4.8 desktop software.
import { app, BrowserWindow, dialog, ipcMain, nativeImage, screen, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appIconBitmap, thumbBitmap } from './desktop/icons.js';
import { startZoon } from './server/app.js';
import { stateDir } from './server/util.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(1);
const arg = (name) => argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const has = (name) => argv.some((a) => a === `--${name}` || a.startsWith(`--${name}=`));

const serveOnly = has('serve-only');
const capturePath = arg('capture'); // --capture=out.png: screenshot the window, then quit (testing)
// --state=<dir> points a test run at a throwaway state folder (e.g. to check first-run behaviour).
const dir = arg('state') ? (fs.mkdirSync(arg('state'), { recursive: true }), arg('state')) : stateDir(serveOnly || !!capturePath);
app.setPath('userData', path.join(dir, 'electron'));
app.setAppUserModelId('com.a44kaliburll.zoon');

const FULL_MIN = { width: 900, height: 600 };
const COMPACT = { width: 390, height: 96 };
const APP_PORT = 18750;

let win = null;
let backend = null;
let compact = false;
let normalBounds = null;
let wasMaximized = false;
let thumbState = { playing: false, hasTrack: false };

if (!serveOnly && !capturePath && !app.requestSingleInstanceLock()) {
  // Another window is already open; it gets focused via 'second-instance'.
  app.exit(0);
}

const makeImage = (bitmap, size) => nativeImage.createFromBitmap(bitmap, { width: size, height: size });
let appIcon = null;
const thumbIcons = {};

/** Resize album art with Chromium's decoder; returns JPEG bytes (or null to keep the original). */
async function resize(buffer, max) {
  const img = nativeImage.createFromBuffer(buffer);
  if (img.isEmpty()) return null;
  const { width, height } = img.getSize();
  const scale = Math.min(1, max / Math.max(width, height));
  const out = scale < 1 ? img.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'best' }) : img;
  return out.toJPEG(88);
}

// ---------------------------------------------------------------- window state
const windowStateFile = path.join(dir, 'window.json');

function loadWindowState() {
  try {
    const s = JSON.parse(fs.readFileSync(windowStateFile, 'utf8'));
    const area = screen.getDisplayMatching(s).workArea;
    const visible = s.x < area.x + area.width - 100 && s.x + s.width > area.x + 100 && s.y >= area.y - 20 && s.y < area.y + area.height - 100;
    return visible ? s : { width: s.width, height: s.height, maximized: s.maximized };
  } catch {
    return {};
  }
}

function saveWindowState() {
  if (!win || win.isDestroyed()) return;
  const bounds = compact ? normalBounds : win.getNormalBounds();
  try {
    fs.writeFileSync(windowStateFile, JSON.stringify({ ...bounds, maximized: compact ? wasMaximized : win.isMaximized() }));
  } catch {}
}

function sendState() {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('win:state', { maximized: !compact && win.isMaximized(), compact });
}

// ---------------------------------------------------------------- compact mode
function setCompact(on) {
  if (!win || on === compact) return;
  compact = on;
  if (compact) {
    wasMaximized = win.isMaximized();
    if (wasMaximized) win.unmaximize();
    normalBounds = win.getBounds();
    win.setMinimumSize(COMPACT.width, COMPACT.height);
    win.setResizable(false);
    win.setMaximizable(false);
    win.setBounds({ x: normalBounds.x + normalBounds.width - COMPACT.width - 24, y: normalBounds.y + 24, ...COMPACT });
    win.setAlwaysOnTop(true, 'floating');
  } else {
    win.setAlwaysOnTop(false);
    win.setResizable(true);
    win.setMaximizable(true);
    win.setMinimumSize(FULL_MIN.width, FULL_MIN.height);
    if (normalBounds) win.setBounds(normalBounds);
    if (wasMaximized) win.maximize();
  }
  sendState();
}

// ---------------------------------------------------------------- taskbar buttons
function updateThumbar() {
  if (!win || win.isDestroyed() || process.platform !== 'win32') return;
  const { playing, hasTrack } = thumbState;
  const flags = hasTrack ? [] : ['disabled'];
  win.setThumbarButtons([
    { tooltip: 'Previous', icon: thumbIcons.prev, flags, click: () => win.webContents.send('thumbar:click', 'prev') },
    { tooltip: playing ? 'Pause' : 'Play', icon: playing ? thumbIcons.pause : thumbIcons.play, click: () => win.webContents.send('thumbar:click', 'play') },
    { tooltip: 'Next', icon: thumbIcons.next, flags, click: () => win.webContents.send('thumbar:click', 'next') },
  ]);
}

// ---------------------------------------------------------------- window
function createWindow() {
  const state = loadWindowState();
  win = new BrowserWindow({
    width: state.width || 1180,
    height: state.height || 780,
    x: state.x,
    y: state.y,
    minWidth: FULL_MIN.width,
    minHeight: FULL_MIN.height,
    frame: false,
    show: false,
    backgroundColor: '#ffffff',
    title: 'Zoon',
    icon: appIcon,
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  if (state.maximized) win.maximize();
  win.removeMenu();

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(backend.url)) e.preventDefault();
  });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const devtools = input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i');
    if (devtools) {
      win.webContents.toggleDevTools();
      e.preventDefault();
    }
  });

  for (const evt of ['maximize', 'unmaximize', 'restore', 'enter-full-screen', 'leave-full-screen']) win.on(evt, sendState);
  win.on('close', saveWindowState);
  win.on('closed', () => { win = null; });
  win.webContents.on('did-finish-load', () => {
    sendState();
    updateThumbar();
  });

  win.once('ready-to-show', () => {
    if (!capturePath) win.show();
  });

  win.loadURL(capturePath ? `${backend.url}?noanim` : backend.url);

  if (capturePath) {
    win.webContents.once('did-finish-load', () => {
      if (has('capture-compact')) setTimeout(() => setCompact(true), 1500);
      // --capture-js="..." runs a snippet first (e.g. open a view) so any screen can be captured.
      if (arg('capture-js')) setTimeout(() => win.webContents.executeJavaScript(arg('capture-js')).catch(() => {}), 1500);
      setTimeout(async () => {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(capturePath, img.toPNG());
        console.log(`captured ${capturePath}`);
        app.quit();
      }, Number(arg('capture-delay') || 3500));
    });
  }
}

// ---------------------------------------------------------------- IPC
ipcMain.on('win', (e, action) => {
  if (!win || e.sender !== win.webContents) return;
  if (action === 'minimize') win.minimize();
  else if (action === 'maximize') {
    if (compact) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  } else if (action === 'close') win.close();
  else if (action === 'compact') setCompact(!compact);
});

ipcMain.handle('dialog:pickFolder', async (e) => {
  if (!win || e.sender !== win.webContents) return null;
  const r = await dialog.showOpenDialog(win, { title: 'Add a folder to your collection', properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.on('thumbar', (e, state) => {
  thumbState = { playing: !!state?.playing, hasTrack: !!state?.hasTrack };
  updateThumbar();
});

// ---------------------------------------------------------------- lifecycle
app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

app.whenReady().then(async () => {
  appIcon = makeImage(appIconBitmap(256), 256);
  for (const name of ['play', 'pause', 'prev', 'next']) thumbIcons[name] = makeImage(thumbBitmap(name), 16);

  const portArg = arg('port');
  backend = await startZoon({
    stateDir: dir,
    uiDir: path.join(here, 'ui'),
    port: portArg ? Number(portArg) : APP_PORT,
    shell: serveOnly ? 'browser' : 'electron',
    // Zune sync runs in the desktop app (not in capture/test runs unless --devices is given).
    devices: (!serveOnly && !capturePath) || has('devices'),
    // Wireless phone sync listens on the LAN only from the real app (it still needs turning on in settings).
    phoneSync: (!serveOnly && !capturePath) || has('phone'),
    resize,
    platform: {
      reveal: (p) => shell.showItemInFolder(p),
      trash: (p) => shell.trashItem(p),
    },
  });
  console.log(`Zoon Player server at ${backend.url}`);
  if (!serveOnly) createWindow();
});

app.on('window-all-closed', () => {
  if (!serveOnly) app.quit();
});

let shuttingDown = false;
app.on('before-quit', async (e) => {
  if (shuttingDown || !backend) return;
  e.preventDefault();
  shuttingDown = true;
  try {
    await backend.shutdown();
  } finally {
    app.quit();
  }
});
