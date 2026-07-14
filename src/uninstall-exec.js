'use strict';

// Фаза 2 (переделка): guard + исполнители деинсталляции — ЧИСТЫЙ модуль (без
// electron), тестируемый. ВСЁ файловое удаление выполняется здесь, в JS main-процесса
// (никакого uninstall-скрипта → нет транспорта целей через env и нет framing-класса).
//
// GUARD (checkTarget) применяется КО ВСЕМ целям ДО любого удаления. Fail-closed:
// ЛЮБАЯ ошибка проверки (EACCES/EIO при lstat/realpath, не смогли канонизировать)
// → отказ удалять эту цель. Данные пользователя священны: в сомнении НЕ удаляем.
//
// Проверки:
//   - строковая гигиена: не пусто, без NUL/CR/LF, без сегментов '.'/'..'
//   - абсолютность; на Windows отвергаются UNC/device/volume-алиасы (\\server,
//     \\?\, \\.\ — любые пути, начинающиеся с двойного разделителя)
//   - reparse/symlink в САМОЙ цели или ЛЮБОМ существующем предке → отказ
//   - канонизация реальным путём (fs.realpathSync.native — на Windows это
//     GetFinalPathNameByHandle): resolved-форма обязана совпасть с лексической
//   - protected-набор: весь ~/.claude, ~/CLAUDE.md, ~/.hamidun-setup, сам дом,
//     предки дома, корень; плюс per-run preserve (state курса, config моста) —
//     сверка и лексическая, и по device+inode (POSIX: APFS firmlink
//     /System/Volumes/Data/... указывает на тот же inode — строка не совпадает,
//     inode совпадает → отказ). На Windows inode-сверка не применяется
//     (алиасы закрыты реджектом UNC/device + reparse-chain + realpath).

const fs = require('fs');
const path = require('path');

function isCaseInsensitive(platform) { return platform === 'win32' || platform === 'darwin'; }
function normKey(p, platform) {
  const n = path.resolve(String(p));
  return isCaseInsensitive(platform) ? n.toLowerCase() : n;
}
function pathEq(a, b, platform) { return normKey(a, platform) === normKey(b, platform); }
function isInside(child, parent, platform) {
  const c = normKey(child, platform), p = normKey(parent, platform);
  return c.length > p.length && c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

// Защищённые корни: их самих, всё внутри них и их предков удалять НЕЛЬЗЯ.
function protectedRoots(home) {
  return [
    path.join(home, '.claude'),
    path.join(home, 'CLAUDE.md'),
    path.join(home, '.hamidun-setup')
  ];
}

function no(reason) { return { ok: false, reason }; }

// value-гигиена (для маркеров/имён из аллоулиста — framing-класс закрыт и внутри процесса)
function valueHygieneOk(v) {
  return typeof v === 'string' && v.length > 0 && !/[\x00\r\n]/.test(v);
}

// Главный guard. opts: { home, platform, extraProtected: [] }.
// Возврат: { ok:true, norm, deepestExisting } | { ok:false, reason }.
function checkTarget(input, opts) {
  try {
    if (!opts || !opts.home || !opts.platform) return no('нет контекста guard-а');
    const platform = opts.platform;
    const home = path.resolve(opts.home);
    if (typeof input !== 'string' || !input.trim()) return no('пустая цель');
    if (/[\x00\r\n]/.test(input)) return no('управляющие символы в пути');
    if (platform === 'win32' && /^[\\/]{2}/.test(input)) return no('UNC/device-путь (\\\\…) отклонён');
    if (!path.isAbsolute(input)) return no('не абсолютный путь');
    if (input.split(/[\\/]+/).some((s) => s === '.' || s === '..')) return no('сегменты «.»/«..» отклонены');
    const norm = path.resolve(input);
    if (platform === 'win32' && /^[\\/]{2}/.test(norm)) return no('UNC после нормализации');
    if (norm.length <= (platform === 'win32' ? 3 : 1)) return no('корень ФС');

    // reparse/symlink в цели или ЛЮБОМ существующем предке → отказ.
    // Ошибка lstat кроме ENOENT/ENOTDIR → отказ (fail-closed).
    let deepestExisting = '';
    {
      let cur = norm, prev = '';
      while (cur && cur !== prev) {
        let st = null;
        try {
          st = fs.lstatSync(cur);
        } catch (e) {
          const code = e && e.code;
          if (code !== 'ENOENT' && code !== 'ENOTDIR') return no('lstat(' + cur + '): ' + (code || e));
        }
        if (st) {
          if (st.isSymbolicLink()) return no('symlink/junction в цепочке: ' + cur);
          if (!deepestExisting) deepestExisting = cur;
        }
        prev = cur; cur = path.dirname(cur);
      }
    }

    // Канонизация реальным путём: resolved-форма deepest existing обязана
    // совпасть с лексической (мы уже отвергли ссылки — расхождение подозрительно).
    if (deepestExisting) {
      let real;
      try {
        const rp = fs.realpathSync.native || fs.realpathSync;
        real = rp(deepestExisting);
      } catch (e) {
        return no('канонизация не удалась (' + ((e && e.code) || e) + ') — отказ');
      }
      if (platform === 'win32' && /^[\\/]{2}/.test(real)) return no('канонический путь — UNC/device');
      if (!pathEq(real, deepestExisting, platform)) return no('канонический путь не совпал: ' + real);
    }

    // Protected-набор (лексически). Дом и его предки — отдельно.
    const prot = protectedRoots(home).concat(opts.extraProtected || []);
    if (pathEq(norm, home, platform)) return no('это домашний каталог');
    if (isInside(home, norm, platform)) return no('предок домашнего каталога');
    for (const p of prot) {
      if (!p) continue;
      if (pathEq(norm, p, platform)) return no('защищённый путь: ' + p);
      if (isInside(norm, p, platform)) return no('внутри защищённого: ' + p);
      if (isInside(p, norm, platform)) {
        // Цель — ПРЕДОК защищённого. Для рекурсивных операций это всегда отказ.
        // Для emptydir (rmdirSync НЕ-рекурсивен и физически не может удалить
        // содержимое) вызывающий передаёт ancestorOfProtectedOk — и то лишь когда
        // защищённый путь реально существует, dir будет «не пуст → kept».
        if (!opts.ancestorOfProtectedOk) {
          let ex = true;
          try { ex = fs.existsSync(p); } catch (e) { ex = true; } // сомнение → защищаем
          if (ex) return no('предок защищённого (существующего): ' + p);
        }
      }
    }

    // POSIX: сверка по device+inode (APFS firmlink-алиасы). Сама цель — против
    // дома И защищённых; существующие предки — против защищённых корней.
    if (platform !== 'win32' && process.platform !== 'win32') {
      const protIno = [];
      for (const p of prot) {
        try { const st = fs.statSync(p); protIno.push({ dev: st.dev, ino: st.ino, p }); }
        catch (e) { if (e && e.code !== 'ENOENT' && e.code !== 'ENOTDIR') return no('stat защищённого ' + p + ': ' + e.code); }
      }
      let homeIno = null;
      try { const st = fs.statSync(home); homeIno = { dev: st.dev, ino: st.ino }; } catch (e) { /* нет дома — ниже нечего сверять */ }
      let cur = deepestExisting, prev = '', isSelf = deepestExisting && pathEq(deepestExisting, norm, platform);
      while (cur && cur !== prev) {
        let st = null;
        try { st = fs.statSync(cur); } catch (e) { return no('stat(' + cur + '): ' + ((e && e.code) || e)); }
        for (const pi of protIno) {
          if (st.dev === pi.dev && st.ino === pi.ino) return no('inode совпал с защищённым: ' + pi.p);
        }
        if (isSelf && homeIno && st.dev === homeIno.dev && st.ino === homeIno.ino) return no('inode совпал с домашним каталогом');
        isSelf = false;
        prev = cur; cur = path.dirname(cur);
      }
    }

    return { ok: true, norm, deepestExisting };
  } catch (e) {
    return no('guard-ошибка: ' + String((e && e.message) || e));
  }
}

// ---- исполнители --------------------------------------------------------
// Возврат: { status: 'removed'|'absent'|'kept'|'failed', message }.

function res(status, message) { return { status, message: message || '' }; }

function removeFile(p, opts, dry) {
  const g = checkTarget(p, opts);
  if (!g.ok) return res('failed', 'ЗАЩИТА: ' + g.reason);
  let st = null;
  try { st = fs.lstatSync(g.norm); }
  catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return res('absent', 'нечего удалять');
    return res('failed', 'lstat: ' + ((e && e.code) || e));
  }
  if (st.isDirectory()) return res('failed', 'ЗАЩИТА: цель-файл оказалась каталогом');
  if (dry) return res('removed', '[dry-run] WOULD remove file');
  try { fs.unlinkSync(g.norm); return res('removed', 'удалено'); }
  catch (e) { return res('failed', 'не удалось удалить: ' + ((e && e.code) || e)); }
}

function removeEmptyDir(p, opts, dry) {
  // rmdirSync НЕ-рекурсивен: содержимое (в т.ч. preserve-файлы внутри) физически
  // не может быть удалено — «предок защищённого» здесь безопасен (будет kept).
  const g = checkTarget(p, Object.assign({}, opts, { ancestorOfProtectedOk: true }));
  if (!g.ok) return res('failed', 'ЗАЩИТА: ' + g.reason);
  let st = null;
  try { st = fs.lstatSync(g.norm); }
  catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return res('absent', 'нечего удалять');
    return res('failed', 'lstat: ' + ((e && e.code) || e));
  }
  if (!st.isDirectory()) return res('failed', 'ЗАЩИТА: цель-каталог оказалась не каталогом');
  let entries;
  try { entries = fs.readdirSync(g.norm); }
  catch (e) { return res('failed', 'readdir: ' + ((e && e.code) || e)); }
  if (entries.length) return res('kept', 'каталог не пуст — оставлен (' + entries.length + ' элементов)');
  if (dry) return res('removed', '[dry-run] WOULD rmdir (пуст)');
  try { fs.rmdirSync(g.norm); return res('removed', 'пустой каталог удалён'); }
  catch (e) { return res('failed', 'rmdir: ' + ((e && e.code) || e)); }
}

// dirtree — ТОЛЬКО для installer-owned поддеревьев из аллоулиста. Если ЛЮБОЙ
// preserve-путь лежит ВНУТРИ цели (или есть цель==preserve) → отказ всей цели.
function removeDirTree(p, opts, dry) {
  const g = checkTarget(p, opts);
  if (!g.ok) return res('failed', 'ЗАЩИТА: ' + g.reason);
  for (const keep of (opts && opts.extraProtected) || []) {
    if (pathEq(keep, g.norm, opts.platform) || isInside(keep, g.norm, opts.platform)) {
      return res('failed', 'ЗАЩИТА: внутри цели лежит сохраняемый путь ' + keep);
    }
  }
  let st = null;
  try { st = fs.lstatSync(g.norm); }
  catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return res('absent', 'нечего удалять');
    return res('failed', 'lstat: ' + ((e && e.code) || e));
  }
  if (!st.isDirectory()) return res('failed', 'ЗАЩИТА: цель-дерево оказалась не каталогом');
  if (dry) return res('removed', '[dry-run] WOULD remove tree');
  try {
    // rmSync не следует по симлинкам внутрь (удаляет саму ссылку) — содержимое чужих целей цело.
    fs.rmSync(g.norm, { recursive: true, force: false });
  } catch (e) {
    if (fs.existsSync(g.norm)) return res('failed', 'не удалось удалить дерево: ' + ((e && e.code) || e));
  }
  if (fs.existsSync(g.norm)) return res('failed', 'дерево осталось на месте');
  return res('removed', 'удалено дерево');
}

// Разрешённые rc-файлы для profileline — ТОЛЬКО эти, ровно в $HOME.
function allowedRcFiles(home) {
  return ['.zshrc', '.bash_profile', '.bashrc'].map((n) => path.join(home, n));
}

// Убрать из rc-файла ТОЛЬКО строки, содержащие точный маркер. Атомарная
// перезапись: tmp (0600, fsync, ре-чтение) → rename; при сбое оригинал цел.
function removeProfileLine(rcFile, marker, opts, dry) {
  if (!valueHygieneOk(marker)) return res('failed', 'ЗАЩИТА: некорректный маркер');
  const home = path.resolve(opts.home);
  if (!allowedRcFiles(home).some((a) => pathEq(a, rcFile, opts.platform))) {
    return res('failed', 'ЗАЩИТА: rc-файл вне разрешённого списка: ' + rcFile);
  }
  const g = checkTarget(rcFile, opts); // symlink-rc / protected → отказ
  if (!g.ok) return res('failed', 'ЗАЩИТА: ' + g.reason);
  let raw;
  try { raw = fs.readFileSync(g.norm, 'utf8'); }
  catch (e) {
    if (e && e.code === 'ENOENT') return res('absent', 'rc-файла нет');
    return res('failed', 'чтение rc: ' + ((e && e.code) || e));
  }
  if (raw.indexOf(marker) === -1) return res('absent', 'маркера нет');
  const kept = raw.split('\n').filter((l) => l.indexOf(marker) === -1);
  const next = kept.join('\n');
  if (dry) return res('removed', '[dry-run] WOULD убрать строки с маркером');
  const tmp = g.norm + '.hm-un.' + process.pid + '.tmp';
  try {
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeFileSync(fd, next, 'utf8');
      try { fs.fsyncSync(fd); } catch (e) { /* не фатально */ }
    } finally { fs.closeSync(fd); }
    if (fs.readFileSync(tmp, 'utf8') !== next) throw new Error('tmp не совпал');
    try { fs.renameSync(tmp, g.norm); }
    catch (e) {
      // Windows EPERM поверх существующего: old→bak, tmp→dst, откат при сбое.
      const bak = g.norm + '.' + process.pid + '.bak';
      let moved = false;
      try {
        fs.renameSync(g.norm, bak); moved = true;
        fs.renameSync(tmp, g.norm);
        try { fs.rmSync(bak, { force: true }); } catch (e2) { /* bak восстановится при чтении */ }
      } catch (e3) {
        if (moved) { try { fs.renameSync(bak, g.norm); } catch (e4) { /* bak остаётся для ручного восстановления */ } }
        throw e3;
      }
    }
    return res('removed', 'строки с маркером убраны');
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch (e2) { /* ignore */ }
    return res('failed', 'перезапись rc не удалась: ' + String((e && e.message) || e));
  }
}

// Точная запись пользовательского PATH: убрать ТОЛЬКО полностью совпавшую
// (TrimEnd('\'), регистронезависимо). Чужие записи не трогаются. Чистая функция.
function computeUserPathWithout(rawPath, dir) {
  const strip = (s) => String(s || '').replace(/[\\/]+$/, '').toLowerCase();
  const want = strip(dir);
  const entries = String(rawPath == null ? '' : rawPath).split(';');
  const kept = [];
  let removed = 0;
  for (const e of entries) {
    if (!e) continue;
    if (strip(e) === want) { removed++; continue; }
    kept.push(e);
  }
  return { changed: removed > 0, removed, value: kept.join(';') };
}

module.exports = {
  protectedRoots, checkTarget, valueHygieneOk, pathEq, isInside,
  removeFile, removeEmptyDir, removeDirTree, removeProfileLine,
  allowedRcFiles, computeUserPathWithout
};
