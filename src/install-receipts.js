'use strict';

// P0-4: ownership receipts — доказательство «это ставил НАШ установщик» — ЧИСТЫЙ
// модуль (без electron), тестируемый. Живёт в ~/.hamidun-setup/receipts/<id>.json.
//
// МОДЕЛЬ ДОВЕРИЯ: деинсталлятор удаляет ТОЛЬКО точные абсолютные пути из квитанции,
// записанной В МОМЕНТ УСТАНОВКИ самими install-скриптами (строки "HM-RECEIPT …" в
// их stdout собирает main). НИКАКИХ масок/glob. Нет квитанции → удаление ОТКЛОНЯЕТСЯ
// (мы это не ставили / квитанция утеряна — в сомнении не удаляем). Информационный
// манифест installed.json НЕ является доказательством владения — только receipts.

const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 1;
const DIR_NAME = '.hamidun-setup';
const SUB_DIR = 'receipts';

// Типы артефактов в квитанции:
//   path        — абсолютный путь ФС, созданный установщиком (удаляем на uninstall)
//   reg         — Windows-реестр 'HIVE|Key\Path|ValueName' (только HKCU)
//   pathentry   — каталог, добавленный нами в пользовательский PATH (Windows)
//   profileline — '<rc-файл>|<маркер>' строка shell-профиля с нашим маркером (mac)
//   launchagent — '<label>|<plist-путь>' LaunchAgent (mac)
//   bundleid    — CFBundleIdentifier установленного .app (mac, идентичность)
//   teamid      — Apple Team ID подписи .app (mac, идентичность)
const ALLOWED_TYPES = ['path', 'reg', 'pathentry', 'profileline', 'launchagent', 'bundleid', 'teamid'];

function receiptsDir(homedir) {
  return path.join(homedir, DIR_NAME, SUB_DIR);
}
function receiptPath(homedir, id) {
  return path.join(receiptsDir(homedir), String(id) + '.json');
}

// Разбор строки 'HM-RECEIPT <type> <value>' из stdout install-скрипта.
// Не строка квитанции / неизвестный тип / пустое значение → null.
function parseReceiptLine(line) {
  const m = /^HM-RECEIPT\s+([a-z]+)\s+(.+)$/.exec(String(line == null ? '' : line).trim());
  if (!m) return null;
  const type = m[1];
  const value = m[2].trim();
  if (ALLOWED_TYPES.indexOf(type) === -1 || !value) return null;
  return { type, value };
}

// Валидация одного артефакта. Пути обязаны быть АБСОЛЮТНЫМИ — относительный путь
// в квитанции никогда не должен привести к удалению (fail-closed: отбрасываем).
function validArtifact(a) {
  if (!a || typeof a !== 'object') return false;
  if (ALLOWED_TYPES.indexOf(a.type) === -1) return false;
  if (typeof a.value !== 'string' || !a.value.trim()) return false;
  if (a.type === 'path' && !path.isAbsolute(a.value)) return false;
  if (a.type === 'pathentry' && !path.isAbsolute(a.value)) return false;
  if (a.type === 'launchagent' || a.type === 'profileline') {
    const parts = a.value.split('|');
    if (parts.length < 2 || !parts[0].trim() || !parts[1].trim()) return false;
    // вторая часть launchagent (plist) и первая часть profileline (rc) — абсолютные пути
    if (a.type === 'launchagent' && !path.isAbsolute(parts[1].trim())) return false;
    if (a.type === 'profileline' && !path.isAbsolute(parts[0].trim())) return false;
  }
  if (a.type === 'reg') {
    const parts = a.value.split('|');
    // ТОЛЬКО HKCU: установщик пишет только туда; всё прочее — отклоняем.
    if (parts.length !== 3 || parts[0].toUpperCase() !== 'HKCU' || !parts[1] || !parts[2]) return false;
  }
  return true;
}

function buildReceipt(id, platform, artifacts) {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: String(id),
    platform: String(platform || process.platform),
    installedAt: new Date().toISOString(),
    artifacts: (artifacts || []).filter(validArtifact)
  };
}

// Атомарная запись: temp в ТОМ ЖЕ каталоге + rename (без unlink-first; паттерн P2-9
// как в install-manifest: old→backup, temp→dest, откат при сбое). dryRun → не пишем.
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
    // old→backup, temp→dest; при сбое возвращаем старый на место (P2-9 паттерн).
    const bak = dst + '.' + process.pid + '.' + Date.now() + '.bak';
    let movedOld = false;
    try {
      try { fs.renameSync(dst, bak); movedOld = true; }
      catch (e2) { if (!e2 || e2.code !== 'ENOENT') throw e2; }
      fs.renameSync(tmp, dst);
      if (movedOld) { try { fs.rmSync(bak, { force: true }); } catch (e3) { /* ignore */ } }
    } catch (e4) {
      if (movedOld) { try { fs.renameSync(bak, dst); } catch (e5) { /* ignore */ } }
      try { fs.rmSync(tmp, { force: true }); } catch (e6) { /* ignore */ }
      throw e4;
    }
  }
  return { ok: true, path: dst };
}

// Чтение квитанции. Отсутствует/битая/чужой id/невалидная схема → null.
// null трактуется вызывающим как ОТКАЗ в деинсталляции (fail-closed).
function readReceipt(homedir, id) {
  try {
    const raw = fs.readFileSync(receiptPath(homedir, id), 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return null;
    if (data.id !== String(id)) return null;
    if (!Array.isArray(data.artifacts)) return null;
    data.artifacts = data.artifacts.filter(validArtifact);
    return data;
  } catch (e) {
    return null;
  }
}

function hasReceipt(homedir, id) {
  return readReceipt(homedir, id) !== null;
}

function removeReceipt(homedir, id) {
  try { fs.rmSync(receiptPath(homedir, id), { force: true }); return { ok: true }; }
  catch (e) { return { ok: false, error: String(e) }; }
}

// env-переменные для uninstall-скрипта: main передаёт ТОЧНЫЙ инвентарь из квитанции
// (newline-joined). Скрипт удаляет ТОЛЬКО это — сам ничего не вычисляет и не глобит.
function envFromReceipt(receipt) {
  const by = (t) => (receipt && receipt.artifacts || [])
    .filter((a) => a.type === t).map((a) => a.value);
  const out = {
    HM_UNINSTALL_PATHS: by('path').join('\n'),
    HM_UNINSTALL_REG: by('reg').join('\n'),
    HM_UNINSTALL_PATHENTRIES: by('pathentry').join('\n'),
    HM_UNINSTALL_PROFILELINES: by('profileline').join('\n'),
    HM_UNINSTALL_LAUNCHAGENTS: by('launchagent').join('\n')
  };
  const bid = by('bundleid'); if (bid.length) out.HM_UNINSTALL_BUNDLEID = bid[0];
  const tid = by('teamid'); if (tid.length) out.HM_UNINSTALL_TEAMID = tid[0];
  return out;
}

module.exports = {
  SCHEMA_VERSION, DIR_NAME, SUB_DIR, ALLOWED_TYPES,
  receiptsDir, receiptPath, parseReceiptLine, validArtifact, buildReceipt,
  writeReceipt, readReceipt, hasReceipt, removeReceipt, envFromReceipt
};
