'use strict';
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { spawn, execFileSync, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const https = require('https');
const remoteFetch = require('./remote-fetch');
const installEnv = require('./install-env');   // #4: истинный allowlist renderer-env
const manifest = require('./install-manifest'); // Фаза 2: версии установленного (справочно)
const installMode = require('./install-mode');  // P0-1: авторитетный additive-режим (main, не renderer)
const receipts = require('./install-receipts'); // installed-маркеры (гейт «Удалить»; целей удаления НЕ задают)
const uninstallTargets = require('./uninstall-targets'); // зашитый per-component аллоулист целей удаления
const uninstallExec = require('./uninstall-exec');       // guard (fail-closed) + исполнители удаления в JS

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

// macOS App Translocation: когда .app перетащили в /Программы и запустили ОТТУДА без
// снятия карантина, Gatekeeper исполняет копию из read-only
// /private/var/folders/.../AppTranslocation/<rand>/d/Hamidun Setup.app. Тогда
// sibling-vendor из dmg (он лежит РЯДОМ с .app, не внутри) отрывается — vendorRoot()
// найдёт лишь частичный Contents/Resources/vendor без uv/nomad/course/mascot, и
// офлайн-компоненты падают «код 1». Определяем по пути exe/__dirname.
function isTranslocated() {
  if (process.platform !== 'darwin') return false;
  try {
    return /\/AppTranslocation\//.test(process.execPath || '')
        || /\/AppTranslocation\//.test(__dirname || '');
  } catch (e) { return false; }
}

// Есть ли в подпапке vendor файл, удовлетворяющий предикату (glob-lite без зависимостей).
function vendorDirHas(sub, test) {
  try { return fs.readdirSync(path.join(vendorRoot(), sub)).some(test); }
  catch (e) { return false; }
}

// Полнота офлайн-vendor покупательского издания: помимо config-pack (база) должны
// быть КЛЮЧЕВЫЕ офлайн-архивы, которые translocation отрывает от .app — архив uv
// (vendor/apps/uv-macos-<arch>.tar.gz) и архив курса (vendor/course/*.zip). Оба
// всегда едут в mac-сборке (fetch-vendor-mac + трекнутый курс); их отсутствие рядом
// с частичным Resources/vendor = верный признак оторванного sibling-vendor.
function vendorComplete() {
  if (!vendorAvailable()) return false;
  const hasUv = vendorDirHas('apps', (f) => /^uv-macos-.*\.tar\.gz$/i.test(f));
  const hasCourse = vendorDirHas('course', (f) => /\.zip$/i.test(f));
  return hasUv && hasCourse;
}

// Издание заявлено «полностью офлайновым»? Маркер offlineEdition:true в bundled
// config.json пишет fetch-vendor (оба фетчера) на сборке. Онлайн/lite-издание
// (dist:mac / dist:win:lite — fetch-vendor НЕ запускался) маркера НЕ имеет, поэтому
// отсутствие vendor у него — норма (онлайн-фолбэк), а не дефект. config.json едет
// ВНУТРИ .app/Contents/Resources → доступен даже когда sibling-vendor оторван.
function isOfflineEdition() {
  try { return readJson('config.json', {}).offlineEdition === true; }
  catch (e) { return false; }
}

// Жёсткий стоп ДО установки (только упакованный mac-.app):
//   • translocation — Gatekeeper исполняет .app из read-only AppTranslocation, sibling-
//     vendor оторван: заведомо сломанный офлайн-запуск → блок ВСЕГДА (не зависит от
//     издания — офлайн-компоненты недостижимы физически);
//   • неполный/отсутствующий vendor БЕЗ translocation → блок ТОЛЬКО если издание
//     заявлено офлайн-полным (offlineEdition). Онлайн/lite-издание при отсутствующем
//     vendor работает штатно через онлайн-фолбэк → мягкое renderVendorWarning в
//     renderer, НЕ жёсткий стоп (иначе легитимная mac-сборка без офлайн-vendor = кирпич).
// В dev (не packaged) и на Windows translocation невозможен — не блокируем.
function vendorBlockInfo() {
  if (process.platform !== 'darwin' || !app.isPackaged) return { blocked: false };
  if (isTranslocated()) {
    return { blocked: true, translocated: true, reason: 'translocation' };
  }
  if (!vendorComplete() && isOfflineEdition()) {
    return { blocked: true, translocated: false, reason: 'incomplete-vendor' };
  }
  return { blocked: false };
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
        // taskkill по АБСОЛЮТНОМУ пути из валидированного System32 (анти-hijack:
        // установщик elevated, подложенный taskkill.exe в PATH = эскалация).
        // #6: НИКАКОГО fallback в короткое имя 'taskkill.exe' (это вернуло бы
        // PATH-резолв). System32 не валиден → fail-closed: рвём только сам child.
        const tk = remoteFetch.sysBin('taskkill.exe');
        if (tk) {
          try {
            execFileSync(tk, ['/PID', String(c.pid), '/T', '/F'],
              { windowsHide: true, stdio: 'ignore' });
          } catch (e) { try { c.kill(); } catch (e2) { /* ignore */ } }
        } else {
          try { c.kill(); } catch (e2) { /* ignore */ }
        }
      } else {
        // Negative pid => the child's whole process group (needs detached spawn).
        try { process.kill(-c.pid, 'SIGKILL'); }
        catch (e) { try { c.kill('SIGKILL'); } catch (e2) { /* ignore */ } }
      }
    } catch (e) { /* ignore */ }
  }
  CHILDREN.clear();
}

// Force the installer window above whatever the user was doing (browser, IDE).
// Тестер-фидбек: окно установки открывалось/уходило ЗА браузером — «просидел 30
// минут, думал ничего не устанавливается». На Windows свежесозданное окно часто
// не выходит на передний план, а после UAC-элевации фокус не возвращается.
let _onTopTimer = null;
function bringToFront() {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.moveTop();
    mainWindow.setAlwaysOnTop(true);   // кратко форсим поверх чужих окон…
    // macOS: focus() поднимает окно, но не активирует приложение, когда активен
    // чужой app — клавфокус остаётся там. app.focus({steal}) реально активирует.
    if (IS_MAC) { try { app.focus({ steal: true }); } catch (_) {} }
    mainWindow.focus();
    if (_onTopTimer) clearTimeout(_onTopTimer);  // один handle — не плодим таймеры
    _onTopTimer = setTimeout(() => {             // …и снимаем on-top, чтобы не мешать
      _onTopTimer = null;
      try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setAlwaysOnTop(false); } catch (_) {}
    }, 600);
  } catch (_) {}
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 920,
    height: 720,
    minWidth: 820,
    minHeight: 600,
    backgroundColor: '#070926',
    show: false,                       // показываем на ready-to-show — сразу поверх
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
  mainWindow.once('ready-to-show', bringToFront);
  // M1: когда юзер сам вернулся в окно — разрешаем следующий однократный подъём
  // (например после следующего UAC) и гасим мигание таскбара.
  mainWindow.on('focus', () => {
    _frontedForInstall = false;
    try { mainWindow.flashFrame(false); } catch (_) {}
  });
}
// M1: подняли ли окно на передний план в текущем «эпизоде» ухода фокуса — чтобы
// не вырывать окно у пользователя на КАЖДОМ компоненте (8-12 рывков за прогон).
let _frontedForInstall = false;

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
    // BUG #11: платформо-гейтнутые компоненты (uv=win32-only) на чужой ОС не отдаём.
    components: componentsForPlatform(),
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
    // macOS App Translocation / оторванный sibling-vendor: жёсткий стоп ДО установки.
    // blocked=true → renderer перекрывает экран блокирующим окном и гасит «Установить».
    vendorBlock: vendorBlockInfo(),
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

// Карта id → компонент (для платформенного гейта, BUG #11).
function loadComponentMeta() {
  const data = readJson('components.json', { groups: [] });
  const m = new Map();
  for (const g of (data.groups || [])) {
    for (const c of (g.components || [])) { if (c && c.id) m.set(c.id, c); }
  }
  return m;
}
const COMPONENT_META = loadComponentMeta();

// BUG #11: показывать компонент на этой платформе? Гейт — необязательное поле
// components.json `platforms:["win32",…]`. Нет поля/пустой массив → показывать везде.
function componentShownOnPlatform(comp, platform) {
  const gate = comp && Array.isArray(comp.platforms) ? comp.platforms : null;
  return !gate || gate.length === 0 || gate.indexOf(platform || process.platform) !== -1;
}

// Компоненты для текущей платформы: платформо-гейтнутые (напр. uv=win32-only) на
// чужой ОС в UI НЕ отдаём — иначе юзер выбрал бы uv на macOS и упёрся бы в отказ
// pickEntry (в реестре докачки нет darwin-сборки). Пустые группы отбрасываем.
function componentsForPlatform() {
  const data = readJson('components.json', { groups: [] });
  const plat = process.platform;
  const groups = (data.groups || [])
    .map((g) => Object.assign({}, g, {
      components: (g.components || []).filter((c) => componentShownOnPlatform(c, plat))
    }))
    .filter((g) => (g.components || []).length);
  return { groups };
}

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

// Куда докачивать (ADMIN-OWNED STAGING):
//   Windows: НЕ ИСПОЛЬЗУЕТСЯ (P0 Codex круг 6). Предсказуемый %ProgramData%\HamidunSetup\
//            cache\<remoteId> позволял medium-малвари пред-создать/удержать <id>.zip и
//            подменить его до распаковки (owner/DACL-window + ZIP-TOCTOU). Теперь на
//            win32 кэш — СВЕЖИЙ random-leaf каталог, рождённый АТОМАРНО Admins-only
//            (winMakeSecureDir → New-HmSecureStagingDir) прямо в run-component.
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

// #4: env для elevated install-скриптов НЕЛЬЗЯ строить как весь process.env +
// renderer-env — иначе medium-integrity процесс ТОГО ЖЕ юзера подсунул бы свой
// git/node/npm/winget/msiexec (через пользовательский PATH или подмену
// command-resolution переменных) под наш elevated-токен = эскалация. Строим
// childEnv из строгого allowlist: PATH ТОЛЬКО из admin-owned каталогов (System32 +
// стандартные Program Files install-таргеты + наш vendor), без пользовательского
// PATH; PSModulePath/ComSpec — валидированные системные (не из env). Из renderer-env
// пропускаем ТОЛЬКО ключи установщика (HM_*, кроме HM_REMOTE_CACHE) — истинный
// allowlist (см. install-env.js). Всё прочее — NODE_OPTIONS, npm_config_*,
// GIT_EXEC_PATH, NODE_PATH, PATH/PSModulePath/ComSpec и любые не-HM_ переменные —
// отбрасывается. Пользовательские install-таргеты (LOCALAPPDATA\Programs, Roaming\npm)
// намеренно НЕ в PATH — скрипты находят их по абсолютным путям как фолбэк, поэтому
// установка не ломается.

// Системные env-переменные (реальные значения ОС), которые скрипты законно читают
// ($env:USERPROFILE, LOCALAPPDATA, TEMP…). PATH/PSModulePath/ComSpec сюда НЕ входят —
// их задаём авторитетно ниже.
const WIN_SYS_ENV_KEYS = [
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'APPDATA', 'PUBLIC',
  'ALLUSERSPROFILE', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432',
  'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432', 'SystemDrive',
  'SystemRoot', 'windir', 'TEMP', 'TMP', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_ARCHITEW6432',
  'PROCESSOR_IDENTIFIER', 'PROCESSOR_LEVEL', 'PROCESSOR_REVISION', 'OS', 'PATHEXT',
  'SESSIONNAME', 'LOGONSERVER', 'USERDNSDOMAIN'
];

function buildInstallEnv(rendererEnv) {
  rendererEnv = rendererEnv || {};
  if (IS_WIN) {
    const winRoot = remoteFetch.winSystemRoot() || 'C:\\Windows';   // валидирован, reparse-safe
    const drive = path.parse(winRoot).root || 'C:\\';
    const s32 = path.join(winRoot, 'System32');
    const pf = path.join(drive, 'Program Files');                   // из ВАЛИДИРОВАННОГО диска, не из env
    const pf86 = path.join(drive, 'Program Files (x86)');
    const out = {};
    for (const k of WIN_SYS_ENV_KEYS) { if (process.env[k] !== undefined) out[k] = process.env[k]; }
    // renderer-env: ИСТИННЫЙ allowlist — только HM_* установщика (кроме HM_REMOTE_CACHE),
    // регистронезависимо. Ключи резолвинга/инъекции (PATH, NODE_OPTIONS, npm_config_* …) не проходят.
    Object.assign(out, installEnv.filterRendererEnv(rendererEnv));
    // Анти-spoof: системные path-переменные (ProgramFiles/SystemRoot/…, из которых
    // Update-Path в скриптах выводит каталоги git/node) перезаписываем ВАЛИДИРОВАННЫМИ
    // значениями — иначе crafted launch-env (ProgramFiles=…\evil) → evil\Git\cmd под админом.
    Object.assign(out, installEnv.authoritativeWinSystemEnv(winRoot, drive));
    // Авторитетно (main, ПОСЛЕ renderer-env): PATH только из admin-owned каталогов.
    const dirs = [
      s32, winRoot,
      path.join(s32, 'WindowsPowerShell', 'v1.0'),
      path.join(s32, 'OpenSSH'),
      path.join(pf, 'Git', 'cmd'), path.join(pf, 'Git', 'bin'),
      path.join(pf, 'nodejs'),
      path.join(pf86, 'Git', 'cmd')
    ];
    const vroot = vendorRoot();
    if (vroot) dirs.push(path.join(vroot, 'apps'));
    const seen = new Set(); const uniq = [];
    for (const d of dirs) { const key = String(d).toLowerCase(); if (d && !seen.has(key)) { seen.add(key); uniq.push(d); } }
    const trustedPath = uniq.join(';');
    out.PATH = trustedPath; out.Path = trustedPath;
    out.ComSpec = path.join(s32, 'cmd.exe');                        // валидированный, не из env
    out.PSModulePath = [
      path.join(s32, 'WindowsPowerShell', 'v1.0', 'Modules'),
      path.join(pf, 'WindowsPowerShell', 'Modules')
    ].join(';');                                                    // только системные модули (анти-module-hijack)
    if (!out.PATHEXT) out.PATHEXT = '.COM;.EXE;.BAT;.CMD;.VBS;.JS;.WSF;.MSC;.PS1';
    return out;
  }
  // POSIX: uv-флоу неэлевейтед end-to-end (см. модель угроз). Реальный env сохраняем,
  // но из renderer-env берём тот же allowlist (только HM_*, кроме HM_REMOTE_CACHE) —
  // никаких PATH/DYLD/LD/NODE_OPTIONS/… из renderer.
  const out = Object.assign({}, process.env);
  Object.assign(out, installEnv.filterRendererEnv(rendererEnv));
  return out;
}

// Run one component script, streaming output back to the renderer.
//
// БЕЗОПАСНОСТЬ (remote-компоненты): докачка+проверка+распаковка+запуск идут
// ОДНОЙ атомарной операцией здесь, в main. Renderer НЕ может: (а) задать путь
// кэша — HM_REMOTE_CACHE из renderer безусловно вырезается и вычисляется тут из
// проверенного пути; (б) вклиниться между verify и run — второго IPC нет.
ipcMain.handle('run-component', async (_evt, payload) => {
  const { id } = payload || {};

  // m1 (defense-in-depth): renderer гасит «Установить» при vendorBlock, но MAIN —
  // единственный авторитет запуска. Заблокировано (translocation / оторванный офлайн-
  // vendor у офлайн-издания) → НЕ запускаем ни один компонент, даже если IPC как-то дошёл.
  const vb = vendorBlockInfo();
  if (vb.blocked) {
    return { id, ok: false, code: -1, error: 'офлайн-ресурсы недоступны (translocation/оторванный vendor) — установка заблокирована' };
  }

  // Allowlist check: reject unknown/traversal ids before building any path.
  if (!id || !VALID_COMPONENT_IDS.has(id)) {
    return { id, ok: false, code: -1, error: `Unknown component id: ${id}` };
  }

  // Тестер-фидбек: окно установщика уходило ЗА браузер (или теряло фокус после
  // UAC) → прогресс не виден, кажется «ничего не ставится». Поднимаем ОДИН раз за
  // эпизод ухода фокуса; дальше — мигаем в таскбаре, чтобы не вырывать окно у
  // юзера, который намеренно ушёл в браузер (M1: без 8-12 рывков за прогон).
  // Флаг сбрасывается, когда юзер сам вернулся в окно (mainWindow 'focus').
  try {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isFocused()) {
      if (!_frontedForInstall) { _frontedForInstall = true; bringToFront(); }
      else { try { mainWindow.flashFrame(true); } catch (_) {} }
    }
  } catch (_) {}

  // BUG #11 (defense-in-depth): компонент, не предназначенный для этой платформы,
  // не запускаем — даже если renderer его как-то прислал (в UI он отфильтрован).
  const meta = COMPONENT_META.get(id);
  if (meta && !componentShownOnPlatform(meta, process.platform)) {
    return { id, ok: false, code: -1, error: `Компонент «${id}» недоступен на платформе ${process.platform}.` };
  }

  const script = scriptFor(id);
  if (!fs.existsSync(script)) {
    return { id, ok: false, code: -1, error: `Script not found: ${script}` };
  }

  // env из renderer НЕ доверяем для чувствительных путей: HM_REMOTE_CACHE всегда
  // вырезаем — его задаёт ТОЛЬКО main из проверенного пути ниже (P0-2/P0-4).
  const rendererEnv = Object.assign({}, (payload && payload.env) || {});
  delete rendererEnv.HM_REMOTE_CACHE;
  // Dry-run АВТОРИТЕТНО: process.env ИЛИ renderer-подсказка. Запуск .exe с
  // HM_DRY_RUN=1 в окружении обязан быть dry-run-ом ЦЕЛИКОМ (не качаем remote,
  // не пишем лог/манифест/квитанцию) — раньше process-env игнорировался.
  const isDryRun = !!(process.env.HM_DRY_RUN || (rendererEnv && rendererEnv.HM_DRY_RUN));
  // P1-8: в dry-run НЕ пишем install.log (никаких следов на диске).
  const logLine = (line) => { if (!isDryRun) logToFile(id, line); };

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
  // P1-8: ветвление dry-run ДО download — в dry-run НИЧЕГО не скачиваем.
  let remoteCache = '';
  // win32: кэш докачки — СВЕЖИЙ Admins-only каталог, рождённый нами атомарно (ниже);
  // после установки чистим (best-effort). POSIX: '' → cleanup no-op (кэш в ~/.cache).
  let secureCacheDir = '';
  const cleanupSecureCache = () => {
    if (!secureCacheDir) return;
    try { fs.rmSync(secureCacheDir, { recursive: true, force: true }); } catch (e) { /* best-effort */ }
    secureCacheDir = '';
  };
  const { reg, compRemote } = loadRemoteMaps();
  const declared = compRemote.get(id);
  if (declared && isDryRun) {
    send('[dry-run] Докачка «' + declared + '» пропущена — ничего не скачиваем.');
  } else if (declared) {
    const entry = remoteFetch.pickEntry(reg, declared, process.platform);
    if (!entry) {
      return { id, ok: false, code: -1, stage: 'fetch', error: `Нет сборки «${declared}» для платформы ${process.platform} в реестре докачки.` };
    }
    // P0 (Codex круг 6): на win32 установщик ELEVATED — кэш докачки НЕ по предсказуемому
    // %ProgramData%\HamidunSetup\cache\<id>, а СВЕЖИЙ random-leaf каталог, рождённый
    // АТОМАРНО с owner=Administrators + DACL {SYSTEM,Administrators} (winMakeSecureDir →
    // New-HmSecureStagingDir — тот же атомарный примитив, что и de-elevation staging).
    // Users писать туда НЕ могут ПО КОНСТРУКЦИИ: medium-малварь ТОГО ЖЕ юзера не может ни
    // пред-создать <id>.zip, ни держать write-handle, ни подменить содержимое между
    // SHA-256 и распаковкой (owner/DACL-window + ZIP-TOCTOU закрыты). Пред-существующее
    // НЕ переиспользуем. fs.mkdirSync+post-icacls запрещён (окно наследования ProgramData).
    let cacheDir;
    if (IS_WIN) {
      cacheDir = winMakeSecureDir();
      if (!cacheDir) {
        return { id, ok: false, code: -1, stage: 'fetch', error: 'не удалось создать защищённый кэш докачки (owner=Administrators + DACL {SYSTEM,Administrators}) — нужны права администратора; установка remote-компонента заблокирована (fail-closed).' };
      }
      secureCacheDir = cacheDir; // чистим после установки
    } else {
      cacheDir = remoteCacheDir(declared);
    }
    logLine('=== fetch-remote start (' + declared + ') ===');
    let fr;
    try {
      fr = await remoteFetch.fetchRemote({
        entry,
        cacheDir,
        timeoutMs: 20000,
        onProgress: (p) => sendChannel('remote-progress', { id, remoteId: declared, pct: p.pct, received: p.received, total: p.total }),
        // Лог докачки идёт в ТОТ ЖЕ канал, что и вывод компонента — попадает в
        // общий лог естественно, атрибутируется по id, ничего не ломает.
        onLog: (line) => { logLine(line); send(line); }
      });
    } catch (e) {
      logLine('[ERROR] fetch-remote: ' + String(e));
      cleanupSecureCache();
      return { id, ok: false, code: -1, stage: 'fetch', error: String(e.message || e) };
    }
    logLine('=== fetch-remote result: ' + (fr && fr.ok ? ('ok ' + fr.path) : ('FAIL ' + (fr && fr.error))) + ' ===');
    if (!fr || !fr.ok) {
      cleanupSecureCache();
      return { id, ok: false, code: -1, stage: 'fetch', error: (fr && fr.error) || 'докачка не удалась' };
    }
    remoteCache = fr.path; // проверенный (sha256) распакованный путь — только из main
  }

  // #4: строгий allowlist-env (admin-owned PATH, без пользовательского PATH и без
  // подменяемых command-resolution переменных). rendererEnv уже без HM_REMOTE_CACHE.
  const childEnv = buildInstallEnv(rendererEnv);
  // P1-A: POSIX buildInstallEnv наследует process.env целиком → HM_REMOTE_CACHE из
  // окружения самого установщика мог бы протечь в компонент и запустить НЕпроверенный
  // бинарь. Стираем БЕЗУСЛОВНО здесь — ниже он ставится ТОЛЬКО из sha-проверенного
  // remoteCache (для оставшихся/будущих remote-компонентов).
  delete childEnv.HM_REMOTE_CACHE;
  // Paths to assets baked into the installer at build time (offline sources).
  const vroot = vendorRoot();
  childEnv.HM_VENDOR = vroot;
  childEnv.HM_BUNDLED_CONFIG = path.join(vroot, 'config-pack');
  childEnv.HM_AGENT_DIR = path.join(resourceRoot(), 'agent');
  childEnv.HM_NOMAD_SRC = path.join(vroot, 'nomad-src');
  childEnv.HM_ASSETS = path.join(resourceRoot(), 'assets');
  // HM_REMOTE_CACHE ставим ТОЛЬКО из проверенного пути (или не ставим вовсе).
  if (remoteCache) childEnv.HM_REMOTE_CACHE = remoteCache;
  // Dry-run авторитетно доезжает до скрипта ДО spawn (даже если пришёл из process.env,
  // а не из renderer — buildInstallEnv переносит только renderer-ключи HM_*).
  if (isDryRun) childEnv.HM_DRY_RUN = '1';

  // P0-1: режим установки конфига решает MAIN — авторитетно, живой детекцией ФС.
  // Renderer-подсказка HM_ADDITIVE игнорируется: additive, если существует ЛЮБОЙ из
  // признаков кастомизации (skills/agents/commands/rules/settings.json/credentials/
  // ~/CLAUDE.md) ИЛИ детекция не смогла отработать (fail-safe). Clean (перезапись
  // свежей базой) — ТОЛЬКО когда кастомизаций доказуемо нет, ЛИБО пользователь ЯВНО
  // включил repair И ОТДЕЛЬНО подтвердил (HM_REPAIR + HM_REPAIR_CONFIRMED).
  if (id === 'config') {
    const det = installMode.detectAdditive(os.homedir());
    const repairRequested = installMode.listHas(rendererEnv.HM_REPAIR, 'config');
    const repairConfirmed = installMode.listHas(rendererEnv.HM_REPAIR_CONFIRMED, 'config');
    const mode = installMode.decideConfigMode(det, repairRequested, repairConfirmed);
    if (mode === 'additive') {
      childEnv.HM_ADDITIVE = '1';
    } else {
      delete childEnv.HM_ADDITIVE;
    }
    const msg = '[режим конфига] ' + (mode === 'additive' ? 'АДДИТИВНЫЙ (только недостающее)' : 'чистая установка') +
      ' — ' + det.reason;
    send(msg); logLine(msg);
  }

  let cmd, args;
  if (IS_WIN) {
    // Абсолютный powershell.exe из ВАЛИДИРОВАННОГО System32 (FIX-E). Fail-closed:
    // не нашли → блокируем установку (никакого fallback в короткое имя, иначе
    // PATH-hijack воскресает; установщик elevated — это была бы эскалация).
    const ps = remoteFetch.winPowershellPath();
    if (!ps) {
      cleanupSecureCache();
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
    logLine('=== start ===');
    try {
      // macOS: give the child its own process group so killChildren can reap the
      // whole tree (msiexec/pip/curl/hdiutil) via process.kill(-pid). On Windows
      // we kill the tree via taskkill /T instead, so no detached group is needed.
      const spawnOpts = { env: childEnv, windowsHide: true };
      if (!IS_WIN) spawnOpts.detached = true;
      child = spawn(cmd, args, spawnOpts);
    } catch (e) {
      logLine('[ERROR] spawn failed: ' + String(e));
      cleanupSecureCache();
      resolve({ id, ok: false, code: -1, error: String(e) });
      return;
    }
    CHILDREN.add(child);

    // Легаси-строки "HM-RECEIPT <type> <value>" из stdout скриптов ТОЛЬКО
    // фильтруются из UI-лога. Как источник целей удаления они НЕ используются:
    // квитанция — маркер {id, version, installedAt}, а цели удаления вычисляет
    // доверенный код по зашитому аллоулисту (src/uninstall-targets.js).
    const onData = (buf) => {
      buf
        .toString()
        .split(/\r?\n/)
        .forEach((l) => {
          if (l.length) {
            const ri = receipts.parseReceiptLine(l);
            if (ri) { logLine(l); return; }
            send(l);
            logLine(l);
          }
        });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => {
      send(`[ERROR] ${e.message}`);
      logLine(`[ERROR] ${e.message}`);
    });
    child.on('close', (code) => {
      CHILDREN.delete(child);
      logLine(`=== exit code: ${code} ===`);
      const okRun = code === 0;
      // P0-1: осознанный skip компонента (нечего ставить) идёт distinct-кодом
      // (receipts.EXIT_SKIP) — НЕ ошибка, но и НЕ установка: маркер НЕ пишем.
      const skipped = receipts.isSkipExit(code);
      // Записываем версию в справочный манифест ~/.hamidun-setup/installed.json ТОЛЬКО
      // при реальном успехе (код 0) и НЕ в dry-run. Скрытый verify не пишем. Skip-код
      // и любой ненулевой код маркер НЕ пишут (иначе фантомная кнопка «Удалить» → снос
      // чужого venv/шимов при деинсталляции). Манифест справочный; grund-truth — детекция.
      if (receipts.shouldRecordInstall(code, isDryRun, !!(meta && meta.hidden))) {
        const ver = (meta && meta.version) || '';
        try {
          const src = remoteCache ? 'remote' : (vendorAvailable() ? 'bundled' : 'online');
          manifest.recordInstall(os.homedir(), id, ver, src);
        } catch (e) { logLine('[manifest] запись версии не удалась: ' + String(e)); }
        // Installed-маркер (id/version/installedAt) — только при успехе, не в dry-run,
        // не для hidden. БЕЗ artifacts-путей: цели удаления квитанция не задаёт.
        try {
          receipts.writeReceipt(os.homedir(), id, receipts.buildReceipt(id, process.platform, ver));
        } catch (e) { logLine('[receipt] запись маркера не удалась: ' + String(e)); }
      } else if (skipped && !isDryRun) {
        logLine(`=== компонент «${id}» пропущен (код ${code}, нечего ставить) — маркер/манифест НЕ записаны ===`);
      }
      // win32: удаляем СВЕЖИЙ Admins-only кэш докачки (25МБ zip+распаковка) — компонент
      // уже отработал (из кэша запущен/скопирован), больше он не нужен. Best-effort.
      cleanupSecureCache();
      // Skip — не провал: отдаём ok (как раньше отдавал exit 0), но с флагом skipped и
      // БЕЗ маркера установки. Реальный успех (код 0) → ok. Прочие коды → не ok.
      resolve({ id, ok: okRun || skipped, code, skipped });
    });
  });
});

ipcMain.handle('open-external', (_e, url) => { if (url) shell.openExternal(url); return true; });

// ---- анонимная телеметрия установки (opt-out чекбоксом на экране выбора) ----
// БЕЗ uid и ПД: только событие, платформа, исход, id упавших компонентов и
// длительность. URL берём ТОЛЬКО из вшитого config.json (renderer URL задать не
// может — иначе IPC превращается в произвольный POST-прокси), поля санитизируем
// здесь же. Fire-and-forget: таймаут 5с, ЛЮБЫЕ ошибки глотаем молча — установка
// от телеметрии не зависит ни в каком исходе.
ipcMain.handle('send-telemetry', (_e, payload) => {
  try {
    const cfg = readJson('config.json', {});
    const url = String((cfg.telemetry && cfg.telemetry.url) || '');
    if (!/^https:\/\//i.test(url)) return { ok: false }; // пустой url = выключено
    const p = (payload && typeof payload === 'object') ? payload : {};
    // failed: только компонентные id (латиница/цифры/_/-), ≤20 штук, ≤64 символа.
    const failed = Array.isArray(p.failed)
      ? p.failed.slice(0, 20).map((s) => String(s).slice(0, 64).replace(/[^A-Za-z0-9_-]/g, '-'))
      : [];
    const body = JSON.stringify({
      event: 'installed',
      platform: IS_WIN ? 'win' : 'mac',
      ok: !!p.ok,
      failed,
      // duration_sec клампим в [0, 24ч] — мусорные значения не улетают.
      duration_sec: Math.max(0, Math.min(86400, Math.round(Number(p.durationSec) || 0))),
    });
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 5000,
    }, (res) => { res.resume(); }); // ответ не важен — просто дренируем сокет
    req.on('timeout', () => { try { req.destroy(); } catch (e) { /* ignore */ } });
    req.on('error', () => { /* молча: телеметрия не должна ломать установку */ });
    req.end(body);
  } catch (e) { /* swallow — see above */ }
  return { ok: true };
});

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
      // P0-C: Cursor.exe лежит в user-writable %LOCALAPPDATA% — из elevated-процесса
      // spawn'ить его напрямую нельзя (integrity-escalation). Запускаем ДЕ-ЭЛЕВИРОВАННО
      // тем же укреплённым лаунчером, что и VS Code (см. winLaunchDeElevated).
      const startDir = path.join(os.homedir(), 'HamidunStart');
      try { fs.mkdirSync(startDir, { recursive: true }); } catch (e) { /* EEXIST — проверим ниже */ }
      try { if (!fs.statSync(startDir).isDirectory()) return false; } catch (e) { return false; }
      const cexe = path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'cursor', 'Cursor.exe');
      if (fs.existsSync(cexe)) { return winLaunchDeElevated(cexe, startDir); }
    } else if (IS_MAC) {
      spawn('/usr/bin/open', ['-a', 'Cursor'], { detached: true, stdio: 'ignore' }).unref();
      return true;
    }
  } catch (e) { /* ignore */ }
  return false;
});

// Абсолютный путь к вшитому примитиву де-элевации (_deelev.ps1) — из resourceRoot
// (packaged -> resourcesPath, dev -> корень проекта), НЕ из renderer/PATH. Тот же
// bundled-скрипт, что дот-сорсят install-скрипты (vscode.ps1/extension.ps1).
function winDeElevScript() {
  try { return path.join(resourceRoot(), 'scripts', 'windows', '_deelev.ps1'); }
  catch (e) { return null; }
}

// PRIVATE high-integrity staging-каталог под ProgramData. Используется ДВОЯКО: (а) для
// транзиентного task.xml де-элевации; (б) как СВЕЖИЙ Admins-only кэш докачки remote-
// компонента (run-component, P0 Codex круг 6) — тот же атомарный owner+DACL-примитив.
// P0 (Codex privesc regate #4): каталог РОЖДАЕТСЯ АТОМАРНО с protected DACL
// {SYSTEM, Administrators: FullControl} — ОДНОЙ операцией [System.IO.Directory]::
// CreateDirectory($dir, $sd) через УЖЕ УКРЕПЛЁННЫЙ PS-примитив New-HmSecureStagingDir
// (_deelev.ps1, тот же, что запирает staging install-пути). SD применяется В МОМЕНТ
// создания -> НЕТ окна, где каталог наследует ACL ProgramData (Users writable).
// Node fs.mkdirSync + post-icacls ЗАПРЕЩЁН: между mkdirSync и icacls medium-малварь
// ТОГО ЖЕ юзера успевала создать task.xml, ДЕРЖАТЬ write-handle и подменить XML
// (RunLevel LeastPrivilege->HighestAvailable + свой payload) ДО schtasks /Create ->
// HIGH execution. Теперь Users в каталог писать НЕ могут ПО КОНСТРУКЦИИ -> ни
// pre-creation, ни удержанного handle, ни tamper. Имя каталога — случайный GUID,
// генерируемый ВНУТРИ примитива (JS его не выбирает и не знает заранее); примитив
// fail-closed на ERROR_ALREADY_EXISTS и reparse-point и сам верифицирует владельца/ACE.
// JS перепроверяет (defense-in-depth): путь строго под ProgramData + verifyDirSecureWin.
function winMakeSecureDir() {
  try {
    const pd = remoteFetch.winProgramData();
    if (!pd || !fs.existsSync(pd)) return null;
    const ps = remoteFetch.winPowershellPath();       // абс. powershell из валидир. System32
    const icacls = remoteFetch.sysBin('icacls.exe');   // абс. icacls (примитив ставит владельца)
    const deelev = winDeElevScript();                  // абс. путь к вшитому _deelev.ps1
    if (!ps || !icacls || !deelev || !fs.existsSync(deelev)) return null;
    // Инлайн: дот-сорсим bundled-примитив и зовём АТОМАРНЫЙ конструктор secure-dir.
    // Пути — ЛИТЕРАЛАМИ (single-quoted, ''-экранирование); ни одного аргумента из
    // renderer/сети. Установщик elevated -> каталог {SYSTEM,Admins}, без user-ACE.
    const deLit = String(deelev).replace(/'/g, "''");
    const pdLit = String(pd).replace(/'/g, "''");
    const icLit = String(icacls).replace(/'/g, "''");
    const inline =
      "$ErrorActionPreference='Stop';" +
      ". '" + deLit + "';" +
      "$d=New-HmSecureStagingDir -ProgramData '" + pdLit + "' -Icacls '" + icLit + "' -Elevated $true;" +
      "if($d){[Console]::Out.Write('HMSECDIR::'+$d+'::END')}";
    let out = '';
    try {
      out = execFileSync(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', inline],
        { encoding: 'utf8', windowsHide: true, timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (e) { return null; }
    const m = /HMSECDIR::([\s\S]+?)::END/.exec(String(out || ''));
    if (!m) return null;                               // примитив вернул $null -> fail-closed
    const dir = m[1].trim();
    if (!dir) return null;
    const rm = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* */ } };
    // Defense-in-depth: путь строго под ProgramData, каталог существует, owner=Admins и
    // никаких посторонних ACE (SID-based). Примитив уже верифицировал — перепроверяем.
    const root = path.resolve(pd);
    if (!path.resolve(dir).startsWith(root + path.sep)) { rm(); return null; }
    if (!fs.existsSync(dir)) return null;
    if (!remoteFetch.verifyDirSecureWin(dir)) { rm(); return null; }   // owner=Admins, посторонних ACE нет
    return dir;
  } catch (e) { return null; }
}

// P0-D (privesc): установщик запущен ELEVATED (requestedExecutionLevel=requireAdministrator).
// Прямой spawn user-writable Code.exe/Cursor.exe (%LOCALAPPDATA%\…) исполнил бы ПОД АДМИНОМ
// (high integrity) то, что medium-integrity малварь ТОГО ЖЕ юзера могла заранее подложить
// на его место — integrity-escalation. Поэтому редактор запускаем ДЕ-ЭЛЕВИРОВАННО:
//   primary  — одноразовая scheduled task от текущего интерактивного пользователя,
//              InteractiveToken + LeastPrivilege (= medium). Задача создаётся ТОЛЬКО через
//              АБСОЛЮТНЫЙ %SystemRoot%\System32\schtasks.exe по XML (нет PS-модуля
//              ScheduledTasks -> module-hijack исключён). Тело обёртки едет ЦЕЛИКОМ в
//              -EncodedCommand (нет .ps1 в %TEMP%); транзиентный task.xml лежит в PRIVATE
//              high-integrity каталоге (winMakeSecureDir) и удаляется сразу после /Create ->
//              pre-creation/tamper XML невозможны. Обёртка ПЕРВЫМИ строками ставит чистые
//              env-ЛИТЕРАЛЫ (ни одного cmdlet до gate), сверяет integrity абсолютным
//              System32\whoami и стартует редактор ЛИШЬ при medium (иначе exit 210).
//   fallback — открыть ТОЛЬКО ПАПКУ через АБСОЛЮТНЫЙ %WINDIR%\explorer.exe (medium, токен
//              shell). Editor-exe в fallback НЕ исполняем (P0-D#4).
// P0-D#5/P1-1: true возвращаем ТОЛЬКО когда задача подтвердила gate И старт — по «Last Result»
// (БД планировщика, SYSTEM-owned, НЕ user-writable): 0 = medium прошёл И Start-Process не бросил.
// Иначе (210 refused / 211 start-fail / нет подтверждения / любой сбой) -> folder-only fallback.
// Возвращает Promise<boolean> (опрос неблокирующий — UI не морозим).
function winLaunchDeElevated(exe, folderArg) {
  const sysRoot = remoteFetch.winSystemRoot() || process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  // Fallback: открыть ПАПКУ (не exe) в explorer — medium integrity, наследует токен shell.
  const folderFallback = () => {
    try {
      const exp = path.join(sysRoot, 'explorer.exe');
      if (folderArg && fs.existsSync(exp)) {
        spawn(exp, [String(folderArg)], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
        return true;
      }
    } catch (e) { /* ignore */ }
    return false;
  };
  const done = (v) => Promise.resolve(v);

  let ps = null, schtasks = null, whoami = null;
  try {
    ps = remoteFetch.winPowershellPath();     // абсолютный powershell.exe (валидир. System32)
    schtasks = remoteFetch.sysBin('schtasks.exe');
    whoami = remoteFetch.sysBin('whoami.exe');
  } catch (e) { /* fail-closed ниже */ }
  if (!ps || !schtasks || !whoami || !fs.existsSync(ps) || !fs.existsSync(schtasks)) { return done(folderFallback()); }

  const s32 = path.join(sysRoot, 'System32');
  const tag = 'HmLaunch_' + crypto.randomBytes(6).toString('hex');
  const dir = winMakeSecureDir();
  if (!dir) { return done(folderFallback()); }        // не заперли staging -> fail-closed на папку
  const xmlFile = path.join(dir, 'task.xml');
  function runSchtasks(args) {
    try { execFileSync(schtasks, args, { windowsHide: true, timeout: 20000, stdio: 'ignore' }); return true; }
    catch (e) { return false; }
  }
  const cleanup = () => {
    try { runSchtasks(['/Delete', '/TN', tag, '/F']); } catch (e) { /* */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* */ }
  };

  // Обёртка исполняется de-elevated планировщиком. ПЕРВЫЕ строки — чистые env-ЛИТЕРАЛЫ (без
  // единого cmdlet/Join-Path до них). Integrity-self-check абсолютным System32\whoami.
  // Start-Process редактора ТОЛЬКО при medium: exit 0 старт / 211 бросок / 210 не-medium.
  // Путь папки — в ОДНОМ аргументе с вложенными кавычками (P1-2: %USERPROFILE% с пробелом не рвётся).
  const s32Lit = s32.replace(/'/g, "''");
  const srLit = sysRoot.replace(/'/g, "''");
  const whoLit = whoami.replace(/'/g, "''");
  const exeLit = String(exe).replace(/'/g, "''");
  const folderLit = String(folderArg).replace(/'/g, "''");
  const wrapperBody =
    "$env:PSModulePath='" + s32Lit + "\\WindowsPowerShell\\v1.0\\Modules'\n" +
    "$env:Path='" + s32Lit + ";" + srLit + ";" + s32Lit + "\\WindowsPowerShell\\v1.0'\n" +
    "if(@(& '" + whoLit + "' /groups 2>$null) -match 'S-1-16-8192'){\n" +
    "try{ Start-Process -FilePath '" + exeLit + "' -ArgumentList '\"" + folderLit + "\"'; exit 0 }catch{ exit 211 }\n" +
    "} else { exit 210 }\n";
  const b64 = Buffer.from(wrapperBody, 'utf16le').toString('base64');
  const wrapArgs = '-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ' + b64;

  // XML: принципал = текущий интерактивный пользователь, InteractiveToken, LeastPrivilege.
  // Тело обёртки — ЦЕЛИКОМ в <Arguments> (нет лимита 261 как у /TR command-line).
  const xmlEsc = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  const userId = (process.env.USERDOMAIN ? process.env.USERDOMAIN + '\\' : '') +
    (process.env.USERNAME || (function () { try { return os.userInfo().username; } catch (e) { return ''; } })());
  const taskXml =
    '<?xml version="1.0" encoding="UTF-16"?>\r\n' +
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">\r\n' +
    '  <RegistrationInfo><Description>Hamidun launch one-shot (de-elevated)</Description></RegistrationInfo>\r\n' +
    '  <Principals><Principal id="Author"><UserId>' + xmlEsc(userId) + '</UserId>' +
    '<LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>\r\n' +
    '  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><AllowHardTerminate>true</AllowHardTerminate>' +
    '<StartWhenAvailable>false</StartWhenAvailable><Enabled>true</Enabled><Hidden>true</Hidden>' +
    '<AllowStartOnDemand>true</AllowStartOnDemand><ExecutionTimeLimit>PT10M</ExecutionTimeLimit></Settings>\r\n' +
    '  <Actions Context="Author"><Exec><Command>' + xmlEsc(ps) + '</Command>' +
    '<Arguments>' + xmlEsc(wrapArgs) + '</Arguments></Exec></Actions>\r\n' +
    '</Task>\r\n';

  // «Last Result» задачи (поле #6 CSV /HRESULT) — локаль-независимый numeric: 267009=выполняется,
  // 267011=ещё не запускалась, иначе=exit-код обёртки. НЕ user-writable (БД планировщика).
  function readLastResult() {
    try {
      const out = execFileSync(schtasks, ['/Query', '/TN', tag, '/HRESULT', '/FO', 'CSV', '/NH', '/V'],
        { encoding: 'utf8', windowsHide: true, timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] });
      const line = String(out || '').split(/\r?\n/).find((l) => l.indexOf('"') !== -1);
      if (!line) return null;
      const fields = []; const re = /"([^"]*)"/g; let m;
      while ((m = re.exec(line)) !== null) fields.push(m[1]);   // base64 без кавычек -> поля надёжны
      return fields.length > 6 ? fields[6] : null;
    } catch (e) { return null; }
  }

  try {
    fs.writeFileSync(xmlFile, '\uFEFF' + taskXml, 'ucs2');   // UTF-16LE + BOM (schtasks /XML)
  } catch (e) { cleanup(); return done(folderFallback()); }

  if (!runSchtasks(['/Create', '/TN', tag, '/XML', xmlFile, '/F'])) { cleanup(); return done(folderFallback()); }
  try { fs.unlinkSync(xmlFile); } catch (e) { /* определение задачи уже в БД планировщика */ }
  if (!runSchtasks(['/Run', '/TN', tag])) { cleanup(); return done(folderFallback()); }

  // Неблокирующий опрос «Last Result» (Start-Process быстр -> обычно ~1-2с; крайний срок 30с).
  return new Promise((resolve) => {
    const deadline = Date.now() + 30000;
    const poll = () => {
      const lr = readLastResult();
      if (lr !== null && lr !== '267009' && lr !== '267011') {
        cleanup();
        return resolve(lr === '0' ? true : folderFallback());   // 0 = gate прошёл И старт; иначе папка
      }
      if (Date.now() > deadline) { cleanup(); return resolve(folderFallback()); }
      setTimeout(poll, 400);
    };
    setTimeout(poll, 400);
  });
}

// Открыть VS Code НА ПАПКЕ проекта (IDE-режим), а не в агент-чате: аналог `code "<папка>"`.
// Папка ~/HamidunStart создаётся, если её нет, чтобы VS Code открыл реальный воркспейс
// (пустой проект), а не безымянное окно. НАМЕРЕННО без URI вида vscode://…/open — тот
// открыл бы панель-агент, а задача — показать новичку файлы проека (IDE).
// Open a folder in VS Code (de-elevated on Windows; `open -a` on macOS). Shared
// by the default finish button (HamidunStart sandbox) and the explicit course
// launcher below.
function launchVsCodeOn(dir, { create = true } = {}) {
  try {
    if (create) {
      // P2: не глушим mkdir вслепую. Если путь занят обычным ФАЙЛОМ (или каталог не создать),
      // редактор получил бы путь к файлу/несуществующему — подтверждаем, что это директория.
      try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* EEXIST — проверим ниже */ }
    }
    try { if (!fs.statSync(dir).isDirectory()) return false; } catch (e) { return false; }
    if (IS_WIN) {
      const codeExe = firstExisting([
        path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Microsoft VS Code', 'Code.exe'),
        path.join(winPF(), 'Microsoft VS Code', 'Code.exe')
      ]);
      // P0: НЕ spawn напрямую (elevated) — де-элевируем запуск (см. winLaunchDeElevated).
      if (codeExe) { return winLaunchDeElevated(codeExe, dir); }
    } else if (IS_MAC) {
      // open -a "Visual Studio Code" "<папка>" — открывает папку в IDE. `open` запускает
      // цель от имени пользователя (macOS не эскалирует integrity как Windows).
      spawn('/usr/bin/open', ['-a', 'Visual Studio Code', dir], { detached: true, stdio: 'ignore' }).unref();
      return true;
    }
  } catch (e) { /* ignore */ }
  return false;
}

ipcMain.handle('launch-vscode', () => launchVsCodeOn(path.join(os.homedir(), 'HamidunStart')));

// Explicit «open the course-simulator» — NOT auto-opened; the finish screen
// offers it as a labelled choice. Opens the course folder in VS Code so Claude
// Code picks up the mentor CLAUDE.md; the user then types «начать» to activate
// the course-driver. Only if the course actually installed (folder exists) —
// we never create an empty course dir.
ipcMain.handle('launch-course', () => {
  const cfg = readJson('config.json', {});
  const raw = (cfg.course && cfg.course.targetDirDefault) || '';
  // resolveCourseTarget зеркалит course.ps1/course.sh: expand %USERPROFILE% на Win,
  // защита от Windows-пути на macOS (иначе `/Users/x\HamidunCourse` — папки нет, B1).
  const target = uninstallTargets.resolveCourseTarget(raw, os.homedir(), process.platform);
  // Курс распаковывается в <target>/vibecoding-course/ — именно там CLAUDE.md
  // наставника (course.ps1:87). Открываем ЕЁ, а не родителя, иначе «начать»
  // подхватит ванильный Claude без наставника (B2). CLAUDE.md — финальный признак.
  const dir = path.join(target, 'vibecoding-course');
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
    if (!fs.existsSync(path.join(dir, 'CLAUDE.md'))) return false;
  } catch (e) { return false; }
  return launchVsCodeOn(dir, { create: false });
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
    // BUG #12: npm применяет ПОСЛЕДНИЙ совпавший ключ, не первый — итерируем все
    // `prefix=` и берём последнее значение. И раскрываем ${VAR} (семантика npmrc),
    // а НЕ %VAR% (это не синтаксис npm — npm его не раскрывает; best-effort).
    let val = '';
    const re = /^[ \t]*prefix[ \t]*=[ \t]*(.+?)[ \t]*$/gim;
    let mm;
    while ((mm = re.exec(rc)) !== null) { val = mm[1]; }
    if (!val) return '';
    val = val.replace(/^["']|["']$/g, '').trim();
    val = val.replace(/\$\{([^}]+)\}/g, (whole, name) => {
      const v = process.env[name];
      return v !== undefined ? v : whole;
    });
    return val;
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
      // #6: fail-closed — БЕЗ fallback в короткое имя 'cmd.exe' (иначе PATH-резолв
      // короткого имени под нашим токеном воскрешает hijack). System32 не валиден →
      // не открываем терминал (return false), не резолвим короткое имя по PATH.
      const cmdExe = remoteFetch.sysBin('cmd.exe');
      if (!cmdExe) return false;
      // `start "Claude Code" cmd /k claude` — a new console window that stays
      // open; it inherits the fresh PATH from this spawn's env.
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

// ---- Фаза 2: детекция состояния компонентов (ГРУНД-ТРУТ) --------------
// «Установлен ли X?» решаем ЖИВОЙ проверкой (fs.existsSync / запуск бинаря),
// НИКОГДА не манифестом. Манифест даёт лишь версию для показа/сравнения обновлений.
// Кросс-платформенно (win + mac). Read-only: ничего не пишет, безопасно в dry-run.

// Windows Program Files из env — только для ЧТЕНИЯ путей детекции (не elevated exec),
// поэтому spoofing здесь безвреден (в отличие от buildInstallEnv, где значения строгие).
function winPF() { return process.env.ProgramFiles || 'C:\\Program Files'; }
function winPF86() { return process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'; }
function winLocalAppData() { return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'); }

// Ищем исполняемый файл: известные абсолютные каталоги, затем свежий PATH (перечитан
// из реестра на Windows) / POSIX-каталоги. Возвращает путь или ''.
function resolveExecutable(names, extraDirs) {
  const dirs = [];
  (extraDirs || []).forEach((d) => { if (d) dirs.push(d); });
  if (IS_WIN) {
    freshWindowsPath().split(';').forEach((d) => { const t = d.trim(); if (t) dirs.push(t); });
  } else {
    ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin',
      path.join(os.homedir(), '.local', 'bin'), path.join(os.homedir(), '.cargo', 'bin')]
      .forEach((d) => dirs.push(d));
    (process.env.PATH || '').split(':').forEach((d) => { const t = d.trim(); if (t) dirs.push(t); });
  }
  for (const d of dirs) {
    for (const n of names) {
      try { const p = path.join(d, n); if (fs.existsSync(p)) return p; } catch (e) { /* ignore */ }
    }
  }
  return '';
}

// Запускает bin с args и достаёт версию regex'ом (1-я группа). Ошибка/таймаут → ''.
function probeVersion(bin, args, re) {
  if (!bin) return '';
  try {
    const out = execFileSync(bin, args, {
      encoding: 'utf8', windowsHide: true, timeout: 6000, stdio: ['ignore', 'pipe', 'ignore']
    });
    const m = String(out || '').match(re);
    if (m) return (m[1] || m[0]).trim();
    return out ? String(out).trim().split(/\r?\n/)[0] : '';
  } catch (e) { return ''; }
}

function firstExisting(paths) {
  for (const p of (paths || [])) { try { if (p && fs.existsSync(p)) return p; } catch (e) { /* ignore */ } }
  return '';
}

// Каталог расширения установлен в dir: есть ПОДКАТАЛОГ вида "<extId>-<версия>".
// Точный префикс `${extId}-` + ЦИФРА версии (ordinal case-insensitive) + ОБЯЗАТЕЛЬНО
// Dirent.isDirectory(): иначе `anthropic.claude-code-helper-1.0` даёт ложный PASS (он тоже
// начинается с `anthropic.claude-code-`), а обычный ФАЙЛ не должен считаться расширением.
// Суффикс платформы `-win32-x64` (после `-<ver>`) продолжает проходить.
function dirHasChildStarting(dir, extId) {
  try {
    const rx = new RegExp('^' + String(extId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-\\d', 'i');
    return fs.readdirSync(dir, { withFileTypes: true })
      .some((d) => d.isDirectory() && rx.test(d.name));
  } catch (e) { return false; }
}

// Расширение (по точному id-префиксу) установлено ИМЕННО в VS Code (папки .vscode /
// .vscode-oss), а НЕ в Cursor. Нужен для «полного» детекта VS Code-бандла.
function vsCodeHasExt(home, extId) {
  return [path.join(home, '.vscode', 'extensions'),
          path.join(home, '.vscode-oss', 'extensions')]
    .some((d) => dirHasChildStarting(d, extId));
}

// Поиск claude-бинаря (зеркало логики claude.ps1 / verify.ps1, но в Node).
function findClaudeBinary() {
  const home = os.homedir();
  if (IS_WIN) {
    const prefix = npmPrefixFromRc() || path.join(home, 'AppData', 'Roaming', 'npm');
    const cands = [
      path.join(prefix, 'claude.cmd'), path.join(prefix, 'claude.exe'), path.join(prefix, 'claude'),
      path.join(home, '.local', 'bin', 'claude.exe'), path.join(home, '.local', 'bin', 'claude.cmd')
    ];
    return firstExisting(cands);
  }
  const prefix = npmPrefixFromRc();
  const cands = [
    path.join(home, '.local', 'bin', 'claude'),
    prefix ? path.join(prefix, 'bin', 'claude') : '',
    '/usr/local/bin/claude', '/opt/homebrew/bin/claude'
  ];
  return firstExisting(cands);
}

// Детектор на компонент: { installed:bool, detectedVersion:string }.
function detectComponents() {
  const home = os.homedir();
  const claudeHome = path.join(home, '.claude');
  const out = {};

  // git
  {
    const bin = resolveExecutable(IS_WIN ? ['git.exe'] : ['git'],
      IS_WIN ? [path.join(winPF(), 'Git', 'cmd'), path.join(winPF(), 'Git', 'bin'), path.join(winPF86(), 'Git', 'cmd')] : []);
    const v = probeVersion(bin, ['--version'], /(\d+\.\d+(?:\.\d+)?)/);
    out.git = { installed: !!(bin && v), detectedVersion: v };
  }
  // node
  {
    const bin = resolveExecutable(IS_WIN ? ['node.exe'] : ['node'],
      IS_WIN ? [path.join(winPF(), 'nodejs')] : []);
    const v = probeVersion(bin, ['-v'], /v?(\d+\.\d+\.\d+)/);
    out.node = { installed: !!(bin && v), detectedVersion: v };
  }
  // cursor (приложение)
  {
    const p = IS_WIN
      ? firstExisting([path.join(winLocalAppData(), 'Programs', 'cursor', 'Cursor.exe'),
                       path.join(winPF(), 'cursor', 'Cursor.exe')])
      : firstExisting(['/Applications/Cursor.app', path.join(home, 'Applications', 'Cursor.app')]);
    out.cursor = { installed: !!p, detectedVersion: '' };
  }
  // vscode (полный бандл: приложение + ОБА расширения) — рекомендуемый редактор.
  // P1: «установлен» (и авто-снятие галки) ТОЛЬКО когда есть И приложение, И оба
  // расширения (Claude + Codex) ИМЕННО в VS Code. Иначе НЕ снимаем — vscode.ps1/sh
  // единственный доставщик Codex, и он до-ставит недостающее даже при уже
  // предустановленном VS Code (сценарий «VS Code есть, Codex нет» больше не молчит).
  {
    const appPresent = IS_WIN
      ? firstExisting([path.join(winLocalAppData(), 'Programs', 'Microsoft VS Code', 'Code.exe'),
                       path.join(winPF(), 'Microsoft VS Code', 'Code.exe')])
      : firstExisting(['/Applications/Visual Studio Code.app', path.join(home, 'Applications', 'Visual Studio Code.app')]);
    const claudeExtId = (readJson('config.json', {}).claudeCodeExtensionId) || 'anthropic.claude-code';
    const bothExts = vsCodeHasExt(home, claudeExtId) && vsCodeHasExt(home, 'openai.chatgpt');
    out.vscode = { installed: !!appPresent && bothExts, detectedVersion: '' };
  }
  // claude CLI
  {
    const bin = findClaudeBinary();
    out.claude = { installed: !!bin, detectedVersion: '' };
  }
  // extension (папка расширения в Cursor/VS Code)
  {
    const extId = (readJson('config.json', {}).claudeCodeExtensionId) || 'anthropic.claude-code';
    const extDirs = [
      path.join(home, '.cursor', 'extensions'),
      path.join(home, '.vscode', 'extensions'),
      path.join(home, '.vscode-oss', 'extensions')
    ];
    const found = extDirs.some((d) => dirHasChildStarting(d, extId));
    out.extension = { installed: found, detectedVersion: '' };
  }
  // config (~/.claude развёрнут)
  {
    const found = firstExisting([path.join(claudeHome, 'skills'), path.join(claudeHome, 'settings.json')]);
    out.config = { installed: !!found, detectedVersion: '' };
  }
  // pydeps (best-effort: python + представительный пакет). Ложно-негатив безвреден —
  // переустановка pydeps идемпотентна; ложно-позитив лишь снимает галку по умолчанию.
  {
    const py = resolveExecutable(IS_WIN ? ['python.exe', 'python3.exe'] : ['python3', 'python'],
      IS_WIN ? [path.join(winLocalAppData(), 'Programs', 'Python', 'Python313'),
                path.join(winLocalAppData(), 'Programs', 'Python', 'Python312')] : []);
    let found = false;
    if (py) {
      try {
        execFileSync(py, ['-c', 'import PIL, requests'],
          { windowsHide: true, timeout: 6000, stdio: 'ignore' });
        found = true;
      } catch (e) { found = false; }
    }
    out.pydeps = { installed: found, detectedVersion: '' };
  }
  // course (папка курса)
  {
    const target = process.env.HM_COURSE_TARGET
      ? process.env.HM_COURSE_TARGET.replace(/%USERPROFILE%/gi, home)
      : path.join(home, 'HamidunCourse');
    const cd = path.join(target, 'vibecoding-course');
    const found = firstExisting([path.join(cd, 'CLAUDE.md'),
      path.join(cd, '.claude', 'skills', 'course-driver', 'SKILL.md')]);
    out.course = { installed: !!found, detectedVersion: '' };
  }
  // nomad — наш агент: шимы nmd/nomad-agent/nomad-acp (их кладёт `uv tool install` в
  // ~/.local/bin, см. scripts/*/nomad.*) либо каталог uv-тула nomad-agent, либо
  // легаси-клон исходников. Голое имя `nomad`/`nomad.exe` НЕ детектим — это HashiCorp
  // Nomad (ложный позитив снимал бы галку компонента и врал «уже установлен»).
  {
    const shimDir = path.join(home, '.local', 'bin');
    const bin = resolveExecutable(
      IS_WIN ? ['nmd.exe', 'nmd', 'nomad-agent.exe', 'nomad-agent', 'nomad-acp.exe', 'nomad-acp']
             : ['nmd', 'nomad-agent', 'nomad-acp'],
      [shimDir]);
    // P1-4: uv-тул называется по pyproject [project].name = nomad-agent.
    const uvTools = IS_WIN
      ? firstExisting([
          path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'uv', 'tools', 'nomad-agent'),
          path.join(home, '.local', 'share', 'uv', 'tools', 'nomad-agent')
        ])
      : firstExisting([path.join(home, '.local', 'share', 'uv', 'tools', 'nomad-agent')]);
    const src = IS_WIN
      ? firstExisting([path.join(winLocalAppData(), 'nomad-src', 'pyproject.toml')])
      : firstExisting([path.join(home, '.nomad-src', 'pyproject.toml')]);
    out.nomad = { installed: !!(bin || uvTools || src), detectedVersion: '' };
  }
  // uv
  {
    const p = IS_WIN
      ? firstExisting([path.join(winLocalAppData(), 'Programs', 'uv', 'uv.exe')]) || resolveExecutable(['uv.exe'], [])
      : firstExisting([path.join(home, '.local', 'bin', 'uv')]) || resolveExecutable(['uv'], []);
    const v = p ? probeVersion(p, ['--version'], /(\d+\.\d+\.\d+)/) : '';
    out.uv = { installed: !!p, detectedVersion: v };
  }
  // bridge (агент моста)
  {
    const p = IS_WIN
      ? firstExisting([path.join(winLocalAppData(), 'HamidunBridge', 'bridge_agent.py')])
      : firstExisting([path.join(home, 'Library', 'Application Support', 'HamidunBridge', 'bridge_agent.py')]);
    out.bridge = { installed: !!p, detectedVersion: '' };
  }
  // mascot (скрепка)
  {
    let found = '';
    if (IS_WIN) {
      found = firstExisting([path.join(winLocalAppData(), 'Programs', 'ClaudeMascot'),
        path.join(home, '.claude-mascot', '.installed')]);
    } else {
      const appsDir = path.join(home, 'Applications');
      found = dirHasChildStarting(appsDir, 'Claude') && (function () {
        try {
          return fs.readdirSync(appsDir).some((n) => /mascot|claude/i.test(n) && /\.app$/i.test(n));
        } catch (e) { return false; }
      })() ? appsDir : '';
    }
    out.mascot = { installed: !!found, detectedVersion: '' };
  }
  // claude-desktop (нативное приложение Anthropic) — идемпотентность (детект пути).
  {
    let found = '';
    if (IS_WIN) {
      const la = winLocalAppData();
      found = firstExisting([
        path.join(la, 'AnthropicClaude', 'claude.exe'),
        path.join(la, 'Microsoft', 'WindowsApps', 'claude.exe')
      ]) || (dirHasChildStarting(path.join(la, 'AnthropicClaude'), 'app-') ? path.join(la, 'AnthropicClaude') : '')
        || (dirHasChildStarting(path.join(la, 'Packages'), 'Claude') ? path.join(la, 'Packages') : '');
    } else {
      found = firstExisting(['/Applications/Claude.app', path.join(home, 'Applications', 'Claude.app')]);
    }
    out['claude-desktop'] = { installed: !!found, detectedVersion: '' };
  }
  // chatgpt-desktop (нативное приложение OpenAI) — идемпотентность (детект пути).
  {
    let found = '';
    if (IS_WIN) {
      // MSIX/Store-пакет: каталог данных в %LOCALAPPDATA%\Packages\<ChatGPT|OpenAI…>.
      const pkgs = path.join(winLocalAppData(), 'Packages');
      found = (dirHasChildStarting(pkgs, 'ChatGPT') || dirHasChildStarting(pkgs, 'OpenAI')) ? pkgs : '';
    } else {
      found = firstExisting(['/Applications/ChatGPT.app', path.join(home, 'Applications', 'ChatGPT.app')]);
    }
    out['chatgpt-desktop'] = { installed: !!found, detectedVersion: '' };
  }

  return out;
}

// Состояние всех (не скрытых) компонентов: installed (ground-truth) + версии.
ipcMain.handle('detect-state', () => {
  try {
    const home = os.homedir();
    const man = manifest.readManifest(home);
    const det = detectComponents();
    const state = {};
    for (const [id, comp] of COMPONENT_META) {
      if (comp && comp.hidden) continue;
      if (!componentShownOnPlatform(comp, process.platform)) continue;
      const d = det[id] || { installed: false, detectedVersion: '' };
      const mEntry = (man.components && man.components[id]) || null;
      const installedVersion = mEntry ? (mEntry.version || '') : '';
      const currentVersion = (comp && comp.version) || '';
      state[id] = {
        installed: !!d.installed,
        detectedVersion: d.detectedVersion || '',
        installedVersion: installedVersion || null,
        currentVersion: currentVersion,
        // Обновление доступно = детекция подтвердила установку И записанная версия
        // строго старше текущей из components.json.
        updateAvailable: !!d.installed && manifest.isOutdated(installedVersion, currentVersion),
        // P0-4: есть ли квитанция владения — UI предлагает «Удалить» ТОЛЬКО для
        // installer-owned компонентов (а не для всего, что «обнаружено на диске»).
        receipted: receipts.hasReceipt(home, id)
      };
    }
    return { ok: true, state, manifestPath: manifest.manifestPath(home) };
  } catch (e) {
    return { ok: false, error: String(e), state: {} };
  }
});

// ---- Фаза 2: деинсталлятор (переделка) ---------------------------------
// ЦЕЛИ удаления вычисляет ТОЛЬКО доверенный код по зашитому per-component
// аллоулисту (src/uninstall-targets.js) из ИЗВЕСТНЫХ мест установки. Квитанция в
// user-writable ~/.hamidun-setup — лишь маркер «мы это ставили» (гейт кнопки/операции);
// её содержимое НЕ управляет тем, ЧТО удалять. ВСЁ удаление выполняется здесь,
// в JS main-процесса (uninstall-exec с guard-ом на КАЖДОЙ цели) — uninstall-скриптов
// и транспорта целей через env больше нет. Пользовательские данные (~/.claude,
// credentials, memory, projects, прогресс курса, config моста) — священны:
// guard fail-closed, в сомнении НЕ удаляем.

// P1-7: reg.exe запрос значения с ТИПОМ (raw, без раскрытия %VAR% — reg query
// отдаёт REG_EXPAND_SZ неразвёрнутым). Tri-state (uninstall-exec.classifyRegQuery):
//   { ok:true, found:true, type, data } | { ok:true, found:false } | { ok:false, error }.
// «Нет значения» НЕ смешивается с ошибкой запуска/кода/парсера — любая ошибка у
// вызывающих обязана дать failed (fail-closed), а НЕ absent.
function regQueryValueTyped(keyPath, valueName) {
  const reg = remoteFetch.sysBin('reg.exe');
  if (!reg) return { ok: false, error: 'reg.exe не найден в System32 (fail-closed)' };
  const r = spawnSync(reg, ['query', keyPath, '/v', valueName],
    { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  return uninstallExec.classifyRegQuery(valueName, r);
}

// Разрешённые HKCU-ключи для удаления значений — ТОЛЬКО автозапуск Run.
const WIN_REG_ALLOWED_KEYS = new Set(['software\\microsoft\\windows\\currentversion\\run']);

// Удалить ТОЧНОЕ значение HKCU-реестра из аллоулиста. Несовпадение с аллоулистом →
// отказ всей операции (fail-closed).
function winRegDeleteValue(t) {
  if (!t || t.hive !== 'HKCU' || !t.key || !t.value) return { status: 'failed', message: 'ЗАЩИТА: некорректная reg-цель' };
  if (!WIN_REG_ALLOWED_KEYS.has(String(t.key).toLowerCase())) {
    return { status: 'failed', message: 'ЗАЩИТА: ключ реестра вне аллоулиста: ' + t.key };
  }
  const reg = remoteFetch.sysBin('reg.exe');
  if (!reg) return { status: 'failed', message: 'reg.exe не найден в System32 (fail-closed)' };
  const keyPath = 'HKCU\\' + t.key;
  // P1-7: tri-state — ошибка чтения/парсинга ≠ «значения нет» (та давала бы absent
  // и ложный успех). Любая ошибка → failed.
  const q0 = regQueryValueTyped(keyPath, t.value);
  if (!q0.ok) return { status: 'failed', message: 'reg query: ' + q0.error };
  if (!q0.found) return { status: 'absent', message: 'значения нет' };
  try {
    execFileSync(reg, ['delete', keyPath, '/v', t.value, '/f'], { windowsHide: true, stdio: 'ignore' });
  } catch (e) {
    return { status: 'failed', message: 'reg delete: ' + String((e && e.message) || e) };
  }
  const q1 = regQueryValueTyped(keyPath, t.value);
  if (!q1.ok) return { status: 'failed', message: 'верификация reg: ' + q1.error };
  if (q1.found) return { status: 'failed', message: 'значение реестра осталось' };
  return { status: 'removed', message: 'реестр: ' + keyPath + ' → ' + t.value };
}

// Убрать ТОЧНУЮ запись из пользовательского PATH (HKCU\Environment), сохранив
// тип значения (REG_SZ/REG_EXPAND_SZ) и НЕ раскрывая %VAR% чужих записей.
// P0-5: pathentry идёт через ТОТ ЖЕ fail-closed guard, что и файловые цели
// (reparse/junction в каталоге-цели или предках → отказ), и запись убирается
// ТОЛЬКО когда целевой каталог реально ОТСУТСТВУЕТ (после удаления наших файлов
// emptydir его снёс; junction/подмена/чужие файлы → запись остаётся).
function winRemoveUserPathEntry(t, guardOpts) {
  const dir = t && t.dir;
  if (!dir) return { status: 'failed', message: 'ЗАЩИТА: пустая pathentry-цель' };
  const g = uninstallExec.checkTarget(dir, guardOpts);
  if (!g.ok) return { status: 'failed', message: 'ЗАЩИТА: ' + g.reason };
  try {
    fs.lstatSync(g.norm);
    return { status: 'kept', message: 'каталог ' + dir + ' ещё существует — запись PATH оставлена' };
  } catch (e) {
    if (!(e && (e.code === 'ENOENT' || e.code === 'ENOTDIR'))) {
      return { status: 'failed', message: 'проверка каталога PATH-записи: ' + String((e && e.code) || e) };
    }
  }
  const reg = remoteFetch.sysBin('reg.exe');
  if (!reg) return { status: 'failed', message: 'reg.exe не найден в System32 (fail-closed)' };
  // P1-7: tri-state — ошибка чтения PATH ≠ «PATH нет» (иначе ложный absent).
  const cur = regQueryValueTyped('HKCU\\Environment', 'Path');
  if (!cur.ok) return { status: 'failed', message: 'чтение PATH: ' + cur.error };
  if (!cur.found) return { status: 'absent', message: 'пользовательского PATH нет' };
  const upd = uninstallExec.computeUserPathWithout(cur.data, dir);
  if (!upd.changed) return { status: 'absent', message: 'записи в PATH нет' };
  try {
    execFileSync(reg, ['add', 'HKCU\\Environment', '/v', 'Path', '/t', cur.type, '/d', upd.value, '/f'],
      { windowsHide: true, stdio: 'ignore' });
  } catch (e) {
    return { status: 'failed', message: 'запись PATH: ' + String((e && e.message) || e) };
  }
  const after = regQueryValueTyped('HKCU\\Environment', 'Path');
  if (!after.ok || !after.found || after.data !== upd.value) {
    // Верификация не сошлась — пробуем вернуть исходное значение (не теряем PATH).
    try { execFileSync(reg, ['add', 'HKCU\\Environment', '/v', 'Path', '/t', cur.type, '/d', cur.data, '/f'], { windowsHide: true, stdio: 'ignore' }); } catch (e) { /* лучшее из возможного */ }
    return { status: 'failed', message: 'PATH после записи не совпал с ожидаемым — вернул исходный' };
  }
  return { status: 'removed', message: 'убрал «' + dir + '» из пользовательского PATH' };
}

// macOS: CFBundleIdentifier бандла (пусто при сбое → вызывающий отказывает).
function macBundleIdOf(appPath) {
  try {
    return execFileSync('/usr/libexec/PlistBuddy',
      ['-c', 'Print :CFBundleIdentifier', path.join(appPath, 'Contents', 'Info.plist')],
      { encoding: 'utf8', timeout: 10000 }).trim();
  } catch (e) { return ''; }
}
// macOS: TeamIdentifier подписи бандла (пусто при сбое/adhoc).
// P1-2: codesign -dv пишет диагностику (вкл. TeamIdentifier=) в STDERR при
// УСПЕХЕ (exit 0) — stdout пуст. Берём spawnSync и парсим stdout+stderr вместе,
// иначе валидный маскот получает пустой TeamID и .app никогда не удаляется.
function macTeamIdOf(appPath) {
  try {
    const r = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', appPath],
      { encoding: 'utf8', timeout: 20000 });
    if (r.error) return '';
    const both = String(r.stdout || '') + '\n' + String(r.stderr || '');
    const m = both.match(/^TeamIdentifier=(.+)$/m);
    const team = m ? m[1].trim() : '';
    // adhoc-подпись даёт «TeamIdentifier=not set» — это НЕ идентичность.
    return team && team.toLowerCase() !== 'not set' ? team : '';
  } catch (e) { return ''; }
}

// macOS: доверенная информация о .app скрепки из ВШИТОГО vendor (не user-writable).
function resolveMascotVendorApp() {
  try {
    const dir = path.join(vendorRoot(), 'apps', 'claude-mascot');
    const names = fs.readdirSync(dir).filter((n) => /\.app$/i.test(n));
    for (const n of names) {
      const p = path.join(dir, n);
      try { if (fs.statSync(p).isDirectory()) return { appName: n, bundleId: macBundleIdOf(p) }; }
      catch (e) { /* следующий кандидат */ }
    }
  } catch (e) { /* vendor недоступен */ }
  return null;
}

// Контекст вычисления целей — ТОЛЬКО доверенные источники: homedir, вшитый
// config.json, vendor. Никаких значений из renderer-env.
function buildUninstallCtx() {
  const cfg = readJson('config.json', {});
  let desktop = '';
  try { desktop = app.getPath('desktop'); } catch (e) { desktop = path.join(os.homedir(), 'Desktop'); }
  return {
    platform: process.platform,
    home: os.homedir(),
    desktop,
    courseTargetRaw: (cfg.course && cfg.course.targetDirDefault) || '',
    courseShortcut: (cfg.course && cfg.course.shortcutName) || 'Курс вайбкодинг (Claude Code)',
    // P1-4: доверенное имя пакета uv-тула nomad из вшитого config.json
    // (pyproject [project].name); гигиена и дефолт — в uninstall-targets.
    nomadTool: (cfg.nomad && cfg.nomad.packageName) || '',
    mascotMac: IS_MAC ? resolveMascotVendorApp() : null
  };
}

// P0-2: findUvBinary/`uv tool uninstall` из деинсталлятора УДАЛЕНЫ. На Windows
// main работает elevated (requireAdministrator), а ~/.local/bin/uv.exe —
// user-writable: запуск подменённого бинаря под elevated-токеном = admin RCE.
// Инвентарь uv-тула (venv + шимы) деинсталлятор удаляет напрямую точными
// file/dirtree-целями через guard — uv для этого не нужен.

// Человекочитаемое описание цели (для dry-run и лога).
function describeTarget(t) {
  switch (t.type) {
    case 'file': return 'файл ' + t.path;
    case 'dirtree': return 'дерево ' + t.path + (t.why ? ' (' + t.why + ')' : '');
    case 'emptydir': return 'каталог (если пуст) ' + t.path;
    case 'reg': return 'реестр HKCU\\' + t.key + ' → ' + t.value;
    case 'pathentry': return 'запись PATH ' + t.dir + ' (только если каталог исчез)';
    case 'profileline': return 'точная строка «' + t.line + '» из ' + t.file;
    case 'launchagent': return 'LaunchAgent ' + t.label + ' (' + t.plist + ')';
    case 'appbundle': return '.app ' + t.path + ' (при совпадении идентичности)';
    case 'killproc': return 'остановка процесса ' + (t.image || t.pattern);
    default: return JSON.stringify(t);
  }
}

// Исполнить одну цель. guardOpts прокидывается в uninstall-exec (fail-closed guard).
function executeUninstallTarget(t, guardOpts) {
  switch (t.type) {
    case 'file':
      // P0-1: gated shim — удаляем ТОЛЬКО при подтверждённом нашем ownership-маркере
      // (наш venv), иначе файл не наш (собственный uv-tool пользователя) → kept.
      if (t.onlyIfOwnerMarker) return uninstallExec.removeFileGated(t.path, guardOpts, t.onlyIfOwnerMarker);
      return uninstallExec.removeFile(t.path, guardOpts);
    case 'emptydir': return uninstallExec.removeEmptyDir(t.path, guardOpts);
    case 'dirtree': {
      // P0-3: gated dirtree (onlyIfContains-маркер) → quarantine-then-guard: атомарный
      // захват проверенной цели в карантин В ТОМ ЖЕ родителе, затем no-follow проверка
      // маркера на ЗАХВАЧЕННОМ каталоге. Нет TOCTOU-окна между проверкой маркера и
      // удалением: маркера нет → каталог возвращается на место (не удаляется).
      if (t.onlyIfContains) return uninstallExec.removeDirTreeGated(t.path, guardOpts, t.onlyIfContains);
      return uninstallExec.removeDirTree(t.path, guardOpts);
    }
    case 'profileline': return uninstallExec.removeProfileLine(t.file, t.line, guardOpts);
    case 'launchagent': {
      if (!IS_MAC) return { status: 'failed', message: 'launchagent вне macOS' };
      // P1-3: guard plist ПЕРВЫМ — для подозрительной цели launchctl не дёргаем.
      const g = uninstallExec.checkTarget(t.plist, guardOpts);
      if (!g.ok) return { status: 'failed', message: 'ЗАЩИТА: ' + g.reason };
      if (!uninstallExec.valueHygieneOk(t.label) || !/^[A-Za-z0-9._-]+$/.test(t.label)) {
        return { status: 'failed', message: 'ЗАЩИТА: некорректный label LaunchAgent' };
      }
      const run = (args) => spawnSync('/bin/launchctl', args, { encoding: 'utf8', timeout: 20000 });
      // unload/remove: «не загружен» — норма; РЕАЛЬНУЮ ошибку не проглатываем,
      // а фиксируем и сверяем с фактом ниже.
      const errs = [];
      let plistExists = false;
      try { plistExists = fs.existsSync(g.norm); } catch (e) { plistExists = false; }
      if (plistExists) {
        const r1 = run(['unload', g.norm]);
        if (r1.error) errs.push('unload: ' + String(r1.error.message || r1.error));
        else if (r1.status !== 0 && !/not (currently )?loaded|could not find|no such/i.test(String(r1.stderr || '') + String(r1.stdout || ''))) {
          errs.push('unload: код ' + r1.status);
        }
      }
      // P1: ненулевой `launchctl remove` НЕ игнорируем — бенайн («не загружен»)
      // отсеивает launchctlRemoveError, реальную ошибку фиксирует в errs.
      const r2 = run(['remove', t.label]);
      const remErr = uninstallExec.launchctlRemoveError(r2);
      if (remErr) errs.push(remErr);
      // Авторитетная проверка ФАКТА: job с нашим label не должен существовать.
      const uid = (typeof process.getuid === 'function') ? process.getuid() : null;
      if (uid == null) return { status: 'failed', message: 'нет uid для launchctl print (fail-closed)' };
      const r3 = run(['print', 'gui/' + uid + '/' + t.label]);
      // P1: ненулевой `print` → отсутствие job ТОЛЬКО при ПОДТВЕРЖДЁННОМ «not found/
      // not loaded»; любой иной ненулевой код (напр. отказ в доступе) → failed, НЕ absence.
      const pc = uninstallExec.classifyLaunchctlPrint(r3);
      if (!pc.ok) {
        return { status: 'failed', message: pc.error + (errs.length ? ' (' + errs.join('; ') + ')' : '') };
      }
      if (pc.loaded) {
        return { status: 'failed', message: 'LaunchAgent «' + t.label + '» всё ещё загружен' + (errs.length ? ' (' + errs.join('; ') + ')' : '') };
      }
      return uninstallExec.removeFile(t.plist, guardOpts);
    }
    case 'appbundle': {
      if (!IS_MAC) return { status: 'failed', message: 'appbundle вне macOS' };
      if (!fs.existsSync(t.path)) return { status: 'absent', message: 'нечего удалять' };
      // Идентичность ОБЯЗАТЕЛЬНА: CFBundleIdentifier == вшитому vendor-значению
      // И TeamIdentifier == пину. Иначе на месте могла оказаться ЧУЖАЯ программа.
      if (!t.expectBundleId) return { status: 'failed', message: 'ЗАЩИТА: нет эталонного CFBundleIdentifier (vendor) — отказ удалять .app' };
      const bid = macBundleIdOf(t.path);
      if (!bid || bid !== t.expectBundleId) {
        return { status: 'failed', message: 'ЗАЩИТА: CFBundleIdentifier «' + (bid || 'нет') + '» ≠ «' + t.expectBundleId + '» — это НЕ наш бандл' };
      }
      const team = macTeamIdOf(t.path);
      if (!team || team !== t.teamId) {
        return { status: 'failed', message: 'ЗАЩИТА: TeamIdentifier «' + (team || 'нет') + '» ≠ «' + t.teamId + '» — это НЕ наша подпись' };
      }
      return uninstallExec.removeDirTree(t.path, guardOpts);
    }
    case 'reg': {
      if (!IS_WIN) return { status: 'failed', message: 'reg вне Windows' };
      return winRegDeleteValue(t);
    }
    case 'pathentry': {
      if (!IS_WIN) return { status: 'failed', message: 'pathentry вне Windows' };
      // P0-5: через guard (junction/reparse в цели или предках → отказ).
      return winRemoveUserPathEntry(t, guardOpts);
    }
    case 'killproc': {
      // best-effort остановка НАШЕГО процесса (иначе exe залочен) — не влияет на статус
      try {
        if (IS_WIN && t.image && /^[a-z0-9._-]+\.exe$/i.test(t.image)) {
          const tk = remoteFetch.sysBin('taskkill.exe');
          if (tk) execFileSync(tk, ['/IM', t.image, '/F'], { windowsHide: true, stdio: 'ignore', timeout: 20000 });
        } else if (IS_MAC && t.pattern && uninstallExec.valueHygieneOk(t.pattern)) {
          execFileSync('/usr/bin/pkill', ['-f', t.pattern], { stdio: 'ignore', timeout: 20000 });
        }
      } catch (e) { /* процесса нет — норма */ }
      return { status: 'absent', message: 'остановка процесса (best-effort)' };
    }
    // P0-2: типа 'uvtool' больше нет — user-writable uv.exe из (elevated)
    // деинсталлятора НЕ запускается; venv/шимы удаляются file/dirtree-целями.
    default:
      return { status: 'failed', message: 'ЗАЩИТА: неизвестный тип цели «' + String(t && t.type) + '» (fail-closed)' };
  }
}

ipcMain.handle('uninstall-component', async (_evt, payload) => {
  const { id } = payload || {};
  if (!id || !VALID_COMPONENT_IDS.has(id)) {
    return { id, ok: false, code: -1, error: `Unknown component id: ${id}` };
  }
  const meta = COMPONENT_META.get(id);
  if (meta && meta.hidden) {
    return { id, ok: false, code: -1, error: `Служебный компонент «${id}» не деинсталлируется.` };
  }
  // P0-4: платформенный гейт применяется и к ДЕИНСТАЛЛЯЦИИ — ДО построения и
  // исполнения плана. Crafted/legacy receipt для win32-only компонента на macOS
  // не должен исполнять win32-план (и наоборот).
  if (meta && !componentShownOnPlatform(meta, process.platform)) {
    return { id, ok: false, code: -1, error: `Компонент «${id}» недоступен на платформе ${process.platform} — деинсталляция отклонена.` };
  }
  // v1: ранний гейт на компоненты с ОТКЛЮЧЁННЫМ авто-удалением (Nomad — TOCTOU/data-loss
  // риск, Codex P0). Отбиваем ДО построения/исполнения плана и ДО деактивации маркера,
  // даже если у компонента есть валидная квитанция установки. Nomad остаётся установленным.
  if (uninstallTargets.UNINSTALL_DISABLED && uninstallTargets.UNINSTALL_DISABLED.has(id)) {
    return { id, ok: false, code: -1, error: `Авто-удаление компонента «${id}» в этой версии отключено — он остаётся установленным. Удали вручную при необходимости.` };
  }

  const home = os.homedir();
  const rendererEnv = Object.assign({}, (payload && payload.env) || {});
  // Dry-run АВТОРИТЕТНО: process.env ИЛИ renderer-подсказка.
  const isDryRun = !!(process.env.HM_DRY_RUN || (rendererEnv && rendererEnv.HM_DRY_RUN));
  // P1-8: в dry-run не пишем install.log.
  const logLine = (line) => { if (!isDryRun) logToFile(id, line); };
  const send = (line) => {
    if (mainWindow && !mainWindow.isDestroyed() &&
        mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('component-log', { id, line });
    }
  };
  const say = (line) => { send(line); logLine(line); };

  // Гейт: маркер «мы это ставили». Его СОДЕРЖИМОЕ целей не задаёт.
  if (!receipts.hasReceipt(home, id)) {
    return {
      id, ok: false, code: -1,
      error: `Нет отметки установки для «${id}» — этот установщик его не ставил (или отметка утеряна). ` +
             'Удаление отклонено, чтобы не задеть чужие файлы. Если уверен — удали вручную.'
    };
  }

  // Цели — ТОЛЬКО из зашитого аллоулиста (доверенный код, не квитанция).
  const plan = uninstallTargets.uninstallTargets(id, buildUninstallCtx());
  if (!plan || !Array.isArray(plan.targets) || !plan.targets.length) {
    return { id, ok: false, code: -1, error: `Компонент «${id}» не поддерживает деинсталляцию (нет зашитой карты удаления).` };
  }
  const guardOpts = { home, platform: process.platform, extraProtected: plan.preserve || [] };

  say('Деинсталляция компонента: ' + id + (isDryRun ? ' [dry-run]' : ''));
  for (const n of plan.notes || []) say('  ' + n);

  if (isDryRun) {
    for (const t of plan.targets) say('  [dry-run] WOULD: ' + describeTarget(t));
    for (const keep of plan.preserve || []) say('  [dry-run] KEEP: ' + keep);
    return { id, ok: true, code: 0, dryRun: true };
  }

  // Деактивируем маркер АТОМАРНО ДО удаления (rename → tombstone). Не смогли → abort.
  const deact = receipts.deactivateReceipt(home, id);
  if (!deact.ok) {
    return { id, ok: false, code: -1, error: 'Не удалось деактивировать отметку установки — деинсталляция прервана (ничего не удалено): ' + deact.error };
  }

  logLine('=== uninstall start (trusted allowlist) ===');
  let failed = 0;
  for (const t of plan.targets) {
    let r;
    try { r = executeUninstallTarget(t, guardOpts); }
    catch (e) { r = { status: 'failed', message: 'исключение: ' + String((e && e.message) || e) }; }
    const line = '  [' + r.status + '] ' + describeTarget(t) + (r.message ? ' — ' + r.message : '');
    say(line);
    if (r.status === 'failed') failed++;
  }

  // P1-6: пост-проверка по ТОЧНЫМ managed-целям плана (uninstall-exec.
  // verifyPostconditions), НЕ по глобальной детекции — чужой uv/nomad/Claude.app
  // на машине не даёт ни вечного failure, ни ложного успеха. Сбой проверки →
  // считаем, что компонент остался (fail-closed).
  let stillThere = true;
  let postProblems = [];
  try {
    const post = uninstallExec.verifyPostconditions(plan, guardOpts, {
      regQuery: (key, value) => regQueryValueTyped(key, value),
      bundleIdOf: (p) => macBundleIdOf(p)
    });
    stillThere = !post.ok;
    postProblems = post.problems || [];
  } catch (e) { stillThere = true; }

  if (failed > 0 || stillThere) {
    const rest = receipts.restoreReceipt(home, id);
    const why = failed > 0
      ? 'часть целей не удалена (' + failed + ' отказ/сбой — см. лог)'
      : 'пост-проверка managed-целей: ' + (postProblems.length ? postProblems.join('; ') : 'не подтвердила удаление');
    say('Деинсталляция «' + id + '» НЕ завершена: ' + why + '. Отметка установки ' + (rest.ok ? 'возвращена' : 'НЕ восстановилась (' + rest.error + ')') + '.');
    logLine('=== uninstall FAILED (failed=' + failed + ', stillThere=' + stillThere + ') ===');
    return { id, ok: false, code: 1, error: why };
  }

  // Успех подтверждён — финализируем учёт и ПРОВЕРЯЕМ результат (не «молча ок»).
  const fin = receipts.finalizeRemoval(home, id);
  let manOk = true, manErr = '';
  try {
    const mr = manifest.removeEntry(home, id);
    if (!mr || mr.ok !== true) { manOk = false; manErr = (mr && mr.error) || 'removeEntry ok=false'; }
  } catch (e) { manOk = false; manErr = String((e && e.message) || e); }
  if (!fin.ok || !manOk) {
    const msg = 'Артефакты удалены, но учётные записи не очищены: ' +
      (!fin.ok ? ('маркер (' + fin.error + ') ') : '') + (!manOk ? ('манифест (' + manErr + ')') : '');
    say(msg);
    logLine('=== uninstall done, bookkeeping FAILED ===');
    return { id, ok: false, code: 1, error: msg };
  }
  say('Деинсталляция «' + id + '» завершена.');
  logLine('=== uninstall done ===');
  return { id, ok: true, code: 0 };
});

ipcMain.handle('quit', () => app.quit());
