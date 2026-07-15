'use strict';
/*
 * remote-fetch.js — докачка «тяжёлых» компонентов из CDN во время установки.
 *
 * Модель Ninite: установщик несёт тонкую офлайн-базу (vendor/), а крупные
 * рантаймы (uv, ffmpeg, браузеры…) НЕ вшиты в exe/dmg — они докачиваются из
 * облака (Reg.ru S3, позже + Cloudflare R2) только если пользователь выбрал
 * соответствующий компонент. Так дистрибутив остаётся лёгким, а «полный стек»
 * доступен по требованию.
 *
 * Этот модуль ЧИСТЫЙ (без electron) — его можно юнит-тестировать напрямую
 * (см. test/run-tests.js). main.js вызывает fetchRemote() ВНУТРИ обработчика
 * run-component: докачка+проверка+распаковка+запуск идут одной атомарной
 * операцией в main-процессе (renderer не может вклиниться между шагами).
 *
 * ═══ МОДЕЛЬ УГРОЗ (round-2, архитектурная) ═══
 * Установщик работает с ПОВЫШЕННЫМИ правами (Win: requireAdministrator) и
 * ЗАПУСКАЕТ бинари, которые сам скачал. Главный класс атаки — TOCTOU процессом
 * ТОГО ЖЕ пользователя (medium integrity): он не может elevate, но может писать
 * в user-writable каталоги (%LOCALAPPDATA%…) и подменять файл между «проверил» и
 * «запустил». Поэтому НИЧЕГО, что elevated-процесс проверяет и запускает, не
 * должно жить в каталоге, куда способен писать обычный процесс пользователя.
 *
 * ГЛАВНЫЙ ГЕЙТ ЦЕЛОСТНОСТИ — sha256-пиннинг (обязателен, безусловен): скачанное
 * сверяется с зашитым в реестр sha; не совпало → не публикуется и не запускается.
 * Именно он закрывает РЕАЛЬНЫЕ угрозы (компрометация CDN, MITM, повреждение). Всё
 * остальное ниже — DEFENSE-IN-DEPTH ПОВЕРХ пиннинга, а НЕ единственная защита.
 * ADMIN-OWNED STAGING (Win) — best-effort сужение остаточного TOCTOU-окна поверх
 * sha-гейта; на POSIX изоляция от процессов ТОГО ЖЕ юзера без root недостижима
 * (best-effort). Остаточный вектор (portable-exe с админ-правами, распакованный в
 * %TEMP% и запускаемый оттуда) владелец принял осознанно — см. THREAT-MODEL.md.
 *
 * Архитектурные гарантии (defense-in-depth поверх sha-пиннинга):
 *   • ADMIN-OWNED STAGING (Win): кэш/распаковка/запуск живут в СВЕЖЕМ random-leaf
 *     каталоге под %ProgramData%, рождённом АТОМАРНО с owner=Administrators + DACL
 *     {SYSTEM (*S-1-5-18), Administrators (*S-1-5-32-544)}, protection on, БЕЗ
 *     user-SID — одной операцией [IO.Directory]::CreateDirectory($dir,$sd) в
 *     PS-примитиве New-HmSecureStagingDir (main.js winMakeSecureDir). remote-fetch
 *     только ПРОВЕРЯЕТ (SID-based, локаль-независимо); каталог не рождён/не прошёл
 *     проверку → компонент НЕ ставится (fail-closed). Node create-then-icacls
 *     ЗАПРЕЩЁН — оставлял бы окно наследования ProgramData (owner/DACL-window +
 *     ZIP-TOCTOU на пред-созданный/удержанный <remoteId>.zip).
 *     mac/linux: uv-флоу неэлевейтед end-to-end (юзер копирует в ~/.local/bin и
 *     запускает под своим токеном) — эскалации нет; каталог 700 + проверка
 *     владельца best-effort. Полная изоляция от процессов ТОГО ЖЕ юзера без root
 *     на POSIX недостижима (нет integrity levels) — задокументировано.
 *   • HELD-FD: скачивание идёт в ОДИН удерживаемый дескриптор (O_EXCL), sha
 *     считается ПОТОКОВО по мере записи в этот же fd — никаких переоткрытий по
 *     имени между download и hash (окно подмены закрыто и под FIX-A, и в целом).
 *   • FRESH EXTRACTION fail-closed: старые unpacked-* удаляются; НЕ удалились →
 *     стоп (не продолжаем в старом каталоге). Распаковка в НОВЫЙ случайный
 *     каталог и публикация атомарным rename только при полном успехе.
 *   • RUN-FROM-PROTECTED: install-скрипт запускает бинарь ИЗ защищённого кэша
 *     (см. scripts/windows/uv.ps1 и scripts/macos/uv.sh), а user-writable копию
 *     под elevated-токеном НЕ исполняет.
 *   • sha256 ОБЯЗАТЕЛЕН и валиден (64-hex), сравнение БЕЗУСЛОВНОЕ (нет sha →
 *     не качаем и не запускаем).
 *   • Системные бинари (powershell/unzip/ditto…) — по АБСОЛЮТНЫМ путям из
 *     ВАЛИДИРОВАННОГО System32 (не из %SystemRoot% env, который можно подменить
 *     в crafted launch env); powershell не найден → fail-closed, без короткого
 *     имени. Очищенный env (trustedEnv) на всех системных спавнах.
 *   • только HTTPS (без http-downgrade), анти-SSRF (canonical IPv4/IPv6, включая
 *     mapped/NAT64), пиннинг всего проверенного DNS-снапшота (анти-rebinding,
 *     dual-stack-friendly), АБСОЛЮТНЫЙ дедлайн стартует ДО connect/DNS + контроль
 *     минимальной скорости + жёсткий size-cap.
 *
 * Только Node stdlib: https, crypto, fs, path, dns, net, child_process, url.
 */
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const dns = require('dns');
const net = require('net');
const { spawnSync } = require('child_process');
const { URL } = require('url');

const CONNECT_TIMEOUT = 20000;             // ms на установление соединения/заголовки
const PROBE_DEADLINE = 8000;               // ms абсолютный дедлайн на пробинг зеркала
const DOWNLOAD_DEADLINE = 20 * 60 * 1000;  // ms абсолютный дедлайн на скачивание
const STALL_WINDOW = 20000;                // ms окно контроля минимальной скорости
const STALL_MIN_BYTES = 1024;              // байт за окно; меньше → соединение мёртвое
const WATCH_TICK = 2000;                   // ms период watchdog-тика
const MAX_SUB_ATTEMPTS = 4;                // сколько раз докачивать в рамках одного зеркала
const MAX_REDIRECTS = 6;
const USER_AGENT = 'hamidun-setup';
const SHA_RE = /^[0-9a-f]{64}$/;

// Транспорт (openStream) свапается ТОЛЬКО в юнит-тестах через __setOpenStreamImpl,
// чтобы детерминированно прогонять resume-ветки против локального http-сервера,
// не ослабляя боевые гейты (https-only/анти-SSRF живут в реальном openStream).
// В test-mode (транспорт подменён) fetchRemote пропускает Windows-ACL-гейт —
// подменить openStreamImpl атакующий не может (это in-proc переменная модуля).
let openStreamImpl = null;

// ---- утилиты --------------------------------------------------------

// Пригодный к скачиванию URL: ТОЛЬКО https, без плейсхолдеров ('<r2>', PLACEHOLDER…).
// R2-зеркало пока заглушка — оно должно молча отсекаться, а не падать сеть.
function isFetchableUrl(u) {
  if (typeof u !== 'string' || !u) return false;
  if (/[<>\s]/.test(u)) return false;
  if (/PLACEHOLDER/i.test(u)) return false;
  return /^https:\/\/[^/]+\/.+/.test(u); // только https (никакого http-downgrade)
}

function hostOf(u) { try { return new URL(u).host; } catch (e) { return u; } }
function fmtMB(n) { return (Number(n || 0) / (1024 * 1024)).toFixed(1) + ' МБ'; }
function trimOut(r) { return String(((r && (r.stderr || r.stdout)) || '') + '').trim(); }

// Выбрать запись реестра по remoteId с учётом платформы: сначала точное
// совпадение platform === текущая, затем платформо-независимая запись.
function pickEntry(registry, remoteId, platform) {
  const list = (registry && registry.components) || [];
  platform = platform || process.platform;
  let m = list.find((e) => e && e.remoteId === remoteId && e.platform === platform);
  if (!m) m = list.find((e) => e && e.remoteId === remoteId && !e.platform);
  return m || null;
}

// Потоковый SHA-256 файла (hex, lower). Возвращает '' при ошибке чтения.
// Используется ТОЛЬКО для cache-hit (файл в admin-owned кэше — подмена по имени
// исключена FIX-A). Свежескачанное хешируется ПОТОКОВО в held-fd (см. downloadToFd).
function sha256File(file) {
  return new Promise((resolve) => {
    try {
      const h = crypto.createHash('sha256');
      const s = fs.createReadStream(file);
      s.on('error', () => resolve(''));
      s.on('data', (c) => h.update(c));
      s.on('end', () => resolve(h.digest('hex').toLowerCase()));
    } catch (e) { resolve(''); }
  });
}

// ---- безопасность путей/каталогов -----------------------------------

function safeLstat(p) { try { return fs.lstatSync(p); } catch (e) { return null; } }

// Обычный файл, НЕ симлинк (reparse-point на Windows lstat тоже помечает симлинком).
function safeIsFile(p) {
  const st = safeLstat(p);
  return !!(st && st.isFile() && !st.isSymbolicLink());
}

// Каталог — настоящий каталог (не симлинк/junction); на POSIX best-effort owner+700.
function ensureSafeDir(dir) {
  const st = safeLstat(dir);
  if (!st) return { ok: false, error: 'кэш-каталог недоступен: ' + dir };
  if (st.isSymbolicLink()) return { ok: false, error: 'кэш-каталог — символическая ссылка (отклонено): ' + dir };
  if (!st.isDirectory()) return { ok: false, error: 'кэш-путь не является каталогом: ' + dir };
  if (process.platform !== 'win32') {
    try {
      if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
        return { ok: false, error: 'кэш-каталог принадлежит другому пользователю: ' + dir };
      }
      fs.chmodSync(dir, 0o700);
    } catch (e) { /* best-effort */ }
  }
  return { ok: true };
}

// ---- доверенные системные бинари / очищенный env (анти-PATH/ENV-hijack) ----

// Валидированный корень Windows: НЕ доверяем %SystemRoot%/%windir% env вслепую
// (crafted launch env может их подменить). Берём известный дефолт C:\Windows, а
// env-значение — только если пройдёт ту же проверку.
// #6: existsSync() проходит и для КАТАЛОГА/reparse-point с именем kernel32.dll, и
// junction на месте System32 увёл бы нас в чужой каталог. Поэтому проверяем КАЖДЫЙ
// сегмент (root, System32) как НАСТОЯЩИЙ каталог (не symlink/junction/reparse — на
// Windows Node помечает reparse как isSymbolicLink()), а kernel32.dll — как ОБЫЧНЫЙ
// ФАЙЛ (не dir, не symlink). Любой reparse-компонент → кандидат отвергается.
function winSystemRoot() {
  const cands = ['C:\\Windows'];
  const envr = process.env.SystemRoot || process.env.windir;
  if (envr && cands.indexOf(envr) === -1) cands.push(envr);
  for (const r of cands) {
    try {
      const rst = fs.lstatSync(r);
      if (!rst.isDirectory() || rst.isSymbolicLink()) continue;      // root — не reparse
      const s32 = path.join(r, 'System32');
      const sst = fs.lstatSync(s32);
      if (!sst.isDirectory() || sst.isSymbolicLink()) continue;      // System32 — не reparse
      const k = path.join(s32, 'kernel32.dll');
      const kst = fs.lstatSync(k);
      if (kst.isFile() && !kst.isSymbolicLink()) return r;           // обычный ФАЙЛ, не symlink
    } catch (e) { /* ignore — кандидат недоступен/некорректен */ }
  }
  return null;
}

function winSystem32() { const r = winSystemRoot(); return r ? path.join(r, 'System32') : null; }

// Абсолютный путь к системному бинарю из ВАЛИДИРОВАННОГО System32 (или null).
function sysBin(name) { const s = winSystem32(); return s ? path.join(s, name) : null; }

// Абсолютный powershell.exe из System32 — fail-closed: не найден → null (НИКАКОГО
// fallback в короткое имя 'powershell.exe', иначе PATH-hijack воскресает).
function winPowershellPath() {
  const s = winSystem32();
  if (!s) return null;
  const p = path.join(s, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try { if (fs.existsSync(p)) return p; } catch (e) { /* ignore */ }
  return null;
}

// Каталог ProgramData на системном диске (admin-owned корень для staging).
// Диск берём из валидированного System32, а НЕ из %ProgramData% env (анти-spoof).
function winProgramData() {
  const root = winSystemRoot();
  const drive = root ? (path.parse(root).root || 'C:\\') : 'C:\\';
  return path.join(drive, 'ProgramData');
}

// Минимальный env для дочерних системных бинарей: только системные каталоги в
// PATH, чтобы powershell/unzip/ditto не подхватили подложенный бинарь.
function trustedEnv() {
  if (process.platform === 'win32') {
    const root = winSystemRoot() || 'C:\\Windows';
    const s32 = path.join(root, 'System32');
    const p = [s32, root, path.join(s32, 'WindowsPowerShell', 'v1.0')].join(';');
    return {
      SystemRoot: root, windir: root, PATH: p, Path: p,
      TEMP: process.env.TEMP || process.env.TMP || '',
      TMP: process.env.TMP || process.env.TEMP || ''
    };
  }
  return { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
}

// ---- Windows: проверка защищённости secure-каталога (SID-based, fail-closed) ----
//
// P0 (Codex круг 6): secure-каталоги (de-elevation staging И кэш докачки) РОЖДАЮТСЯ
// АТОМАРНО с owner=Administrators + DACL {SYSTEM,Administrators: FullControl} одной
// операцией [IO.Directory]::CreateDirectory($dir,$sd) в PS-примитиве
// New-HmSecureStagingDir (_deelev.ps1). Каталог кэша докачки порождает main.js
// (winMakeSecureDir → тот же примитив) и передаёт сюда УЖЕ защищённым. Node
// fs.mkdirSync + post-icacls (/setowner + /grant:r) ЗАПРЕЩЁН: между mkdirSync
// (каталог наследует ACL ProgramData — Users writable) и icacls остаётся окно, в
// котором medium-малварь ТОГО ЖЕ юзера успевает пред-создать/удержать <remoteId>.zip
// и подменить его до распаковки (owner/DACL-window + ZIP-TOCTOU). Поэтому здесь —
// ТОЛЬКО ПРОВЕРКА уже атомарно-защищённого каталога (verifyDirSecureWin), без
// создания и без icacls.

// Проверить (ПОСЛЕ применения ACL), что владелец — SYSTEM/Administrators и в DACL
// нет ни одного постороннего SID (никакого user-SID, Everyone, Users,
// Authenticated Users). SID-based через PowerShell → локаль-независимо. Путь
// передаём env-переменной (не в -Command строке) — без инъекций через путь.
// КРИТИЧНО (round-2): проверяем ВЛАДЕЛЬЦА — icacls /setowner как non-admin может
// молча выйти 0 НЕ сменив владельца; user-owner сохраняет неявный WRITE_DAC и
// сможет вернуть себе доступ. Owner != {SYSTEM,Admins} → INSECURE (fail-closed).
function verifyDirSecureWin(dir, log) {
  const ps = winPowershellPath();
  if (!ps) { log && log('  [sec] powershell не найден — не могу проверить ACL'); return false; }
  const script =
    "$ErrorActionPreference='Stop';" +
    "$d=$env:HM_VERIFY_DIR;" +
    "$allow=@('S-1-5-18','S-1-5-32-544');" +
    "$acl=Get-Acl -LiteralPath $d;" +
    "$o=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;" +
    "if($allow -notcontains $o){Write-Output ('INSECURE:owner='+$o);exit 0};" +
    "foreach($a in $acl.Access){" +
    "try{$s=$a.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value}catch{$s=[string]$a.IdentityReference};" +
    "if($allow -notcontains $s){Write-Output ('INSECURE:ace='+$s);exit 0}};" +
    "Write-Output 'SECURE'";
  const env = Object.assign(trustedEnv(), { HM_VERIFY_DIR: dir });
  const r = spawnSync(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', windowsHide: true, env });
  const out = String(r.stdout || '').trim();
  if (!r.error && r.status === 0 && /(^|\n)SECURE$/.test(out)) return true;
  log && log('  [sec] проверка ACL не пройдена для ' + dir + ': ' + (out || trimOut(r) || (r.error && r.error.message) || ('exit ' + r.status)));
  return false;
}

// Убедиться, что кэш докачки безопасен. Fail-closed: небезопасно → { ok:false } и
// компонент НЕ ставится.
//   Windows: cacheDir УЖЕ рождён АТОМАРНО Admins-only (main.js winMakeSecureDir →
//     New-HmSecureStagingDir): свежий random-leaf каталог под ProgramData, owner=
//     Administrators + DACL {SYSTEM,Administrators}, protection on. ЗДЕСЬ — ТОЛЬКО
//     ПРОВЕРКА (не создаём, не icacls): существует, обычный каталог (не symlink/
//     reparse), owner=Admins и НЕТ посторонних ACE (verifyDirSecureWin, SID-based).
//     Любой сбой проверки (в т.ч. небезопасный пред-существующий каталог) → reject,
//     а НЕ «чиним» post-hoc. Так и .zip, и распаковка живут в Admins-only каталоге →
//     medium-малварь ТОГО ЖЕ юзера не может ни пред-положить, ни подменить архив, ни
//     держать write-handle между SHA-256 и ExtractToDirectory (ZIP-TOCTOU закрыт по
//     конструкции).
//   POSIX: mkdir + owner-check + chmod 700 (best-effort; установка uv неэлевейтед).
function ensureCacheSecure(cacheDir, log) {
  if (process.platform === 'win32') {
    // НЕ создаём и НЕ «чиним» icacls'ом — каталог обязан быть уже атомарно защищён.
    const st = safeLstat(cacheDir);
    if (!st) return { ok: false, error: 'защищённый кэш не найден (ожидался атомарно созданный Admins-only каталог): ' + cacheDir };
    if (st.isSymbolicLink() || !st.isDirectory()) return { ok: false, error: 'кэш небезопасен (симлинк/reparse/не каталог): ' + cacheDir };
    if (!verifyDirSecureWin(cacheDir, log)) return { ok: false, error: 'кэш не прошёл проверку защищённости (нужен owner=Administrators без посторонних ACE): ' + cacheDir };
    return { ok: true };
  }
  // POSIX
  try { fs.mkdirSync(cacheDir, { recursive: true }); }
  catch (e) { return { ok: false, error: 'не удалось создать кэш ' + cacheDir + ': ' + e.message }; }
  const dc = ensureSafeDir(cacheDir);
  if (!dc.ok) return { ok: false, error: dc.error };
  return { ok: true };
}

// Приватный temp-файл в каталоге: O_EXCL + уникальное случайное имя. Возвращает
// { fd, name }. Дескриптор УДЕРЖИВАЕТСЯ вызывающим — пишем и хешируем по нему,
// не переоткрывая по имени (окно подмены закрыто; в admin-owned кэше имя и так
// не подменить).
function openExclTemp(dir) {
  let lastErr;
  for (let i = 0; i < 8; i++) {
    const name = path.join(dir, '.dl-' + crypto.randomBytes(12).toString('hex') + '.part');
    try {
      const fd = fs.openSync(name, 'wx', 0o600); // 'wx' = O_CREAT|O_EXCL|O_WRONLY
      return { fd, name };
    } catch (e) { lastErr = e; if (e.code !== 'EEXIST') throw e; }
  }
  throw lastErr || new Error('не удалось создать временный файл в ' + dir);
}

// ---- анти-SSRF: только публичные адреса (canonical IPv4/IPv6) --------

// Снять [] и zone-id (%eth0) с host/адреса.
function normalizeIp(host) {
  return String(host || '').replace(/^\[/, '').replace(/\]$/, '').replace(/%[^%\]]*$/, '').trim();
}

function ipv4IsPrivate(ip) {
  const o = ip.split('.').map(Number);
  if (o.length !== 4 || o.some((n) => !(n >= 0 && n <= 255))) return true; // мусор → небезопасно
  if (o[0] === 0) return true;                                // 0.0.0.0/8
  if (o[0] === 127) return true;                              // loopback
  if (o[0] === 10) return true;                               // private
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;  // private
  if (o[0] === 192 && o[1] === 168) return true;              // private
  if (o[0] === 169 && o[1] === 254) return true;              // link-local
  if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true; // CGNAT
  if (o[0] === 192 && o[1] === 0 && o[2] === 0) return true;  // IETF protocol
  if (o[0] === 192 && o[1] === 0 && o[2] === 2) return true;  // TEST-NET-1
  if (o[0] === 198 && o[1] === 18) return true;               // benchmark
  if (o[0] === 198 && o[1] === 51 && o[2] === 100) return true; // TEST-NET-2
  if (o[0] === 203 && o[1] === 0 && o[2] === 113) return true; // TEST-NET-3
  if (o[0] >= 224) return true;                               // multicast/reserved
  return false;
}

// Развернуть IPv6-адрес (в т.ч. со встроенным IPv4) в 16 байт. null при мусоре.
function ipv6Bytes(addr) {
  addr = String(addr || '').toLowerCase();
  const dotM = addr.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  let head = addr;
  if (dotM) {
    const v4 = dotM[1].split('.').map(Number);
    if (v4.some((n) => n > 255)) return null;
    const h1 = ((v4[0] << 8) | v4[1]).toString(16);
    const h2 = ((v4[2] << 8) | v4[3]).toString(16);
    head = addr.slice(0, addr.length - dotM[1].length) + h1 + ':' + h2;
  }
  const parts = head.split('::');
  if (parts.length > 2) return null;
  const toGroups = (s) => (s ? s.split(':').filter((x) => x !== '') : []);
  const left = toGroups(parts[0]);
  let groups;
  if (parts.length === 2) {
    const right = toGroups(parts[1]);
    const missing = 8 - (left.length + right.length);
    if (missing < 0) return null;
    groups = left.concat(new Array(missing).fill('0'), right);
  } else {
    groups = left;
  }
  if (groups.length !== 8) return null;
  const b = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    if (!/^[0-9a-f]{1,4}$/.test(groups[i])) return null;
    const v = parseInt(groups[i], 16);
    b[i * 2] = (v >> 8) & 0xff; b[i * 2 + 1] = v & 0xff;
  }
  return b;
}

function ipv6IsPrivate(addr) {
  const b = ipv6Bytes(addr);
  if (!b) return true; // непарсибельно → небезопасно (fail-closed)
  const v4tail = () => [b[12], b[13], b[14], b[15]].join('.');
  if (b.every((x) => x === 0)) return true;                                   // :: unspecified
  if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return true;       // ::1 loopback
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true;                   // fe80::/10 link-local
  if ((b[0] & 0xfe) === 0xfc) return true;                                    // fc00::/7 ULA
  if (b[0] === 0xff) return true;                                             // ff00::/8 multicast
  if (b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff) return ipv4IsPrivate(v4tail()); // ::ffff:0:0/96
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b &&
      b.slice(4, 12).every((x) => x === 0)) return ipv4IsPrivate(v4tail());   // 64:ff9b::/96 NAT64 (well-known)
  // #10: 64:ff9b:1::/48 — NAT64 LOCAL-USE prefix (IANA), НЕ global-reachable. Весь
  // /48 (первые 6 байт = 00 64 ff 9b 00 01) отвергаем безусловно (fail-closed).
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b &&
      b[4] === 0x00 && b[5] === 0x01) return true;                            // 64:ff9b:1::/48 NAT64 local-use
  if (b.slice(0, 12).every((x) => x === 0)) return ipv4IsPrivate(v4tail());   // ::a.b.c.d (deprecated)
  return false;
}

function ipInPrivateRange(ip) {
  const s = normalizeIp(ip);
  const v = net.isIP(s);
  if (v === 4) return ipv4IsPrivate(s);
  if (v === 6) return ipv6IsPrivate(s);
  // Не распознан как IP-литерал: если похоже на IPv6 (есть ':') — пытаемся
  // классифицировать (форма с zone-id уже снята); иначе — небезопасно.
  if (s.indexOf(':') !== -1) return ipv6IsPrivate(s);
  return true;
}

// Проверка URL перед КАЖДЫМ соединением (первичным и на каждом редиректе):
// только https; хост не должен резолвиться в приватный/loopback/link-local адрес.
// cb(err) | cb(null, parsedUrl, pinned) — pinned = ВЕСЬ проверенный DNS-снапшот
// (массив {address,family}) для анти-rebinding и dual-stack; null для IP-литерала.
function guardUrl(u, cb) {
  let parsed;
  try { parsed = new URL(u); } catch (e) { cb(new Error('битый URL: ' + u)); return; }
  if (parsed.protocol !== 'https:') { cb(new Error('разрешён только https (получено ' + parsed.protocol + ')')); return; }
  const host = parsed.hostname;
  const lit = normalizeIp(host);
  if (net.isIP(lit)) {
    if (ipInPrivateRange(lit)) { cb(new Error('запрещённый хост-адрес: ' + host)); return; }
    cb(null, parsed, null); return;
  }
  dns.lookup(host, { all: true }, (err, addrs) => {
    if (err || !addrs || !addrs.length) { cb(new Error('DNS-ошибка для ' + host + (err ? ': ' + err.message : ''))); return; }
    for (const a of addrs) {
      if (ipInPrivateRange(a.address)) { cb(new Error('хост резолвится в приватный адрес (' + a.address + '): ' + host)); return; }
    }
    cb(null, parsed, addrs.map((a) => ({ address: a.address, family: a.family })));
  });
}

// GET с ручным следованием редиректам (S3/CDN могут редиректить). Каждый хоп
// проходит guardUrl. Заголовки (в т.ч. Range) сохраняются между хопами.
// opts.onRequest(req) вызывается на каждый созданный запрос (для внешнего abort
// по дедлайну/watchdog). cb(err, res).
function openStream(url, opts, cb) {
  if (openStreamImpl) { openStreamImpl(url, opts, cb); return; }
  let redirects = 0;
  const maxRedirects = opts.maxRedirects || MAX_REDIRECTS;
  // #8: цепочку редиректов надо разруливать герметично, иначе (а) каждый 302 просто
  // сливал тело и переходил дальше, перезаписывая activeReq — старый redirect-сокет
  // жил вечно (watchdog видит только новейший req); (б) поздняя ошибка старого хопа
  // могла выиграть общий колбэк. Держим ВСЮ цепочку req'ов, глушим её при
  // завершении, а cb вызываем РОВНО один раз (settled-гейт). Ошибка учитывается
  // только от ТЕКУЩЕГО хопа (currentReq) — обрыв старого (destroy при переходе) молчит.
  let settled = false;
  let currentReq = null;
  const chain = [];
  const finishOne = (err, res) => {
    if (settled) { if (res) { try { res.destroy(); } catch (e) { /* ignore */ } } return; }
    settled = true;
    const keep = res && res.req;                 // сокет, который отдаём наружу, не рвём
    for (const r of chain) { if (r !== keep) { try { r.destroy(); } catch (e) { /* ignore */ } } }
    cb(err, res);
  };
  const go = (u) => {
    if (settled) return;
    guardUrl(u, (gerr, parsed, pinned) => {
      if (settled) return;
      if (gerr) { finishOne(gerr); return; }
      const reqOpts = { method: 'GET', headers: opts.headers || {} };
      if (pinned && pinned.length) {
        // Соединяемся строго по проверенным адресам; SNI/Host = домен из URL.
        // Отдаём ВЕСЬ снапшот (dual-stack CDN не падает), Node зовёт lookup с
        // {all:true} и ждёт массив — поддерживаем обе формы.
        reqOpts.lookup = (hostname, options, lcb) => {
          if (options && options.all) lcb(null, pinned.map((a) => ({ address: a.address, family: a.family })));
          else lcb(null, pinned[0].address, pinned[0].family);
        };
      }
      let req;
      try {
        req = https.request(parsed, reqOpts, (res) => {
          if (settled) { try { res.destroy(); } catch (e) { /* ignore */ } return; }
          const sc = res.statusCode;
          if (sc >= 300 && sc < 400 && res.headers.location) {
            try { res.destroy(); } catch (e) { /* ignore */ } // #8: рвём тело редиректа (не держим сокет; прежде тут был resume-слив)
            if (++redirects > maxRedirects) { finishOne(new Error('слишком много редиректов')); return; }
            let next;
            try { next = new URL(res.headers.location, parsed).toString(); }
            catch (e) { finishOne(new Error('битый Location: ' + res.headers.location)); return; }
            const prev = currentReq; currentReq = null; // ошибки старого хопа больше не в счёт
            try { prev && prev.destroy(); } catch (e) { /* ignore */ }
            go(next);
            return;
          }
          finishOne(null, res);
        });
      } catch (e) { finishOne(e); return; }
      currentReq = req;
      chain.push(req);
      try { opts.onRequest && opts.onRequest(req); } catch (e) { /* ignore */ }
      req.setTimeout(opts.timeoutMs || CONNECT_TIMEOUT, () => {
        req.destroy(new Error('таймаут соединения (' + parsed.host + ')'));
      });
      req.on('error', (e) => { if (req === currentReq) finishOne(e); }); // только текущий хоп
      req.end();
    });
  };
  go(url);
}

// Пробинг зеркала: Range bytes=0-0, живо = 200/206. Абсолютный дедлайн
// PROBE_DEADLINE с реальным destroy() зависшего запроса (без утечки сокета).
function probeMirror(url, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let done = false;
    let hard = null;
    let activeReq = null;
    const finish = (r) => {
      if (done) return; done = true;
      if (hard) clearTimeout(hard);
      try { activeReq && activeReq.destroy(); } catch (e) { /* ignore */ }
      resolve(r);
    };
    hard = setTimeout(() => finish({ url, ok: false, code: 0, ms: Date.now() - t0 }), PROBE_DEADLINE);
    openStream(url, {
      headers: { 'User-Agent': USER_AGENT, Range: 'bytes=0-0' },
      timeoutMs: Math.min(timeoutMs || CONNECT_TIMEOUT, PROBE_DEADLINE), maxRedirects: MAX_REDIRECTS,
      onRequest: (req) => { activeReq = req; if (done) { try { req.destroy(); } catch (e) { /* ignore */ } } }
    }, (err, res) => {
      if (err) { finish({ url, ok: false }); return; }
      const sc = res.statusCode;
      try { res.destroy(); } catch (e) { /* ignore */ } // заголовков достаточно
      finish({ url, ok: sc === 200 || sc === 206, code: sc, ms: Date.now() - t0 });
    });
  });
}

// Скачать URL в УДЕРЖИВАЕМЫЙ дескриптор fd с ПОТОКОВЫМ sha (held-fd, FIX-B).
// Внутри — bounded resume (докачка после обрыва от текущего смещения) + жёсткий
// size-cap + контроль минимальной скорости + АБСОЛЮТНЫЙ дедлайн, который тикает
// с САМОГО НАЧАЛА (до connect/DNS) — покрывает висящий DNS/connect и медленную
// отдачу заголовков (header-trickle). Promise завершается РОВНО один раз.
// → { ok:true, bytes, sha } | { ok:false, error }
function downloadToFd(url, fd, expectedSize, onProgress, timeoutMs, deadlineAt, tuning) {
  tuning = tuning || {};
  const stallWindow = tuning.stallWindow || STALL_WINDOW;
  const stallMinBytes = (tuning.stallMinBytes != null) ? tuning.stallMinBytes : STALL_MIN_BYTES;
  const tickMs = tuning.tickMs || WATCH_TICK;
  const cap = expectedSize || 0;

  return new Promise((resolve) => {
    let hash = crypto.createHash('sha256');
    let written = 0;
    let done = false;
    let subAttempts = 0;
    let activeReq = null;
    let activeRes = null;
    let lastTick = Date.now();
    let lastTickBytes = 0;
    let lastPct = -1;

    const finish = (r) => {
      if (done) return; done = true;
      clearInterval(watch);
      try { activeRes && activeRes.destroy(); } catch (e) { /* ignore */ }
      try { activeReq && activeReq.destroy(); } catch (e) { /* ignore */ }
      resolve(r);
    };

    // FIX-F: watchdog СТАРТУЕТ СЕЙЧАС, ДО openStream (до DNS/connect).
    const watch = setInterval(() => {
      if (done) return;
      if (deadlineAt && Date.now() > deadlineAt) { finish({ ok: false, error: 'дедлайн скачивания превышен' }); return; }
      const now = Date.now();
      if (now - lastTick >= stallWindow) {
        if (written - lastTickBytes < stallMinBytes) { finish({ ok: false, error: 'скорость ниже минимума — обрыв' }); return; }
        lastTick = now; lastTickBytes = written;
      }
    }, tickMs);

    const restartFresh = () => {
      try { fs.ftruncateSync(fd, 0); } catch (e) { /* ignore */ }
      hash = crypto.createHash('sha256');
      written = 0;
    };

    const attempt = () => {
      if (done) return;
      if (++subAttempts > MAX_SUB_ATTEMPTS) { finish({ ok: false, error: 'исчерпаны попытки докачки' }); return; }
      let cbUsed = false;    // openStream может позвать cb дважды (res, потом поздний error) — учитываем 1 раз
      let advanced = false;  // этот attempt уже уступил место resume — не дублируем из error/close/end
      let localErr = false;
      const nextAttempt = () => { if (advanced || done) return; advanced = true; attempt(); };
      const headers = { 'User-Agent': USER_AGENT };
      if (written > 0) headers.Range = 'bytes=' + written + '-';
      openStream(url, {
        headers, timeoutMs, maxRedirects: MAX_REDIRECTS,
        onRequest: (req) => { activeReq = req; if (done) { try { req.destroy(); } catch (e) { /* ignore */ } } }
      }, (err, res) => {
        if (done) { try { res && res.destroy(); } catch (e) { /* ignore */ } return; }
        if (cbUsed) return; // повторный вызов cb для того же запроса (поздний error после res) — игнор
        cbUsed = true;
        if (err) { nextAttempt(); return; } // обрыв на connect/DNS → bounded retry
        activeRes = res;
        const code = res.statusCode;

        if (code === 416) { restartFresh(); try { res.destroy(); } catch (e) { /* ignore */ } nextAttempt(); return; }
        if (written > 0 && code === 206) {
          const cr = String(res.headers['content-range'] || '');
          const mr = cr.match(/bytes\s+(\d+)-/i);
          if (mr && Number(mr[1]) !== written) { restartFresh(); try { res.destroy(); } catch (e) { /* ignore */ } nextAttempt(); return; }
          // корректная докачка от written — пишем хвост в этот же response
        } else if (code === 200) {
          if (written > 0) restartFresh(); // сервер проигнорировал Range → пишем full с нуля из этого response
        } else if (code >= 400) { finish({ ok: false, error: 'HTTP ' + code }); return; }
        else if (code >= 300) { finish({ ok: false, error: 'HTTP ' + code }); return; }
        // иначе 2xx при written===0 — пишем с нуля

        res.on('data', (chunk) => {
          if (done || localErr) return;
          // #9 (held-fd short-write): fs.writeSync возвращает ЧИСЛО реально записанных
          // байт. При коротком записи хешировать весь чанк нельзя — файл окажется
          // КОРОЧЕ проверенного, а sha/size «совпадут» → публикуется обрезанный. Пишем
          // в цикле по возвращаемому счётчику; фейлим при нулевом прогрессе; хешируем
          // ТОЛЬКО реально записанные байты; written растёт строго на записанное.
          let off = 0;
          while (off < chunk.length) {
            let n;
            try { n = fs.writeSync(fd, chunk, off, chunk.length - off, written + off); }
            catch (e) { localErr = true; try { res.destroy(); } catch (x) { /* ignore */ } finish({ ok: false, error: 'запись на диск: ' + String(e.message || e) }); return; }
            if (!(n > 0)) { localErr = true; try { res.destroy(); } catch (x) { /* ignore */ } finish({ ok: false, error: 'нулевой прогресс записи на диск (short-write)' }); return; }
            hash.update(chunk.subarray(off, off + n)); // хешируем РОВНО записанный сегмент
            off += n;
          }
          written += off; // off === chunk.length после полной записи
          if (cap && written > cap) { localErr = true; try { res.destroy(); } catch (x) { /* ignore */ } finish({ ok: false, error: 'превышен ожидаемый размер (' + written + ' > ' + cap + ')' }); return; }
          if (cap) {
            const pct = Math.min(100, Math.floor((written / cap) * 100));
            if (pct !== lastPct) { lastPct = pct; try { onProgress && onProgress({ received: written, total: cap, pct }); } catch (e) { /* ignore */ } }
          } else {
            try { onProgress && onProgress({ received: written, total: 0, pct: null }); } catch (e) { /* ignore */ }
          }
        });
        // Обрыв в середине: 'error' или 'close' без 'end' → одна попытка resume от written.
        res.on('error', () => { if (done || localErr) return; activeRes = null; nextAttempt(); });
        res.on('close', () => { if (done || localErr) return; activeRes = null; nextAttempt(); });
        res.on('end', () => {
          if (done || localErr) return;
          activeRes = null;
          if (cap && written < cap) { nextAttempt(); return; } // короткий ответ → докачиваем
          // #9: перед публикацией — РЕАЛЬНЫЙ размер файла на диске == хешированному
          // (written) == ожидаемому (cap, если известен). Закрывает случай, когда
          // held-fd короче, чем то, что мы «посчитали» записанным/захешированным.
          let fsize = -1;
          try { fsize = fs.fstatSync(fd).size; }
          catch (e) { finish({ ok: false, error: 'fstat перед публикацией не удался: ' + String(e.message || e) }); return; }
          if (fsize !== written) { finish({ ok: false, error: 'размер на диске (' + fsize + ') не совпал с записанным (' + written + ')' }); return; }
          if (cap && (written !== cap || fsize !== cap)) { finish({ ok: false, error: 'итоговый размер ' + written + ' не равен ожидаемому ' + cap }); return; }
          finish({ ok: true, bytes: written, sha: hash.digest('hex').toLowerCase() });
        });
      });
    };

    attempt();
  });
}

// Распаковка zip доверенным системным распаковщиком по АБСОЛЮТНОМУ пути с
// очищенным env (анти-PATH-hijack). Пересоздаёт целевой каталог с нуля.
function unpackZip(zipPath, destDir) {
  try {
    try { fs.rmSync(destDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    fs.mkdirSync(destDir, { recursive: true });
    const env = trustedEnv();
    if (process.platform === 'win32') {
      const ps = winPowershellPath();
      if (!ps) return { ok: false, error: 'powershell не найден в System32 — распаковка невозможна (fail-closed)' };
      const zp = zipPath.replace(/'/g, "''");
      const dp = destDir.replace(/'/g, "''");
      const psScript =
        'Add-Type -AssemblyName System.IO.Compression.FileSystem; ' +
        "[System.IO.Compression.ZipFile]::ExtractToDirectory('" + zp + "','" + dp + "')";
      const r = spawnSync(ps,
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
        { windowsHide: true, encoding: 'utf8', env });
      if (r.error) return { ok: false, error: String(r.error.message || r.error) };
      if (r.status !== 0) {
        return { ok: false, error: String((r.stderr || r.stdout || ('powershell exit ' + r.status)) || '').trim() };
      }
    } else {
      let r = spawnSync('/usr/bin/unzip', ['-o', '-q', zipPath, '-d', destDir], { encoding: 'utf8', env });
      if (r.error || r.status !== 0) {
        // Фолбэк для macOS без unzip в PATH — ditto по абсолютному пути.
        r = spawnSync('/usr/bin/ditto', ['-x', '-k', zipPath, destDir], { encoding: 'utf8', env });
        if (r.error || r.status !== 0) {
          return { ok: false, error: String((r.stderr || (r.error && r.error.message) || 'распаковка не удалась')).trim() };
        }
      }
    }
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e) }; }
}

// Удалить ВСЕ прежние unpacked-*/unpacking-* каталоги. Fail-closed: если хоть
// один НЕ удалился — { ok:false } (не продолжаем в старом каталоге).
function removeOldUnpacked(cacheDir) {
  let names;
  try { names = fs.readdirSync(cacheDir); }
  catch (e) { return { ok: false, error: 'чтение кэша ' + cacheDir + ': ' + String(e.message || e) }; }
  for (const name of names) {
    if (name.indexOf('unpacked') === 0 || name.indexOf('unpacking') === 0) {
      const p = path.join(cacheDir, name);
      try { fs.rmSync(p, { recursive: true, force: true }); }
      catch (e) { return { ok: false, error: 'не удалить старую распаковку ' + p + ': ' + String(e.message || e) }; }
      if (safeLstat(p)) return { ok: false, error: 'старая распаковка не удалилась: ' + p };
    }
  }
  return { ok: true };
}

// Свежая распаковка (FIX-C): fail-closed чистка старых unpacked-* → распаковка в
// НОВЫЙ случайный staging → атомарная публикация (rename) в finalDir ТОЛЬКО при
// полном успехе. Ошибка на любом шаге → { ok:false } (ничего не публикуем).
function freshUnpack(zipPath, finalDir, cacheDir) {
  const rm = removeOldUnpacked(cacheDir);
  if (!rm.ok) return { ok: false, error: rm.error };
  const staging = path.join(cacheDir, 'unpacking-' + crypto.randomBytes(9).toString('hex'));
  const u = unpackZip(zipPath, staging);
  if (!u.ok) { try { fs.rmSync(staging, { recursive: true, force: true }); } catch (e) { /* ignore */ } return { ok: false, error: u.error }; }
  try {
    if (safeLstat(finalDir)) { try { fs.rmSync(finalDir, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
    if (safeLstat(finalDir)) { try { fs.rmSync(staging, { recursive: true, force: true }); } catch (e) { /* ignore */ } return { ok: false, error: 'целевой каталог распаковки не освобождён: ' + finalDir }; }
    fs.renameSync(staging, finalDir);
  } catch (e) {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch (x) { /* ignore */ }
    return { ok: false, error: 'атомарная публикация распаковки не удалась: ' + String(e.message || e) };
  }
  return { ok: true };
}

// ---- основной вход --------------------------------------------------

// fetchRemote({ entry, cacheDir, onProgress, onLog, timeoutMs, downloadDeadlineMs, tuning })
//   entry     — запись реестра (remoteId, sizeBytes, sha256, mirrors[], …)
//   cacheDir  — admin-owned staging (main.js: %ProgramData%\HamidunSetup\cache\<id>)
//   onProgress({received,total,pct}) — прогресс докачки (для step-list)
//   onLog(str)                       — человекочитаемый лог (в общий лог)
// → { ok:true, path:<unpacked>, bytes, sha256, mirror, cached? } | { ok:false, error }
async function fetchRemote(opts) {
  opts = opts || {};
  const entry = opts.entry;
  const cacheDir = opts.cacheDir;
  const onProgress = opts.onProgress;
  const timeoutMs = opts.timeoutMs || CONNECT_TIMEOUT;
  const dlDeadline = opts.downloadDeadlineMs || DOWNLOAD_DEADLINE;
  const tuning = opts.tuning || null;
  const log = (m) => { try { opts.onLog && opts.onLog(m); } catch (e) { /* ignore */ } };

  if (!entry || !entry.remoteId) return { ok: false, error: 'нет записи реестра для компонента' };
  if (!cacheDir) return { ok: false, error: 'не задан cacheDir' };

  // P0-1 (fail-closed): sha256 ОБЯЗАТЕЛЕН и валиден. Нет валидного sha в реестре →
  // компонент НЕ ставится. Проверяем ПЕРВЫМ — до любой файловой активности.
  const expectedSha = String(entry.sha256 || '').toLowerCase();
  if (!SHA_RE.test(expectedSha)) {
    return { ok: false, error: 'нет валидного SHA-256 в реестре для «' + entry.remoteId + '» — установка remote-компонента заблокирована (fail-closed)' };
  }
  const expectedSize = Number(entry.sizeBytes || 0);

  // Проверяем защищённость staging (Windows: каталог УЖЕ рождён атомарно Admins-only
  // в main.js winMakeSecureDir; здесь ТОЛЬКО verify, без create/icacls). Fail-closed:
  // не защищён → НЕ ставим. В test-mode (транспорт подменён юнит-тестом) ACL-гейт
  // пропускаем — подменить openStreamImpl атакующий не может (in-proc переменная).
  if (!openStreamImpl) {
    const h = ensureCacheSecure(cacheDir, log);
    if (!h.ok) return { ok: false, error: 'staging-каталог не защищён — установка remote-компонента заблокирована (fail-closed): ' + h.error };
  } else {
    try { fs.mkdirSync(cacheDir, { recursive: true }); }
    catch (e) { return { ok: false, error: 'не удалось создать кэш ' + cacheDir + ': ' + e.message }; }
    const dc = ensureSafeDir(cacheDir);
    if (!dc.ok) return { ok: false, error: dc.error };
  }

  const archivePath = path.join(cacheDir, entry.remoteId + '.zip');
  const unpackDir = path.join(cacheDir, 'unpacked-' + expectedSha);

  // Идемпотентность: валидный архив уже в кэше (sha ок) → сеть не трогаем, но
  // РАСПАКОВЫВАЕМ ЗАНОВО в свежий каталог (FIX-C). Файл в admin-owned кэше — имя
  // не подменить, поэтому name-based sha256File здесь безопасен.
  if (safeIsFile(archivePath)) {
    const got = await sha256File(archivePath);
    if (got === expectedSha) {
      const u = freshUnpack(archivePath, unpackDir, cacheDir);
      if (!u.ok) return { ok: false, error: 'кэш валиден, но распаковка не удалась: ' + u.error };
      log('Уже в кэше (SHA-256 совпал) — пропускаю скачивание: ' + entry.remoteId);
      return { ok: true, path: unpackDir, cached: true, sha256: expectedSha, bytes: expectedSize };
    }
    try { fs.unlinkSync(archivePath); } catch (e) { /* ignore */ }
  } else if (safeLstat(archivePath)) {
    try { fs.rmSync(archivePath, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }

  const mirrors = (entry.mirrors || []).map((m) => m && m.url).filter(isFetchableUrl);
  if (!mirrors.length) return { ok: false, error: 'нет доступных зеркал для ' + entry.remoteId + ' (R2 — заглушка)' };

  // Пробинг с абсолютным дедлайном на каждый (allSettled — один зависший probe
  // не блокирует остальные). Живые — по возрастанию латентности, мёртвые в хвост.
  const settled = await Promise.allSettled(mirrors.map((u) => probeMirror(u, timeoutMs)));
  const probes = settled.map((r, i) => (r.status === 'fulfilled' ? r.value : { url: mirrors[i], ok: false }));
  const live = probes.filter((p) => p.ok).sort((a, b) => a.ms - b.ms).map((p) => p.url);
  const dead = mirrors.filter((u) => live.indexOf(u) === -1);
  const order = live.concat(dead);
  log('Зеркал живых: ' + live.length + ' из ' + mirrors.length +
      (live.length ? ' (быстрейшее: ' + hostOf(live[0]) + ')' : ''));

  let lastErr = 'неизвестно';
  for (const url of order) {
    const deadlineAt = Date.now() + dlDeadline;
    log('Качаю ' + entry.remoteId + ' из ' + hostOf(url) + ' …');

    // Приватный temp-файл (O_EXCL) в защищённом кэше; УДЕРЖИВАЕМ fd весь download+hash.
    let tmp;
    try { tmp = openExclTemp(cacheDir); }
    catch (e) { lastErr = 'temp: ' + String(e.message || e); log('  ! ' + lastErr); continue; }

    let dr;
    try {
      dr = await downloadToFd(url, tmp.fd, expectedSize, onProgress, timeoutMs, deadlineAt, tuning);
      try { fs.fsyncSync(tmp.fd); } catch (e) { /* ignore */ }
    } finally { try { fs.closeSync(tmp.fd); } catch (e) { /* ignore */ } }

    if (!dr.ok) {
      lastErr = dr.error || 'скачивание не удалось';
      try { fs.unlinkSync(tmp.name); } catch (e) { /* ignore */ }
      log('  ! ' + lastErr);
      continue; // сетевой сбой/дедлайн этого зеркала — следующее зеркало
    }

    // sha посчитан ПОТОКОВО по held-fd — без переоткрытия по имени (FIX-B).
    if (dr.sha !== expectedSha) {
      lastErr = 'SHA-256 не совпал (ожид ' + expectedSha.slice(0, 12) + '…, получено ' + (dr.sha || '?').slice(0, 12) + '…)';
      try { fs.unlinkSync(tmp.name); } catch (e) { /* ignore */ }
      log('  ! ' + lastErr + ' — удаляю, пробую следующее зеркало');
      continue;
    }

    // sha ок → атомарно фиксируем стабильный <remoteId>.zip и распаковываем заново.
    try {
      try { fs.rmSync(archivePath, { recursive: true, force: true }); } catch (e) { /* ignore */ }
      fs.renameSync(tmp.name, archivePath);
    } catch (e) {
      try { fs.unlinkSync(tmp.name); } catch (x) { /* ignore */ }
      lastErr = 'не удалось зафиксировать архив: ' + String(e.message || e);
      log('  ! ' + lastErr);
      continue;
    }
    const u = freshUnpack(archivePath, unpackDir, cacheDir);
    if (!u.ok) { lastErr = 'распаковка: ' + u.error; log('  ! ' + lastErr); return { ok: false, error: 'распаковка не удалась (fail-closed): ' + u.error }; }

    log('Готово: ' + entry.remoteId + ' — ' + fmtMB(dr.bytes) + ', целостность подтверждена (SHA-256).');
    return { ok: true, path: unpackDir, bytes: dr.bytes, sha256: dr.sha, mirror: url };
  }

  return { ok: false, error: 'все зеркала не сработали: ' + lastErr };
}

module.exports = {
  fetchRemote,
  pickEntry,
  isFetchableUrl,
  sha256File,
  unpackZip,
  freshUnpack,
  removeOldUnpacked,
  probeMirror,
  downloadToFd,
  ipInPrivateRange,
  // системные пути (для main.js — единый источник правды по FIX-E)
  winSystemRoot,
  winSystem32,
  sysBin,
  winPowershellPath,
  winProgramData,
  // security-хелперы (для отчёта/тестов)
  ensureCacheSecure,      // Windows: проверка атомарно-защищённого кэша (без create/icacls)
  verifyDirSecureWin,     // SID-based проверка owner+DACL (Windows)
  // тест-хук: подмена транспорта openStream для детерминированных resume-тестов.
  __setOpenStreamImpl: (fn) => { openStreamImpl = fn || null; }
};
