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

// P2: восстановление после краха rollback-а — если installed.json пропал, а рядом
// остался *.bak (см. writeManifest fallback), возвращаем самый свежий .bak на место.
function recoverBak(homedir) {
  try {
    const dst = manifestPath(homedir);
    if (fs.existsSync(dst)) return;
    const dir = setupDir(homedir);
    const cands = fs.readdirSync(dir)
      .filter((n) => n.indexOf(FILE_NAME + '.') === 0 && n.endsWith('.bak'));
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

// Читает манифест. ВСЕГДА возвращает корректный объект (не бросает). Отсутствие/битый
// файл → пустой манифест: отсутствие манифеста никогда ничего не блокирует (fail-safe).
function readManifest(homedir) {
  recoverBak(homedir);
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
//
// P2-9 (Windows): rename поверх существующего может дать EPERM. НИКОГДА не делаем
// unlink-перед-rename (окно, где старый уже удалён, а новый не встал → манифест
// ПОТЕРЯН при сбое второго rename). Вместо этого: old→backup, temp→dest; при сбое —
// откат backup→dest и удаление temp. Плюс fsync temp-файла где можно.
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
    const bak = dst + '.' + process.pid + '.' + Date.now() + '.bak';
    let movedOld = false;
    try {
      // старый → backup (ENOENT допустим: файла ещё не было)
      try { fs.renameSync(dst, bak); movedOld = true; }
      catch (e2) { if (!e2 || e2.code !== 'ENOENT') throw e2; }
      // temp → dest; старый цел в backup до подтверждения успеха
      fs.renameSync(tmp, dst);
      if (movedOld) { try { fs.rmSync(bak, { force: true }); } catch (e3) { /* ignore */ } }
    } catch (e4) {
      // ОТКАТ: вернуть старый манифест на место, убрать temp — данные не теряем.
      // Если и rollback упал — .bak остаётся, recoverBak вернёт его при следующем чтении.
      if (movedOld) { try { fs.renameSync(bak, dst); } catch (e5) { /* .bak сохраняется для recoverBak */ } }
      try { fs.rmSync(tmp, { force: true }); } catch (e6) { /* ignore */ }
      throw e4;
    }
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

// P2-10: разбор версии — ТОЛЬКО строгий числовой формат x[.y[.z…]] (v-префикс
// допустим). Любые суффиксы (-rc, +build, буквы) → null = «не знаем»: не заявляем
// newer и НЕ показываем ложный апдейт-бейдж. "v1.2.3" → [1,2,3]; "1.2.3-rc1" → null.
function parseVersion(v) {
  const s = String(v == null ? '' : v).trim().replace(/^v/i, '');
  if (!s) return null;
  if (!/^\d+(\.\d+)*$/.test(s)) return null; // не строго-числовой → «не знаем»
  return s.split('.').map((p) => parseInt(p, 10));
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
