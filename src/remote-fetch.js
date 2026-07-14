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
 * (см. test/remote-fetch-live.js). main.js вызывает fetchRemote() ВНУТРИ
 * обработчика run-component: докачка+проверка+распаковка+запуск идут одной
 * атомарной операцией в main-процессе (renderer не может вклиниться между шагами).
 *
 * МОДЕЛЬ УГРОЗ: установщик работает с повышенными правами и ЗАПУСКАЕТ бинари из
 * пользовательского кэша. Единственный гейт целостности — SHA-256, поэтому:
 *   • sha256 ОБЯЗАТЕЛЕН и валиден (64-hex) — иначе компонент НЕ ставится (fail-closed);
 *   • сравнение хэша БЕЗУСЛОВНОЕ (нет sha в реестре → не качаем и не запускаем);
 *   • скачивание идёт в приватный temp-файл (O_EXCL, уникальное имя) — атакующий
 *     не может подсунуть файл на известный путь;
 *   • кэш-каталог ужесточается по ACL (Win: только SYSTEM+Администраторы+владелец;
 *     mac: chmod 700 + проверка владельца), симлинки/reparse-points отвергаются;
 *   • ПОСЛЕ проверки sha архив СРАЗУ распаковывается заново в свежий каталог и
 *     возвращается — «непустая папка» НЕ считается признаком целостности;
 *   • системные распаковщики зовутся по АБСОЛЮТНЫМ доверенным путям с очищенным
 *     env (минимальный PATH) — без PATH-hijack;
 *   • только HTTPS, без downgrade на http, редиректы/хосты в приватные/loopback/
 *     link-local адреса отвергаются (анти-SSRF), адрес пиннится (анти-rebinding);
 *   • абсолютный дедлайн и контроль минимальной скорости на скачивание, жёсткий
 *     size-cap (disk-DoS/вечное висение исключены).
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
const MAX_REDIRECTS = 6;
const USER_AGENT = 'hamidun-setup';
const SHA_RE = /^[0-9a-f]{64}$/;

// Транспорт (openStream) свапается ТОЛЬКО в юнит-тестах через __setOpenStreamImpl,
// чтобы детерминированно прогонять resume-ветки против локального http-сервера,
// не ослабляя боевые гейты (https-only/анти-SSRF живут в реальном openStream).
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

// Кэш-каталог должен быть настоящим каталогом (не симлинком/junction) и на POSIX —
// принадлежать нам, с правами 700.
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

// Определить SID текущего пользователя (Windows) — для точечного grant в ACL.
function currentUserSidWin() {
  try {
    const sysroot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
    const whoami = path.join(sysroot, 'System32', 'whoami.exe');
    const r = spawnSync(whoami, ['/user', '/fo', 'csv', '/nh'],
      { encoding: 'utf8', windowsHide: true, env: trustedEnv() });
    if (r.status === 0 && r.stdout) {
      const m = r.stdout.trim().match(/"([^"]*)","(S-1-[0-9-]+)"/);
      if (m) return m[2];
    }
  } catch (e) { /* ignore */ }
  return '';
}

// Ужесточить ACL кэш-каталога: доступ ТОЛЬКО SYSTEM+Администраторы+владелец
// (Windows) или chmod 700 (mac/linux). Атомарно и best-effort: провал не валит
// установку, но логируется. SID/well-known SID — без локализации имён групп.
function hardenDirAcl(dir, log) {
  try {
    if (process.platform === 'win32') {
      const sid = currentUserSidWin();
      if (!sid) { log && log('  [warn] не удалось определить SID пользователя — ACL кэша не ужесточён'); return false; }
      const sysroot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
      const icacls = path.join(sysroot, 'System32', 'icacls.exe');
      // Один атомарный вызов: снять наследование и выдать полный доступ ровно
      // трём: SYSTEM (*S-1-5-18), Администраторы (*S-1-5-32-544), владелец (*<sid>).
      const r = spawnSync(icacls, [
        dir, '/inheritance:r',
        '/grant:r', '*S-1-5-18:(OI)(CI)F',
        '/grant:r', '*S-1-5-32-544:(OI)(CI)F',
        '/grant:r', '*' + sid + ':(OI)(CI)F'
      ], { encoding: 'utf8', windowsHide: true, env: trustedEnv() });
      if (r.status !== 0) {
        log && log('  [warn] icacls не смог ужесточить ACL кэша: ' + String((r.stderr || r.stdout || '').trim()));
        return false;
      }
      return true;
    }
    fs.chmodSync(dir, 0o700);
    return true;
  } catch (e) { log && log('  [warn] hardenDirAcl: ' + String(e.message || e)); return false; }
}

// Приватный temp-файл в каталоге: O_EXCL + уникальное случайное имя. Возвращает
// { fd, name }. Атакующий не может предсоздать/подсунуть симлинк на этот путь.
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

// ---- доверенные бинари / очищенный env (анти-PATH-hijack) -----------

// Минимальный env для дочерних системных бинарей: только системные каталоги в
// PATH, чтобы powershell/unzip/ditto не подхватили подложенный бинарь.
function trustedEnv() {
  if (process.platform === 'win32') {
    const sysroot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
    const p = [
      path.join(sysroot, 'System32'),
      sysroot,
      path.join(sysroot, 'System32', 'WindowsPowerShell', 'v1.0')
    ].join(';');
    return {
      SystemRoot: sysroot, windir: sysroot, PATH: p, Path: p,
      TEMP: process.env.TEMP || process.env.TMP || '',
      TMP: process.env.TMP || process.env.TEMP || ''
    };
  }
  return { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
}

function winPowershell() {
  const sysroot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  return path.join(sysroot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

// ---- анти-SSRF: только публичные адреса ------------------------------

function ipInPrivateRange(ip) {
  const v = net.isIP(ip);
  if (v === 4) {
    const o = ip.split('.').map(Number);
    if (o[0] === 0) return true;                              // 0.0.0.0/8
    if (o[0] === 127) return true;                           // loopback
    if (o[0] === 10) return true;                            // private
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true; // private
    if (o[0] === 192 && o[1] === 168) return true;           // private
    if (o[0] === 169 && o[1] === 254) return true;           // link-local
    if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true; // CGNAT
    if (o[0] >= 224) return true;                            // multicast/reserved
    return false;
  }
  if (v === 6) {
    const a = ip.toLowerCase().replace(/^\[|\]$/g, '');
    if (a === '::1' || a === '::') return true;              // loopback/unspecified
    if (a.startsWith('fe80')) return true;                  // link-local
    if (a.startsWith('fc') || a.startsWith('fd')) return true; // ULA
    if (a.startsWith('ff')) return true;                    // multicast
    const m = a.match(/(?:::ffff:)(\d+\.\d+\.\d+\.\d+)$/);   // IPv4-mapped
    if (m) return ipInPrivateRange(m[1]);
    return false;
  }
  return false;
}

// Проверка URL перед КАЖДЫМ соединением (первичным и на каждом редиректе):
// только https; хост не должен резолвиться в приватный/loopback/link-local адрес.
// cb(err) | cb(null, parsedUrl, pinnedAddr) — pinnedAddr пиннит проверенный IP
// (анти-DNS-rebinding: соединяемся ровно по нему, SNI/Host остаются доменом).
function guardUrl(u, cb) {
  let parsed;
  try { parsed = new URL(u); } catch (e) { cb(new Error('битый URL: ' + u)); return; }
  if (parsed.protocol !== 'https:') { cb(new Error('разрешён только https (получено ' + parsed.protocol + ')')); return; }
  const host = parsed.hostname;
  if (net.isIP(host)) {
    if (ipInPrivateRange(host)) { cb(new Error('запрещённый хост-адрес: ' + host)); return; }
    cb(null, parsed, null); return;
  }
  dns.lookup(host, { all: true }, (err, addrs) => {
    if (err || !addrs || !addrs.length) { cb(new Error('DNS-ошибка для ' + host + (err ? ': ' + err.message : ''))); return; }
    for (const a of addrs) {
      if (ipInPrivateRange(a.address)) { cb(new Error('хост резолвится в приватный адрес (' + a.address + '): ' + host)); return; }
    }
    cb(null, parsed, addrs[0]);
  });
}

// GET с ручным следованием редиректам (S3/CDN могут редиректить). Каждый хоп
// проходит guardUrl. Заголовки (в т.ч. Range) сохраняются между хопами. cb(err, res).
function openStream(url, opts, cb) {
  if (openStreamImpl) { openStreamImpl(url, opts, cb); return; }
  let redirects = 0;
  const maxRedirects = opts.maxRedirects || MAX_REDIRECTS;
  const go = (u) => {
    guardUrl(u, (gerr, parsed, pinned) => {
      if (gerr) { cb(gerr); return; }
      const reqOpts = { method: 'GET', headers: opts.headers || {} };
      if (pinned) {
        // Соединяемся строго по проверенному адресу; SNI/Host = домен из URL.
        // Node зовёт lookup с {all:true} и ждёт массив — поддерживаем обе формы.
        reqOpts.lookup = (hostname, options, lcb) => {
          if (options && options.all) lcb(null, [{ address: pinned.address, family: pinned.family }]);
          else lcb(null, pinned.address, pinned.family);
        };
      }
      let req;
      try {
        req = https.request(parsed, reqOpts, (res) => {
          const sc = res.statusCode;
          if (sc >= 300 && sc < 400 && res.headers.location) {
            res.resume(); // сливаем тело редиректа, чтобы освободить сокет
            if (++redirects > maxRedirects) { cb(new Error('слишком много редиректов')); return; }
            let next;
            try { next = new URL(res.headers.location, parsed).toString(); }
            catch (e) { cb(new Error('битый Location: ' + res.headers.location)); return; }
            go(next);
            return;
          }
          cb(null, res);
        });
      } catch (e) { cb(e); return; }
      req.setTimeout(opts.timeoutMs || CONNECT_TIMEOUT, () => {
        req.destroy(new Error('таймаут соединения (' + parsed.host + ')'));
      });
      req.on('error', (e) => cb(e));
      req.end();
    });
  };
  go(url);
}

// Пробинг зеркала: Range bytes=0-0, живо = 200/206. Абсолютный дедлайн PROBE_DEADLINE.
function probeMirror(url, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let done = false;
    let hard = null;
    const finish = (r) => { if (!done) { done = true; if (hard) clearTimeout(hard); resolve(r); } };
    hard = setTimeout(() => finish({ url, ok: false, code: 0, ms: Date.now() - t0 }), PROBE_DEADLINE);
    openStream(url, {
      headers: { 'User-Agent': USER_AGENT, Range: 'bytes=0-0' },
      timeoutMs: Math.min(timeoutMs || CONNECT_TIMEOUT, PROBE_DEADLINE), maxRedirects: MAX_REDIRECTS
    }, (err, res) => {
      if (err) { finish({ url, ok: false }); return; }
      const sc = res.statusCode;
      try { res.destroy(); } catch (e) {} // заголовков достаточно — тело не нужно
      finish({ url, ok: sc === 200 || sc === 206, code: sc, ms: Date.now() - t0 });
    });
  });
}

// Одна HTTP-попытка скачивания в filePath с докачкой (resume от текущего размера).
// Гейты: жёсткий size-cap (expectedSize), абсолютный дедлайн (deadlineAt),
// контроль минимальной скорости (STALL_WINDOW/STALL_MIN_BYTES), сверка Content-Range.
// → {ok, bytes} | {ok:false, error} | {ok:false, retryFresh:true} (416/битый диапазон).
function downloadWithResume(url, filePath, expectedSize, onProgress, timeoutMs, deadlineAt) {
  return new Promise((resolve) => {
    let start = 0;
    try { start = fs.statSync(filePath).size; } catch (e) { start = 0; }
    // Частичный файл больше ожидаемого => мусор/битый: начинаем с нуля.
    if (expectedSize && start > expectedSize) {
      try { fs.truncateSync(filePath, 0); } catch (e) { /* ignore */ }
      start = 0;
    }
    // Уже полный по размеру — sha проверит вызывающий.
    if (expectedSize && start === expectedSize) { resolve({ ok: true, bytes: start }); return; }

    const headers = { 'User-Agent': USER_AGENT };
    if (start > 0) { headers.Range = 'bytes=' + start + '-'; }

    openStream(url, { headers, timeoutMs, maxRedirects: MAX_REDIRECTS }, (err, res) => {
      if (err) { resolve({ ok: false, error: String(err.message || err) }); return; }
      const code = res.statusCode;
      let flags = 'a';
      let base = start;

      if (code === 416) {
        // Range не удовлетворить — вероятно, хвост битый: качаем заново.
        try { res.destroy(); } catch (e) {}
        try { fs.truncateSync(filePath, 0); } catch (e) {}
        resolve({ ok: false, retryFresh: true, error: 'HTTP 416' });
        return;
      }
      if (start > 0 && code === 206) {
        // Проверяем, что сервер отдал ИМЕННО запрошенный диапазон.
        const cr = String(res.headers['content-range'] || '');
        const mr = cr.match(/bytes\s+(\d+)-/i);
        if (mr && Number(mr[1]) !== start) {
          try { res.destroy(); } catch (e) {}
          try { fs.truncateSync(filePath, 0); } catch (e) {}
          resolve({ ok: false, retryFresh: true, error: 'Content-Range не совпал (' + cr + ')' });
          return;
        }
        flags = 'a'; base = start; // корректная докачка
      } else if (code === 200) {
        // Полный ответ (в т.ч. сервер проигнорировал Range) — файл заново.
        flags = 'w'; base = 0;
        try { fs.truncateSync(filePath, 0); } catch (e) { /* ignore */ }
      } else if (code >= 400) {
        try { res.destroy(); } catch (e) {}
        resolve({ ok: false, error: 'HTTP ' + code });
        return;
      } else {
        // 206 при start===0 или иной 2xx — пишем с нуля.
        flags = 'w'; base = 0;
        try { fs.truncateSync(filePath, 0); } catch (e) { /* ignore */ }
      }

      const clen = parseInt(res.headers['content-length'] || '0', 10) || 0;
      const total = expectedSize || (base + clen) || 0;
      const cap = expectedSize || 0; // жёсткий предел (0 = выключен)
      let received = base;
      let lastPct = -1;
      let settled = false;
      let lastTick = Date.now();
      let lastTickBytes = received;

      let out;
      try { out = fs.createWriteStream(filePath, { flags }); }
      catch (e) { try { res.destroy(); } catch (x) {} resolve({ ok: false, error: String(e) }); return; }

      const fail = (msg) => {
        if (settled) return; settled = true;
        clearInterval(watch);
        try { res.destroy(); } catch (e) {}
        try { out.destroy(); } catch (e) {}
        resolve({ ok: false, error: msg });
      };

      // Watchdog: абсолютный дедлайн + минимальная скорость.
      const watch = setInterval(() => {
        if (deadlineAt && Date.now() > deadlineAt) { fail('дедлайн скачивания превышен'); return; }
        const now = Date.now();
        if (now - lastTick >= STALL_WINDOW) {
          if (received - lastTickBytes < STALL_MIN_BYTES) { fail('скорость ниже минимума — обрыв'); return; }
          lastTick = now; lastTickBytes = received;
        }
      }, 2000);

      res.on('data', (chunk) => {
        received += chunk.length;
        if (cap && received > cap) { fail('превышен ожидаемый размер (' + received + ' > ' + cap + ')'); return; }
        if (total > 0) {
          const pct = Math.min(100, Math.floor((received / total) * 100));
          if (pct !== lastPct) { lastPct = pct; try { onProgress && onProgress({ received, total, pct }); } catch (e) {} }
        } else {
          try { onProgress && onProgress({ received, total: 0, pct: null }); } catch (e) {}
        }
      });
      res.on('error', (e) => fail(String(e.message || e)));
      out.on('error', (e) => fail(String(e.message || e)));
      out.on('finish', () => {
        if (settled) return; settled = true;
        clearInterval(watch);
        resolve({ ok: true, bytes: received });
      });
      res.pipe(out);
    });
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
      const zp = zipPath.replace(/'/g, "''");
      const dp = destDir.replace(/'/g, "''");
      const ps =
        'Add-Type -AssemblyName System.IO.Compression.FileSystem; ' +
        "[System.IO.Compression.ZipFile]::ExtractToDirectory('" + zp + "','" + dp + "')";
      const r = spawnSync(winPowershell(),
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps],
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

// Свежая распаковка: сносим ЛЮБЫЕ прежние unpacked-* каталоги (P0-3 — не доверяем
// содержимому старой распаковки) и распаковываем архив заново в unpackDir.
function freshUnpack(zipPath, unpackDir, cacheDir) {
  try {
    for (const name of fs.readdirSync(cacheDir)) {
      if (name.indexOf('unpacked') === 0) {
        try { fs.rmSync(path.join(cacheDir, name), { recursive: true, force: true }); } catch (e) { /* ignore */ }
      }
    }
  } catch (e) { /* ignore */ }
  return unpackZip(zipPath, unpackDir);
}

// ---- основной вход --------------------------------------------------

// fetchRemote({ entry, cacheDir, onProgress, onLog, timeoutMs })
//   entry     — запись реестра (remoteId, sizeBytes, sha256, mirrors[], …)
//   cacheDir  — куда класть <remoteId>.zip и unpacked-<sha>/ (main.js вычисляет по ОС)
//   onProgress({received,total,pct}) — прогресс докачки (для step-list)
//   onLog(str)                       — человекочитаемый лог (в общий лог)
// → { ok:true, path:<unpacked>, bytes, sha256, mirror, cached? } | { ok:false, error }
async function fetchRemote(opts) {
  opts = opts || {};
  const entry = opts.entry;
  const cacheDir = opts.cacheDir;
  const onProgress = opts.onProgress;
  const timeoutMs = opts.timeoutMs || CONNECT_TIMEOUT;
  const log = (m) => { try { opts.onLog && opts.onLog(m); } catch (e) { /* ignore */ } };

  if (!entry || !entry.remoteId) return { ok: false, error: 'нет записи реестра для компонента' };
  if (!cacheDir) return { ok: false, error: 'не задан cacheDir' };

  // P0-1 (fail-closed): sha256 ОБЯЗАТЕЛЕН и валиден. Нет валидного sha в реестре →
  // компонент НЕ ставится (никакого fail-open «пропустить проверку»).
  const expectedSha = String(entry.sha256 || '').toLowerCase();
  if (!SHA_RE.test(expectedSha)) {
    return { ok: false, error: 'нет валидного SHA-256 в реестре для «' + entry.remoteId + '» — установка remote-компонента заблокирована (fail-closed)' };
  }
  const expectedSize = Number(entry.sizeBytes || 0);

  // Готовим и защищаем кэш-каталог (ACL/владелец/симлинки).
  try { fs.mkdirSync(cacheDir, { recursive: true }); }
  catch (e) { return { ok: false, error: 'не удалось создать кэш ' + cacheDir + ': ' + e.message }; }
  hardenDirAcl(cacheDir, log);
  const dirCheck = ensureSafeDir(cacheDir);
  if (!dirCheck.ok) return { ok: false, error: dirCheck.error };

  const archivePath = path.join(cacheDir, entry.remoteId + '.zip');
  const unpackDir = path.join(cacheDir, 'unpacked-' + expectedSha);

  // Идемпотентность: валидный архив уже в кэше (sha ок) → сеть не трогаем, но
  // РАСПАКОВЫВАЕМ ЗАНОВО в свежий каталог (P0-3). Файл проверяем на симлинк.
  if (safeIsFile(archivePath)) {
    const got = await sha256File(archivePath);
    if (got === expectedSha) {
      const u = freshUnpack(archivePath, unpackDir, cacheDir);
      if (!u.ok) return { ok: false, error: 'кэш валиден, но распаковка не удалась: ' + u.error };
      log('Уже в кэше (SHA-256 совпал) — пропускаю скачивание: ' + entry.remoteId);
      return { ok: true, path: unpackDir, cached: true, sha256: expectedSha, bytes: expectedSize };
    }
    // sha не совпал → мусор/подмена: удаляем и качаем заново.
    try { fs.unlinkSync(archivePath); } catch (e) { /* ignore */ }
  } else if (safeLstat(archivePath)) {
    // Путь существует, но это НЕ обычный файл (симлинк/каталог) — сносим.
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
    const deadlineAt = Date.now() + DOWNLOAD_DEADLINE;
    // До 2 попыток на зеркало: обычная + одна «с нуля» (P2 — битый resume/подмена).
    for (let attempt = 0; attempt < 2; attempt++) {
      log((attempt ? 'Повтор с нуля ' : 'Качаю ') + entry.remoteId + ' из ' + hostOf(url) + ' …');

      // Приватный temp-файл (O_EXCL) — атакующий не подсунет файл на известный путь.
      let tmp;
      try { tmp = openExclTemp(cacheDir); }
      catch (e) { lastErr = 'temp: ' + String(e.message || e); log('  ! ' + lastErr); break; }

      let dr;
      try {
        dr = await downloadWithResume(url, tmp.name, expectedSize, onProgress, timeoutMs, deadlineAt);
        if (dr.retryFresh) {
          try { fs.truncateSync(tmp.name, 0); } catch (e) { /* ignore */ }
          dr = await downloadWithResume(url, tmp.name, expectedSize, onProgress, timeoutMs, deadlineAt);
        }
      } finally { try { fs.closeSync(tmp.fd); } catch (e) { /* ignore */ } }

      if (!dr.ok) {
        lastErr = dr.error || 'скачивание не удалось';
        try { fs.unlinkSync(tmp.name); } catch (e) { /* ignore */ }
        log('  ! ' + lastErr);
        break; // сетевой сбой этого зеркала — переходим к следующему
      }

      const got = await sha256File(tmp.name);
      if (got !== expectedSha) {
        lastErr = 'SHA-256 не совпал (ожид ' + expectedSha.slice(0, 12) + '…, получено ' + (got || '?').slice(0, 12) + '…)';
        try { fs.unlinkSync(tmp.name); } catch (e) { /* ignore */ }
        log('  ! ' + lastErr + (attempt === 0 ? ' — удаляю, повторяю это зеркало с нуля' : ' — удаляю, пробую следующее зеркало'));
        continue; // P2: одна свежая попытка того же зеркала
      }

      // sha ок → атомарно фиксируем стабильный <remoteId>.zip и распаковываем заново.
      try {
        try { fs.rmSync(archivePath, { recursive: true, force: true }); } catch (e) { /* ignore */ }
        fs.renameSync(tmp.name, archivePath);
      } catch (e) {
        try { fs.unlinkSync(tmp.name); } catch (x) { /* ignore */ }
        lastErr = 'не удалось зафиксировать архив: ' + String(e.message || e);
        log('  ! ' + lastErr);
        break;
      }
      const u = freshUnpack(archivePath, unpackDir, cacheDir);
      if (!u.ok) { lastErr = 'распаковка: ' + u.error; log('  ! ' + lastErr); break; }

      log('Готово: ' + entry.remoteId + ' — ' + fmtMB(dr.bytes) + ', целостность подтверждена (SHA-256).');
      return { ok: true, path: unpackDir, bytes: dr.bytes, sha256: got, mirror: url };
    }
  }

  return { ok: false, error: 'все зеркала не сработали: ' + lastErr };
}

module.exports = {
  fetchRemote,
  pickEntry,
  isFetchableUrl,
  sha256File,
  unpackZip,
  probeMirror,
  downloadWithResume,
  ipInPrivateRange,
  // тест-хук: подмена транспорта openStream для детерминированных resume-тестов.
  __setOpenStreamImpl: (fn) => { openStreamImpl = fn || null; }
};
