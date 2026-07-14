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
 * (см. test/remote-fetch-live.js). main.js оборачивает его в IPC-хендлер
 * `fetch-remote`, прокидывая колбэки прогресса/лога в renderer.
 *
 * Гарантии:
 *   • выбор БЫСТРЕЙШЕГО живого зеркала (параллельный Range-пробинг, min latency);
 *   • ДОКАЧКА при обрыве (HTTP Range resume от размера частичного файла);
 *   • потоковая проверка SHA-256 → не совпал → удаляем, пробуем след. зеркало;
 *   • все зеркала пали → {ok:false, error};
 *   • ИДЕМПОТЕНТНОСТЬ: валидный архив уже в кэше (sha256 ок) → сеть не трогаем;
 *   • распаковка zip средствами ОС (Windows: .NET ZipFile; mac/linux: unzip/ditto)
 *     — без тяжёлых npm-зависимостей, только stdlib + системный распаковщик.
 *
 * Только Node stdlib: https, http, crypto, fs, path, os, child_process, url.
 */
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { URL } = require('url');

const DEFAULT_TIMEOUT = 20000; // ms на установление соединения/ответ заголовков
const USER_AGENT = 'hamidun-setup';

// ---- утилиты --------------------------------------------------------

// Пригодный к скачиванию URL: http(s), без плейсхолдеров ('<r2>', PLACEHOLDER…).
// R2-зеркало пока заглушка — оно должно молча отсекаться, а не падать сеть.
function isFetchableUrl(u) {
  if (typeof u !== 'string' || !u) return false;
  if (/[<>\s]/.test(u)) return false;
  if (/PLACEHOLDER/i.test(u)) return false;
  return /^https?:\/\/[^/]+\/.+/.test(u);
}

function hostOf(u) { try { return new URL(u).host; } catch (e) { return u; } }
function fmtMB(n) { return (Number(n || 0) / (1024 * 1024)).toFixed(1) + ' МБ'; }
function isNonEmptyDir(d) {
  try { return fs.statSync(d).isDirectory() && fs.readdirSync(d).length > 0; }
  catch (e) { return false; }
}

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

// GET с ручным следованием редиректам (GitHub/S3 могут редиректить на CDN).
// Заголовки (в т.ч. Range) сохраняются между хопами. cb(err, res).
function openStream(url, opts, cb) {
  let redirects = 0;
  const maxRedirects = opts.maxRedirects || 6;
  const go = (u) => {
    let parsed;
    try { parsed = new URL(u); } catch (e) { cb(e); return; }
    const mod = parsed.protocol === 'http:' ? http : https;
    let req;
    try {
      req = mod.request(parsed, { method: 'GET', headers: opts.headers || {} }, (res) => {
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
    req.setTimeout(opts.timeoutMs || DEFAULT_TIMEOUT, () => {
      req.destroy(new Error('таймаут соединения (' + hostOf(u) + ')'));
    });
    req.on('error', (e) => cb(e));
    req.end();
  };
  go(url);
}

// Пробинг зеркала: Range bytes=0-0, живо = 200/206. Возвращает латентность.
function probeMirror(url, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    openStream(url, {
      headers: { 'User-Agent': USER_AGENT, Range: 'bytes=0-0' },
      timeoutMs, maxRedirects: 6
    }, (err, res) => {
      if (err) { finish({ url, ok: false }); return; }
      const sc = res.statusCode;
      res.destroy(); // заголовков достаточно — тело не нужно
      finish({ url, ok: sc === 200 || sc === 206, code: sc, ms: Date.now() - t0 });
    });
  });
}

// Скачивание в archivePath с докачкой (resume). Возвращает {ok, bytes} либо
// {ok:false, error} / {ok:false, retryFresh:true} (для 416 — качать заново).
function downloadWithResume(url, archivePath, expectedSize, onProgress, log, timeoutMs) {
  return new Promise((resolve) => {
    let start = 0;
    try { if (fs.existsSync(archivePath)) start = fs.statSync(archivePath).size; } catch (e) { start = 0; }
    // Частичный файл больше ожидаемого => мусор/битый: качаем с нуля.
    if (expectedSize && start > expectedSize) {
      try { fs.unlinkSync(archivePath); } catch (e) { /* ignore */ }
      start = 0;
    }
    // Уже полный по размеру — пусть проверку sha сделает вызывающий.
    if (expectedSize && start === expectedSize) { resolve({ ok: true, bytes: start }); return; }

    const headers = { 'User-Agent': USER_AGENT };
    if (start > 0) { headers.Range = 'bytes=' + start + '-'; }

    openStream(url, { headers, timeoutMs, maxRedirects: 6 }, (err, res) => {
      if (err) { resolve({ ok: false, error: String(err.message || err) }); return; }
      const code = res.statusCode;
      let flags = 'a';
      let base = start;

      if (code === 416) {
        // Range не удовлетворить — вероятно, файл уже целиком либо битый хвост.
        res.destroy();
        try { fs.unlinkSync(archivePath); } catch (e) { /* ignore */ }
        resolve({ ok: false, retryFresh: true, error: 'HTTP 416' });
        return;
      }
      if (start > 0 && code === 200) {
        // Сервер проигнорировал Range — начинаем файл заново.
        flags = 'w'; base = 0;
        try { fs.truncateSync(archivePath, 0); } catch (e) { /* ignore */ }
      } else if (start > 0 && code === 206) {
        flags = 'a'; // корректная докачка
      } else if (start === 0 && code === 200) {
        flags = 'w'; base = 0;
      } else if (code >= 400) {
        res.destroy();
        resolve({ ok: false, error: 'HTTP ' + code });
        return;
      }

      const clen = parseInt(res.headers['content-length'] || '0', 10) || 0;
      const total = expectedSize || (base + clen) || 0;
      let received = base;
      let lastPct = -1;

      let out;
      try { out = fs.createWriteStream(archivePath, { flags }); }
      catch (e) { res.destroy(); resolve({ ok: false, error: String(e) }); return; }

      res.on('data', (chunk) => {
        received += chunk.length;
        if (total > 0) {
          const pct = Math.min(100, Math.floor((received / total) * 100));
          if (pct !== lastPct) { lastPct = pct; try { onProgress && onProgress({ received, total, pct }); } catch (e) {} }
        } else {
          try { onProgress && onProgress({ received, total: 0, pct: null }); } catch (e) {}
        }
      });
      res.on('error', (e) => { try { out.destroy(); } catch (x) {} resolve({ ok: false, error: String(e.message || e) }); });
      out.on('error', (e) => { try { res.destroy(); } catch (x) {} resolve({ ok: false, error: String(e.message || e) }); });
      out.on('finish', () => resolve({ ok: true, bytes: received }));
      res.pipe(out);
    });
  });
}

// Распаковка zip средствами ОС (без npm-зависимостей). Чистит целевую папку.
function unpackZip(zipPath, destDir) {
  try {
    try { fs.rmSync(destDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    fs.mkdirSync(destDir, { recursive: true });
    if (process.platform === 'win32') {
      const zp = zipPath.replace(/'/g, "''");
      const dp = destDir.replace(/'/g, "''");
      const ps =
        'Add-Type -AssemblyName System.IO.Compression.FileSystem; ' +
        "[System.IO.Compression.ZipFile]::ExtractToDirectory('" + zp + "','" + dp + "')";
      const r = spawnSync('powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps],
        { windowsHide: true, encoding: 'utf8' });
      if (r.status !== 0) {
        return { ok: false, error: String((r.stderr || r.stdout || ('powershell exit ' + r.status)) || '').trim() };
      }
    } else {
      let r = spawnSync('unzip', ['-o', '-q', zipPath, '-d', destDir], { encoding: 'utf8' });
      if (r.error || r.status !== 0) {
        // Фолбэк для macOS без unzip в PATH.
        r = spawnSync('ditto', ['-x', '-k', zipPath, destDir], { encoding: 'utf8' });
        if (r.error || r.status !== 0) {
          return { ok: false, error: String((r.stderr || (r.error && r.error.message) || 'распаковка не удалась')).trim() };
        }
      }
    }
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e) }; }
}

// ---- основной вход --------------------------------------------------

// fetchRemote({ entry, cacheDir, onProgress, onLog, timeoutMs })
//   entry     — запись реестра (remoteId, sizeBytes, sha256, mirrors[], …)
//   cacheDir  — куда класть <remoteId>.zip и unpacked/ (main.js вычисляет по ОС)
//   onProgress({received,total,pct}) — прогресс докачки (для step-list)
//   onLog(str)                       — человекочитаемый лог (в общий лог)
// → { ok:true, path:<unpacked>, bytes, sha256, mirror, cached? } | { ok:false, error }
async function fetchRemote(opts) {
  opts = opts || {};
  const entry = opts.entry;
  const cacheDir = opts.cacheDir;
  const onProgress = opts.onProgress;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT;
  const log = (m) => { try { opts.onLog && opts.onLog(m); } catch (e) { /* ignore */ } };

  if (!entry || !entry.remoteId) return { ok: false, error: 'нет записи реестра для компонента' };
  if (!cacheDir) return { ok: false, error: 'не задан cacheDir' };

  const expectedSha = String(entry.sha256 || '').toLowerCase();
  const expectedSize = Number(entry.sizeBytes || 0);
  const archivePath = path.join(cacheDir, entry.remoteId + '.zip');
  const unpackDir = path.join(cacheDir, 'unpacked');

  try { fs.mkdirSync(cacheDir, { recursive: true }); }
  catch (e) { return { ok: false, error: 'не создать кэш ' + cacheDir + ': ' + e.message }; }

  // Идемпотентность: валидный архив уже в кэше — сеть не трогаем.
  if (expectedSha && fs.existsSync(archivePath)) {
    const got = await sha256File(archivePath);
    if (got === expectedSha) {
      if (!isNonEmptyDir(unpackDir)) {
        const u = unpackZip(archivePath, unpackDir);
        if (!u.ok) return { ok: false, error: 'кэш валиден, но распаковка не удалась: ' + u.error };
      }
      log('Уже в кэше (SHA-256 совпал) — пропускаю скачивание: ' + entry.remoteId);
      return { ok: true, path: unpackDir, cached: true, sha256: expectedSha, bytes: expectedSize };
    }
  }

  const mirrors = (entry.mirrors || []).map((m) => m && m.url).filter(isFetchableUrl);
  if (!mirrors.length) return { ok: false, error: 'нет доступных зеркал для ' + entry.remoteId + ' (R2 — заглушка)' };

  // Параллельный пробинг → живые по возрастанию латентности, мёртвые в хвост.
  const probes = await Promise.all(mirrors.map((u) => probeMirror(u, timeoutMs)));
  const live = probes.filter((p) => p.ok).sort((a, b) => a.ms - b.ms).map((p) => p.url);
  const dead = mirrors.filter((u) => live.indexOf(u) === -1);
  const order = live.concat(dead);
  log('Зеркал живых: ' + live.length + ' из ' + mirrors.length +
      (live.length ? ' (быстрейшее: ' + hostOf(live[0]) + ')' : ''));

  let lastErr = 'неизвестно';
  for (const url of order) {
    log('Качаю ' + entry.remoteId + ' из ' + hostOf(url) + ' …');
    let dr = await downloadWithResume(url, archivePath, expectedSize, onProgress, log, timeoutMs);
    if (dr.retryFresh) {
      dr = await downloadWithResume(url, archivePath, expectedSize, onProgress, log, timeoutMs);
    }
    if (!dr.ok) { lastErr = dr.error || 'скачивание не удалось'; log('  ! ' + lastErr); continue; }

    const got = await sha256File(archivePath);
    if (expectedSha && got !== expectedSha) {
      lastErr = 'SHA-256 не совпал (ожид ' + expectedSha.slice(0, 12) + '…, получено ' + (got || '?').slice(0, 12) + '…)';
      log('  ! ' + lastErr + ' — удаляю, пробую следующее зеркало');
      try { fs.unlinkSync(archivePath); } catch (e) { /* ignore */ }
      continue;
    }

    const u = unpackZip(archivePath, unpackDir);
    if (!u.ok) { lastErr = 'распаковка: ' + u.error; log('  ! ' + lastErr); continue; }

    log('Готово: ' + entry.remoteId + ' — ' + fmtMB(dr.bytes) + ', целостность подтверждена (SHA-256).');
    return { ok: true, path: unpackDir, bytes: dr.bytes, sha256: got, mirror: url };
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
  downloadWithResume
};
