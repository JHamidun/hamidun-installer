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
const { rmStagingTree } = require('./staging-paths'); // снос staging — только по имени HmDeElev-<hex>
const nomadKey = require('./nomad-key');             // запись ключа Nomad в config.yaml
const credentialsMerge = require('./credentials-merge'); // слияние ключей визарда в .env

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

// ОФЛАЙН-база рядом? Признак — config-pack (его везёт ТОЛЬКО полный офлайн-vendor).
// ВАЖНО: это НЕ ответ на вопрос «сиблинг-vendor на месте» — в lite-издании config-pack
// отсутствует ПО ПОСТРОЕНИЮ (tools/build-lite.js: LITE_KEEP_* = checksums.json + uv +
// курс, без config-pack). Для «на месте ли то, что обязано быть у ДАННОГО издания»
// есть editionVendorPresent() ниже.
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

// Лёгкое (стриминг с S3) издание? Маркер edition:'lite' в config.json ставит
// prep-lite.js на сборке. В lite тяжёлые компоненты НЕ вшиты — main докачивает их
// из реестра (loadRemoteMaps авто-выводит remote по наличию записи, id==remoteId),
// кроме bundled-only (uv, P1-A). Офлайн-издание маркера lite НЕ имеет → всё из vendor.
function isLiteEdition() {
  try { return readJson('config.json', {}).edition === 'lite'; }
  catch (e) { return false; }
}

// Сиблинг-vendor, обязательный ДЛЯ ЭТОГО ИЗДАНИЯ, реально на месте?
//
// ЗАЧЕМ ОТДЕЛЬНО ОТ vendorAvailable(): признак обязан доказывать именно то, что
// заявляет. config-pack доказывает «полная офлайн-база рядом», но в lite-издании его
// НЕТ ПО ПОСТРОЕНИЮ (tools/build-lite.js LITE_KEEP_WIN/LITE_KEEP_MAC; на mac том dmg
// собирает .github/workflows/build-mac-lite.yml — checksums.json + uv + курс). Поэтому
// проверка по config-pack давала lite-изданию ВЕЧНУЮ ложную тревогу: маковод запускал
// .app правильно, из окна смонтированного dmg, и всё равно видел мягкую плашку
// «файлы рядом не подхватятся». Тот же класс дефекта, что закрывали в claude.ps1/
// verify.ps1: факт объявлялся по признаку, который его не доказывает.
//
// Показательно, что авторы build-lite.js это предвидели («Курс обязателен ещё и потому,
// что vendorComplete() ищет apps/uv-macos-*.tar.gz и course/*.zip») — но их
// предусмотрительность обнулялась первой строкой vendorComplete(): !vendorAvailable().
//
// Обязательный минимум lite = вшитый checksums.json (ВТОРОЙ fail-closed гейт докачек,
// без него не пройдёт ни один компонент) + архив uv (uv — BUNDLED_ONLY, не докачивается
// ниоткуда) + архив курса. Имена — из build-lite.js: mac apps/uv-macos-<arch>.tar.gz,
// win apps/uv/uv.exe.
function editionVendorPresent() {
  if (!isLiteEdition()) return vendorAvailable();
  let hasChecksums = false;
  try { hasChecksums = fs.existsSync(path.join(vendorRoot(), 'checksums.json')); }
  catch (e) { hasChecksums = false; }
  const hasUv = (process.platform === 'darwin')
    ? vendorDirHas('apps', (f) => /^uv-macos-.*\.tar\.gz$/i.test(f))
    : vendorDirHas(path.join('apps', 'uv'), (f) => /^uvx?\.exe$/i.test(f));
  const hasCourse = vendorDirHas('course', (f) => /\.zip$/i.test(f));
  return hasChecksums && hasUv && hasCourse;
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

// ---- uid: связь установки с конкретным человеком ---------------------
// Резолвинг uid и очистка текстов от ПД живут в отдельном модуле (src/uid-telemetry.js):
// это граница доверия — значения уходят на сервер и проверяются тестами напрямую.
const uidTelemetry = require('./uid-telemetry');
const scrubText = uidTelemetry.scrubText;
const INSTALL_UID = uidTelemetry.resolveUid();

// ---- install log (~/.hamidun-setup/install.log) ----------------------
// Every line streamed to the renderer is also appended here, so a user can
// send one file to support when something goes wrong.
const LOG_DIR = path.join(os.homedir(), '.hamidun-setup');
const LOG_PATH = path.join(LOG_DIR, 'install.log');
let logDirReady = false;
// Дескриптор держим ОТКРЫТЫМ. fs.appendFileSync открывает и закрывает файл на
// КАЖДОЙ строке, а установочные скрипты (pip, uv, npm) выдают их десятками тысяч:
// это десятки тысяч синхронных open/write/close в главном процессе — он же качает
// насос сообщений окна. Один открытый дескриптор убирает две трети работы и
// сохраняет главное свойство журнала: строка на диске сразу, переживает падение.
let logFd = null;
function logToFile(id, line) {
  try {
    if (!logDirReady) { fs.mkdirSync(LOG_DIR, { recursive: true }); logDirReady = true; }
    if (logFd === null) logFd = fs.openSync(LOG_PATH, 'a');
    fs.writeSync(logFd, '[' + new Date().toISOString() + '] [' + id + '] ' + line + '\n');
  } catch (e) {
    // Дескриптор мог протухнуть (файл убрали/переименовали) — уроним его, следующая
    // строка откроет заново. Журналирование НИКОГДА не должно ломать установку.
    if (logFd !== null) { try { fs.closeSync(logFd); } catch (e2) { /* ignore */ } logFd = null; }
  }
}

let mainWindow = null;

// Track live installer child processes so we can kill orphans if the window
// closes mid-install (otherwise silent installers keep running invisibly).
const CHILDREN = new Set();
// Замок «идёт установка компонента» на уровне ПРОЦЕССА (переживает Ctrl+R окна).
let _installBusy = false;

// win32: Admins-only staging-каталоги докачки, ЖИВЫЕ в этом процессе (remoteId → dir).
// Нужны для двух вещей: (1) ретрай компонента в той же сессии переиспользует УЖЕ
// скачанный и sha-проверенный <remoteId>.zip (remote-fetch сам ловит идемпотентность)
// вместо повторной закачки сотен МБ; (2) гарантированная уборка на выходе — иначе
// закрытие окна посреди докачки оставляет в %ProgramData% до ~1.6 ГБ, которые обычный
// пользователь без админа удалить НЕ может. Модель угроз не меняется: каталог рождён
// НАМИ атомарно (owner=Administrators, DACL {SYSTEM,Admins}), имя случайное, а
// remote-fetch.ensureCacheSecure перепроверяет защищённость перед КАЖДЫМ использованием.
const SECURE_DIRS = new Map();
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

// Уборка Admins-only staging-каталогов ЭТОГО процесса (см. SECURE_DIRS): закрытие окна
// посреди докачки не должно оставлять пользователю нестираемые гигабайты в %ProgramData%.
function cleanupAllSecureDirs() {
  for (const d of SECURE_DIRS.values()) {
    // ВНЕШНИЙ каталог, а не рабочий подкаталог «w»: staging двухуровневый, и
    // удаление только «w» оставляло в %ProgramData% запертый Admins-only
    // HmDeElev-*, который пользователь не может стереть сам. Ровно для этого
    // и заведён rmStagingTree — здесь его когда-то забыли применить.
    rmStagingTree(d);   // fail-closed по имени HmDeElev-<32 hex>, см. src/staging-paths.js
  }
  SECURE_DIRS.clear();
}

// Сборка мусора от ПРОШЛЫХ запусков (краш/убийство антивирусом/выключение питания —
// before-quit тогда не отработал). Гейты, чтобы элевейтед-удаление не превратилось в
// arbitrary-delete примитив (%ProgramData% доступен Users на создание — malware может
// пред-создать HmDeElev-* junction): строгий шаблон имени, НЕ reparse-point, каталог
// защищён (owner=Admins, посторонних ACE нет) и «остыл» (ничего не менялось 6 часов —
// живая докачка другого инстанса обновляет mtime своего .part).
function pruneStaleSecureDirs() {
  if (!IS_WIN) return;
  try {
    const pd = remoteFetch.winProgramData();
    if (!pd || !fs.existsSync(pd)) return;
    const cutoff = Date.now() - 6 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(pd)) {
      if (!/^HmDeElev-[0-9a-f]{32}$/i.test(name)) continue;
      const dir = path.join(pd, name);
      let st;
      try { st = fs.lstatSync(dir); } catch (e) { continue; }
      if (!st.isDirectory() || st.isSymbolicLink()) continue;      // junction-подмена → не трогаем
      let newest = st.mtimeMs;
      try {
        for (const child of fs.readdirSync(dir)) {
          try { newest = Math.max(newest, fs.lstatSync(path.join(dir, child)).mtimeMs); } catch (e) { /* ignore */ }
        }
      } catch (e) { /* ignore */ }
      if (newest > cutoff) continue;                                // возможно живой каталог другого инстанса
      if (!remoteFetch.verifyDirSecureWin(dir)) continue;           // не наш/не защищён → не удаляем
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* best-effort */ }
    }
  } catch (e) { /* уборка мусора не должна ломать запуск */ }
}

// Второй запуск установщика недопустим. Целевая аудитория — новички: первый клик
// даёт запрос прав и ~минуту тишины на распаковке, и человек кликает ещё раз.
// Два элевейтед-экземпляра параллельно ставили бы одно и то же в ~/.claude,
// npm prefix и uv tools, а portable-стаб вдобавок рекурсивно чистит ОБЩИЙ каталог
// распаковки — то есть второй запуск выдёргивал ресурсы из-под первого.
// Поднимаем уже открытое окно вместо запуска второй копии.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const wins = BrowserWindow.getAllWindows();
    const w = wins.length ? wins[0] : null;
    // Окон может не быть вовсе: на macOS закрытие окна НЕ завершает приложение,
    // и процесс живёт дальше — держа замок единственного экземпляра. Раньше здесь
    // стоял голый return, и второй запуск в такой ситуации молча умирал: человек
    // видел, что установщик «не открывается», хотя тот висел в памяти невидимкой.
    if (!w) { try { createWindow(); } catch (e) { /* не роняем процесс */ } return; }
    try {
      if (w.isMinimized()) w.restore();
      w.show();
      w.focus();
    } catch (e) { /* окно могло закрыться — не роняем установку */ }
  });

  app.whenReady().then(() => {
    createWindow();
    try { pruneStaleSecureDirs(); } catch (e) { /* best-effort */ }
    // Прерванное удаление (антивирус убил процесс, пропало питание) оставляло
    // маркер переименованным — и кнопка «Удалить» исчезала навсегда. Возвращаем
    // маркер, чтобы человек мог просто повторить удаление.
    try { receipts.recoverOrphanTombstones(os.homedir()); } catch (e) { /* best-effort */ }
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  killChildren();
  cleanupAllSecureDirs();
  if (!IS_MAC) app.quit();
});

app.on('before-quit', () => { killChildren(); cleanupAllSecureDirs(); });

// ---- IPC -------------------------------------------------------------

// Warn when the installer is running under a DIFFERENT user account than the
// person at the keyboard — its scripts write ~/.claude, PATH, credentials, etc.
// into whatever HOME the process token has, so a foreign account silently sets
// up the wrong profile. Returns a human-readable RU string, or '' when there's
// nothing to warn about / we can't tell reliably.
// Декодирование вывода КОНСОЛЬНОГО инструмента Windows (tasklist, reg, chcp…):
// он печатает в кодовой странице консоли, а НЕ в UTF-8. Чтение буфера как UTF-8
// превращает кириллицу в мусор — этот класс уже кусал реестр. Кодовую страницу
// определяем один раз за сессию через chcp.com.
// ВАЖНО: это НЕ для чтения ПУТЕЙ (там reg.exe делает best-fit-подмену «José→Jose»,
// и текстовый разбор запрещён). Здесь — только имена/сравнения, где важна читаемая
// кириллица, а не байт-в-байт точность структурных символов.
let _consoleCp;
function consoleCodePage() {
  if (_consoleCp !== undefined) return _consoleCp;
  _consoleCp = 0;
  try {
    const chcp = remoteFetch.sysBin('chcp.com');
    if (chcp) {
      const r = spawnSync(chcp, [], { encoding: 'latin1', windowsHide: true, timeout: 8000 });
      const m = String(r.stdout || '').match(/(\d{3,5})/);
      if (m) _consoleCp = parseInt(m[1], 10) || 0;
    }
  } catch (e) { /* не определили — ниже честный фолбэк */ }
  return _consoleCp;
}
const _CP_LABELS = {
  65001: 'utf-8', 866: 'ibm866', 1251: 'windows-1251', 1252: 'windows-1252',
  437: null, 850: null, 852: null,   // DOS-страницы без WHATWG-имени → ASCII-путь
};
let _consoleDecoder;
function decodeConsole(buf) {
  if (!buf) return '';
  if (_consoleDecoder === undefined) {
    _consoleDecoder = null;
    const cp = consoleCodePage();
    const tries = [];
    if (_CP_LABELS[cp]) tries.push(_CP_LABELS[cp]);
    tries.push('cp' + cp, 'ibm' + cp, 'windows-' + cp);
    for (const label of tries) {
      try { _consoleDecoder = new TextDecoder(label); break; } catch (e) { /* следующий */ }
    }
  }
  if (_consoleDecoder) { try { return _consoleDecoder.decode(buf); } catch (e) { /* ниже */ } }
  // Декодера нет (DOS-страница без имени и т.п.): для ASCII latin1 совпадает с
  // содержимым, а на не-ASCII данные исказятся — но это лишь имя владельца для
  // сравнения, а не путь, и fail-open ниже (нет '\' → молчим) страхует.
  return Buffer.isBuffer(buf) ? buf.toString('latin1') : String(buf);
}

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
    // Windows «over-the-shoulder UAC»: у реального юзера СТАНДАРТНАЯ учётка, а установщик
    // требует админа (requireAdministrator) → UAC просит пароль ДРУГОГО (админского)
    // аккаунта → весь процесс идёт от имени админа, и ~/.claude, курс, ярлык, claude,
    // PATH, креды уезжают в ЧУЖОЙ профиль; де-элевация тоже ломается. Обычная UAC-
    // элевация ТЕМ ЖЕ аккаунтом токен-юзера не меняет — предупреждать не о чем.
    // Определяем интерактивного (консольного) пользователя как владельца explorer.exe
    // (оболочка запущена интерактивным входом даже когда наш процесс — под другим
    // аккаунтом) и сравниваем с пользователем нашего токена. Fail-OPEN: любая
    // ошибка/таймаут/неоднозначность → '' (НИКОГДА не пугаем ложным баннером).
    const tokenUser = String(process.env.USERNAME || '').trim().toLowerCase();
    if (!tokenUser) return '';
    const tasklist = remoteFetch.sysBin('tasklist.exe'); // абсолютный System32 (как reg/cmd)
    if (!tasklist) return '';
    let out = '';
    try {
      // encoding НЕ 'utf8': tasklist.exe печатает в кодовой странице консоли
      // (CP866 на русской Windows), и имя владельца с кириллицей приезжало бы
      // мусором. Нам важен только формат DOMAIN\user (наличие '\') и сравнение с
      // tokenUser — берём вывод буфером и декодируем реальной кодовой страницей,
      // тем же примитивом, что и реестр (тот же класс дефекта закрыт там).
      const buf = execFileSync(tasklist,
        ['/v', '/fi', 'imagename eq explorer.exe', '/fo', 'csv', '/nh'],
        { windowsHide: true, timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] });
      out = decodeConsole(buf);
    } catch (e) { return ''; } // tasklist недоступен/таймаут — молчим
    // Собираем владельцев ВСЕХ explorer.exe (при fast-user-switching их несколько).
    // Реальный владелец ВСЕГДА в формате DOMAIN\user — это локале-НЕзависимый признак
    // «резолв удался»: «N/A» англ., «Н/Д» рус. и любая локаль НЕ содержат '\' → отбрасываем
    // (иначе на рус. Windows «Н/Д» дало бы ложный баннер — инвариант fail-open нарушился бы).
    const short = (s) => s.split('\\').pop().trim().toLowerCase();
    const owners = String(out || '').split(/\r?\n/)
      .filter((l) => /explorer\.exe/i.test(l))
      .map((row) => (row.match(/"([^"]*)"/g) || []).map((s) => s.replace(/^"|"$/g, '')))
      .map((f) => (f[6] || '').trim())
      .filter((full) => full.includes('\\'));
    if (!owners.length) return ''; // владельца определить не удалось — молчим
    // Наш токен-юзер интерактивен (есть его explorer) → файлы уедут в ЕГО профиль, всё ок.
    // Покрывает и обычную UAC-элевацию тем же аккаунтом, и семейный ПК с фоновой 2-й сессией
    // (fast user switching): если хоть один explorer — наш, предупреждать не о чем.
    if (owners.some((o) => short(o) === tokenUser)) return '';
    // Токен-юзер НЕ интерактивен. Предупреждаем ТОЛЬКО при однозначности: ВСЕ интерактивные
    // сессии принадлежат ОДНОМУ и тому же чужому юзеру (истинный over-the-shoulder — админ
    // ввёл пароль, но интерактивно не залогинен). 2+ разных владельца = неоднозначность → молчим.
    const distinct = Array.from(new Set(owners.map(short)));
    if (distinct.length !== 1) return '';
    const interactiveFull = owners.find((o) => short(o) === distinct[0]);
    const tokenDisplay = process.env.USERNAME || tokenUser;
    return 'Установщик запущен с правами другой учётки («' + tokenDisplay + '»), а в Windows ' +
      'вы вошли как «' + interactiveFull + '». Из-за этого всё — курс, ярлык на рабочем столе, ' +
      'настройки, Claude — установится в профиль «' + tokenDisplay + '», а не в ваш, и у вас ' +
      'этого не будет. Решение: сделайте вашу учётку «' + interactiveFull + '» администратором ' +
      '(Параметры → Учётные записи → Семья и другие пользователи), затем запустите установщик ' +
      'заново — тогда всё встанет в ваш профиль.';
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
    // Лёгкое (стриминг с S3) издание? Renderer по этому полю решает, показывать ли
    // превью размера докачки («Скачается: ~X МБ») и гонять ли preflight probe-remote.
    edition: isLiteEdition() ? 'lite' : 'offline',
    // Превью МБ докачки: componentId → ТОЧНЫЙ sizeBytes архива из вшитого реестра
    // remote-components.json — ровно для тех компонентов, которые ЭТО издание реально
    // докачивает (loadRemoteMaps: явный remote-флаг ИЛИ lite-авто-remote, кроме
    // bundled-only). Вес вшитых компонентов сюда НЕ мешаем: он живёт в components.json
    // (sizeBytes[платформа], считает tools/sync-sizes.js по реальному vendor) — две
    // копии одного факта неминуемо разъезжаются, как разъехался бывший sizeHint.
    remoteSizes: remoteSizesForRenderer(),
    logPath: LOG_PATH,
    freeGB,
    osRelease: os.release(),
    // Absolute path to the bundled resources dir (vendor/agent/assets live here).
    // The renderer needs it to open the offline START-HERE fallback locally.
    resourcesRoot: resourceRoot(),
    // vendor доступен? На mac vendor лежит в dmg РЯДОМ с .app. Если приложение
    // перетащили в /Applications без dmg — vendor не найдётся: офлайн-установка
    // невозможна, компоненты уйдут в онлайн-фолбэк или упадут. UI это подсветит.
    // Проверка ПО ИЗДАНИЮ (editionVendorPresent, НЕ vendorAvailable): в lite нет
    // config-pack по построению, и проверка по нему жгла мягкую плашку ВСЕГДА —
    // даже когда маковод запустил .app правильно, из окна смонтированного dmg.
    vendorAvailable: editionVendorPresent(),
    // macOS App Translocation / оторванный sibling-vendor: жёсткий стоп ДО установки.
    // blocked=true → renderer перекрывает экран блокирующим окном и гасит «Установить».
    vendorBlock: vendorBlockInfo(),
    // userWarning считается ОТДЕЛЬНЫМ async-IPC (detect-user-warning), а НЕ здесь:
    // на Windows детект гоняет tasklist /v (0.5–2с, до 4с на машине с AV) и синхронно
    // морозил бы стартовый экран. Пусто в bootstrap → renderer дорисует баннер позже.
    userWarning: ''
  };
});

// Отдельный (после первой отрисовки) детект «запущен под другим пользователем» —
// чтобы медленный tasklist на Windows не тормозил стартовый экран (см. bootstrap).
ipcMain.handle('detect-user-warning', () => {
  try { return detectForeignUserWarning(); } catch (e) { return ''; }
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
  const compRemote = new Map(); // component id → remoteId
  const data = readJson('components.json', { groups: [] });
  // В lite-издании тяжёлые компоненты НЕ вшиты → авто-выводим remote по наличию
  // записи в реестре (id==remoteId, так публикует publish-vendor.py), КРОМЕ
  // bundled-only (uv — P1-A, мал, едет внутри lite). Так components.json остаётся
  // чистым и в офлайн-, и в lite-издании (remote — не файловый флаг, а edition+реестр).
  const lite = isLiteEdition();
  const BUNDLED_ONLY = new Set(['uv']);
  for (const g of (data.groups || [])) {
    for (const c of (g.components || [])) {
      if (!c || !c.id) continue;
      if (c.remote && c.remoteId) {
        compRemote.set(c.id, c.remoteId);                     // явный флаг (совместимость)
      } else if (lite && ids.has(c.id) && !BUNDLED_ONLY.has(c.id)) {
        compRemote.set(c.id, c.id);                           // lite: авто-remote по реестру
      }
    }
  }
  return { reg, ids, compRemote };
}

// Превью размера докачки для renderer (bootstrap.remoteSizes): componentId →
// sizeBytes архива из реестра. Карта следует loadRemoteMaps (какие id remote в
// ЭТОМ издании) × pickEntry (платформенная запись). В офлайн-издании compRemote
// без явных remote-флагов пуст → превью пустое (ничего не качаем — не показываем).
function remoteSizesForRenderer() {
  const out = {};
  try {
    const { reg, compRemote } = loadRemoteMaps();
    for (const [cid, rid] of compRemote) {
      const entry = remoteFetch.pickEntry(reg, rid, process.platform);
      const sz = entry ? Number(entry.sizeBytes) : 0;
      if (sz > 0) out[cid] = sz;
    }
  } catch (e) { /* превью размеров не должно ломать bootstrap */ }
  return out;
}

// PREFLIGHT LITE: доступность сервера докачки (S3/CDN) ДО активации «Установить».
// CSP renderer'а запрещает fetch — сеть пробует ТОЛЬКО main через этот IPC.
// Renderer аргументов не передаёт; пробуем зеркала ПЕРВОГО платформенного
// remote-компонента реестра (probeMirror: https-only + анти-SSRF, Range bytes=0-0,
// абсолютный дедлайн 8с). Любое живое зеркало → online:true (установка пойдёт —
// fetchRemote сам выберет живое зеркало). Не lite / нечего качать → online:true.
ipcMain.handle('probe-remote', async () => {
  try {
    if (!isLiteEdition()) return { online: true, skipped: true };
    const { reg, compRemote } = loadRemoteMaps();
    let entry = null;
    for (const rid of new Set(compRemote.values())) {
      entry = remoteFetch.pickEntry(reg, rid, process.platform);
      if (entry) break;
    }
    if (!entry) return { online: true, skipped: true }; // качать нечего — сеть не нужна
    const urls = (entry.mirrors || []).map((m) => m && m.url).filter((u) => remoteFetch.isFetchableUrl(u));
    if (!urls.length) return { online: false };
    const settled = await Promise.allSettled(urls.map((u) => remoteFetch.probeMirror(u, 8000)));
    const online = settled.some((r) => r.status === 'fulfilled' && r.value && r.value.ok);
    return { online };
  } catch (e) {
    return { online: false, error: String((e && e.message) || e) };
  }
});

// vendor-first гейт: id remote-компонента → его ОСНОВНОЙ вшитый артефакт
// (относительно vendorRoot). Если он есть в bundled vendor — это ОФЛАЙН-издание,
// докачка НЕ запускается (даже при remote:true в components.json): существующий
// vendor/ имеет приоритет, сеть не трогается. Путь = та же vendor-раскладка, что
// публикует tools/publish-vendor.py (zip повторяет её 1:1) → HM_VENDOR=staging.
const COMPONENT_VENDOR_ARTIFACT = {
  git: 'apps/git-setup.exe',
  node: 'apps/node-lts.msi',
  vscode: 'apps/vscode-setup.exe',
  cursor: 'apps/cursor-setup.exe',
  claude: 'npm-cache',
  uv: 'apps/uv',
  mascot: 'apps/claude-mascot',
  nomad: 'nomad-src',
  config: 'config-pack',
  // NB: ключа 'playwright-browsers' здесь НЕТ намеренно — карта ключуется по id
  // КОМПОНЕНТА (components.json), а компонента с таким id не существует: браузеры
  // Playwright ставит pydeps.ps1 (офлайн из $HM_VENDOR\playwright-browsers, иначе
  // онлайн-фолбэк `playwright install chromium`). Мёртвый ключ вводил в заблуждение.
  pydeps: 'apps/python-setup.exe',
  extension: 'apps/claude-code.vsix',
  // handy: тот же vendor-first приоритет, что у остальных. Ключ нужен ровно с того
  // момента, как handy появится в реестре докачки (tools/publish-vendor.py): без него
  // издание с ВШИТЫМ apps/handy-setup.exe, но без маркера offlineEdition, полезло бы
  // в сеть за тем, что уже лежит рядом. Путь — та же vendor-раскладка, что читает
  // scripts/windows/handy.ps1 ($HM_VENDOR\apps\handy-setup.exe).
  handy: 'apps/handy-setup.exe',
};

// Дедлайн скачивания = f(sizeBytes): консервативные ~300 КБ/с (медленный РФ-канал)
// + 30% запас, но не меньше 20 мин. 786МБ npm-cache в дефолтные 20 мин не лезет.
function downloadDeadlineFor(sizeBytes) {
  const sz = Number(sizeBytes) || 0;
  const est = Math.ceil((sz / (300 * 1024)) * 1000 * 1.3);
  return Math.max(20 * 60 * 1000, est);
}

// Компоненты, чей install-скрипт имеет СОБСТВЕННЫЙ онлайн-фолбэк (winget / прямая
// загрузка с github/vendor CDN; у config это укреплённый `git clone` из config.ps1/
// config.sh с АВТОРИТЕТНЫМИ координатами репозитория — см. блок id==='config' ниже).
// В lite при неудачной докачке с S3 НЕ роняем их жёстко — даём скрипту попробовать
// системный установщик (как в офлайн-издании, где они не declared-remote и скрипт
// всегда запускается). Компоненты БЕЗ такого фолбэка (nomad/pydeps/extension/claude)
// остаются fail-closed. ВАЖНО: провал докачки запоминается (fetchFellBack) — тогда
// graceful-skip скрипта (exit 120) НЕ выдаётся за успех, а превращается в честную
// ошибку с ретраем (иначе сорванная докачка vscode = тихий «пропущено»).
const SCRIPT_ONLINE_FALLBACK = new Set(['git', 'node', 'vscode', 'cursor', 'config']);

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

// Переменные, глушащие ЛЮБОЙ интерактивный запрос у инструментов, которые мы запускаем.
// Повод — живой случай: Git Credential Manager (на Windows он ставится по умолчанию)
// поднял ГРАФИЧЕСКОЕ окно «введите логин» при обращении к репозиторию, и процесс,
// который его вызвал, встал намертво. У установщика ровно та же схема: он делает
// git clone конфига, а окно может всплыть ЗА окном установщика — человек увидит
// вечный спиннер и ничего больше. Все наши источники ПУБЛИЧНЫЕ: запрос кредов всегда
// означает сломанную ситуацию (прокси, перехват, лимит), и правильный исход — быстро
// упасть с понятной ошибкой.
const NONINTERACTIVE_ENV = {
  GIT_TERMINAL_PROMPT: '0',          // git не спрашивает логин в терминале
  GIT_ASKPASS: 'echo',               // и не зовёт графический askpass
  GCM_INTERACTIVE: 'never',          // Git Credential Manager: без окон
  SSH_ASKPASS: 'echo',
  SSH_ASKPASS_REQUIRE: 'never',
  DEBIAN_FRONTEND: 'noninteractive',
  PIP_DISABLE_PIP_VERSION_CHECK: '1',
  npm_config_yes: 'true',            // npx/npm не спрашивают подтверждение установки
  CI: '1',                           // общепринятый сигнал «интерактива нет»
};

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
    // ВНИМАНИЕ: НЕ добавляем vendor/apps в elevated PATH — portable-exe распаковывает
    // vendor в user-writable %TEMP%, medium-малварь того же юзера подсадила бы туда
    // node.exe/git.exe и получила бы запуск под АДМИНОМ через bare-команду. Vendor-
    // артефакты потребляются ТОЛЬКО по абсолютному HM_VENDOR-пути в install-скриптах.
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
    Object.assign(out, NONINTERACTIVE_ENV);
    return out;
  }
  // POSIX: uv-флоу неэлевейтед end-to-end (см. модель угроз). Реальный env сохраняем,
  // но из renderer-env берём тот же allowlist (только HM_*, кроме HM_REMOTE_CACHE) —
  // никаких PATH/DYLD/LD/NODE_OPTIONS/… из renderer.
  const out = Object.assign({}, process.env);
  Object.assign(out, installEnv.filterRendererEnv(rendererEnv));
  Object.assign(out, NONINTERACTIVE_ENV);
  return out;
}

// Человеческий перевод машинного провала установки (cargo/PyO3/pip/Gatekeeper/…)
// в объяснение для ученика. Вынесен в модуль — его напрямую гоняет test/run-tests.js
// (main.js целиком в тесте не поднять: это Electron-точка входа).
const failureExplain = require('./failure-explain.js');

// Run one component script, streaming output back to the renderer.
//
// БЕЗОПАСНОСТЬ (remote-компоненты): докачка+проверка+распаковка+запуск идут
// ОДНОЙ атомарной операцией здесь, в main. Renderer НЕ может: (а) задать путь
// кэша — HM_REMOTE_CACHE из renderer безусловно вырезается и вычисляется тут из
// проверенного пути; (б) вклиниться между verify и run — второго IPC нет.
ipcMain.handle('run-component', async (_evt, payload) => {
  const { id } = payload || {};

  // «В момент времени идёт не более одной операции над машиной» — инвариант
  // ПРОЦЕССА, а не экрана. Раньше защёлка жила только в renderer, и перезагрузка
  // окна (Ctrl+R) сбрасывала её: новый renderer запускал компонент повторно, пока
  // дочерние процессы прошлого запуска ещё работали (два msiexec/uv в одни и те же
  // каталоги). Замок в main переживает перезагрузку окна.
  if (_installBusy) {
    return { id, ok: false, code: -1, error: 'установка уже идёт в этом установщике — дождитесь завершения текущего шага' };
  }
  _installBusy = true;
  try {

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
    rmStagingTree(secureCacheDir);
    for (const [rid, d] of SECURE_DIRS) { if (d === secureCacheDir) SECURE_DIRS.delete(rid); }
    secureCacheDir = '';
  };
  // Провал докачки, «прощённый» из-за собственного онлайн-фолбэка скрипта (см.
  // SCRIPT_ONLINE_FALLBACK). Заполнен → graceful-skip скрипта (exit 120) НЕ считается
  // успехом: компонент честно краснеет со stage:'fetch' и получает авто-ретрай.
  let fetchFellBack = '';
  let stagingVendor = '';       // задан → HM_VENDOR указывает СЮДА (sha-проверенный staging докачки)
  const { reg, compRemote } = loadRemoteMaps();
  const declared = compRemote.get(id);
  // vendor-first: если основной артефакт компонента уже вшит в bundled vendor —
  // это офлайн-издание, докачку НЕ запускаем (защита от remote-флагов).
  const bundledVendorEarly = vendorRoot();
  const bundledRel = COMPONENT_VENDOR_ARTIFACT[id];
  const vendorHasArtifact = !!(bundledRel && fs.existsSync(path.join(bundledVendorEarly, bundledRel)));
  // Офлайн-издание НИКОГДА не качает — защита от remote-флагов в общей
  // components.json. Держит это именно isOfflineEdition(), и снимать проверку нельзя.
  //
  // ОСТОРОЖНО с прежним обоснованием. Здесь стояло «mac-офлайн … darwin-записей в
  // реестре пока нет» — и это неверно с тех пор, как в реестре появились darwin-сборки:
  // в remote-components.json 23 записи, из них ОДИННАДЦАТЬ darwin (git, node, vscode,
  // cursor, claude, mascot, nomad, config, pydeps, extension, handy). Поведение
  // правильное, но по неправильной причине: mac-офлайн не качает из-за этой проверки,
  // а вовсе не из-за пустого реестра. Следующий, кто поверил бы комментарию, снял бы
  // проверку как избыточную — и офлайн-издание пошло бы в сеть.
  //
  // Lite-издание (offlineEdition=false) без вшитого артефакта — качает.
  const useBundled = vendorHasArtifact || isOfflineEdition();
  if (declared && isDryRun) {
    send('[dry-run] Докачка «' + declared + '» пропущена — ничего не скачиваем.');
  } else if (declared && useBundled) {
    const why = vendorHasArtifact ? 'уже вшит в установщик' : 'офлайн-издание';
    send('[локально] «' + declared + '» ' + why + ' — докачка не нужна.');
    logLine('vendor-first: ' + declared + ' (' + why + ') — download пропущен.');
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
    // НА ДИСКЕ (чужое) НЕ переиспользуем НИКОГДА. Переиспользуем ТОЛЬКО каталог, который
    // РОДИЛИ САМИ в ЭТОМ процессе (SECURE_DIRS) — иначе ретрай компонента качал бы те же
    // сотни МБ заново, хотя валидный <remoteId>.zip уже лежит рядом. Защищённость всё
    // равно перепроверяется в fetchRemote (ensureCacheSecure) перед каждым использованием.
    // fs.mkdirSync+post-icacls запрещён (окно наследования ProgramData).
    let cacheDir;
    if (IS_WIN) {
      // Каталог ЭТОГО процесса переиспользуем только если он всё ещё существует И
      // всё ещё защищён (owner=Admins, посторонних ACE нет) — иначе рождаем новый.
      cacheDir = SECURE_DIRS.get(declared) || '';
      if (cacheDir) {
        let stillSafe = false;
        try { stillSafe = fs.existsSync(cacheDir) && remoteFetch.verifyDirSecureWin(cacheDir); } catch (e) { stillSafe = false; }
        if (!stillSafe) { SECURE_DIRS.delete(declared); cacheDir = ''; }
      }
      if (!cacheDir) cacheDir = await winMakeSecureDir();
      if (!cacheDir) {
        return { id, ok: false, code: -1, stage: 'env',
        error: 'не удалось подготовить защищённый каталог для загрузки'
          + (lastSecureDirError ? ' (' + lastSecureDirError + ')' : '')
          + '. Запусти установщик от имени администратора; если это не помогает — пришли журнал боту.' };
      }
      SECURE_DIRS.set(declared, cacheDir);
      secureCacheDir = cacheDir; // чистим после успешной установки / на выходе
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
        downloadDeadlineMs: downloadDeadlineFor(entry.sizeBytes),
        onProgress: (p) => sendChannel('remote-progress', { id, remoteId: declared, pct: p.pct, received: p.received, total: p.total }),
        // Лог докачки идёт в ТОТ ЖЕ канал, что и вывод компонента — попадает в
        // общий лог естественно, атрибутируется по id, ничего не ломает.
        onLog: (line) => { logLine(line); send(line); }
      });
    } catch (e) {
      logLine('[ERROR] fetch-remote: ' + String(e));
      fr = { ok: false, error: String(e.message || e) };
    }
    logLine('=== fetch-remote result: ' + (fr && fr.ok ? ('ok ' + fr.path) : ('FAIL ' + (fr && fr.error))) + ' ===');
    if (!fr || !fr.ok) {
      // Каталог НЕ сносим: частично скачанное/уже проверенное переживёт ретрай в этой
      // же сессии (см. SECURE_DIRS); финальная уборка — при успехе или на выходе.
      const errMsg = (fr && fr.error) || 'докачка не удалась';
      if (SCRIPT_ONLINE_FALLBACK.has(id)) {
        // Не роняем жёстко: у скрипта есть свой онлайн-фолбэк (winget/прямая загрузка/
        // git clone для config). stagingVendor остаётся '' → HM_VENDOR=bundled (артефакта
        // нет) → скрипт уйдёт в фолбэк. Проваливаемся дальше к spawn (как офлайн-издание).
        // Помним, что фолбэк вызван ПРОВАЛОМ ДОКАЧКИ: если скрипт всё же скажет «нечего
        // ставить» (exit 120), это НЕ успех, а невосстановленная докачка (см. close).
        fetchFellBack = errMsg;
        const m = '[докачка] «' + declared + '» не удалась (' + errMsg + ') — пробую системный установщик компонента (winget/прямая загрузка).';
        send(m); logLine(m);
      } else {
        // Стадию классифицируем ЗДЕСЬ (авторитетно), а не регексом в renderer: только
        // реальное расхождение sha/манифеста — это 'integrity' (подмена артефакта,
        // повтор бессмыслен). Сеть, недоступные зеркала, отказ создать staging и прочая
        // среда — 'fetch': пользователю честно предлагаем «Повторить».
        const integrity = /sha-?256|checksums\.json|не совпал|подмен/i.test(errMsg);
        return { id, ok: false, code: -1, stage: integrity ? 'integrity' : 'fetch', error: errMsg };
      }
    } else {
      remoteCache = fr.path; // проверенный (sha256) распакованный путь — только из main
      // Второй fail-closed рубеж (Confirm-HmArtifact/verify_artifact) читает
      // $HM_VENDOR/checksums.json по basename. Staging станет HM_VENDOR → кладём туда
      // КОПИЮ вшитого checksums.json (покрывает артефакты по basename). Не смогли —
      // fail-closed: без второго гейта remote-компонент не пускаем.
      try {
        fs.copyFileSync(path.join(bundledVendorEarly, 'checksums.json'), path.join(fr.path, 'checksums.json'));
      } catch (e) {
        cleanupSecureCache();
        return { id, ok: false, code: -1, stage: 'fetch', error: 'не удалось положить checksums.json в staging (второй гейт целостности не сработает): ' + String(e.message || e) };
      }
      stagingVendor = fr.path;   // HM_VENDOR укажет СЮДА (а не в bundled vendor)
    }
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
  // Для remote-компонента (докачан в staging) HM_VENDOR указывает на sha-проверенный
  // staging (структурирован как vendor/), иначе — на bundled vendor. Так все 18
  // install-скриптов (source-agnostic через HM_VENDOR) + второй checksums-гейт
  // работают без правок и на офлайн-, и на lite-издании.
  const vroot = stagingVendor || bundledVendorEarly;
  // LITE-ГОЧА (иначе половина компонентов ломается): staging несёт артефакты ТОЛЬКО
  // СВОЕГО компонента, поэтому он ЗАСЛОНЯЕТ вшитый vendor. HM_VENDOR по-прежнему
  // указывает на staging (там лежат sha-проверенные байты этого компонента и копия
  // checksums.json — второй гейт), а вот пути к КОНКРЕТНЫМ файлам резолвим по факту
  // существования: есть в staging → берём оттуда, иначе → из bundled vendor. Без этого
  // pydeps в lite искал requirements.txt в staging pydeps (там его нет) и падал
  // «сначала установите конфиг», а nomad не видел nomad-src при чужом staging.
  const vendorPick = (rel) => {
    try {
      const inStaging = path.join(vroot, rel);
      if (fs.existsSync(inStaging)) return inStaging;
    } catch (e) { /* ignore */ }
    return path.join(bundledVendorEarly, rel);
  };
  // LITE-ГОЧА №2 (nomad): его архив несёт только исходники агента, а uv вшит в
  // установщик (bundled-only) и в staging не попадает НИКОГДА → nomad.ps1 не находил
  // $HM_VENDOR\apps\uv\uv.exe и уходил в `irm https://astral.sh/uv/install.ps1 | iex`
  // ПОД АДМИНОМ, обнуляя офлайн/sha-гарантию для байтов, физически лежащих внутри
  // установщика. Докладываем вшитый uv в staging этого компонента: источник —
  // read-only bundled vendor внутри exe, приёмник — Admins-only staging, новых окон
  // подмены нет, а второй гейт проходит (Confirm-HmArtifact резолвит по basename, и
  // uv.exe/uvx.exe есть в скопированном туда checksums.json).
  if (stagingVendor && id === 'nomad') {
    try {
      const uvSrc = path.join(bundledVendorEarly, 'apps', 'uv');
      const uvDst = path.join(stagingVendor, 'apps', 'uv');
      if (fs.existsSync(uvSrc) && !fs.existsSync(uvDst)) {
        fs.mkdirSync(path.dirname(uvDst), { recursive: true });
        fs.cpSync(uvSrc, uvDst, { recursive: true });
        logLine('[vendor] вшитый uv доложен в staging nomad (офлайн-путь uv.ps1 вместо онлайн-установки).');
      }
    } catch (e) { logLine('[vendor] не удалось доложить uv в staging: ' + String(e && e.message || e)); }
  }
  childEnv.HM_VENDOR = vroot;
  childEnv.HM_BUNDLED_CONFIG = vendorPick('config-pack');
  childEnv.HM_AGENT_DIR = path.join(resourceRoot(), 'agent');
  childEnv.HM_NOMAD_SRC = vendorPick('nomad-src');
  childEnv.HM_ASSETS = path.join(resourceRoot(), 'assets');
  // Секрет подписи маяка завершения курса — ТОЛЬКО из вшитого config.json, тем же
  // паттерном, что HM_VENDOR. Через renderer его пускать нельзя: renderer работает
  // под medium integrity, и скомпрометированный renderer подставил бы свой секрет
  // (install-env.js:12-16 запрещает это для всего класса URL/путей/ключей).
  // Пусто — курс поставится, маяк просто уйдёт без подписи (мягкий режим сервера).
  //
  // МЁРТВЫЙ МАЯК (починено 20.08.2026). Адрес маяка лежал в config.json
  // (course.beaconUrl) с самого начала, install-скрипты курса умеют его
  // разложить, подпись на сервере работает — но в childEnv переменную никто не
  // клал, поэтому `if ($env:HM_COURSE_BEACON_URL)` в course.ps1/course.sh был
  // ложным ВСЕГДА, блок completion_beacon в .course/config.yaml не появлялся, и
  // за всю историю не пришло НИ ОДНОГО сигнала «дошёл до конца курса».
  // Источник — тот же вшитый config.json, что и у секрета: через renderer такие
  // ключи не пускаем (install-env.js:12-16 — renderer работает под medium
  // integrity и подставил бы свой адрес элевейтед-скрипту).
  // Пустой beaconUrl по-прежнему означает «маяк выключен» — поведение сборки без
  // адреса не меняется.
  const courseCfg = readJson('config.json', {}).course || {};
  childEnv.HM_COURSE_BEACON_URL = String(courseCfg.beaconUrl || '').trim();
  childEnv.HM_COURSE_BEACON_SECRET = courseCfg.beaconSecret || '';
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
    // Координаты репозитория конфига — АВТОРИТЕТНО из вшитого config.json, НИКОГДА из
    // renderer'а (install-env пропускает любые HM_*, поэтому HM_CONFIG_REPO_URL/BRANCH
    // были renderer-управляемыми). Это обязательное условие того, что config попал в
    // SCRIPT_ONLINE_FALLBACK: онлайн-фолбэк config.ps1/config.sh делает `git clone` —
    // подменяемый URL означал бы клонирование чужого репозитория в ~/.claude.
    const appCfg = readJson('config.json', {});
    const repoUrl = String(appCfg.configRepoUrl || '');
    childEnv.HM_CONFIG_REPO_URL = /^https:\/\/github\.com\/JHamidun\//i.test(repoUrl)
      ? repoUrl : 'https://github.com/JHamidun/claude-code-config-pack';
    childEnv.HM_CONFIG_REPO_BRANCH = String(appCfg.configRepoBranch || 'main');
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
  // await, а НЕ голый return: иначе finally (снимающий замок _installBusy) сработал
  // бы СРАЗУ после возврата промиса, не дождавшись завершения дочернего процесса.
  return await new Promise((resolve) => {
    let child;
    logLine('=== start ===');
    try {
      // macOS: give the child its own process group so killChildren can reap the
      // whole tree (msiexec/pip/curl/hdiutil) via process.kill(-pid). On Windows
      // we kill the tree via taskkill /T instead, so no detached group is needed.
      // stdin ЗАКРЫТ (ignore) — это системная защита от зависания.
      // По умолчанию Node даёт ребёнку живой пайп на stdin, который никогда не получает
      // данных и никогда не закрывается. Любой инструмент, задавший вопрос, ждёт ответа
      // ВЕЧНО: человек видит бесконечный спиннер и решает, что всё сломалось. Ровно так
      // встала установка на 15 минут — unzip спросил «write error… Continue? (y/n/^C)».
      // С /dev/null на stdin вопрос получает EOF, инструмент честно падает, а шаг
      // показывает ошибку, которую видно и можно починить. Никто в stdin не пишет
      // (проверено), поэтому потерь нет.
      const spawnOpts = { env: childEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] };
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
    // Кольцевой буфер последних строк вывода — по нему при НЕуспехе строится
    // человеческое объяснение (failureExplain). Держим хвост, а не весь вывод:
    // pip/npm/cargo выдают десятки тысяч строк, а сигнатура причины всегда рядом
    // с концом. 400 строк с запасом перекрывают финальный блок ошибки.
    const TAIL_MAX = 400;
    const outTail = [];
    const emitLine = (l) => {
      if (!l.length) return;
      const ri = receipts.parseReceiptLine(l);
      if (ri) { logLine(l); return; }
      outTail.push(l);
      if (outTail.length > TAIL_MAX) outTail.shift();
      send(l);
      logLine(l);
    };
    // buf.toString() на КАЖДОМ чанке рвал многобайтовую кириллицу на границе чанка и
    // терял склейку незавершённой строки (обильный вывод pip/robocopy → «кракозябры»).
    // StringDecoder держит хвост многобайтовой последовательности, а tail — хвост строки.
    let lastOut = Date.now();
    const mkLineReader = () => {
      const dec = new (require('string_decoder').StringDecoder)('utf8');
      let tail = '';
      return {
        push: (buf) => {
          lastOut = Date.now();
          const parts = (tail + dec.write(buf)).split(/\r?\n/);
          tail = parts.pop();
          parts.forEach(emitLine);
        },
        flush: () => { const rest = tail + dec.end(); tail = ''; rest.split(/\r?\n/).forEach(emitLine); }
      };
    };
    const outR = mkLineReader();
    const errR = mkLineReader();
    child.stdout.on('data', (b) => outR.push(b));
    child.stderr.on('data', (b) => errR.push(b));
    // Watchdog БЕЗ убийства: msiexec/pip/playwright легально идут десятками минут, а
    // kill посреди MSI-транзакции хуже висяка. Но молчащий шаг без единого признака
    // жизни — это «установщик завис, что делать?»: раз в 10 минут честно говорим.
    let stallWarned = 0;
    const stallTimer = setInterval(() => {
      const mins = Math.floor((Date.now() - lastOut) / 60000);
      if (mins >= 10 && mins >= stallWarned + 10) {
        stallWarned = mins;
        // Текст намеренно НЕ называет одну причину: раньше здесь стояло «системный
        // установщик ждёт другую установку Windows», и на шаге «vscode» это уводило
        // в сторону — там ставится Inno Setup и расширения, а не MSI. Человек видел
        // уверенное объяснение, которое к его случаю не относилось.
        const m = '[внимание] шаг «' + id + '» не выдаёт вывод ' + mins + ' мин. ' +
          'Установка НЕ остановлена и продолжается. Так бывает, когда антивирус проверяет ' +
          'распаковку, идёт обновление Windows или машина медленная. Ждать стоит: шаг сам ' +
          'прервётся по своему лимиту. Закрывать окно (это остановит дочерние процессы) ' +
          'и запускать заново имеет смысл, только если ничего не меняется больше часа.';
        send(m); logLine(m);
      }
    }, 60000);
    if (stallTimer.unref) stallTimer.unref();
    child.on('error', (e) => {
      send(`[ERROR] ${e.message}`);
      logLine(`[ERROR] ${e.message}`);
    });
    child.on('close', (code) => {
      CHILDREN.delete(child);
      invalidatePathCache();   // скрипт мог дописать в PATH — перечитаем при следующей детекции
      try { clearInterval(stallTimer); } catch (e) { /* ignore */ }
      try { outR.flush(); errR.flush(); } catch (e) { /* ignore */ }  // последняя строка без \n
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
        let ver = (meta && meta.version) || '';
        try {
          const src = remoteCache ? 'remote' : (vendorAvailable() ? 'bundled' : 'online');
          // FIX #17: аддитивная переустановка config НЕ трогает уже изменённые базовые
          // файлы (robocopy /XC пропускает существующие), поэтому нельзя продвигать
          // записанную версию до currentVersion — иначе updateAvailable погаснет, а
          // базовый скилл со старым багом останется, и пользователь решит, что обновился.
          // Когда запуск был АДДИТИВНЫМ (HM_ADDITIVE='1') И обновление реально было
          // доступно (прежняя записанная версия строго старше currentVersion) — держим
          // прежнюю installedVersion. Тогда isOutdated() остаётся true и UI продолжает
          // предлагать «Переустановить начисто» (repair/clean реально применит обновление).
          if (id === 'config' && childEnv.HM_ADDITIVE === '1') {
            const prev = manifest.getEntry(os.homedir(), id);
            const prevVer = prev ? (prev.version || '') : '';
            if (prevVer && manifest.isOutdated(prevVer, ver)) {
              logLine('[manifest] config additive + доступно обновление (' + prevVer +
                ' → ' + ver + '): версию НЕ продвигаем, оставляем ' + prevVer +
                ' — updateAvailable сохраняется, нужна чистая переустановка (repair).');
              ver = prevVer;
            }
          }
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
      // win32: удаляем СВЕЖИЙ Admins-only кэш докачки (zip+распаковка) — компонент
      // отработал успешно, больше кэш не нужен. Best-effort. При НЕуспехе каталог
      // оставляем: повтор шага переиспользует уже скачанный sha-проверенный архив
      // (уборка гарантированно произойдёт на выходе, см. cleanupAllSecureDirs).
      if (okRun || skipped) cleanupSecureCache();
      // Graceful-skip (exit 120) ПОСЛЕ провала докачки — не «нечего ставить», а
      // «докачка не доехала, системный установщик тоже не сработал»: отдаём честную
      // сетевую ошибку (авто-ретрай + inline «Повторить»), а не тихое «пропущено».
      if (skipped && fetchFellBack) {
        resolve({ id, ok: false, code, stage: 'fetch',
          error: 'докачка не удалась (' + fetchFellBack + '), а системный установщик компонента недоступен' });
        return;
      }
      // ПРОВАЛ → переводим машинный вывод на человеческий ЗДЕСЬ, пока хвост под рукой.
      // Объяснение печатаем в лог/UI сразу (человек читает его на месте, а не ищет
      // причину в простыне из cargo/pip) и отдаём renderer'у в res.hint — он ставит
      // короткую подпись на шаге и кладёт вид причины в отчёт боту.
      if (!okRun && !skipped) {
        const why = failureExplain.explainScriptFailure(outTail);
        // ВЫЖИМКА строится ВСЕГДА, опознана причина или нет. До 20.08.2026 её не
        // было вовсе: если ни одно правило словаря не совпало, хвост выбрасывался,
        // и наружу уходил голый код возврата. В базе это дало 44 падения из 46,
        // записанных как «код 1» — по такой записи нельзя ни помочь человеку, ни
        // починить установщик. Теперь в отчёт всегда едут код, ЭТАП и последние
        // строки вывода; полный хвост остаётся в журнале на машине человека.
        const sum = failureExplain.summarizeFailure(outTail, { code, maxChars: 280, maxLines: 6 });
        if (why) {
          const head = '[почему] ' + why.short + ':';
          send(head); logLine(head);
          why.lines.forEach((l) => { const m = '  ' + l; send(m); logLine(m); });
        }
        // Блок «что именно упало» в журнал/UI: этап + отобранные строки. Человеку он
        // показывает, на каком шаге всё встало, а поддержке — куда смотреть, даже
        // когда причина словарём не опознана.
        if (sum.phase || sum.lines.length) {
          const h = '[что именно упало] шаг «' + id + '», код ' + code +
            (sum.phase ? ', этап: ' + sum.phase : '');
          send(h); logLine(h);
          sum.lines.forEach((l) => { const m = '  ' + l; send(m); logLine(m); });
        }
        resolve({
          id, ok: false, code, skipped: false,
          hint: why ? why.short : '',
          hintKind: why ? why.kind : '',
          hintLines: why ? why.lines : undefined,
          // error едет в отчёт (там его чистит scrubText и режет приёмник),
          // phase — в подпись шага. Сами строки вывода renderer'у отдельно НЕ шлём:
          // они уже ушли в его лог через send() выше, дубль был бы мёртвым полем.
          error: sum.oneLine,
          phase: sum.phase,
        });
        return;
      }
      // Skip — не провал: отдаём ok (как раньше отдавал exit 0), но с флагом skipped и
      // БЕЗ маркера установки. Реальный успех (код 0) → ok. Прочие коды → не ok.
      //
      // При пропуске (120) отдаём ПРИЧИНУ, а не только факт. Код 120 выдают 74 места в
      // скриптах, и причины у них несовместимые: «артефакт не вшит в эту сборку», «нет
      // сети», «winget не найден», «уже стоит чужая установка» — и, что важнее всего,
      // fail-closed отказы безопасности вроде «установщик не прошёл проверку подписи —
      // НЕ запускаю». Renderer подписывал их всех одинаково: «Не входит в эту сборку —
      // пропущено (это не ошибка)». Про отклонённую подпись человек так не узнавал
      // ничего, а это ровно тот случай, когда узнать нужно.
      //
      // Причину берём из последней содержательной строки вывода: скрипты печатают её
      // прямо перед exit 120 — это их собственное объяснение, а не наша догадка.
      let skipReason = '';
      if (skipped) {
        const lines = String(outTail || '').split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l && !/^\[(dry-run|debug)\]/i.test(l));
        skipReason = lines.length ? lines[lines.length - 1].slice(0, 240) : '';
      }
      resolve({ id, ok: okRun || skipped, code, skipped, skipReason });
    });
  });
  } finally {
    _installBusy = false;   // замок снимается ТОЛЬКО после реального завершения шага
  }
});

ipcMain.handle('open-external', (_e, url) => {
  // Renderer НЕ доверенный: без allowlist схем file:/UNC(file://host)/ms-msdt:/
  // search-ms:/HKCU-зарегистрированные хендлеры дали бы запуск произвольного через
  // elevated shell.openExternal. Пропускаем только веб/почту/telegram (нужны кнопкам).
  try {
    const u = new URL(String(url));
    if (['http:', 'https:', 'mailto:', 'tg:'].includes(u.protocol)) {
      shell.openExternal(u.href);
      return true;
    }
  } catch (e) { /* невалидный url */ }
  return false;
});

// ---- телеметрия установки (opt-out чекбоксом на экране выбора) ----
// НЕ анонимная, если человек пришёл по персональной ссылке бота: тогда отчёт везёт
// uid (его идентификатор в Telegram), иначе бот не сможет помочь адресно. Свободные
// тексты ошибок чистятся scrubText. Событие, платформа, исход, id упавших компонентов и
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
    // Тип события задаёт renderer, но ТОЛЬКО из закрытого списка — иначе IPC становится
    // генератором произвольных событий в воронке.
    const EVENTS = ['installed', 'install_started', 'open_editor'];
    const event = EVENTS.indexOf(String(p.event || 'installed')) !== -1 ? String(p.event) : 'installed';
    // ids: только компонентные id (латиница/цифры/_/-), ≤20 штук, ≤64 символа.
    const ids = (v) => (Array.isArray(v)
      ? v.slice(0, 20).map((s) => String(s).slice(0, 64).replace(/[^A-Za-z0-9_-]/g, '-'))
      : []);
    const body = JSON.stringify({
      event,
      platform: IS_WIN ? 'win' : 'mac',
      // uid определяет ГЛАВНЫЙ процесс (имя файла/файл рядом/env) — renderer его задать
      // не может: иначе он бы приписывал установки чужим людям.
      uid: INSTALL_UID || null,
      edition: isLiteEdition() ? 'lite' : 'offline',
      ok: !!p.ok,
      failed: ids(p.failed),
      skipped: ids(p.skipped),
      selected: ids(p.selected),
      // Почему упало — иначе бот видит «упал git» и не знает, сеть это, права или
      // целостность, а именно это определяет совет человеку. Тексты чистятся от ПД
      // (имя пользователя и домашний каталог) в scrubText.
      errors: Array.isArray(p.errors)
        ? p.errors.slice(0, 10).map((e) => ({
          id: String((e && e.id) || '').slice(0, 64).replace(/[^A-Za-z0-9_-]/g, '-'),
          stage: String((e && e.stage) || '').slice(0, 24).replace(/[^a-z-]/g, ''),
          error: scrubText(String((e && e.error) || '')).slice(0, 300),
        }))
        : [],
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
  // Renderer НЕ доверенный: без confine он мог бы попросить открыть \\attacker\share\x.exe
  // или подсаженный в user-writable путь → shell.openPath запустит его под АДМИНОМ.
  // Разрешаем ТОЛЬКО доверенные цели: install.log, памятку «Что дальше» на столе,
  // файлы внутри ресурсов установщика (вшитый START-HERE.html).
  try {
    const rp = path.resolve(String(p));
    const root = path.resolve(resourceRoot());
    const desktopMemo = path.join(app.getPath('desktop'), 'Что дальше — Hamidun.html');
    const allowed = rp === path.resolve(LOG_PATH) || rp === desktopMemo || rp.startsWith(root + path.sep);
    if (!allowed) return { ok: false, error: 'bad-path' };
    const err = await shell.openPath(rp);
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
    // Проверяем НАЗНАЧЕНИЕ, а не только источник. Раньше здесь был голый
    // copyFileSync: имя на рабочем столе фиксированное и известное заранее, и
    // если по нему заранее подложить symlink или hardlink на чужой файл, копия
    // пойдёт ПО ССЫЛКЕ и затрёт его содержимое HTML-памяткой. Установщик при
    // этом местами работает с правами администратора — тогда запись уйдёт туда,
    // куда обычный пользователь не дотянулся бы.
    //
    // lstat, а не existsSync: последний идёт ПО ссылке и о самой ссылке молчит.
    // Отсутствие файла — норма (первый запуск), обычный файл — норма (повторное
    // сохранение перезаписывает нашу же памятку). Всё остальное — отказ.
    let dst = null;
    try { dst = fs.lstatSync(dest); } catch (e) {
      if (!e || e.code !== 'ENOENT') {
        return { ok: false, dest: '', src, error: 'dest-stat: ' + ((e && e.code) || e) };
      }
    }
    if (dst && !dst.isFile()) {
      return { ok: false, dest: '', src, error: 'dest-not-regular-file' };
    }
    // Hardlink от обычного файла НЕ отличается ни lstat-ом, ни stat-ом: тип тот
    // же, флага нет. Единственный признак — счётчик жёстких ссылок: у честного
    // файла он равен единице, у второго имени того же содержимого — больше.
    // Без этой строки проверка выше ловила бы только symlink, то есть половину
    // случая, и читалась бы как полная защита.
    if (dst && dst.nlink > 1) {
      return { ok: false, dest: '', src, error: 'dest-hardlinked' };
    }
    fs.copyFileSync(src, dest);
    return { ok: true, dest, src };
  } catch (e) {
    // src отдаём и при ошибке — renderer откроет вшитую копию как фолбэк.
    return { ok: false, dest: '', src, error: e.message };
  }
});

// Встроенный просмотр памятки «Что дальше» прямо в окне установщика: отдаём
// содержимое вшитого START-HERE.html строкой. Путь считаем ТОЛЬКО здесь из
// вшитого config.json (renderer НЕ доверенный и путь не передаёт — тот же
// принцип, что у save-start-here выше: IPC с путём из renderer'а дал бы
// произвольное чтение файлов из elevated-процесса) и проверяем, что цель
// не вышла из ресурсов. Ошибки не бросаем — honest {ok:false,error}.
ipcMain.handle('read-start-here', () => {
  try {
    const cfg = readJson('config.json', {});
    const rel = String((cfg.finish && cfg.finish.startHtmlRelPath) || 'assets/START-HERE.html');
    const root = path.resolve(resourceRoot());
    const src = path.resolve(root, rel);
    if (!src.startsWith(root + path.sep)) return { ok: false, html: '', error: 'bad-path' };
    if (!fs.existsSync(src)) return { ok: false, html: '', error: 'source-missing' };
    return { ok: true, html: fs.readFileSync(src, 'utf8'), error: '' };
  } catch (e) {
    return { ok: false, html: '', error: e.message };
  }
});

// Reveal a file in Explorer/Finder (openPath on a .env silently fails on macOS
// where .env has no default app — showItemInFolder always works).
// Renderer НЕ доверенный: путь из него НЕ принимаем (как в open-path/open-external/
// save-start-here). Иначе elevated shell.showItemInFolder биндил бы shell-namespace
// на \\attacker\share (UNC/WebDAV, HKCU-shell-extension). Легитимная цель ровно одна —
// файл ключей из вшитого config.json; собираем её здесь, аргумент игнорируем.
ipcMain.handle('reveal-path', () => {
  try {
    const cfg = readJson('config.json', {});
    const rel = String((cfg.finish && cfg.finish.credentialsRelPath) || '.claude/.credentials.master.env');
    const home = path.resolve(os.homedir());
    const target = path.resolve(home, rel);
    if (!target.startsWith(home + path.sep)) return false;   // rel с ../ или UNC
    if (!fs.existsSync(target)) return false;
    shell.showItemInFolder(target);
    return true;
  } catch (e) { return false; }
});

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
// Последняя причина отказа защищённого staging — чтобы в журнале и в тексте ошибки
// стояла ПРАВДА, а не «сеть оборвалась». Пишется только из winMakeSecureDir.
let lastSecureDirError = '';

// Вычисление пути для сноса staging и сам снос живут в src/staging-paths.js:
// это код с ценой ошибки «стёрли чужой каталог под админом», и он обязан
// проверяться тестом напрямую, а не через выковыривание функции из этого файла.
// Гейт по имени HmDeElev-<32 hex> — там же (зеркало Remove-HmSecureStagingDir).

async function winMakeSecureDir() {
  // Сбрасываем на КАЖДОМ входе. Иначе причина от прошлого отказа доживает до следующего
  // и приклеивается к другому компоненту: половина веток возвращает null молча, и в
  // тексте шага оказалась бы чужая, уже неверная причина — ровно то, ради чего эта
  // диагностика и заводилась.
  lastSecureDirError = '';
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
    // PSModulePath ПРИБИВАЕМ литералом к System32\WindowsPowerShell\v1.0\Modules.
    // Две причины, обе кусаются:
    //  1) если установщик запущен из окружения PowerShell 7 (терминал pwsh, CI-раннер),
    //     унаследованный PSModulePath указывает на модули ...\PowerShell\7\Modules —
    //     .NET Core-сборки, которые powershell.exe 5.1 ЗАГРУЗИТЬ НЕ МОЖЕТ. Autoload
    //     Microsoft.PowerShell.Security падает, примитив уходит в $null, и lite не качает
    //     НИ ОДНОГО компонента. Снаружи (запуск из Explorer) всё работает — поэтому
    //     ручные прогоны этого не ловили, поймал только E2E на раннере.
    //  2) PSModulePath пишется medium-малварью того же юзера (HKCU\Environment) и является
    //     штатным вектором module-hijack в elevated-процессе.
    const s32 = path.dirname(path.dirname(path.dirname(ps)));   // ...\System32 из валидированного powershell.exe
    const psmLit = path.join(s32, 'WindowsPowerShell', 'v1.0', 'Modules').replace(/'/g, "''");
    const inline =
      // Кодировку консоли задаём ПЕРВОЙ командой. powershell 5.1 пишет stdout и stderr
      // в кодовой странице консоли (CP866 на русской Windows), а Node читает трубу как
      // UTF-8 — и причина отказа («Отказано в доступе») приезжала пользователю, в лог и
      // в телеметрию кракозябрами. Для компонентных скриптов это уже делается (см. выше).
      "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;" +
      "$OutputEncoding=[System.Text.Encoding]::UTF8;" +
      "$ErrorActionPreference='Stop';" +
      "$env:PSModulePath='" + psmLit + "';" +
      ". '" + deLit + "';" +
      "$d=New-HmSecureStagingDir -ProgramData '" + pdLit + "' -Icacls '" + icLit + "' -Elevated $true;" +
      "if($d){[Console]::Out.Write('HMSECDIR::'+$d+'::END')}";
    // АСИНХРОННО (spawn, не spawnSync). Каталог рождается на КАЖДЫЙ докачиваемый артефакт,
    // а старт powershell.exe — это секунды; синхронный вызов морозил главный процесс, и окно
    // установщика переставало отвечать на каждом компоненте (прогресс замирал, клики
    // копились). Ждём результат через промис — UI живёт.
    // Читаем stderr, а не только stdout: примитив на отказе НЕ бросает, он возвращает $null
    // и пишет причину (HMSECFAIL) в stderr. Раньше причина молча терялась, и пользователь
    // получал бесполезное «примитив не вернул путь».
    const r = await new Promise((resolve) => {
      let so = '', se = '', settled = false;
      const done = (res) => { if (!settled) { settled = true; resolve(res); } };
      let child;
      try {
        // env — ДОВЕРЕННЫЙ, а не унаследованный. Инлайн-присваивание $env:PSModulePath
        // закрывает только подмену модулей, но НЕ COR_ENABLE_PROFILING/COR_PROFILER/
        // COR_PROFILER_PATH: их CLR читает при старте хоста, ДО разбора строки -Command.
        // medium-малварь того же юзера пишет их в HKCU\Environment — и получает
        // загрузку своей DLL в powershell.exe, запущенный НАМИ под администратором.
        child = spawn(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', inline],
          { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: detectSpawnEnv() });
      } catch (e) { return done({ error: e }); }
      const kill = setTimeout(() => { try { child.kill(); } catch (e) { /* */ } done({ stdout: so, stderr: se || 'таймаут примитива (20 с)' }); }, 20000);
      child.stdout.on('data', (d) => { so += String(d); });
      child.stderr.on('data', (d) => { se += String(d); });
      child.on('error', (e) => { clearTimeout(kill); done({ error: e }); });
      child.on('close', () => { clearTimeout(kill); done({ stdout: so, stderr: se }); });
    });
    const out = String((r && r.stdout) || '');
    // Берём ПОСЛЕДНЮЮ строку HMSECFAIL: их может быть несколько (посторонние ACE
    // перечисляются по одному), и последняя — та, что решила исход.
    const errLines = String((r && r.stderr) || '').trim().split(/\r?\n/).filter(Boolean);
    const secFail = errLines.filter((l) => /HMSECFAIL/.test(l)).pop() || '';
    if (r && r.error) {
      lastSecureDirError = String(r.error.message || r.error).slice(0, 300);
      return null;
    }
    const m = /HMSECDIR::([\s\S]+?)::END/.exec(out);
    if (!m) {                                          // примитив вернул $null -> fail-closed
      lastSecureDirError = (secFail || errLines[errLines.length - 1]
        || 'примитив не вернул путь (проверка владельца/ACL не прошла)').replace(/^HMSECFAIL:\s*/, '').slice(0, 300);
      return null;
    }
    const dir = m[1].trim();
    if (!dir) return null;
    const rm = () => rmStagingTree(dir);
    // Defense-in-depth: путь строго под ProgramData, каталог существует, owner=Admins и
    // никаких посторонних ACE (SID-based). Примитив уже верифицировал — перепроверяем.
    const root = path.resolve(pd);
    // Путь ВНЕ ProgramData — отказываемся и НИЧЕГО не трогаем.
    //
    // Здесь стоял `rm()`, и это было наоборот: ветка, которая обнаружила путь не там,
    // где ему положено быть, отвечала на находку РЕКУРСИВНЫМ УДАЛЕНИЕМ этого пути под
    // админом. Проверка на выход за границу превращалась в примитив «снести каталог,
    // оказавшийся не нашим» — то есть страховка работала ровно против своей цели.
    // Правильный ответ на «путь не наш» — не удалять его, а отказаться.
    if (!path.resolve(dir).startsWith(root + path.sep)) {
      lastSecureDirError = 'примитив вернул путь вне %ProgramData% — каталог не тронут';
      return null;
    }
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
async function winLaunchDeElevated(exe, folderArg) {
  const sysRoot = remoteFetch.winSystemRoot() || process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  // Fallback: открыть ПАПКУ (не exe) в explorer — medium integrity, наследует токен shell.
  // Возвращаем 'explorer', а НЕ true: открылась папка, редактор не запускался.
  //
  // Контракт «true = редактор, 'explorer'/'finder' = только папка» уже соблюдён и в
  // launchVsCodeOn (ветка без редактора), и в обработчике launch-course, который под
  // 'explorer' печатает отдельный текст — файлы видно, но наставник не подхватится.
  // Ломало его ровно это место: фолбэк отдавал true, и правильный обработчик получал
  // ложь на входе. Человеку рапортовали «редактор открыт», в телеметрию уходило
  // open_editor как успех, а на экране был Проводник. Сюда приходят не редкие случаи:
  // отключённый UAC, сломанный планировщик, отказ создать задачу — всё, где
  // де-элевированный запуск невозможен.
  const folderFallback = () => {
    try {
      const exp = path.join(sysRoot, 'explorer.exe');
      if (folderArg && fs.existsSync(exp)) {
        spawn(exp, [String(folderArg)], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
        return 'explorer';
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
  const dir = await winMakeSecureDir();
  if (!dir) { return done(folderFallback()); }        // не заперли staging -> fail-closed на папку
  const xmlFile = path.join(dir, 'task.xml');
  function runSchtasks(args) {
    // env доверенный: schtasks — тот же класс привилегированного вызова, что и
    // powershell выше (унаследованное окружение = вектор подсадки через COR_*).
    try { execFileSync(schtasks, args, { windowsHide: true, timeout: 20000, stdio: 'ignore', env: detectSpawnEnv() }); return true; }
    catch (e) { return false; }
  }
  const cleanup = () => {
    try { runSchtasks(['/Delete', '/TN', tag, '/F']); } catch (e) { /* */ }
    rmStagingTree(dir);
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
        { encoding: 'utf8', windowsHide: true, timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'], env: detectSpawnEnv() });
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
      // ЗАПАСНОЙ РЕДАКТОР — CURSOR. Установщик предлагает оба редактора на выбор, и
      // человек вправе снять VS Code, оставив Cursor. Раньше здесь искался ТОЛЬКО
      // Code.exe, и у такого человека кнопка «Открыть курс-симулятор» молча ничего не
      // делала, а подсказка врала про «папка курса не найдена» — папка была на месте,
      // не было редактора. Именно так это и выглядело у ученика первой группы:
      // «кнопка есть, но не приводит ни к чему».
      const cursorExe = firstExisting([
        path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'cursor', 'Cursor.exe'),
        path.join(winPF(), 'cursor', 'Cursor.exe')
      ]);
      if (cursorExe) { return winLaunchDeElevated(cursorExe, dir); }
      // Редактора нет вовсе — открываем папку в проводнике. Это не «как задумано», но
      // человек хотя бы видит файлы курса и понимает, куда идти, вместо пустого клика.
      try {
        const r = spawnSync('explorer.exe', [dir], { stdio: 'ignore', timeout: 10000 });
        // explorer.exe возвращает 1 даже при успешном открытии — код игнорируем осознанно.
        if (r) return 'explorer';
      } catch (e) { /* ниже вернём false */ }
      return false;
    } else if (IS_MAC) {
      // open -a "Visual Studio Code" "<папка>" — открывает папку в IDE. `open` запускает
      // цель от имени пользователя (macOS не эскалирует integrity как Windows).
      // #7: `open -a` возвращает НЕнулевой код, если приложения нет НИГДЕ (LaunchServices
      // ищет по всему диску, не только /Applications), и при этом НЕ запускает ничего.
      // spawnSync даёт честный код синхронно: не врём true (нет .app) и не врём false
      // (VS Code в нестандартном месте вроде ~/Downloads — pre-check по путям его бы
      // пропустил). Раньше fire-and-forget spawn всегда возвращал true. open отдаёт
      // управление быстро (хендофф в LaunchServices), main-поток блокируется кратко.
      const r = spawnSync('/usr/bin/open', ['-a', 'Visual Studio Code', dir],
        { stdio: 'ignore', timeout: 15000 });
      if (r.status === 0) return true;
      // Тот же запасной путь, что и на Windows: человек мог выбрать Cursor вместо
      // VS Code — тогда открываем в нём, а если редактора нет вовсе, показываем папку
      // в Finder. Пустой клик — худший из возможных исходов.
      const rc = spawnSync('/usr/bin/open', ['-a', 'Cursor', dir],
        { stdio: 'ignore', timeout: 15000 });
      if (rc.status === 0) return true;
      const rf = spawnSync('/usr/bin/open', [dir], { stdio: 'ignore', timeout: 10000 });
      return rf.status === 0 ? 'finder' : false;
    }
  } catch (e) { /* ignore */ }
  return false;
}

ipcMain.handle('launch-vscode', () => launchVsCodeOn(path.join(os.homedir(), 'HamidunStart')));

// Приём ключа Nomad ПОСЛЕ установки.
//
// До этого ключ попадал в config.yaml единственным путём: env HM_NOMAD_CLOUD_KEY на
// момент запуска nomad.ps1/nomad.sh. А человек заводит ключ в кабинете уже ПОСЛЕ
// установки — финиш сам его туда и посылает («получи ключ и вставь его»). Вставить
// было некуда: поля нет, а `nmd model` — интерактивная консоль, про которую на экране
// ни слова. На видео тестировщик дошёл до выданного nmd_-ключа и встал.
//
// Пишем ровно тот же управляемый блок и теми же тремя регулярками, что и nomad.ps1:275
// — иначе повторный прогон установщика получит два блока model: и YAML-парсер возьмёт
// последний. Сама запись живёт в `src/nomad-key.js`: отсюда её было не позвать тестом
// (main.js требует electron), и фича годами оставалась без единой проверки — это
// отдельная строка в реестре рисков (4.2).
ipcMain.handle('nomad-set-key', (_e, key) =>
  nomadKey.writeNomadKey(key, { config: readJson('config.json', {}) }));

// Explicit «open the course-simulator» — NOT auto-opened; the finish screen
// offers it as a labelled choice. Opens the course folder in VS Code so Claude
// Code picks up the mentor CLAUDE.md; the user then types «начать» to activate
// the course-driver. Only if the course actually installed (folder exists) —
// we never create an empty course dir.
// async — ОБЯЗАТЕЛЬНО, и вот почему. На Windows launchVsCodeOn возвращает
// результат winLaunchDeElevated, а та объявлена `async` (строка ~1799), то есть
// отдаёт Promise. Синхронное сравнение `r === true` ниже с Promise не сходится
// НИКОГДА: редактор при этом честно открывается (обещание уже исполняется), а
// человеку интерфейс отвечает «редактор не найден». Кнопка работает, ответ врёт.
//
// На macOS ветка синхронная, поэтому дефект был виден только на Windows — и
// только вживую: main.js в юнит-тестах не грузится (требует electron), а E2E
// гоняется на mac-раннере. Чтение кода тоже не помогало: `r === true` выглядит
// правильным ровно до того момента, когда посмотришь на объявление вызываемой.
ipcMain.handle('launch-course', async () => {
  const cfg = readJson('config.json', {});
  const raw = (cfg.course && cfg.course.targetDirDefault) || '';
  // resolveCourseTarget зеркалит course.ps1/course.sh: expand %USERPROFILE% на Win,
  // защита от Windows-пути на macOS (иначе `/Users/x\HamidunCourse` — папки нет, B1).
  const target = uninstallTargets.resolveCourseTarget(raw, os.homedir(), process.platform);
  // Курс распаковывается в <target>/vibecoding-course/ — именно там CLAUDE.md
  // наставника (course.ps1:87). Открываем ЕЁ, а не родителя, иначе «начать»
  // подхватит ванильный Claude без наставника (B2). CLAUDE.md — финальный признак.
  const dir = path.join(target, 'vibecoding-course');
  // РАЗЛИЧАЕМ ПРИЧИНЫ ОТКАЗА. Раньше все три случая возвращали одинаковый false, и
  // интерфейс на любой из них печатал «Папка курса не найдена — курс не входил в эту
  // сборку». Для человека, у которого папка есть, а редактора нет, это прямая
  // дезинформация: он идёт переустанавливать курс, которого и так на месте.
  // Возвращаем строку-причину; renderer печатает под неё свой текст.
  try {
    if (!fs.statSync(dir).isDirectory()) return { ok: false, reason: 'no-dir', dir };
    if (!fs.existsSync(path.join(dir, 'CLAUDE.md'))) return { ok: false, reason: 'no-mentor', dir };
  } catch (e) { return { ok: false, reason: 'no-dir', dir }; }

  const r = await launchVsCodeOn(dir, { create: false });
  if (r === true) return { ok: true, how: 'editor', dir };
  // Папка открыта в проводнике/Finder — это успех с оговоркой: файлы человек видит,
  // но наставник не подхватится, пока он не откроет папку редактором.
  if (r === 'explorer' || r === 'finder') return { ok: true, how: r, dir };
  return { ok: false, reason: 'no-editor', dir };
});

// ---- «Войти в Claude» — открыть терминал с командой claude -----------

// The install scripts just added git/node/claude to PATH, but this (already
// running) Electron process still carries the stale PATH. Re-read Machine +
// User PATH from the registry and add the places `claude` lands in.
function regQueryValue(keyPath, valueName) {
  // Через .NET, а не через консольный вывод reg.exe: тот печатает в кодовой
  // странице консоли (CP866 на русской Windows), и путь вида
  // C:\Users\Жемал\AppData\... приезжал сюда мусором — собранный PATH получался
  // с битыми записями, и claude из терминала не находился.
  // У regQueryValueTyped есть таймаут: без него зависший запрос (агрессивный
  // AV/EDR, повреждённый куст) морозил бы main-процесс навсегда.
  const r = regQueryValueTyped(keyPath, valueName);
  return (r && r.ok && r.found) ? String(r.data || '').trim() : '';
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
  // ОДИН запуск интерпретатора на оба значения вместо двух. Раньше это были
  // два отдельных спавна, и на старте окно замирало на секунды.
  const readBoth = () => regQueryManyDotNet([
    { key: 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', name: 'Path' },
    { key: 'HKCU\\Environment', name: 'Path' },
  ]);
  let got = readBoth();
  // Сбой транспорта роняет ОБА значения разом (winPsPayload при таймауте/пустом
  // ответе возвращает ok:false на весь пакет). Даём один ретрай — единичный
  // ETIMEDOUT под нагрузкой не должен ослеплять детекцию на весь сеанс.
  if (got.some((r) => !r || !r.ok)) got = readBoth();
  // Различаем «прочитали и там пусто» и «НЕ СМОГЛИ прочитать». Второе — НЕ
  // результат: без машинной ветки git/node/python становятся невидимы, и
  // компоненты показываются неустановленными. Признак неполноты обязан дойти до
  // вызывающего (иначе «не смог прочитать» неотличимо от «не установлено»), и
  // огрызок нельзя кэшировать. Сбой реален: заблокированный политикой/EDR
  // powershell.exe, таймаут, повреждённый куст.
  const failed = got.some((r) => !r || !r.ok);
  const val = (r) => (r && r.ok && r.found) ? String(r.data || '').trim() : '';
  const machine = expandWinEnv(val(got[0]));
  const user = expandWinEnv(val(got[1]));
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
  // Прежней строки `if (!joined) joined = process.env.PATH` тут БОЛЬШЕ НЕТ: она
  // была мёртвой (два push выше делают parts непустым всегда) и создавала ложное
  // ощущение защищённости. Наследовать process.env под элевацией нельзя —
  // medium-процесс мог бы подсунуть чужой ProgramFiles (см. buildInstallEnv).
  return { path: parts.join(';'), partial: failed };
}

// ---- кэши ОДНОГО прохода детекции --------------------------------------
// Кэшировать на весь процесс НЕЛЬЗЯ: PATH меняется ПОСЛЕ установки, и пере-детекция
// (renderer зовёт detect-state снова) обязана читать свежий реестр. Поэтому кэш
// сбрасывается в начале КАЖДОГО прохода detectComponents: внутри прохода 8-10 пар
// спавнов reg.exe схлопываются в одну, а Get-Acl по одному и тому же бинарю — в один.
let _detPathCache = '';
let _detOwnerCache = null;
// Прочитали ли системный PATH последним проходом детекции. false = чтение реестра
// не удалось, и «не установлено» на экране может означать «не смог посмотреть».
// Признак уезжает в detect-state, а renderer показывает честный баннер вместо
// молчаливого «переустанови всё поверх рабочего».
let _lastPathReadOk = true;
// PATH из реестра НЕ сбрасываем на каждом проходе детекции: чтение стоит
// запуска интерпретатора, а сам PATH меняется только когда МЫ что-то ставим
// или удаляем. Раньше он перечитывался при каждом проходе, и это была часть
// той самой заморозки окна. Явный сброс — invalidatePathCache() после
// установки/удаления компонента.
function detResetCaches() { _detOwnerCache = new Map(); }
function invalidatePathCache() { _detPathCache = ''; }
function lastPathReadOk() { return _lastPathReadOk; }
function freshWindowsPathCached() {
  if (_detPathCache) return _detPathCache;
  const r = freshWindowsPath();
  _lastPathReadOk = !r.partial;
  // НЕПОЛНЫЙ результат НЕ кэшируем: иначе один сбой чтения реестра замораживал
  // огрызок PATH на весь сеанс, компоненты показывались неустановленными, и
  // «перепроверить» ничего не меняло. Следующий проход попробует заново.
  if (!r.partial) _detPathCache = r.path;
  return r.path;
}

// Окружение для ДЕТЕКЦИОННЫХ спавнов (Windows). Установщик elevated, поэтому
// наследовать process.env нельзя: HKCU\Environment пишется medium-малварью того же
// юзера, а интерпретаторы/хосты исполняют код из env (PYTHONPATH/PYTHONSTARTUP →
// import чужого .py; PSModulePath/COR_PROFILER → загрузка в powershell.exe). Здесь —
// авторитетные системные значения (валидированный SystemRoot, не из env) + профильные
// пути, которые НУЖНЫ для корректной детекции (python user site-packages ставится
// `pip install --user` в %APPDATA%). Никаких PYTHON*/NODE_OPTIONS/GIT_*/COR_* внутрь.
function detectSpawnEnv() {
  const root = remoteFetch.winSystemRoot() || process.env.SystemRoot || 'C:\\Windows';
  const s32 = path.join(root, 'System32');
  const out = {
    SystemRoot: root,
    windir: root,
    SystemDrive: (path.parse(root).root || 'C:\\').replace(/[\\/]+$/, ''),
    PATH: s32, Path: s32,
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    PSModulePath: path.join(s32, 'WindowsPowerShell', 'v1.0', 'Modules')
  };
  for (const k of ['USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'USERNAME']) {
    if (process.env[k] !== undefined) out[k] = process.env[k];
  }
  return out;
}

ipcMain.handle('open-claude-terminal', async () => {
  try {
    if (IS_WIN) {
      const startDir = path.join(os.homedir(), 'HamidunStart');
      try { fs.mkdirSync(startDir, { recursive: true }); } catch (e) { /* EEXIST — не критично */ }
      // #6: НЕ spawn cmd напрямую из elevated-процесса. Иначе (1) вся ПЕРВАЯ сессия
      // Claude у новичка идёт с ПРАВАМИ АДМИНА (high integrity — тот же integrity-
      // escalation, что закрыт для Code.exe через winLaunchDeElevated), (2) cwd
      // наследуется от установщика = %TEMP%-распаковка portable-exe → «куда делись
      // мои файлы» + claude просит доверие к странной папке, (3) drag&drop файлов в
      // elevated-окно не работает (UIPI). Решение: .cmd-лаунчер с фиксированным cwd,
      // запущенный через explorer.exe — тот стартует цель medium-токеном shell
      // (де-элевация), как folderFallback в winLaunchDeElevated.
      const sysRoot = remoteFetch.winSystemRoot() || process.env.SystemRoot || process.env.windir || 'C:\\Windows';
      const exp = path.join(sysRoot, 'explorer.exe');
      const launcher = path.join(startDir, 'claude-start.cmd');
      // cwd фиксируем в HamidunStart; canonical-локации claude (~/.local/bin,
      // %APPDATA%\npm) префиксуем к PATH — %USERPROFILE% cmd раскроет в рантайме
      // под ДЕ-элевированным (интерактивным) пользователем.
      // %USERPROFILE%/%ProgramFiles% раскрываются в РАНТАЙМЕ под ДЕ-элевированным
      // (интерактивным) юзером — не бейкаем абсолютные пути os.homedir() (в over-the-
      // shoulder это был бы профиль АДМИНА). where claude — авторитетная проверка в
      // контексте запуска: нет claude → сообщение + pause (окно НЕ схлопывается за долю
      // секунды, как было бы с голым `claude`). nodejs в PATH — claude.cmd требует node.
      const cmdBody = '@echo off\r\n' +
        'cd /d "%USERPROFILE%\\HamidunStart"\r\n' +
        'set "PATH=%USERPROFILE%\\.local\\bin;%USERPROFILE%\\AppData\\Roaming\\npm;%ProgramFiles%\\nodejs;%PATH%"\r\n' +
        'title Claude Code\r\n' +
        'where claude >nul 2>nul || (echo Claude Code не найден. Запусти установщик заново и отметь компонент "Claude Code". & echo. & pause & exit /b 1)\r\n' +
        'claude\r\n' +
        'if errorlevel 1 pause\r\n';
      try { fs.writeFileSync(launcher, cmdBody, 'utf8'); } catch (e) { return false; }
      if (fs.existsSync(exp)) {
        spawn(exp, [launcher], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
        return true;
      }
      // Фолбэк (explorer недоступен, крайне редко): НЕ запускаем claude под elevated-
      // токеном с user-writable PATH (freshPath несёт ~/.local/bin, %APPDATA%\npm →
      // claude.cmd юзера выполнился бы под АДМИНОМ). Возвращаем false → renderer покажет
      // ручную инструкцию «открой обычный терминал и набери claude».
      return false;
    }
    if (IS_MAC) {
      // #3: НЕ fire-and-forget с вечным true. На hardened-runtime без Apple-Events-
      // entitlement (добавлен в build/entitlements.mac.plist) событие отклонилось бы
      // (-1743), на ad-hoc сборке юзер мог нажать «Не разрешать» — тогда osascript
      // выходит НЕнулевым. Возвращаем честный результат → renderer покажет подсказку.
      // АСИНХРОННО (main-loop НЕ морозим) + БОЛЬШОЙ таймаут: первый клик упирается в
      // TCC-диалог «управлять Терминалом», который osascript ждёт, пока юзер читает и
      // жмёт «Разрешить». false — ТОЛЬКО по реальному ненулевому коду, НЕ по короткому
      // таймауту (иначе врали бы «не дал разрешение», пока диалог ещё на экране).
      return await new Promise((resolve) => {
        let settled = false;
        const done = (v) => { if (!settled) { settled = true; resolve(v); } };
        let child;
        try {
          child = spawn('/usr/bin/osascript', [
            '-e', 'tell application "Terminal" to activate',
            '-e', 'tell application "Terminal" to do script "claude"'
          ], { stdio: 'ignore' });
        } catch (e) { return done(false); }
        child.on('error', () => done(false));
        child.on('close', (code) => done(code === 0));
        setTimeout(() => done(false), 120000); // renderer не ждёт вечно, но переживает TCC-диалог
      });
    }
  } catch (e) { /* ignore */ }
  return false;
});

// ---- мини-визард ключей: merge в ~/.claude/.credentials.master.env ----
// Существующие `KEY=…` заменяются НА МЕСТЕ, недостающие дописываются в конец;
// ничего другого не удаляется и не переставляется. Само слияние живёт в
// `src/credentials-merge.js` — здесь его было не позвать тестом, а цена ошибки
// тут все ключи человека разом, без бэкапа.
ipcMain.handle('save-credentials', (_e, obj) => credentialsMerge.saveCredentials(obj));

// ---- Фаза 2: детекция состояния компонентов (ГРУНД-ТРУТ) --------------
// «Установлен ли X?» решаем ЖИВОЙ проверкой (fs.existsSync / запуск бинаря),
// НИКОГДА не манифестом. Манифест даёт лишь версию для показа/сравнения обновлений.
// Кросс-платформенно (win + mac). Read-only: ничего не пишет, безопасно в dry-run.

// Windows Program Files — НЕ из env: значение попадает в extraDirs резолвинга бинарей,
// а результат резолвинга запускается под elevated-токеном (probeVersion). Подменённый
// HKCU\Environment\ProgramFiles поставил бы каталог атакующего ПЕРВЫМ в порядке поиска.
// Выводим из валидированного системного корня. Цена: у admin'а, перенёсшего Program Files
// на другой диск, компонент может не задетектиться → предложим переустановку (скрипты
// идемпотентны) — безопасный ложно-отрицательный вместо запуска чужого бинаря.
function winSysDrive() {
  try { return path.parse(remoteFetch.winSystemRoot() || 'C:\\Windows').root || 'C:\\'; }
  catch (e) { return 'C:\\'; }
}
function winPF() { return path.join(winSysDrive(), 'Program Files'); }
function winPF86() { return path.join(winSysDrive(), 'Program Files (x86)'); }
function winLocalAppData() { return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'); }

// БЕЗОПАСНОСТЬ (детекция под ELEVATED-токеном): путь ведёт в admin-owned корень
// (Program Files / System32 / Windows)? Medium-юзер туда писать не может → запускать
// бинарь оттуда для probe-версии безопасно. Всё прочее (LOCALAPPDATA/APPDATA/home/
// WindowsApps) — user-writable: medium-малварь того же юзера подсадила бы туда fake
// (git.exe/node.exe/python.exe/uv.exe) на PATH и получила бы RCE под АДМИНОМ при
// авто-детекции на старте. Такие бинари НЕ запускаем (детект по существованию цел).
// КРИТИЧНО: корни выводим ТОЛЬКО из ВАЛИДИРОВАННОГО winSystemRoot(), НИКОГДА из
// launch-env. Иначе medium-малварь пишет HKCU\Environment\ProgramFiles=C:\Users\v\evil,
// кладёт туда evil\Git\cmd\git.exe — и префикс-проверка вернула бы true, а winSafeToExec
// (`winPathAdminOwned(...) || winFileAdminOwned(...)`) короткозамкнулся бы ДО честной
// проверки владельца → запуск чужого бинаря под АДМИНОМ на старте детекции.
// Program Files, перенесённый админом в нестандартное место, по-прежнему проходит —
// через owner-фолбэк winFileAdminOwned (его файлы принадлежат Administrators/SYSTEM).
function winPathAdminOwned(p) {
  try {
    const winRoot = remoteFetch.winSystemRoot() || 'C:\\Windows';
    const drv = path.parse(winRoot).root || 'C:\\';
    const rp = path.resolve(String(p)).toLowerCase();
    const roots = [path.join(drv, 'Program Files'), path.join(drv, 'Program Files (x86)'), winRoot]
      .map((r) => path.resolve(String(r)).toLowerCase().replace(/[\\/]+$/, '') + path.sep);
    return roots.some((r) => rp.startsWith(r));
  } catch (e) { return false; }
}

// Владелец ФАЙЛА — admin-принципал (SYSTEM / Administrators / TrustedInstaller)?
// Тогда medium-малварь его не создавала/подменяла (её файлы user-owned) → безопасно
// запускать под elevated-токеном ГДЕ БЫ он ни лежал (в т.ч. admin-установленный инструмент
// в нестандартной локации вне Program Files — иначе его версия не детектилась бы). Дороже
// (spawn powershell Get-Acl), поэтому зовём ТОЛЬКО когда путь НЕ в очевидном admin-корне.
// ВАЖНО: одного ВЛАДЕЛЬЦА мало. Файл, созданный элевейтед-процессом в user-writable
// каталоге (%LOCALAPPDATA%\Programs\…, ~\.local\bin), наследует DACL родителя с Full
// Control для интерактивного юзера, а владельцем остаётся Administrators: medium-малварь
// ПЕРЕЗАПИСЫВАЕТ такой файл НА МЕСТЕ (владелец не меняется!) → гейт пропускал бы payload
// под elevated-токеном. Поэтому дополнительно требуем, чтобы у НЕ-admin принципалов не
// было write-класса прав ни на файл, ни на его родительский каталог — это же закрывает
// и TOCTOU-окно между проверкой и exec (подменить нечем). Любая ошибка/таймаут → false.
function winFileAdminOwned(p) {
  const key = String(p).toLowerCase();
  if (_detOwnerCache && _detOwnerCache.has(key)) return _detOwnerCache.get(key);
  const remember = (v) => { if (_detOwnerCache) _detOwnerCache.set(key, v); return v; };
  try {
    const ps = remoteFetch.winPowershellPath();
    if (!ps) return remember(false);
    const script =
      "$ErrorActionPreference='Stop';" +
      // SYSTEM, Administrators, TrustedInstaller — принципалы, писать под которыми medium-юзер не может.
      "$allow=@('S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464');" +
      // NB: [IO.Path]::GetDirectoryName, а НЕ Split-Path: в PS 5.1 «-LiteralPath … -Parent»
      // не резолвится (AmbiguousParameterSet), а «-Path» глобит [квадратные] скобки в пути.
      "$f=$env:HM_CHK_FILE;$par=[System.IO.Path]::GetDirectoryName($f);" +
      // write-класс: WriteData/CreateFiles 0x2, AppendData/CreateDirs 0x4, WriteEA 0x10,
      // WriteAttributes 0x100, Delete 0x10000, WriteDAC 0x40000, WriteOwner 0x80000 +
      // generic-формы GENERIC_ALL 0x10000000 / GENERIC_WRITE 0x40000000; для каталога
      // дополнительно DeleteSubdirectoriesAndFiles 0x40 (им удаляют НАШ файл).
      "foreach($it in @($f,$par)){" +
      "$m=if($it -eq $par){0x500C0156}else{0x500C0116};" +
      "$a=Get-Acl -LiteralPath $it;" +
      "$o=$a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;" +
      "if($allow -notcontains $o){Write-Output 'USER';exit 0}" +
      // GetAccessRules(...[SecurityIdentifier]) отдаёт ACE СРАЗУ в SID-виде. Через
      // $a.Access + .Translate() нельзя: локализованные псевдо-принципалы («ЦЕНТР
      // ПАКЕТОВ ПРИЛОЖЕНИЙ\ВСЕ ПАКЕТЫ ПРИЛОЖЕНИЙ» на ru-RU) НЕ транслируются обратно,
      // и проверка вырождалась бы в вечный USER — то есть в мёртвый код (проверено).
      // Inherit-only ACE (PropagationFlags -band 2) к самому объекту не применяются —
      // иначе штатный CREATOR OWNER (OI)(CI)(IO)(F) в System32 давал бы ложный USER.
      "foreach($ace in $a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])){" +
      "if($ace.AccessControlType -ne 'Allow'){continue}" +
      "if(([int]$ace.PropagationFlags -band 2) -ne 0){continue}" +
      "if($allow -contains $ace.IdentityReference.Value){continue}" +
      "if(([int]$ace.FileSystemRights -band $m) -ne 0){Write-Output 'USER';exit 0}" +
      "}}" +
      "Write-Output 'ADMIN'";
    // env — доверенный (см. detectSpawnEnv): унаследованный process.env позволял бы
    // medium-юзеру подсунуть свой PSModulePath/COR_PROFILER в powershell.exe ВНУТРИ
    // самой проверки, которая и отвечает на вопрос ADMIN/USER.
    const env = IS_WIN
      ? Object.assign(detectSpawnEnv(), { HM_CHK_FILE: String(p) })
      : Object.assign({}, process.env, { HM_CHK_FILE: String(p) });
    const r = spawnSync(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { encoding: 'utf8', windowsHide: true, timeout: 8000, env });
    return remember(!r.error && r.status === 0 && /(^|\n)ADMIN$/.test(String(r.stdout || '').trim()));
  } catch (e) { return remember(false); }
}

// Безопасно ли запускать этот бинарь под elevated-токеном при детекции: путь в admin-owned
// корне (быстро, без subprocess) ИЛИ сам файл admin-owned (точная проверка для нестандартных
// admin-локаций). Иначе — не запускаем (user-owned fake = RCE-вектор), детект по существованию.
function winSafeToExec(bin) {
  if (!IS_WIN) return true;
  // КАНОНИЗАЦИЯ ОБЯЗАТЕЛЬНА: строковый префикс-тест обходится симлинком/junction из
  // admin-корня в user-writable каталог (nvm-windows штатно делает C:\Program Files\
  // nodejs → %APPDATA%\nvm\v<ver>) — CreateProcess пойдёт через reparse-точку и
  // исполнит подменённый бинарь ПОД АДМИНОМ. Проверяем РЕАЛЬНЫЙ путь; не удалось
  // канонизировать → fail-closed (ложно-негатив безвреден: детект по существованию цел).
  let real;
  try { real = (fs.realpathSync.native || fs.realpathSync)(String(bin)); }
  catch (e) { return false; }
  return winPathAdminOwned(real) || winFileAdminOwned(real);
}

// Ищем исполняемый файл: известные абсолютные каталоги, затем свежий PATH (перечитан
// из реестра на Windows) / POSIX-каталоги. Возвращает путь или ''.
function resolveExecutable(names, extraDirs) {
  const dirs = [];
  (extraDirs || []).forEach((d) => { if (d) dirs.push(d); });
  if (IS_WIN) {
    // Кэш на ОДИН проход детекции: иначе каждый resolveExecutable = 2 спавна reg.exe
    // (8-10 за проход, под EDR это секунды заморозки main-процесса при выключенной
    // кнопке «Установить»). Сбрасывается в начале detectComponents — PATH после
    // установки перечитывается заново.
    freshWindowsPathCached().split(';').forEach((d) => { const t = d.trim(); if (t) dirs.push(t); });
  } else {
    ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin',
      path.join(os.homedir(), '.local', 'bin'), path.join(os.homedir(), '.cargo', 'bin')]
      .forEach((d) => dirs.push(d));
    (process.env.PATH || '').split(':').forEach((d) => { const t = d.trim(); if (t) dirs.push(t); });
  }
  for (const d of dirs) {
    // #18: мёртвые UNC/сетевые записи PATH (\\server\share при выключенном VPN)
    // заставляют fs.existsSync висеть полный SMB-таймаут — × имена × компоненты это
    // минуты фриза детекции при выключенной кнопке «Установить». UNC при детекции
    // пропускаем; существование КАТАЛОГА проверяем ОДИН раз, а не имя×каталог.
    if (IS_WIN && /^\\\\/.test(d)) continue;
    let dirOk;
    try { dirOk = fs.existsSync(d); } catch (e) { dirOk = false; }
    if (!dirOk) continue;
    for (const n of names) {
      try { const p = path.join(d, n); if (fs.existsSync(p)) return p; } catch (e) { /* ignore */ }
    }
  }
  return '';
}

// Запускает bin с args и достаёт версию regex'ом (1-я группа). Ошибка/таймаут → ''.
function probeVersion(bin, args, re) {
  if (!bin) return '';
  // Под elevated-токеном НЕ запускаем бинарь, который мог подменить medium-юзер (RCE):
  // разрешаем admin-owned (путь в Program Files/System32 ИЛИ владелец файла = admin).
  // Прочее → пустая версия (существование детектится отдельно; переустановка безопасна).
  if (!winSafeToExec(bin)) return '';
  try {
    const opts = {
      encoding: 'utf8', windowsHide: true, timeout: 6000, stdio: ['ignore', 'pipe', 'ignore']
    };
    // Windows: спавним с ДОВЕРЕННЫМ окружением (см. detectSpawnEnv) — унаследованный
    // process.env под elevated-токеном нёс бы HKCU-переменные medium-юзера.
    if (IS_WIN) opts.env = detectSpawnEnv();
    const out = execFileSync(bin, args, opts);
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
// macOS: установлены ли Xcode Command Line Tools. `xcode-select -p` возвращает
// путь если да, ошибку если нет — и, в отличие от `git`/`xcode-select --install`,
// САМ диалог установки НЕ открывает. Кэшируем: за детекцию состояние не меняется.
let _cltPresent = null;
function xcodeCltPresent() {
  if (!IS_MAC) return true;
  if (_cltPresent !== null) return _cltPresent;
  try {
    const r = spawnSync('/usr/bin/xcode-select', ['-p'],
      { timeout: 4000, stdio: ['ignore', 'ignore', 'ignore'] });
    _cltPresent = r.status === 0;
  } catch (_) { _cltPresent = false; }
  return _cltPresent;
}

function detectComponents() {
  detResetCaches();   // свежий PATH и свежие owner-проверки на КАЖДЫЙ проход детекции
  const home = os.homedir();
  const claudeHome = path.join(home, '.claude');
  const out = {};

  // git
  {
    const bin = resolveExecutable(IS_WIN ? ['git.exe'] : ['git'],
      IS_WIN ? [path.join(winPF(), 'Git', 'cmd'), path.join(winPF(), 'Git', 'bin'), path.join(winPF86(), 'Git', 'cmd')] : []);
    // macOS-ГОЧА: /usr/bin/git — это Apple-шим; его вызов на чистом маке БЕЗ
    // Command Line Tools САМ открывает системный диалог «установить инструменты
    // разработчика» (тестер упёрся в него в фазе детекции). Не пробим версию
    // такого шима — считаем git не установленным; git.sh поставит вшитый
    // портативный dugite-git без окон Apple.
    const macShim = IS_MAC && bin === '/usr/bin/git' && !xcodeCltPresent();
    const v = (bin && !macShim) ? probeVersion(bin, ['--version'], /(\d+\.\d+(?:\.\d+)?)/) : '';
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
    // #19: «установлено» — по МАРКЕРУ завершённости (config.ps1/config.sh пишут его
    // ТОЛЬКО в самом конце успешной раскладки). Иначе оборванная установка (частичный
    // ~/.claude/skills после сна/перезагрузки/убийства AV) выглядела завершённой,
    // авто-снимала галку config, и повторный запуск не доразворачивал конфиг. Легаси-
    // фолбэк (маркера ещё нет от старых сборок): skills И settings.json одновременно.
    const marker = fs.existsSync(path.join(claudeHome, '.hamidun-config-complete'));
    const legacy = fs.existsSync(path.join(claudeHome, 'skills')) &&
                   fs.existsSync(path.join(claudeHome, 'settings.json'));
    out.config = { installed: marker || legacy, detectedVersion: '' };
  }
  // pydeps (best-effort: python + представительный пакет). Ложно-негатив безвреден —
  // переустановка pydeps идемпотентна; ложно-позитив лишь снимает галку по умолчанию.
  {
    const py = resolveExecutable(IS_WIN ? ['python.exe', 'python3.exe'] : ['python3', 'python'],
      IS_WIN ? [path.join(winLocalAppData(), 'Programs', 'Python', 'Python313'),
                path.join(winLocalAppData(), 'Programs', 'Python', 'Python312')] : []);
    let found = false;
    // macOS-ГОЧА (ТОТ ЖЕ класс, что git-шим выше, стр. 1379): /usr/bin/python3 —
    // Apple-стаб; его запуск на чистом маке БЕЗ Command Line Tools САМ открывает
    // системный диалог «установить инструменты разработчика» — прямо в фазе
    // детекции, до единого клика. Не пробим такой шим — считаем pydeps не
    // установленным (ложно-негатив безвреден: pydeps.sh идемпотентен и ставит
    // пакеты через framework/uv-python без окон Apple).
    const pyShim = IS_MAC && (py === '/usr/bin/python3' || py === '/usr/bin/python') && !xcodeCltPresent();
    // Windows: НЕ запускаем python под elevated-токеном, если он мог быть подменён medium-
    // юзером (тот же RCE-вектор, что probeVersion; admin-owned — можно). Ложно-негатив
    // безвреден (pydeps.ps1 идемпотентен).
    const pyExecSafe = py && !pyShim && winSafeToExec(py);
    if (pyExecSafe) {
      try {
        // `-E` + доверенный env: без них PYTHONPATH/PYTHONSTARTUP из HKCU\Environment
        // (пишет medium-малварь того же юзера) заставили бы интерпретатор ИМПОРТИРОВАТЬ
        // чужой PIL.py ПОД АДМИНОМ — авто-детекция на старте, до единого клика.
        // `-I` НЕ используем: он выключает и user site-packages, а pydeps ставит пакеты
        // через `pip install --user` → детекция стала бы вечно ложно-отрицательной.
        // cwd в System32: для `-c` sys.path[0]='' = ТЕКУЩИЙ каталог, а portable-exe
        // запускается из user-writable Downloads (подмена модуля по cwd).
        const opts = { windowsHide: true, timeout: 6000, stdio: 'ignore' };
        const pyArgs = IS_WIN ? ['-E', '-c', 'import PIL, requests'] : ['-c', 'import PIL, requests'];
        if (IS_WIN) {
          opts.env = detectSpawnEnv();
          opts.cwd = path.join(remoteFetch.winSystemRoot() || 'C:\\Windows', 'System32');
        }
        execFileSync(py, pyArgs, opts);
        found = true;
      } catch (e) { found = false; }
    }
    // Браузер Playwright — часть этого компонента, и без него он неполон.
    //
    // pydeps выходит кодом 0, даже когда `playwright install chromium` не прошёл: сами
    // Python-пакеты при этом стоят, и валить весь шаг нельзя — от pydeps зависит bridge,
    // которому браузер не нужен. Но main на код 0 пишет квитанцию «установлено», и на
    // СЛЕДУЮЩЕМ прогоне детекция (проверявшая только импорт PIL/requests) подтверждала
    // это же: компонент зелёный, кнопки «Повторить» нет, а браузерные навыки молча не
    // работают. Первый прогон ловил verify, второй не ловил никто.
    //
    // Поэтому «установлен» = пакеты И браузер. Каталоги — те же, куда кладёт pydeps
    // (pydeps.ps1:174 / pydeps.sh:98). Пустой каталог не считаем: `playwright install`
    // создаёт его до распаковки.
    if (found) {
      const pwRoot = IS_WIN
        ? path.join(winLocalAppData(), 'ms-playwright')
        : path.join(home, 'Library', 'Caches', 'ms-playwright');
      let hasBrowser = false;
      try {
        hasBrowser = fs.readdirSync(pwRoot).some((n) => /^chromium/i.test(n));
      } catch (e) { hasBrowser = false; }
      if (!hasBrowser) found = false;
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
    // Проверяем НЕ сам каталог тула, а entrypoint внутри него. Порядок, в котором
    // работает `uv tool install` (проверено запуском вшитого uv): каталог venv
    // создаётся ПЕРВЫМ, исполняемые файлы кладутся ПОСЛЕДНИМИ. Значит закрытое
    // посреди установки окно оставляет ровно тот каталог, который прежняя проверка
    // считала успехом: детекция рапортовала «Nomad уже установлен», повторный
    // запуск шаг пропускал — и человек навсегда оставался без агента при зелёной
    // галке. Имена entrypoint'ов — из [project.scripts] пакета.
    const uvToolDirs = IS_WIN
      ? [path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'uv', 'tools', 'nomad-agent'),
         path.join(home, '.local', 'share', 'uv', 'tools', 'nomad-agent')]
      : [path.join(home, '.local', 'share', 'uv', 'tools', 'nomad-agent')];
    const uvToolEntries = [];
    for (const d of uvToolDirs) {
      for (const n of ['nmd', 'nomad-agent', 'nomad-acp']) {
        uvToolEntries.push(IS_WIN ? path.join(d, 'Scripts', n + '.exe') : path.join(d, 'bin', n));
      }
    }
    const uvTools = firstExisting(uvToolEntries);
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
    // pathReadOk=false на Windows → детекция шла по неполному PATH, и «не
    // установлено» могло означать «не смог прочитать системный PATH». Renderer
    // покажет честный баннер, а не предложит переустановить поверх рабочего.
    const pathReadOk = (process.platform !== 'win32') || lastPathReadOk();
    return { ok: true, state, manifestPath: manifest.manifestPath(home), pathReadOk };
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
// Соответствие .NET RegistryValueKind ↔ имена типов reg.exe (их ждут вызывающие).
const REG_KIND_TO_TYPE = {
  String: 'REG_SZ', ExpandString: 'REG_EXPAND_SZ', DWord: 'REG_DWORD',
  QWord: 'REG_QWORD', Binary: 'REG_BINARY', MultiString: 'REG_MULTI_SZ',
};
const REG_TYPE_TO_KIND = {
  REG_SZ: 'String', REG_EXPAND_SZ: 'ExpandString', REG_DWORD: 'DWord',
  REG_QWORD: 'QWord', REG_BINARY: 'Binary', REG_MULTI_SZ: 'MultiString',
};

// Запустить однострочник PowerShell и получить ответ в виде base64-строки.
// ЗАЧЕМ base64: reg.exe и сам powershell 5.1 печатают в кодировке КОНСОЛИ
// (CP866 на русской Windows), Node читает трубу как UTF-8 — кириллица
// превращается в «?». Для PATH это было разрушительно: чужая запись
// «C:\Программы\Python\Scripts» после нашей перезаписи навсегда становилась
// «C:\?????\Python\Scripts». base64 — чистый ASCII, кодировка перестаёт
// участвовать в разговоре вообще.
function winPsPayload(inline) {
  const ps = remoteFetch.winPowershellPath();
  if (!ps) return { ok: false, error: 'PowerShell не найден в System32 (fail-closed)' };
  const r = spawnSync(ps, ['-ExecutionPolicy', 'Bypass', '-NoProfile', '-NonInteractive', '-Command', inline],
    { encoding: 'ascii', windowsHide: true, timeout: 20000, env: detectSpawnEnv() });
  if (r.error) return { ok: false, error: String(r.error.message || r.error) };
  const out = String(r.stdout || '');
  const m = out.match(/HMREG1:([A-Za-z0-9+/=]+)/);
  if (!m) return { ok: false, error: 'реестр: пустой ответ (код ' + r.status + ')' };
  try {
    return { ok: true, payload: JSON.parse(Buffer.from(m[1], 'base64').toString('utf8')) };
  } catch (e) {
    return { ok: false, error: 'реестр: неразбираемый ответ' };
  }
}

// Разбор пути вида «HKCU\Environment» / «HKLM\SYSTEM\...». Запись разрешена
// ТОЛЬКО в HKCU (см. regWriteValueTyped/regDeleteValueTyped — там hive обязан
// быть CurrentUser); HKLM читается для машинного PATH.
// Неизвестный куст или пустой подключ → null (вызывающий отказывает, fail-closed).
function regPathParts(keyPath) {
  const m = String(keyPath || '').match(/^(HKCU|HKEY_CURRENT_USER|HKLM|HKEY_LOCAL_MACHINE)\\(.+)$/i);
  if (!m) return null;
  const hive = /^HKLM|^HKEY_LOCAL_MACHINE/i.test(m[1]) ? 'LocalMachine' : 'CurrentUser';
  return { hive, sub: m[2] };
}

// Только HKCU — для операций записи/удаления.
function hkcuSubkeyOf(keyPath) {
  const m = String(keyPath || '').match(/^(?:HKCU|HKEY_CURRENT_USER)\\(.+)$/i);
  return m ? m[1] : '';
}

// Единственный путь чтения — авторитетный. Быстрый разбор вывода reg.exe УДАЛЁН,
// и вот почему: reg.exe печатает в кодовой странице консоли, а символы, у которых
// есть best-fit-отображение, он подменяет ПОХОЖИМ ASCII, а не «?». Значение
// приходит идеально чистым и при этом неверным — ни один гейт такого не поймает.
// Проверено запуском на этой машине (консоль 866): «C:\Users\José\…» → «Jose»,
// «Müller» → «Muller», «Dev’s» → «Dev's», а «a…b» → «a:b» — появляется двоеточие,
// структурно значимый символ пути. Четыре искажения из шести проб.
// Последствия были тихими и неприятными: компонент, установленный в каталог с
// диакритикой, детектировался как отсутствующий; пост-проверка удаления
// рапортовала «чисто», хотя запись в PATH оставалась.
// Скорость возвращена не разбором текста, а ПАКЕТНЫМ чтением (regQueryManyDotNet):
// один запуск интерпретатора на все нужные значения вместо одного на каждое.
function regQueryValueTyped(keyPath, valueName) {
  return regQueryValueDotNet(keyPath, valueName);
}

// Несколько значений ОДНИМ запуском. Старт powershell.exe — это сотни миллисекунд,
// и платить их за каждое значение нельзя: именно из-за этого окно уходило в «не
// отвечает» на секунды. Читаем пачкой, платим один раз.
// Возвращает массив результатов в том же порядке, что и запросы.
function regQueryManyDotNet(reqs) {
  if (!reqs || !reqs.length) return [];
  const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  const parts = [];
  for (const r of reqs) {
    const p = regPathParts(r.key);
    if (!p) { parts.push("$out += ,@{error='неподдерживаемый ключ'}"); continue; }
    parts.push(
      "try{" +
      "$k=[Microsoft.Win32.Registry]::" + p.hive + ".OpenSubKey(" + q(p.sub) + ",$false);" +
      "if($null -eq $k){$out += ,@{found=$false}}else{" +
      "$has=@($k.GetValueNames()|Where-Object{$_ -eq " + q(r.name) + "}).Count -gt 0;" +
      "if(-not $has){$out += ,@{found=$false}}else{" +
      "$v=$k.GetValue(" + q(r.name) + ",$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames);" +
      "$out += ,@{found=$true;kind=$k.GetValueKind(" + q(r.name) + ").ToString();data=[string]$v}}}" +
      "}catch{$out += ,@{error=$_.Exception.Message}}"
    );
  }
  const inline =
    "$ErrorActionPreference='Stop';$out=@();" + parts.join(';') +
    ";Write-Output ('HMREG1:'+[Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json @($out) -Compress -Depth 4))))";
  const r = winPsPayload(inline);
  if (!r.ok) return reqs.map(() => ({ ok: false, error: r.error }));
  const arr = Array.isArray(r.payload) ? r.payload : [r.payload];
  return reqs.map((_, i) => {
    const p = arr[i];
    if (!p) return { ok: false, error: 'реестр: пустой ответ' };
    if (p.error) return { ok: false, error: 'реестр: ' + p.error };
    if (!p.found) return { ok: true, found: false };
    return { ok: true, found: true, type: REG_KIND_TO_TYPE[p.kind] || p.kind, data: String(p.data == null ? '' : p.data) };
  });
}

// Авторитетное чтение через .NET: медленно, но без единой зависимости от кодовой
// страницы и от языка системы. Сюда попадают «значения нет», ошибки и всё,
// в чём быстрый путь не уверен.
function regQueryValueDotNet(keyPath, valueName) {
  const parts = regPathParts(keyPath);
  if (!parts) return { ok: false, error: 'реестр: неподдерживаемый ключ (' + keyPath + ')' };
  const sub = parts.sub;
  const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  const inline =
    "$ErrorActionPreference='Stop'; try {" +
    "$k=[Microsoft.Win32.Registry]::" + parts.hive + ".OpenSubKey(" + q(sub) + ",$false);" +
    "if ($null -eq $k) { $o=@{found=$false} } else {" +
    "  $has=@($k.GetValueNames() | Where-Object { $_ -eq " + q(valueName) + " }).Count -gt 0;" +
    "  if (-not $has) { $o=@{found=$false} } else {" +
    // DoNotExpandEnvironmentNames: REG_EXPAND_SZ обязан прийти СЫРЫМ, иначе чужие
    // %VAR% раскроются и мы запишем обратно уже развёрнутый мусор.
    "    $v=$k.GetValue(" + q(valueName) + ",$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames);" +
    "    $o=@{found=$true; kind=$k.GetValueKind(" + q(valueName) + ").ToString(); data=[string]$v} } }" +
    "} catch { $o=@{error=$_.Exception.Message} }" +
    "; Write-Output ('HMREG1:'+[Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $o -Compress))))";
  const r = winPsPayload(inline);
  if (!r.ok) return { ok: false, error: r.error };
  const p = r.payload || {};
  if (p.error) return { ok: false, error: 'реестр: ' + p.error };
  if (!p.found) return { ok: true, found: false };
  const type = REG_KIND_TO_TYPE[p.kind] || p.kind;
  return { ok: true, found: true, type, data: String(p.data == null ? '' : p.data) };
}

// Запись значения HKCU через .NET. Значение передаётся в base64 — иначе длинный
// PATH с кириллицей и кавычками не пережил бы ни командную строку, ни CP866.
function regWriteValueTyped(keyPath, valueName, data, type) {
  const sub = hkcuSubkeyOf(keyPath);
  if (!sub) return { ok: false, error: 'реестр: поддерживается только HKCU (' + keyPath + ')' };
  const kind = REG_TYPE_TO_KIND[type];
  if (!kind) return { ok: false, error: 'реестр: неизвестный тип значения ' + type };
  const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  const b64 = Buffer.from(String(data), 'utf8').toString('base64');
  const inline =
    "$ErrorActionPreference='Stop'; try {" +
    "$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey(" + q(sub) + ",$true);" +
    "if ($null -eq $k) { throw 'нет ключа " + sub.replace(/'/g, '') + "' }" +
    "$val=[System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + b64 + "'));" +
    "$k.SetValue(" + q(valueName) + ",$val,[Microsoft.Win32.RegistryValueKind]::" + kind + ");" +
    "$o=@{ok=$true}" +
    "} catch { $o=@{error=$_.Exception.Message} }" +
    "; Write-Output ('HMREG1:'+[Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $o -Compress))))";
  const r = winPsPayload(inline);
  if (!r.ok) return { ok: false, error: r.error };
  if (r.payload && r.payload.error) return { ok: false, error: 'реестр: ' + r.payload.error };
  return { ok: true };
}

// Удаление значения HKCU через .NET (та же причина — кодировка диагностики).
function regDeleteValueTyped(keyPath, valueName) {
  const sub = hkcuSubkeyOf(keyPath);
  if (!sub) return { ok: false, error: 'реестр: поддерживается только HKCU (' + keyPath + ')' };
  const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  const inline =
    "$ErrorActionPreference='Stop'; try {" +
    "$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey(" + q(sub) + ",$true);" +
    "if ($null -eq $k) { throw 'нет ключа' }" +
    "$k.DeleteValue(" + q(valueName) + ",$false); $o=@{ok=$true}" +
    "} catch { $o=@{error=$_.Exception.Message} }" +
    "; Write-Output ('HMREG1:'+[Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $o -Compress))))";
  const r = winPsPayload(inline);
  if (!r.ok) return { ok: false, error: r.error };
  if (r.payload && r.payload.error) return { ok: false, error: 'реестр: ' + r.payload.error };
  return { ok: true };
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
  const keyPath = 'HKCU\\' + t.key;
  // P1-7: tri-state — ошибка чтения/парсинга ≠ «значения нет» (та давала бы absent
  // и ложный успех). Любая ошибка → failed.
  const q0 = regQueryValueTyped(keyPath, t.value);
  if (!q0.ok) return { status: 'failed', message: 'чтение реестра: ' + q0.error };
  if (!q0.found) return { status: 'absent', message: 'значения нет' };
  const del = regDeleteValueTyped(keyPath, t.value);
  if (!del.ok) return { status: 'failed', message: 'удаление значения: ' + del.error };
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
  // ЗДЕСЬ — только АВТОРИТЕТНЫЙ путь чтения, без быстрой оптимизации.
  // Операция разрушительная (перезапись чужого PATH), а быстрый путь разбирает
  // ТЕКСТОВЫЙ вывод reg.exe: он не различает значение с переводом строки, зависит
  // от кодовой страницы и однажды уже срезал хвостовые пробелы. Расхождение на
  // один символ между чтением и сверкой означает либо вечный откат, либо
  // затирание чужой записи. Лишняя доля секунды в редкой операции удаления —
  // несопоставимо дешевле.
  // P1-7: tri-state — ошибка чтения PATH ≠ «PATH нет» (иначе ложный absent).
  const cur = regQueryValueDotNet('HKCU\\Environment', 'Path');
  if (!cur.ok) return { status: 'failed', message: 'чтение PATH: ' + cur.error };
  if (!cur.found) return { status: 'absent', message: 'пользовательского PATH нет' };
  // Гейт на порчу: чужая запись важнее нашей. Если в прочитанном PATH есть
  // символ замены U+FFFD или «?» там, где мы ждём путь, — значит значение
  // приехало испорченным, и переписывать его НЕЛЬЗЯ ни при каких условиях:
  // лучше оставить нашу лишнюю запись, чем стереть чужой кириллический путь.
  if (/�/.test(cur.data)) {
    return { status: 'failed', message: 'PATH прочитан с потерей символов — не переписываю (сохранность чужих записей важнее)' };
  }
  const upd = uninstallExec.computeUserPathWithout(cur.data, dir);
  if (!upd.changed) return { status: 'absent', message: 'записи в PATH нет' };
  const w = regWriteValueTyped('HKCU\\Environment', 'Path', upd.value, cur.type);
  if (!w.ok) return { status: 'failed', message: 'запись PATH: ' + w.error };
  // Сверка — ТЕМ ЖЕ авторитетным путём, что и чтение выше. Сравнивать значения,
  // прочитанные РАЗНЫМИ способами, значит ловить расхождение самих способов,
  // а не результат записи.
  const after = regQueryValueDotNet('HKCU\\Environment', 'Path');
  if (!after.ok || !after.found || after.data !== upd.value) {
    // Верификация не сошлась — пробуем вернуть исходное значение (не теряем PATH).
    //
    // Ответ отката ЧИТАЕТСЯ, и сообщение ставится по факту. Раньше здесь стоял
    // голый вызов, а строкой ниже человеку сообщалось «вернул исходный» — как
    // свершившееся. Если откат не проходил (отказ доступа, PowerShell не
    // стартовал), у человека оставался УРЕЗАННЫЙ PATH, то есть сломанный
    // терминал, и он читал, что всё вернули. Битый PATH и так плохо; хуже
    // только битый PATH, про который сказали, что он цел.
    //
    // Сверяем не кодом возврата записи, а ЧТЕНИЕМ: запись может отчитаться
    // успехом и не долететь — ровно поэтому выше и стоит верификация.
    const back = regWriteValueTyped('HKCU\\Environment', 'Path', cur.data, cur.type);
    const now = regQueryValueDotNet('HKCU\\Environment', 'Path');
    const restored = back.ok && now.ok && now.found && now.data === cur.data;
    if (restored) {
      return { status: 'failed', message: 'PATH после записи не совпал с ожидаемым — исходный ВЕРНУЛ (проверено чтением)' };
    }
    return {
      status: 'failed',
      message: 'PATH после записи не совпал с ожидаемым, и откат НЕ УДАЛСЯ (' +
        (back.ok ? 'запись прошла, но чтение показало другое' : 'запись отката: ' + back.error) +
        '). PATH пользователя сейчас в НЕИЗВЕСТНОМ состоянии — проверь ' +
        'переменную Path в «Переменные среды» и при необходимости верни строку вручную.',
    };
  }
  invalidatePathCache();   // запись убрана — кэш PATH протух
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
    case 'hookurl': return 'hook-url «' + t.from + '» → «' + t.to + '» в ' + t.file +
      (t.why ? ' (' + t.why + ')' : '');
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
    // Не удаление, а обратная правка: hook-url скрепки возвращается к плейсхолдеру
    // пака. Свой узкий допуск внутри restoreHookUrl (ровно ~/.claude/settings.json),
    // потому что checkTarget закрывает весь ~/.claude — и правильно делает: там
    // нельзя УДАЛЯТЬ. Здесь ничего и не удаляется.
    case 'hookurl': return uninstallExec.restoreHookUrl(t.file, t.from, t.to, guardOpts);
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

// ---- macOS: САМОЛЕЧЕНИЕ карантина/транслокации --------------------------------
//
// Живой случай (двое на маке, кнопка «Установить» серая): человек сохранил образ НЕ в
// «Загрузки», а на Рабочий стол. Инструкция предлагала выполнить команду с жёстко
// вбитым ~/Downloads — она падала с «No such file», карантин не снимался, и человек
// упирался в тупик, хотя всё было исправимо. Просить пользователя копировать команды в
// Терминал вообще плохо: там ошибётся кто угодно.
//
// Установщик знает про себя больше, чем человек: где смонтирован образ, из какого файла
// он смонтирован (hdiutil info) и что сам он запущен из карантинной копии. Значит может
// починить сам: снять карантин с ОБРАЗА, отцепить ВСЕ его тома, открыть заново и
// запуститься из свежего — уже без карантина, а значит без транслокации.
//
// Привилегии не нужны: на macOS установщик работает НЕ от администратора, а образ —
// файл самого пользователя. Все вызовы идут execFile с массивом аргументов (без shell),
// пути проверяются: только абсолютные, только под /Volumes или домашним каталогом,
// только имя вида Hamidun-Setup-Mac*.dmg.
function macFindOurDmg() {
  const okDmg = (p) => {
    try {
      if (!p || typeof p !== 'string' || !path.isAbsolute(p)) return false;
      if (!/^Hamidun-Setup-Mac[A-Za-z0-9._ ()-]*\.dmg$/i.test(path.basename(p))) return false;
      return fs.statSync(p).isFile();
    } catch (e) { return false; }
  };
  // 1) Самый точный источник: смонтированный образ знает свой файл.
  try {
    const out = execFileSync('/usr/bin/hdiutil', ['info'], { encoding: 'utf8', timeout: 15000 });
    for (const line of String(out).split(/\r?\n/)) {
      const m = /^image-path\s*:\s*(.+)$/.exec(line.trim());
      if (m && okDmg(m[1].trim())) return m[1].trim();
    }
  } catch (e) { /* образ мог быть уже отцеплен — идём дальше */ }
  // 2) Обычные места, куда браузеры кладут скачанное — С ПОДПАПКАМИ.
  //    Люди раскладывают загрузки по папкам (Downloads/installers, Desktop/Хамидун…),
  //    и плоский обход находил образ только если тот лежал ровно в корне. Глубину
  //    ограничиваем и каталог-жертву пропускаем, чтобы обход не гулял по всему диску.
  const home = os.homedir();
  const SKIP = /^(Library|Applications|\.Trash|node_modules|\.git|Pictures|Music|Movies)$/i;
  const found = [];
  const walk = (d, depth) => {
    if (depth < 0 || found.length >= 40) return;
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || SKIP.test(e.name)) continue;
        walk(p, depth - 1);
      } else if (/^Hamidun-Setup-Mac[A-Za-z0-9._ ()-]*\.dmg$/i.test(e.name) && okDmg(p)) {
        found.push(p);
      }
    }
  };
  for (const dir of ['Downloads', 'Desktop', 'Documents']) walk(path.join(home, dir), 2);
  if (!found.length) walk(home, 1);          // корень профиля — без углубления
  if (!found.length) return '';
  // Самый свежий: человек мог скачать заново, и чинить надо именно новый образ.
  found.sort((a, b) => {
    try { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs; } catch (e) { return 0; }
  });
  return found[0];
}

ipcMain.handle('mac-selfheal', async () => {
  if (process.platform !== 'darwin') return { ok: false, error: 'not-darwin' };
  const dmg = macFindOurDmg();
  if (!dmg) return { ok: false, error: 'dmg-not-found' };
  // 1) Карантин снимаем с ФАЙЛА образа — именно он делает копию «карантинной» —
  //    и ПРОВЕРЯЕМ факт. Раньше результат не проверялся вовсе: человеку писали
  //    «Готово», закрывали окно, и он получал ровно тот же заблокированный
  //    установщик. Отсутствие исключения — не доказательство.
  try {
    execFileSync('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', dmg],
      { timeout: 20000, stdio: 'ignore' });
  } catch (e) { /* атрибута могло и не быть — проверяем ниже */ }
  let quarantined = false;
  try {
    // Код 0 = атрибут ЕСТЬ (значит снять не удалось), ненулевой = атрибута нет.
    execFileSync('/usr/bin/xattr', ['-p', 'com.apple.quarantine', dmg],
      { timeout: 10000, stdio: 'ignore' });
    quarantined = true;
  } catch (e) { quarantined = false; }
  if (quarantined) return { ok: false, error: 'quarantine-not-cleared', dmg };

  // 2) Хвост операции выполняет ОТЦЕПЛЁННЫЙ помощник, переживающий наш выход.
  //    Нельзя отцеплять том из процесса, который с этого тома и запущен: при
  //    штатном сценарии (человек запустил приложение прямо из окна образа)
  //    `hdiutil detach -force` выдёргивает backing store у собственного
  //    исполняемого файла, и установщик умирает посреди «починки» — окно просто
  //    исчезает, без свежего образа и без объяснений.
  //    Помощник: ждёт нашего выхода → отцепляет ВСЕ тома Hamidun → открывает
  //    образ → дожидается ПОЯВЛЕНИЯ тома → запускает приложение оттуда.
  //    `open -n` обязателен: без него macOS просто активировала бы уже
  //    запущенный экземпляр того же bundle id вместо запуска с нового тома.
  const helper = [
    'DMG="$1"; PID="$2"; ST="$3";',
    // Ждём выхода установщика. Дождаться ОБЯЗАТЕЛЬНО: пока мы живы, наш замок
    // единственного экземпляра не отпущен, и запущенный помощником свежий
    // установщик просто закроется сам. Потолок щедрый — 120 с.
    'i=0; while kill -0 "$PID" 2>/dev/null && [ $i -lt 240 ]; do sleep 0.5; i=$((i+1)); done;',
    'for v in /Volumes/Hamidun*; do [ -d "$v" ] && /usr/bin/hdiutil detach "$v" -force >/dev/null 2>&1; done;',
    // Монтируем САМИ и берём точку монтирования ИЗ ВЫВОДА. Раньше том искали
    // перебором /Volumes/Hamidun*, полагаясь на то, что старые уже отцеплены.
    // Но том держит Finder (человек как раз из окна образа и запускался), detach
    // не проходит, macOS монтирует «Hamidun Setup 1» рядом — а перебор брал
    // первый по алфавиту, то есть СТАРЫЙ, всё ещё карантинный том. Человек
    // получал тот же экран блокировки и надпись «Готово». Свой mount-point
    // такой ошибки не допускает: он заведомо от ЭТОГО монтирования.
    'MP=$(/usr/bin/hdiutil attach -nobrowse "$DMG" 2>/dev/null | /usr/bin/sed -n "s|.*\\(/Volumes/.*\\)$|\\1|p" | /usr/bin/tail -1);',
    'if [ -z "$MP" ] || [ ! -d "$MP/Hamidun Setup.app" ]; then printf mount-failed > "$ST"; exit 1; fi;',
    // open -n обязателен: без него macOS активировала бы уже запущенный
    // экземпляр того же bundle id вместо запуска с нового тома.
    'if ! /usr/bin/open -n -a "$MP/Hamidun Setup.app"; then printf relaunch-failed > "$ST"; exit 1; fi;',
    // `open` вернул 0 — это лишь «команда принята». Ждём, пока процесс РЕАЛЬНО
    // появится: раньше в крошку писали «ok» по коду open, и самый вероятный тихий
    // провал (свежий экземпляр закрылся сам из-за занятого замка) выглядел успехом.
    'i=0; while [ $i -lt 20 ]; do',
    '  if /usr/bin/pgrep -f "Hamidun Setup.app/Contents/MacOS" >/dev/null 2>&1; then',
    '    printf ok > "$ST"; exit 0;',
    '  fi;',
    '  sleep 1; i=$((i+1));',
    'done;',
    'printf relaunch-not-seen > "$ST"; exit 1',
  ].join(' ');
  // Хлебная крошка: помощник работает уже после нашего выхода, и без неё любой
  // его отказ был бы невидим — окно просто исчезало бы навсегда. Свежий
  // экземпляр читает этот файл при старте и показывает, что пошло не так.
  const statusFile = path.join(os.homedir(), 'Library', 'Application Support',
    'HamidunSetup', 'selfheal.status');
  try {
    fs.mkdirSync(path.dirname(statusFile), { recursive: true });
    // Пишем не голое слово, а отметку времени и образ: без них отказ полугодовой
    // давности всплывал в первом же следующем заблокированном запуске и советовал
    // перекачать заведомо исправный файл.
    fs.writeFileSync(statusFile, JSON.stringify({ result: 'started', at: Date.now(), dmg }));
  } catch (e) { /* без крошки починка всё равно поедет */ }
  try {
    // Путь к образу уходит аргументом, а не подстановкой в текст скрипта:
    // в имени файла бывают пробелы и скобки («… (1).dmg»).
    const child = spawn('/bin/sh', ['-c', helper, 'hm-selfheal', dmg, String(process.pid), statusFile],
      { detached: true, stdio: 'ignore' });
    child.unref();
  } catch (e) {
    return { ok: false, error: 'helper-failed', dmg };
  }
  // Выход инициируем ЗДЕСЬ, а не из окна. Раньше это делал renderer таймером на
  // 6 секунд — но модалка прямо просит «закрой это окно», и человек, закрывший его
  // сам, уничтожал таймер вместе с окном. Процесс при этом НЕ умирал (на macOS
  // окно-без-приложения — норма) и продолжал держать замок единственного
  // экземпляра, поэтому запущенный помощником свежий установщик закрывался сам.
  // Установщик исчезал с экрана навсегда, а в крошку писалось «ok».
  setTimeout(() => { try { app.quit(); } catch (e) { /* уже выходим */ } }, 6000);
  // ok здесь означает «карантин снят и починка ЗАПУЩЕНА», а не «всё готово»:
  // остальное произойдёт уже после нашего выхода. Renderer обязан говорить
  // человеку именно это, а не «открыл свежее окно образа».
  return { ok: true, dmg, handoff: true };
});

// Что рассказал о себе прошлый прогон самолечения. Читаем при старте: если
// починка провалилась уже после нашего выхода, человек обязан увидеть причину,
// а не пустоту.
ipcMain.handle('mac-selfheal-status', () => {
  if (process.platform !== 'darwin') return { status: '' };
  const p = path.join(os.homedir(), 'Library', 'Application Support',
    'HamidunSetup', 'selfheal.status');
  try {
    const raw = String(fs.readFileSync(p, 'utf8')).trim();
    // Свежесть — по времени файла: помощник пишет голое слово, главный процесс —
    // объект со временем. Отметка старше получаса относится к ДРУГОЙ попытке
    // (возможно, к другому образу), и показывать её как «прошлая попытка не
    // смогла» значит отправлять человека перекачивать заведомо исправный файл.
    let ageMs = Infinity;
    try { ageMs = Date.now() - fs.statSync(p).mtimeMs; } catch (e) { /* нет времени — считаем старым */ }
    try { fs.rmSync(p, { force: true }); } catch (e) { /* прочитали — и хватит */ }
    if (ageMs > 30 * 60 * 1000) return { status: '' };
    let status = raw.slice(0, 40);
    if (raw.charAt(0) === '{') {
      try { status = String((JSON.parse(raw) || {}).result || '').slice(0, 40); } catch (e) { /* оставим сырое */ }
    }
    return { status };
  } catch (e) { return { status: '' }; }
});

ipcMain.handle('quit', () => app.quit());
