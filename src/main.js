'use strict';
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const remoteFetch = require('./remote-fetch');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

// In a packaged app, extraResources land in process.resourcesPath.
// In dev, they sit next to this file's project root.
function resourceRoot() {
  if (app.isPackaged) return process.resourcesPath;
  return path.join(__dirname, '..');
}

// Где лежит vendor (офлайн-ресурсы: apps, wheels, config-pack, nomad-src).
// На macOS vendor вынесен ИЗ .app (иначе нотаризация ломается о неподписанные
// .so внутри вшитых .whl) и едет в dmg РЯДОМ с .app. Ищем sibling-папку
// (корень смонтированного dmg), иначе — внутри Resources (Windows / dev / если
// vendor всё-таки вложен). Возвращаем путь + признак «найден».
function vendorRoot() {
  const inside = path.join(resourceRoot(), 'vendor');
  if (app.isPackaged && process.platform === 'darwin') {
    // process.resourcesPath = .../Hamidun Setup.app/Contents/Resources
    // → на 3 уровня выше = папка рядом с .app (корень dmg-мнимого тома)
    const sibling = path.resolve(process.resourcesPath, '..', '..', '..', 'vendor');
    try { if (fs.existsSync(sibling)) return sibling; } catch (e) {}
  }
  return inside;
}

// vendor доступен? (на mac при запуске .app из /Applications без dmg — нет)
function vendorAvailable() {
  try { return fs.existsSync(path.join(vendorRoot(), 'config-pack')); } catch (e) { return false; }
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
// Kill the whole process TREE of each tracked child, not just the shell wrapper.
// The shell (powershell/bash) spawns msiexec, pip, curl, hdiutil… as its own
// children; killing only the wrapper orphans them and they keep running unseen.
//   Windows: taskkill /T /F walks and terminates the child tree by pid.
//   macOS:   each child is spawned detached (its own process-group leader), so
//            process.kill(-pid) signals the entire group at once.
function killChildren() {
  for (const c of CHILDREN) {
    try {
      if (!c || !c.pid) { try { if (c) c.kill(); } catch (e) { /* ignore */ } continue; }
      if (IS_WIN) {
        try {
          // taskkill по АБСОЛЮТНОМУ пути из валидированного System32 (анти-hijack:
          // установщик elevated, подложенный taskkill.exe в PATH = эскалация).
          const tk = remoteFetch.sysBin('taskkill.exe') || 'taskkill.exe';
          execFileSync(tk, ['/PID', String(c.pid), '/T', '/F'],
            { windowsHide: true, stdio: 'ignore' });
        } catch (e) { try { c.kill(); } catch (e2) { /* ignore */ } }
      } else {
        // Negative pid => the child's whole process group (needs detached spawn).
        try { process.kill(-c.pid, 'SIGKILL'); }
        catch (e) { try { c.kill('SIGKILL'); } catch (e2) { /* ignore */ } }
      }
    } catch (e) { /* ignore */ }
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

// Warn when the installer is running under a DIFFERENT user account than the
// person at the keyboard — its scripts write ~/.claude, PATH, credentials, etc.
// into whatever HOME the process token has, so a foreign account silently sets
// up the wrong profile. Returns a human-readable RU string, or '' when there's
// nothing to warn about / we can't tell reliably.
function detectForeignUserWarning() {
  try {
    if (!IS_WIN) {
      // macOS/Linux: sudo preserves the original login name in $SUDO_USER. If it
      // is set and differs from the effective user, the install is heading into
      // root's (or another user's) home instead of the real user's — reliable.
      const sudoUser = (process.env.SUDO_USER || '').trim();
      let me = '';
      try { me = (os.userInfo().username || '').trim(); } catch (e) { me = ''; }
      if (sudoUser && me && sudoUser !== me) {
        return 'Установщик запущен через sudo от имени «' + me + '», но вы вошли в систему ' +
               'как «' + sudoUser + '». Файлы уедут не в тот профиль. Запустите установщик ' +
               'обычным двойным кликом, без sudo.';
      }
      return '';
    }
    // Windows: there is no reliable pure-Node/Electron way to learn the
    // INTERACTIVE session's user from inside a process launched under a
    // different account. Ordinary UAC elevation keeps the SAME user (nothing to
    // warn about); only "Запуск от имени другого пользователя" / runas /user
    // swaps the token, and that leaves NO trace of the original interactive user
    // in this process's environment.
    // TODO(reliability): detecting that case needs a native call — e.g. compare
    // this process's token SID against the owner of the interactive shell
    // (explorer.exe) via WTSQuerySessionInformation + OpenProcessToken. Until a
    // native helper exists we deliberately return '' instead of guessing and
    // scaring users with a false banner.
    return '';
  } catch (e) {
    return '';
  }
}

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
    osRelease: os.release(),
    // Absolute path to the bundled resources dir (vendor/agent/assets live here).
    // The renderer needs it to open the offline START-HERE fallback locally.
    resourcesRoot: resourceRoot(),
    // vendor доступен? На mac vendor лежит в dmg РЯДОМ с .app. Если приложение
    // перетащили в /Applications без dmg — vendor не найдётся: офлайн-установка
    // невозможна, компоненты уйдут в онлайн-фолбэк или упадут. UI это подсветит.
    vendorAvailable: vendorAvailable(),
    // Non-empty when we can tell the installer runs under a different user than
    // the interactive one (files would land in the wrong profile).
    userWarning: detectForeignUserWarning()
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

// ---- remote (CDN on-demand) components -------------------------------
// Реестр докачки (remote-components.json) вшивается через extraResources.
// remoteId → S3/CDN-архив, который качается ТОЛЬКО если компонент выбран.
function loadRemoteRegistry() {
  return readJson('remote-components.json', { components: [] });
}
// Allowlist валидных remoteId — только из вшитого реестра (не из renderer'а).
// Плюс карта id компонента → его remoteId (сверяем, что renderer не подменил).
function loadRemoteMaps() {
  const reg = loadRemoteRegistry();
  const ids = new Set();
  for (const e of (reg.components || [])) { if (e && e.remoteId) ids.add(e.remoteId); }
  const compRemote = new Map(); // component id → remoteId (из components.json)
  const data = readJson('components.json', { groups: [] });
  for (const g of (data.groups || [])) {
    for (const c of (g.components || [])) {
      if (c && c.remote && c.remoteId) compRemote.set(c.id, c.remoteId);
    }
  }
  return { reg, ids, compRemote };
}

// Куда докачивать (ADMIN-OWNED STAGING, FIX-A):
//   Windows: %ProgramData%\HamidunSetup\cache\<remoteId> — admin-owned корень,
//            remote-fetch.fetchRemote() ужесточает и ПРОВЕРЯЕТ его DACL (SYSTEM +
//            Administrators, /inheritance:r, без user-SID) — обычный/medium
//            процесс пользователя туда писать НЕ может (закрывает TOCTOU-класс).
//   macOS/Linux: ~/Library/Caches | ~/.cache — установка uv здесь неэлевейтед
//            end-to-end (эскалации нет); полная изоляция от процессов ТОГО ЖЕ
//            пользователя без root на POSIX недостижима (см. remote-fetch модель угроз).
function remoteCacheDir(remoteId) {
  let base;
  if (IS_WIN) {
    base = path.join(remoteFetch.winProgramData(), 'HamidunSetup', 'cache');
  } else if (IS_MAC) {
    base = path.join(os.homedir(), 'Library', 'Caches', 'HamidunSetup');
  } else {
    base = path.join(os.homedir(), '.cache', 'HamidunSetup');
  }
  return path.join(base, remoteId);
}

// Run one component script, streaming output back to the renderer.
//
// БЕЗОПАСНОСТЬ (remote-компоненты): докачка+проверка+распаковка+запуск идут
// ОДНОЙ атомарной операцией здесь, в main. Renderer НЕ может: (а) задать путь
// кэша — HM_REMOTE_CACHE из renderer безусловно вырезается и вычисляется тут из
// проверенного пути; (б) вклиниться между verify и run — второго IPC нет.
ipcMain.handle('run-component', async (_evt, payload) => {
  const { id } = payload || {};

  // Allowlist check: reject unknown/traversal ids before building any path.
  if (!id || !VALID_COMPONENT_IDS.has(id)) {
    return { id, ok: false, code: -1, error: `Unknown component id: ${id}` };
  }

  const script = scriptFor(id);
  if (!fs.existsSync(script)) {
    return { id, ok: false, code: -1, error: `Script not found: ${script}` };
  }

  // env из renderer НЕ доверяем для чувствительных путей: HM_REMOTE_CACHE всегда
  // вырезаем — его задаёт ТОЛЬКО main из проверенного пути ниже (P0-2/P0-4).
  const rendererEnv = Object.assign({}, (payload && payload.env) || {});
  delete rendererEnv.HM_REMOTE_CACHE;

  const send = (line) => {
    if (mainWindow && !mainWindow.isDestroyed() &&
        mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('component-log', { id, line });
    }
  };
  const sendChannel = (channel, data) => {
    if (mainWindow && !mainWindow.isDestroyed() &&
        mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send(channel, data);
    }
  };

  // Remote-компонент: сначала атомарно докачиваем+проверяем+распаковываем в main.
  // remoteId берётся ТОЛЬКО из вшитого реестра (compRemote), не из renderer.
  let remoteCache = '';
  const { reg, compRemote } = loadRemoteMaps();
  const declared = compRemote.get(id);
  if (declared) {
    const entry = remoteFetch.pickEntry(reg, declared, process.platform);
    if (!entry) {
      return { id, ok: false, code: -1, stage: 'fetch', error: `Нет сборки «${declared}» для платформы ${process.platform} в реестре докачки.` };
    }
    const cacheDir = remoteCacheDir(declared);
    logToFile(id, '=== fetch-remote start (' + declared + ') ===');
    let fr;
    try {
      fr = await remoteFetch.fetchRemote({
        entry,
        cacheDir,
        timeoutMs: 20000,
        onProgress: (p) => sendChannel('remote-progress', { id, remoteId: declared, pct: p.pct, received: p.received, total: p.total }),
        // Лог докачки идёт в ТОТ ЖЕ канал, что и вывод компонента — попадает в
        // общий лог естественно, атрибутируется по id, ничего не ломает.
        onLog: (line) => { logToFile(id, line); send(line); }
      });
    } catch (e) {
      logToFile(id, '[ERROR] fetch-remote: ' + String(e));
      return { id, ok: false, code: -1, stage: 'fetch', error: String(e.message || e) };
    }
    logToFile(id, '=== fetch-remote result: ' + (fr && fr.ok ? ('ok ' + fr.path) : ('FAIL ' + (fr && fr.error))) + ' ===');
    if (!fr || !fr.ok) {
      return { id, ok: false, code: -1, stage: 'fetch', error: (fr && fr.error) || 'докачка не удалась' };
    }
    remoteCache = fr.path; // проверенный (sha256) распакованный путь — только из main
  }

  const childEnv = Object.assign({}, process.env, rendererEnv);
  // Paths to assets baked into the installer at build time (offline sources).
  const vroot = vendorRoot();
  childEnv.HM_VENDOR = vroot;
  childEnv.HM_BUNDLED_CONFIG = path.join(vroot, 'config-pack');
  childEnv.HM_AGENT_DIR = path.join(resourceRoot(), 'agent');
  childEnv.HM_NOMAD_SRC = path.join(vroot, 'nomad-src');
  childEnv.HM_ASSETS = path.join(resourceRoot(), 'assets');
  // HM_REMOTE_CACHE ставим ТОЛЬКО из проверенного пути (или не ставим вовсе).
  if (remoteCache) childEnv.HM_REMOTE_CACHE = remoteCache;

  let cmd, args;
  if (IS_WIN) {
    // Абсолютный powershell.exe из ВАЛИДИРОВАННОГО System32 (FIX-E). Fail-closed:
    // не нашли → блокируем установку (никакого fallback в короткое имя, иначе
    // PATH-hijack воскресает; установщик elevated — это была бы эскалация).
    const ps = remoteFetch.winPowershellPath();
    if (!ps) {
      return { id, ok: false, code: -1, error: 'PowerShell не найден в System32 — установка заблокирована (fail-closed).' };
    }
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
    cmd = ps;
    args = ['-ExecutionPolicy', 'Bypass', '-NoProfile', '-Command', inline];
  } else {
    cmd = '/bin/bash';
    args = [script];
  }

  // send/sendChannel уже объявлены выше (используются и для докачки, и для лога).
  return new Promise((resolve) => {
    let child;
    logToFile(id, '=== start ===');
    try {
      // macOS: give the child its own process group so killChildren can reap the
      // whole tree (msiexec/pip/curl/hdiutil) via process.kill(-pid). On Windows
      // we kill the tree via taskkill /T instead, so no detached group is needed.
      const spawnOpts = { env: childEnv, windowsHide: true };
      if (!IS_WIN) spawnOpts.detached = true;
      child = spawn(cmd, args, spawnOpts);
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

// shell.openPath резолвится СТРОКОЙ: пустая = успех, непустая = текст ошибки.
// Пробрасываем это в renderer, чтобы он мог показать фолбэк вместо тихого no-op.
ipcMain.handle('open-path', async (_e, p) => {
  if (!p) return { ok: false, error: 'empty-path' };
  try {
    const err = await shell.openPath(p);
    return { ok: !err, error: err || '' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Копируем памятку START-HERE.html на рабочий стол — чтобы к ней можно было
// вернуться в любой момент (не зависит от того, где лежит установщик/ресурсы).
// Путь берём ТОЛЬКО из вшитого config.json (не из renderer'а — иначе IPC даёт
// произвольное чтение файлов) и проверяем, что он не вышел из ресурсов.
// Идемпотентно: перезаписываем при каждом запуске (памятка могла обновиться).
// Известное ограничение (как у всей установки, см. TODO про cross-user
// elevation выше): если UAC-креды дал ДРУГОЙ пользователь, Desktop будет его.
ipcMain.handle('save-start-here', () => {
  let src = '';
  try {
    const cfg = readJson('config.json', {});
    const rel = String((cfg.finish && cfg.finish.startHtmlRelPath) || 'assets/START-HERE.html');
    const root = path.resolve(resourceRoot());
    src = path.resolve(root, rel);
    if (!src.startsWith(root + path.sep)) return { ok: false, dest: '', src: '', error: 'bad-path' };
    if (!fs.existsSync(src)) return { ok: false, dest: '', src, error: 'source-missing' };
    const dest = path.join(app.getPath('desktop'), 'Что дальше — Hamidun.html');
    fs.copyFileSync(src, dest);
    return { ok: true, dest, src };
  } catch (e) {
    // src отдаём и при ошибке — renderer откроет вшитую копию как фолбэк.
    return { ok: false, dest: '', src, error: e.message };
  }
});

// Reveal a file in Explorer/Finder (openPath on a .env silently fails on macOS
// where .env has no default app — showItemInFolder always works).
ipcMain.handle('reveal-path', (_e, p) => { try { if (p) shell.showItemInFolder(p); } catch (e) { /* ignore */ } return true; });

ipcMain.handle('launch-cursor', () => {
  try {
    if (IS_WIN) {
      const cexe = path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'cursor', 'Cursor.exe');
      if (fs.existsSync(cexe)) { spawn(cexe, [], { detached: true, stdio: 'ignore' }).unref(); return true; }
    } else if (IS_MAC) {
      spawn('/usr/bin/open', ['-a', 'Cursor'], { detached: true, stdio: 'ignore' }).unref();
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
    // reg.exe по АБСОЛЮТНОМУ пути из валидированного System32 (FIX-E).
    const reg = remoteFetch.sysBin('reg.exe');
    if (!reg) return '';
    const out = execFileSync(reg, ['query', keyPath, '/v', valueName],
      { encoding: 'utf8', windowsHide: true });
    const m = out.match(new RegExp('^\\s*' + valueName + '\\s+REG(?:_EXPAND)?_SZ\\s+(.+)$', 'im'));
    return m ? m[1].trim() : '';
  } catch (e) { return ''; }
}

// npm global prefix БЕЗ спавна npm через shell (FIX-E: убираем shell-строки).
// Читаем `prefix=` из пользовательского ~/.npmrc (единственное надёжное место
// кастомного префикса). Дефолтные локации npm покрыты push() в freshWindowsPath.
function npmPrefixFromRc() {
  try {
    const rc = fs.readFileSync(path.join(os.homedir(), '.npmrc'), 'utf8');
    const m = rc.match(/^\s*prefix\s*=\s*(.+?)\s*$/m);
    if (m) return expandWinEnv(m[1].replace(/^["']|["']$/g, '').trim());
  } catch (e) { /* нет .npmrc — дефолты покрывают */ }
  return '';
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
  // npm может иметь кастомный global prefix — читаем из ~/.npmrc БЕЗ spawn через
  // shell (FIX-E). Дефолтные локации уже добавлены push() выше.
  const prefix = npmPrefixFromRc();
  if (prefix && !seen.has(prefix.toLowerCase())) { seen.add(prefix.toLowerCase()); parts.push(prefix); }
  let joined = parts.join(';');
  if (!joined) joined = process.env.PATH || '';
  return joined;
}

ipcMain.handle('open-claude-terminal', () => {
  try {
    if (IS_WIN) {
      const freshPath = freshWindowsPath();
      const env = Object.assign({}, process.env, { PATH: freshPath, Path: freshPath });
      // cmd.exe по АБСОЛЮТНОМУ пути из валидированного System32 (FIX-E).
      // `start "Claude Code" cmd /k claude` — a new console window that stays
      // open; it inherits the fresh PATH from this spawn's env.
      const cmdExe = remoteFetch.sysBin('cmd.exe') || 'cmd.exe';
      const child = spawn(cmdExe, ['/c', 'start', 'Claude Code', 'cmd', '/k', 'claude'],
        { env, detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
      return true;
    }
    if (IS_MAC) {
      const child = spawn('/usr/bin/osascript', [
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
