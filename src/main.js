'use strict';
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

// In a packaged app, extraResources land in process.resourcesPath.
// In dev, they sit next to this file's project root.
function resourceRoot() {
  if (app.isPackaged) return process.resourcesPath;
  return path.join(__dirname, '..');
}

function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(resourceRoot(), name), 'utf8'));
  } catch (e) {
    return fallback;
  }
}

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 920,
    height: 720,
    minWidth: 820,
    minHeight: 600,
    backgroundColor: '#070926',
    titleBarStyle: IS_MAC ? 'hiddenInset' : 'default',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (!IS_MAC) app.quit();
});

// ---- IPC -------------------------------------------------------------

ipcMain.handle('bootstrap', () => {
  return {
    platform: process.platform,
    homedir: os.homedir(),
    config: readJson('config.json', {}),
    components: readJson('components.json', { groups: [] }),
    packs: readJson('packs.json', { core: [], packs: [] })
  };
});

// Resolve the platform-specific script path for a component id.
function scriptFor(id) {
  const dir = IS_WIN ? 'windows' : 'macos';
  const ext = IS_WIN ? 'ps1' : 'sh';
  return path.join(resourceRoot(), 'scripts', dir, `${id}.${ext}`);
}

// Run one component script, streaming output back to the renderer.
ipcMain.handle('run-component', async (_evt, payload) => {
  const { id, env } = payload || {};
  const script = scriptFor(id);
  if (!fs.existsSync(script)) {
    return { id, ok: false, code: -1, error: `Script not found: ${script}` };
  }

  const childEnv = Object.assign({}, process.env, env || {});
  // Paths to assets baked into the installer at build time (offline sources).
  childEnv.HM_VENDOR = path.join(resourceRoot(), 'vendor');
  childEnv.HM_BUNDLED_CONFIG = path.join(resourceRoot(), 'vendor', 'config-pack');

  let cmd, args;
  if (IS_WIN) {
    cmd = 'powershell.exe';
    args = ['-ExecutionPolicy', 'Bypass', '-NoProfile', '-File', script];
  } else {
    cmd = '/bin/bash';
    args = [script];
  }

  const send = (line) =>
    mainWindow && mainWindow.webContents.send('component-log', { id, line });

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { env: childEnv, windowsHide: true });
    } catch (e) {
      resolve({ id, ok: false, code: -1, error: String(e) });
      return;
    }

    const onData = (buf) => {
      buf
        .toString()
        .split(/\r?\n/)
        .forEach((l) => {
          if (l.length) send(l);
        });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => {
      send(`[ERROR] ${e.message}`);
    });
    child.on('close', (code) => {
      resolve({ id, ok: code === 0, code });
    });
  });
});

ipcMain.handle('open-external', (_e, url) => { if (url) shell.openExternal(url); return true; });

ipcMain.handle('open-path', (_e, p) => { if (p) shell.openPath(p); return true; });

ipcMain.handle('launch-cursor', () => {
  try {
    if (IS_WIN) {
      const cexe = path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'cursor', 'Cursor.exe');
      if (fs.existsSync(cexe)) { spawn(cexe, [], { detached: true, stdio: 'ignore' }).unref(); return true; }
    } else if (IS_MAC) {
      spawn('open', ['-a', 'Cursor'], { detached: true, stdio: 'ignore' }).unref();
      return true;
    }
  } catch (e) { /* ignore */ }
  return false;
});

ipcMain.handle('quit', () => app.quit());
