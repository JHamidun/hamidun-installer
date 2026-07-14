'use strict';

// Receipts = installed-МАРКЕР {id, version, installedAt} — ЧИСТЫЙ модуль (без
// electron), тестируемый. Живёт в ~/.hamidun-setup/receipts/<id>.json.
//
// МОДЕЛЬ ДОВЕРИЯ (Фаза 2, переделка): квитанция БОЛЬШЕ НЕ содержит и НЕ является
// источником путей удаления. Она отвечает ровно на один вопрос: «ставил ли ЭТОТ
// установщик компонент id» (гейт кнопки «Удалить» в UI + гейт деинсталляции).
// ЦЕЛИ удаления вычисляет ТОЛЬКО доверенный код по зашитому аллоулисту
// (src/uninstall-targets.js) — user-writable квитанция не может увести удаление
// в чужой путь. Легаси-квитанции (schemaVersion 1, с artifacts) остаются валидным
// МАРКЕРОМ; их artifacts игнорируются целиком.
//
// Жизненный цикл при деинсталляции (main.js):
//   deactivateReceipt  — атомарно переименовать маркер в tombstone ДО удаления
//                        (не смогли → деинсталляция прерывается);
//   restoreReceipt     — вернуть маркер при провале удаления;
//   finalizeRemoval    — убрать tombstone после подтверждённого успеха
//                        (результат проверяется, не «молча ок»).

const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 2;
const DIR_NAME = '.hamidun-setup';
const SUB_DIR = 'receipts';
const TOMBSTONE_SUFFIX = '.uninst';

// Легаси-типы строк 'HM-RECEIPT <type> <value>' в stdout install-скриптов.
// Используются ТОЛЬКО чтобы отфильтровать эти строки из UI-лога — как источник
// целей удаления они игнорируются.
const ALLOWED_TYPES = ['path', 'reg', 'pathentry', 'profileline', 'launchagent', 'bundleid', 'teamid'];

function receiptsDir(homedir) {
  return path.join(homedir, DIR_NAME, SUB_DIR);
}
function receiptPath(homedir, id) {
  return path.join(receiptsDir(homedir), String(id) + '.json');
}
function tombstonePath(homedir, id) {
  return receiptPath(homedir, id) + TOMBSTONE_SUFFIX;
}

// Разбор строки 'HM-RECEIPT <type> <value>' (только для фильтрации из UI-лога).
function parseReceiptLine(line) {
  const m = /^HM-RECEIPT\s+([a-z]+)\s+(.+)$/.exec(String(line == null ? '' : line).trim());
  if (!m) return null;
  const type = m[1];
  const value = m[2].trim();
  if (ALLOWED_TYPES.indexOf(type) === -1 || !value) return null;
  return { type, value };
}

// Маркер владения: НИКАКИХ artifacts-путей.
function buildReceipt(id, platform, version) {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: String(id),
    platform: String(platform || process.platform),
    version: version != null ? String(version) : '',
    installedAt: new Date().toISOString()
  };
}

// P2: восстановление после краха rollback-а — если основной файл пропал, а рядом
// остался *.bak (см. writeReceipt fallback), возвращаем самый свежий .bak на место.
function recoverBak(dir, dstBaseName) {
  try {
    const dst = path.join(dir, dstBaseName);
    if (fs.existsSync(dst)) return;
    // P1-1: идёт (или упала посреди) деинсталляция — маркер деактивирован в
    // tombstone. «Удалённый» компонент НЕ воскрешаем из осиротевшего .bak.
    if (fs.existsSync(dst + TOMBSTONE_SUFFIX)) return;
    const cands = fs.readdirSync(dir)
      .filter((n) => n.indexOf(dstBaseName + '.') === 0 && n.endsWith('.bak'));
    if (!cands.length) return;
    let best = '', bestM = -1;
    for (const n of cands) {
      try {
        const m = fs.statSync(path.join(dir, n)).mtimeMs;
        if (m > bestM) { bestM = m; best = n; }
      } catch (e) { /* ignore */ }
    }
    if (best) fs.renameSync(path.join(dir, best), dst);
  } catch (e) { /* best-effort */ }
}

// Атомарная запись: temp в ТОМ ЖЕ каталоге + rename (без unlink-first; old→backup,
// temp→dest, откат при сбое — P2-9 паттерн). dryRun → не пишем.
function writeReceipt(homedir, id, receipt, opts) {
  opts = opts || {};
  const dst = receiptPath(homedir, id);
  if (opts.dryRun) return { ok: true, path: dst, dryRun: true };
  const dir = receiptsDir(homedir);
  fs.mkdirSync(dir, { recursive: true });
  const json = JSON.stringify(receipt, null, 2);
  const tmp = path.join(dir, id + '.json.' + process.pid + '.' + Date.now() + '.tmp');
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, json, 'utf8');
    try { fs.fsyncSync(fd); } catch (e) { /* fsync недоступен — не фатально */ }
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, dst);
  } catch (e) {
    // Windows: rename поверх существующего может дать EPERM. НЕ unlink-first:
    // old→backup, temp→dest; при сбое возвращаем старый на место. Если и rollback
    // упал — .bak остаётся и восстановится при следующем чтении (recoverBak).
    const bak = dst + '.' + process.pid + '.' + Date.now() + '.bak';
    let movedOld = false;
    try {
      try { fs.renameSync(dst, bak); movedOld = true; }
      catch (e2) { if (!e2 || e2.code !== 'ENOENT') throw e2; }
      fs.renameSync(tmp, dst);
      if (movedOld) { try { fs.rmSync(bak, { force: true }); } catch (e3) { /* ignore */ } }
    } catch (e4) {
      if (movedOld) {
        try { fs.renameSync(bak, dst); }
        catch (e5) { /* rollback упал → .bak остаётся, recoverBak вернёт при чтении */ }
      }
      try { fs.rmSync(tmp, { force: true }); } catch (e6) { /* ignore */ }
      throw e4;
    }
  }
  return { ok: true, path: dst };
}

// Чтение маркера. Отсутствует/битый/чужой id → null (null = «мы это не ставили»).
// Легаси-схема (v1 c artifacts) — валидный маркер; artifacts НЕ экспонируются.
function readReceipt(homedir, id) {
  try {
    recoverBak(receiptsDir(homedir), String(id) + '.json');
  } catch (e) { /* ignore */ }
  try {
    const raw = fs.readFileSync(receiptPath(homedir, id), 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return null;
    if (data.id !== String(id)) return null;
    return {
      schemaVersion: data.schemaVersion,
      id: data.id,
      platform: data.platform || '',
      version: data.version || '',
      installedAt: data.installedAt || ''
    };
  } catch (e) {
    return null;
  }
}

function hasReceipt(homedir, id) {
  return readReceipt(homedir, id) !== null;
}

// Деактивация ДО удаления: маркер → tombstone (атомарный rename). Не смогли →
// { ok:false } и деинсталляция ОБЯЗАНА прерваться.
function deactivateReceipt(homedir, id) {
  const src = receiptPath(homedir, id);
  const dst = tombstonePath(homedir, id);
  try {
    try { fs.rmSync(dst, { force: true }); } catch (e) { /* хвост прошлого краша */ }
    fs.renameSync(src, dst);
    return { ok: true, tombstone: dst };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// Вернуть маркер при провале удаления. Возврат честный: {ok:bool}.
function restoreReceipt(homedir, id) {
  const src = tombstonePath(homedir, id);
  const dst = receiptPath(homedir, id);
  try {
    fs.renameSync(src, dst);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// P1-1: хвосты атомарной записи маркера (<id>.json.*.bak / <id>.json.*.tmp).
// Осиротевший .bak после finalize воскресил бы «удалённый» компонент через
// recoverBak — finalize обязан подчистить и его.
function listReceiptDebris(dir, baseName) {
  try {
    return fs.readdirSync(dir)
      .filter((n) => n.indexOf(baseName + '.') === 0 && (n.endsWith('.bak') || n.endsWith('.tmp')));
  } catch (e) { return []; }
}

// Убрать tombstone (И .bak/.tmp-хвосты — P1-1) после подтверждённого успеха.
// Результат ПРОВЕРЯЕТСЯ.
function finalizeRemoval(homedir, id) {
  const t = tombstonePath(homedir, id);
  const dir = receiptsDir(homedir);
  const base = String(id) + '.json';
  try {
    fs.rmSync(t, { force: true });
    for (const n of listReceiptDebris(dir, base)) {
      try { fs.rmSync(path.join(dir, n), { force: true }); } catch (e) { /* проверим ниже */ }
    }
    if (fs.existsSync(t)) return { ok: false, error: 'tombstone остался: ' + t };
    const left = listReceiptDebris(dir, base);
    if (left.length) return { ok: false, error: '.bak/.tmp-хвосты остались: ' + left.join(', ') };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// Прямое удаление маркера (легаси-API). Результат честный: проверяем, что файла нет.
function removeReceipt(homedir, id) {
  const p = receiptPath(homedir, id);
  try {
    fs.rmSync(p, { force: true });
    if (fs.existsSync(p)) return { ok: false, error: 'файл остался: ' + p };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

module.exports = {
  SCHEMA_VERSION, DIR_NAME, SUB_DIR, ALLOWED_TYPES, TOMBSTONE_SUFFIX,
  receiptsDir, receiptPath, tombstonePath, parseReceiptLine, buildReceipt,
  writeReceipt, readReceipt, hasReceipt,
  deactivateReceipt, restoreReceipt, finalizeRemoval, removeReceipt
};
