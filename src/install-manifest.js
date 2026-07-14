'use strict';

// Version manifest for the installer — ЧИСТЫЙ модуль (без electron), тестируемый.
// Отслеживает, что установщик реально положил: компонент → {version, installedAt, source}.
// Живёт в ~/.hamidun-setup/installed.json.
//
// ВАЖНО (модель доверия): ГРУНД-ТРУТ «установлен ли X?» — ВСЕГДА живая проверка
// файловой системы / запуска бинаря (см. main.js → detectComponents). Этот манифест
// СПРАВОЧНЫЙ: он нужен только чтобы показать версию установленного и посчитать
// «доступно обновление». Манифест НИКОГДА не используется для деструктивных решений
// (аддитивная раскладка и деинсталлятор смотрят на реальную ФС и явный выбор id,
// а не на installed.json) — иначе повреждённый/отставший манифест мог бы стереть
// пользовательские данные.

const fs = require('fs');
const path = require('path');
const os = require('os');

const SCHEMA_VERSION = 1;
const DIR_NAME = '.hamidun-setup';
const FILE_NAME = 'installed.json';

function setupDir(homedir) {
  return path.join(homedir || os.homedir(), DIR_NAME);
}
function manifestPath(homedir) {
  return path.join(setupDir(homedir), FILE_NAME);
}

function emptyManifest() {
  return { schemaVersion: SCHEMA_VERSION, components: {} };
}

// Читает манифест. ВСЕГДА возвращает корректный объект (не бросает). Отсутствие/битый
// файл → пустой манифест: отсутствие манифеста никогда ничего не блокирует (fail-safe).
function readManifest(homedir) {
  try {
    const raw = fs.readFileSync(manifestPath(homedir), 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return emptyManifest();
    if (!data.components || typeof data.components !== 'object') data.components = {};
    if (typeof data.schemaVersion !== 'number') data.schemaVersion = SCHEMA_VERSION;
    return data;
  } catch (e) {
    return emptyManifest();
  }
}

// Атомарная запись: temp-файл в ТОМ ЖЕ каталоге + rename (rename атомарен в пределах
// тома). Краш в середине записи никогда не оставит наполовину записанный installed.json.
// dryRun → ничего не пишем (HM_DRY_RUN уважается вызывающим кодом).
function writeManifest(homedir, data, opts) {
  opts = opts || {};
  const obj = (data && typeof data === 'object') ? data : emptyManifest();
  if (!obj.components || typeof obj.components !== 'object') obj.components = {};
  if (typeof obj.schemaVersion !== 'number') obj.schemaVersion = SCHEMA_VERSION;
  const dst = manifestPath(homedir);
  if (opts.dryRun) return { ok: true, path: dst, dryRun: true };
  const dir = setupDir(homedir);
  const json = JSON.stringify(obj, null, 2);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, FILE_NAME + '.' + process.pid + '.' + Date.now() + '.tmp');
  fs.writeFileSync(tmp, json, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.renameSync(tmp, dst);
  } catch (e) {
    // Windows: rename поверх существующего файла может дать EPERM — повторяем через
    // unlink+rename. При провале — убираем temp, чтобы не копить мусор.
    try { fs.rmSync(dst, { force: true }); fs.renameSync(tmp, dst); }
    catch (e2) { try { fs.rmSync(tmp, { force: true }); } catch (e3) { /* ignore */ } throw e2; }
  }
  return { ok: true, path: dst };
}

// Записать (или обновить) запись одного компонента, атомарно.
function recordInstall(homedir, id, version, source, opts) {
  if (!id) return { ok: false, error: 'no id' };
  const data = readManifest(homedir);
  const prev = data.components[id] || {};
  data.components[id] = {
    version: version != null ? String(version) : (prev.version || ''),
    installedAt: new Date().toISOString(),
    source: source != null ? String(source) : (prev.source || '')
  };
  return writeManifest(homedir, data, opts);
}

// Удалить запись одного компонента (для деинсталлятора), атомарно. Нет записи → no-op ok.
function removeEntry(homedir, id, opts) {
  if (!id) return { ok: false, error: 'no id' };
  const data = readManifest(homedir);
  if (!(id in data.components)) return { ok: true, changed: false, path: manifestPath(homedir) };
  delete data.components[id];
  const r = writeManifest(homedir, data, opts);
  return Object.assign({ changed: true }, r);
}

function getEntry(homedir, id) {
  const data = readManifest(homedir);
  return data.components[id] || null;
}

// Разбор версии в числовые сегменты; нечисловой хвост игнорируется. "v1.2.3" → [1,2,3].
function parseVersion(v) {
  const s = String(v == null ? '' : v).trim().replace(/^v/i, '');
  if (!s) return null;
  if (!/^\d/.test(s)) return null; // мусор без ведущей цифры → «не знаем» (никаких ложных апдейтов)
  const parts = s.split(/[.\-+]/).map((p) => {
    const m = String(p).match(/^\d+/);
    return m ? parseInt(m[0], 10) : 0;
  });
  return parts.length ? parts : null;
}

// Простое semver-подобное сравнение: -1 если a<b, 0 если равны, 1 если a>b.
// Непарсимое (пустое/мусор) → 0 (считаем «не знаем» → без ложных апдейтов).
function compareVersions(a, b) {
  const pa = parseVersion(a), pb = parseVersion(b);
  if (!pa || !pb) return 0;
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

// installedVersion СТРОГО старше currentVersion? (доступно обновление)
function isOutdated(installedVersion, currentVersion) {
  if (!installedVersion || !currentVersion) return false;
  return compareVersions(installedVersion, currentVersion) < 0;
}

module.exports = {
  SCHEMA_VERSION, DIR_NAME, FILE_NAME, manifestPath, readManifest, writeManifest,
  recordInstall, removeEntry, getEntry, parseVersion, compareVersions, isOutdated
};
