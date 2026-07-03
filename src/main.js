'use strict';
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { spawn, execFileSync, execSync } = require('child_process');
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

// ---- install log (~/.hamidun-setup/install.log) ----------------------
// Every line streamed to the renderer is also appended here, so a user can
// send one file to support when something goes wrong.
const LOG_DIR = path.join(os.homedir(), '.hamidun-setup');
const LOG_PATH = path.join(LOG_DIR, 'install.log');
let logDirReady = false;
function logToFile(id, line) {
  try {
    if (!logDirReady) { fs.mkdirSync(LOG_DIR, { recursive: true }); logDirReady = true; }
    fs.appendFileSync(LOG_PATH, '[' + new Date().toISOString() + '] [' + id + '] ' + line + '\n');
  } catch (e) { /* logging must never break the install */ }
}

let mainWindow = null;

// Track live installer child processes so we can kill orphans if the window
// closes mid-install (otherwise silent installers keep running invisibly).
const CHILDREN = new Set();
function killChildren() {
  for (const c of CHILDREN) {
    try { c.kill(); } catch (e) { /* ignore */ }
  }
  CHILDREN.clear();
}

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
  killChildren();
  if (!IS_MAC) app.quit();
});

app.on('before-quit', killChildren);

// ---- IPC -------------------------------------------------------------

ipcMain.handle('bootstrap', () => {
  // Preflight: free space on the home-dir volume (GB, best-effort) + OS version.
  let freeGB = null;
  try {
    if (typeof fs.statfsSync === 'function') {
      const st = fs.statfsSync(os.homedir());
      freeGB = Math.round(((st.bavail * st.bsize) / (1024 * 1024 * 1024)) * 10) / 10;
    }
  } catch (e) { freeGB = null; }
  return {
    platform: process.platform,
    homedir: os.homedir(),
    config: readJson('config.json', {}),
    components: readJson('components.json', { groups: [] }),
    packs: readJson('packs.json', { core: [], packs: [] }),
    logPath: LOG_PATH,
    freeGB,
    osRelease: os.release()
  };
});

// Resolve the platform-specific script path for a component id.
function scriptFor(id) {
  const dir = IS_WIN ? 'windows' : 'macos';
  const ext = IS_WIN ? 'ps1' : 'sh';
  return path.join(resourceRoot(), 'scripts', dir, `${id}.${ext}`);
}

// Build allowlist of valid component ids from components.json.
function loadValidIds() {
  const data = readJson('components.json', { groups: [] });
  const ids = new Set();
  for (const group of (data.groups || [])) {
    for (const comp of (group.components || [])) {
      if (comp.id) ids.add(comp.id);
    }
  }
  return ids;
}
const VALID_COMPONENT_IDS = loadValidIds();

// Run one component script, streaming output back to the renderer.
ipcMain.handle('run-component', async (_evt, payload) => {
  const { id, env } = payload || {};

  // Allowlist check: reject unknown/traversal ids before building any path.
  if (!id || !VALID_COMPONENT_IDS.has(id)) {
    return { id, ok: false, code: -1, error: `Unknown component id: ${id}` };
  }

  const script = scriptFor(id);
  if (!fs.existsSync(script)) {
    return { id, ok: false, code: -1, error: `Script not found: ${script}` };
  }

  const childEnv = Object.assign({}, process.env, env || {});
  // Paths to assets baked into the installer at build time (offline sources).
  childEnv.HM_VENDOR = path.join(resourceRoot(), 'vendor');
  childEnv.HM_BUNDLED_CONFIG = path.join(resourceRoot(), 'vendor', 'config-pack');
  childEnv.HM_AGENT_DIR = path.join(resourceRoot(), 'agent');
  childEnv.HM_NOMAD_SRC = path.join(resourceRoot(), 'vendor', 'nomad-src');
  childEnv.HM_ASSETS = path.join(resourceRoot(), 'assets');

  let cmd, args;
  if (IS_WIN) {
    // PowerShell 5.1 emits pipe output in the console's OEM code page (CP866 on
    // ru-RU Windows). Node reads the pipe as UTF-8, so Cyrillic logs turn to
    // garbage. Force the console output encoding to UTF-8 *before* running the
    // script, then invoke it via the call operator so its own `exit N` becomes
    // this process's exit code. Escape single quotes in the path ('  -> '').
    const psScript = script.replace(/'/g, "''");
    // Trailing exit propagates the script's real code (bare `exit $LASTEXITCODE`
    // would return 0 when the script fails to load — $LASTEXITCODE is $null then).
    const inline =
      "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; " +
      "$OutputEncoding=[System.Text.Encoding]::UTF8; " +
      "& '" + psScript + "'; " +
      "if ($null -eq $LASTEXITCODE) { exit 1 } else { exit $LASTEXITCODE }";
    cmd = 'powershell.exe';
    args = ['-ExecutionPolicy', 'Bypass', '-NoProfile', '-Command', inline];
  } else {
    cmd = '/bin/bash';
    args = [script];
  }

  // Guard against a window closed mid-install (send to a destroyed webContents
  // crashes the main process on macOS).
  const send = (line) => {
    if (mainWindow && !mainWindow.isDestroyed() &&
        mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('component-log', { id, line });
    }
  };

  return new Promise((resolve) => {
    let child;
    logToFile(id, '=== start ===');
    try {
      child = spawn(cmd, args, { env: childEnv, windowsHide: true });
    } catch (e) {
      logToFile(id, '[ERROR] spawn failed: ' + String(e));
      resolve({ id, ok: false, code: -1, error: String(e) });
      return;
    }
    CHILDREN.add(child);

    const onData = (buf) => {
      buf
        .toString()
        .split(/\r?\n/)
        .forEach((l) => {
          if (l.length) {
            send(l);
            logToFile(id, l);
          }
        });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => {
      send(`[ERROR] ${e.message}`);
      logToFile(id, `[ERROR] ${e.message}`);
    });
    child.on('close', (code) => {
      CHILDREN.delete(child);
      logToFile(id, `=== exit code: ${code} ===`);
      resolve({ id, ok: code === 0, code });
    });
  });
});

ipcMain.handle('open-external', (_e, url) => { if (url) shell.openExternal(url); return true; });

ipcMain.handle('open-path', (_e, p) => { if (p) shell.openPath(p); return true; });

// Reveal a file in Explorer/Finder (openPath on a .env silently fails on macOS
// where .env has no default app — showItemInFolder always works).
ipcMain.handle('reveal-path', (_e, p) => { try { if (p) shell.showItemInFolder(p); } catch (e) { /* ignore */ } return true; });

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

// ---- «Войти в Claude» — открыть терминал с командой claude -----------

// The install scripts just added git/node/claude to PATH, but this (already
// running) Electron process still carries the stale PATH. Re-read Machine +
// User PATH from the registry and add the places `claude` lands in.
function regQueryValue(keyPath, valueName) {
  try {
    const out = execFileSync('reg.exe', ['query', keyPath, '/v', valueName],
      { encoding: 'utf8', windowsHide: true });
    const m = out.match(new RegExp('^\\s*' + valueName + '\\s+REG(?:_EXPAND)?_SZ\\s+(.+)$', 'im'));
    return m ? m[1].trim() : '';
  } catch (e) { return ''; }
}

// Expand %VAR% in REG_EXPAND_SZ values (User PATH often contains %USERPROFILE%).
function expandWinEnv(str) {
  return String(str || '').replace(/%([^%;]+)%/g, (whole, name) => {
    const v = process.env[name];
    return v !== undefined ? v : whole;
  });
}

function freshWindowsPath() {
  const machine = expandWinEnv(regQueryValue(
    'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', 'Path'));
  const user = expandWinEnv(regQueryValue('HKCU\\Environment', 'Path'));
  const parts = [];
  const seen = new Set();
  const push = (chunk) => {
    String(chunk || '').split(';').forEach((p) => {
      const t = p.trim();
      if (t && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); parts.push(t); }
    });
  };
  push(machine);
  push(user);
  // Claude Code native install target + default npm global prefix.
  push(path.join(os.homedir(), '.local', 'bin'));
  push(path.join(os.homedir(), 'AppData', 'Roaming', 'npm'));
  let joined = parts.join(';');
  if (!joined) joined = process.env.PATH || '';
  // npm may use a custom global prefix — ask it (best-effort, with the fresh PATH).
  try {
    const prefix = execSync('npm config get prefix', {
      encoding: 'utf8', windowsHide: true, timeout: 10000,
      env: Object.assign({}, process.env, { PATH: joined, Path: joined })
    }).trim();
    if (prefix && !seen.has(prefix.toLowerCase())) joined += ';' + prefix;
  } catch (e) { /* npm not found — the defaults above still cover it */ }
  return joined;
}

ipcMain.handle('open-claude-terminal', () => {
  try {
    if (IS_WIN) {
      const freshPath = freshWindowsPath();
      const env = Object.assign({}, process.env, { PATH: freshPath, Path: freshPath });
      // `start "Claude Code" cmd /k claude` — a new console window that stays
      // open; it inherits the fresh PATH from this spawn's env.
      const child = spawn('cmd.exe', ['/c', 'start', 'Claude Code', 'cmd', '/k', 'claude'],
        { env, detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
      return true;
    }
    if (IS_MAC) {
      const child = spawn('osascript', [
        '-e', 'tell application "Terminal" to activate',
        '-e', 'tell application "Terminal" to do script "claude"'
      ], { detached: true, stdio: 'ignore' });
      child.unref();
      return true;
    }
  } catch (e) { /* ignore */ }
  return false;
});

// ---- мини-визард ключей: merge в ~/.claude/.credentials.master.env ----
// Replaces existing `KEY=...` lines in place, appends missing ones at the
// end. Never deletes or reorders anything else in the file.
ipcMain.handle('save-credentials', (_e, obj) => {
  try {
    const dir = path.join(os.homedir(), '.claude');
    const file = path.join(dir, '.credentials.master.env');
    fs.mkdirSync(dir, { recursive: true });
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { text = ''; }
    const saved = [];
    for (const key of Object.keys(obj || {})) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(key)) continue; // sane env-var names only
      const raw = obj[key];
      if (typeof raw !== 'string') continue;
      const val = raw.trim().replace(/[\r\n]+/g, '');
      if (!val) continue; // пустые поля игнорируем
      const line = key + '=' + val;
      const re = new RegExp('^' + key + '=.*$', 'm');
      if (re.test(text)) {
        text = text.replace(re, () => line); // fn-replacement: `$` в значении не трогаем
      } else {
        if (text.length && !text.endsWith('\n')) text += '\n';
        text += line + '\n';
      }
      saved.push(key);
    }
    if (saved.length) fs.writeFileSync(file, text, 'utf8');
    return { ok: true, saved, path: file };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('quit', () => app.quit());
