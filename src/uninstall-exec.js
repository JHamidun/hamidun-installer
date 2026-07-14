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
const crypto = require('crypto');

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

// P0-1: подтверждён ли НАШ ownership-маркер — хотя бы один из markerPaths существует
// как ОБЫЧНЫЙ файл (lstat, no-follow: symlink НЕ считается маркером). Пусто → false.
function anyOwnerMarker(markerPaths) {
  for (const m of (markerPaths || [])) {
    try {
      const st = fs.lstatSync(m);
      if (st.isFile() && !st.isSymbolicLink()) return true;
    } catch (e) { /* нет маркера — следующий кандидат */ }
  }
  return false;
}

// P0-1: удалить файл (shim) ТОЛЬКО при подтверждённом нашем ownership-маркере.
// Нет маркера → файл НЕ наш (напр. собственный uv-tool пользователя) → kept.
function removeFileGated(p, opts, markerPaths, dry) {
  if (!anyOwnerMarker(markerPaths)) {
    return res('kept', 'нет ownership-маркера (наш venv не найден) — файл не наш, не трогаю');
  }
  return removeFile(p, opts, dry);
}

// P0-3: quarantine-then-guard для gated dirtree (onlyIfContains-маркер). Устраняет
// TOCTOU-окно между проверкой маркера и удалением: атомарно ПЕРЕИМЕНОВЫВАЕМ проверенную
// цель в СЛУЧАЙНЫЙ quarantine-каталог В ТОМ ЖЕ родителе (подменить захваченный каталог
// нельзя — имя непредсказуемо), ЗАТЕМ ВНУТРИ quarantine делаем no-follow проверку
// маркера (lstat, маркер обязан быть обычным файлом, не symlink). Валидный маркер есть
// → удаляем quarantine (ровно то, что проверили). Маркера нет → ВОЗВРАЩАЕМ каталог на
// место (rename back), НЕ удаляем.
function removeDirTreeGated(p, opts, markerName, dry) {
  if (!valueHygieneOk(markerName) || /[\\/]/.test(markerName) || markerName === '.' || markerName === '..') {
    return res('failed', 'ЗАЩИТА: некорректное имя маркера');
  }
  // 1. Guard исходной цели (symlink/protected/UNC/канонизация) — как у removeDirTree.
  const g = checkTarget(p, opts);
  if (!g.ok) return res('failed', 'ЗАЩИТА: ' + g.reason);
  for (const keep of (opts && opts.extraProtected) || []) {
    if (pathEq(keep, g.norm, opts.platform) || isInside(keep, g.norm, opts.platform)) {
      return res('failed', 'ЗАЩИТА: внутри цели лежит сохраняемый путь ' + keep);
    }
  }
  // 2. Цель существует и это НЕ symlink и это каталог?
  let st = null;
  try { st = fs.lstatSync(g.norm); }
  catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return res('absent', 'нечего удалять');
    return res('failed', 'lstat: ' + ((e && e.code) || e));
  }
  if (st.isSymbolicLink()) return res('failed', 'ЗАЩИТА: цель — symlink');
  if (!st.isDirectory()) return res('failed', 'ЗАЩИТА: цель-дерево оказалась не каталогом');

  // 3. Карантин: атомарный rename в непредсказуемое имя В ТОМ ЖЕ родителе.
  const parent = path.dirname(g.norm);
  let quarantine = '';
  for (let attempt = 0; attempt < 5 && !quarantine; attempt++) {
    const cand = path.join(parent, '.hm-quar.' + crypto.randomBytes(12).toString('hex'));
    let candFree = false;
    try { fs.lstatSync(cand); } catch (e) { if (e && e.code === 'ENOENT') candFree = true; else return res('failed', 'карантин (проверка имени): ' + ((e && e.code) || e)); }
    if (!candFree) continue;
    try { fs.renameSync(g.norm, cand); quarantine = cand; }
    catch (e) {
      if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return res('absent', 'цель исчезла во время карантина');
      return res('failed', 'карантин (rename): ' + ((e && e.code) || e));
    }
  }
  if (!quarantine) return res('failed', 'ЗАЩИТА: не удалось захватить цель в карантин');

  const restore = () => { try { fs.renameSync(quarantine, g.norm); return true; } catch (e) { return false; } };

  // 4. No-follow проверка маркера на ЗАХВАЧЕННОМ каталоге.
  let qst = null;
  try { qst = fs.lstatSync(quarantine); }
  catch (e) { const back = restore(); return res('failed', 'ЗАЩИТА: карантин не читается: ' + ((e && e.code) || e) + (back ? '' : ' (и не удалось вернуть)')); }
  if (qst.isSymbolicLink() || !qst.isDirectory()) {
    const back = restore();
    return res('failed', 'ЗАЩИТА: захваченная цель — не каталог (возможна подмена)' + (back ? ', возвращена' : ', и не удалось вернуть'));
  }
  let markerOk = false;
  try {
    const mst = fs.lstatSync(path.join(quarantine, markerName));
    markerOk = !!(mst && mst.isFile() && !mst.isSymbolicLink());
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) markerOk = false;
    else { const back = restore(); return res('failed', 'ЗАЩИТА: проверка маркера: ' + ((e && e.code) || e) + (back ? '' : ' (и не удалось вернуть)')); }
  }

  if (!markerOk) {
    // Нет нашего маркера → это НЕ наш каталог. Вернуть на место, НЕ удалять.
    if (restore()) return res('kept', 'нет маркера ' + markerName + ' — каталог возвращён, не удаляю');
    return res('failed', 'ЗАЩИТА: нет маркера и не удалось вернуть каталог из карантина: ' + quarantine);
  }

  if (dry) { restore(); return res('removed', '[dry-run] WOULD remove tree (маркер подтверждён)'); }

  // 5. Маркер подтверждён на ЗАХВАЧЕННОМ каталоге → удаляем quarantine.
  try {
    fs.rmSync(quarantine, { recursive: true, force: false });
  } catch (e) {
    if (fs.existsSync(quarantine)) { restore(); return res('failed', 'не удалось удалить дерево: ' + ((e && e.code) || e)); }
  }
  if (fs.existsSync(quarantine)) { restore(); return res('failed', 'дерево осталось в карантине'); }
  return res('removed', 'удалено дерево (карантин, маркер подтверждён)');
}

// P1: классификаторы результата launchctl — чистые, тестируемые.
// classifyLaunchctlPrint(result) — `launchctl print gui/<uid>/<label>`:
//   { ok:true, loaded:true }   — job существует (код 0);
//   { ok:true, loaded:false }  — ПОДТВЕРЖДЁННОЕ отсутствие (нужный not-found текст);
//   { ok:false, error }        — ненулевой код без подтверждения отсутствия / ошибка запуска.
function classifyLaunchctlPrint(execResult) {
  if (!execResult || typeof execResult !== 'object') return { ok: false, error: 'нет результата launchctl print' };
  if (execResult.error) return { ok: false, error: String((execResult.error && execResult.error.message) || execResult.error) };
  if (execResult.status === 0) return { ok: true, loaded: true };
  const msg = String(execResult.stderr || '') + '\n' + String(execResult.stdout || '');
  if (/could not find service|could not find|no such (process|service)|not loaded|no such/i.test(msg)) {
    return { ok: true, loaded: false };
  }
  return { ok: false, error: 'launchctl print: код ' + execResult.status + ' без подтверждения отсутствия job: ' + msg.trim().slice(0, 160) };
}
// launchctlRemoveError(result) — `launchctl remove <label>`: '' если ok/бенайн
// (job уже не загружен), иначе текст ошибки (ненулевой код НЕ игнорируем).
function launchctlRemoveError(execResult) {
  if (!execResult || typeof execResult !== 'object') return 'нет результата launchctl remove';
  if (execResult.error) return 'remove: ' + String((execResult.error && execResult.error.message) || execResult.error);
  if (execResult.status === 0) return '';
  const msg = String(execResult.stderr || '') + '\n' + String(execResult.stdout || '');
  if (/could not find|no such (process|service)|not loaded/i.test(msg)) return '';
  return 'remove: код ' + execResult.status;
}

// Разрешённые rc-файлы для profileline — ТОЛЬКО эти, ровно в $HOME.
function allowedRcFiles(home) {
  return ['.zshrc', '.bash_profile', '.bashrc'].map((n) => path.join(home, n));
}

// P0-6: убрать из rc-файла ТОЛЬКО строки, ТОЧНО РАВНЫЕ нашей installer-строке
// (полное совпадение после trim) — НЕ по подстроке: пользовательская строка,
// внутри которой встречается наш маркер-текст (export NOTE="… # Hamidun …"),
// НЕ удаляется.
// P0-1: атомарная перезапись через temp в ТОМ ЖЕ каталоге с НЕПРЕДСКАЗУЕМЫМ
// именем и O_EXCL ('wx' — по существующему пути/hardlink/symlink НЕ идём, EEXIST),
// затем fstat-проверка открытого fd (обычный файл, nlink==1 — не чей-то hardlink),
// запись через fd, fsync, ре-чтение, rename. Любая аномалия → отказ, цель цела.
function removeProfileLine(rcFile, line, opts, dry) {
  if (!valueHygieneOk(line)) return res('failed', 'ЗАЩИТА: некорректная строка-цель');
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
  const want = String(line).trim();
  const lines = raw.split('\n');
  const kept = lines.filter((l) => l.trim() !== want);
  if (kept.length === lines.length) return res('absent', 'нашей строки нет');
  const next = kept.join('\n');
  if (dry) return res('removed', '[dry-run] WOULD убрать точную installer-строку');
  let tmp = '';
  try {
    // O_EXCL + случайное имя: заранее заготовленный hardlink на чужой файл
    // (например ~/.claude/settings.json) даст EEXIST, а не запись в его inode.
    let fd = -1;
    for (let attempt = 0; attempt < 3 && fd < 0; attempt++) {
      const cand = g.norm + '.hm-un.' + crypto.randomBytes(8).toString('hex') + '.tmp';
      try { fd = fs.openSync(cand, 'wx', 0o600); tmp = cand; }
      catch (e) { if (!e || e.code !== 'EEXIST') throw e; }
    }
    if (fd < 0) throw new Error('ЗАЩИТА: temp уже существует (EEXIST) — возможная подмена, отказ');
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) throw new Error('ЗАЩИТА: temp — не обычный файл');
      if (typeof st.nlink === 'number' && st.nlink !== 1) {
        throw new Error('ЗАЩИТА: temp имеет nlink=' + st.nlink + ' (hardlink на чужое) — отказ');
      }
      fs.writeFileSync(fd, next, 'utf8');
      try { fs.fsyncSync(fd); } catch (e) { /* не фатально */ }
    } finally { fs.closeSync(fd); }
    if (fs.readFileSync(tmp, 'utf8') !== next) throw new Error('tmp не совпал');
    try { fs.renameSync(tmp, g.norm); }
    catch (e) {
      // Windows EPERM поверх существующего: old→bak (тоже непредсказуемое имя),
      // tmp→dst, откат при сбое.
      const bak = g.norm + '.' + crypto.randomBytes(8).toString('hex') + '.bak';
      let moved = false;
      try {
        fs.renameSync(g.norm, bak); moved = true;
        fs.renameSync(tmp, g.norm);
        try { fs.rmSync(bak, { force: true }); } catch (e2) { /* bak останется рядом */ }
      } catch (e3) {
        if (moved) { try { fs.renameSync(bak, g.norm); } catch (e4) { /* bak остаётся для ручного восстановления */ } }
        throw e3;
      }
    }
    return res('removed', 'точная installer-строка убрана');
  } catch (e) {
    if (tmp) { try { fs.rmSync(tmp, { force: true }); } catch (e2) { /* ignore */ } }
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

// P1: reg.exe отдаёт код 1 И на «значение/ключ не найдены» (штатное отсутствие),
// И на «Access is denied» (реальная ошибка) — по коду их НЕ различить. Различаем
// по тексту диагностики (reg.exe пишет её по-английски даже на локализованной
// Windows; ru-фолбэки на случай локализации). Неузнанный код 1 → fail-closed.
const REG_NOTFOUND_RE = /unable to find the specified|specified registry key or value|cannot find the (registry|specified)|was unable to find|не удаёт?с?я найти|не удалось найти|указанн\w*\s+(раздел|параметр)|раздел или параметр реестра/i;
const REG_DENIED_RE = /access is denied|permission denied|отказано в доступе|доступ запрещ/i;

// P1-7: чистый tri-state классификатор результата `reg query <key> /v <value>`.
// НЕ смешивает «значения нет» с ошибкой query/парсера:
//   { ok:true, found:true, type, data } — значение прочитано;
//   { ok:true, found:false }            — ключа/значения ШТАТНО нет (код 1 + not-found);
//   { ok:false, error }                 — любая другая ошибка запуска/кода/парсинга
//                                         (в т.ч. код 1 «Access is denied» или код 1 без
//                                         распознанной not-found диагностики)
//                                         → вызывающий обязан дать failed, НЕ absent.
function classifyRegQuery(valueName, execResult) {
  if (!execResult || typeof execResult !== 'object') return { ok: false, error: 'нет результата reg query' };
  if (execResult.error) return { ok: false, error: String((execResult.error && execResult.error.message) || execResult.error) };
  if (execResult.status !== 0) {
    // P1: код 1 → absent ТОЛЬКО при ЯВНО распознанной not-found диагностике.
    // «Access is denied» и любой нераспознанный код 1 → ошибка (НЕ absent).
    if (execResult.status === 1) {
      const msg = String(execResult.stderr || '') + '\n' + String(execResult.stdout || '');
      if (REG_DENIED_RE.test(msg)) return { ok: false, error: 'reg query: доступ запрещён (код 1)' };
      if (REG_NOTFOUND_RE.test(msg)) return { ok: true, found: false };
      return { ok: false, error: 'reg query: код 1 без распознанной not-found диагностики: ' + msg.trim().slice(0, 200) };
    }
    return { ok: false, error: 'reg query: код ' + execResult.status };
  }
  const esc = String(valueName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = String(execResult.stdout || '').match(new RegExp('^\\s*' + esc + '\\s+(REG_(?:EXPAND_)?SZ)\\s+(.*)$', 'im'));
  if (!m) return { ok: false, error: 'вывод reg query не разобрался как REG_(EXPAND_)SZ (это ОШИБКА, не absent)' };
  return { ok: true, found: true, type: m[1], data: m[2].replace(/\r$/, '') };
}

// P1-6: пост-проверка деинсталляции по ТОЧНЫМ managed-целям плана — НЕ глобальная
// детекция («любой uv/nomad/Claude.app на машине»): чужая установка не даёт ни
// вечного failure, ни ложного успеха. Правила по типам:
//   file/launchagent      — путь обязан отсутствовать;
//   dirtree               — отсутствует, ЛИБО намеренно оставлен (onlyIfContains-маркер отсутствует);
//   emptydir              — отсутствует или НЕ пуст (preserve/чужие данные — законно);
//   reg/pathentry (win)   — через helpers.regQuery (tri-state); ошибка чтения → проблема (fail-closed);
//   profileline           — точной installer-строки в rc больше нет;
//   appbundle             — отсутствует, ЛИБО чужой (bundleId ≠ эталону — не наш, законно оставлен);
//   killproc              — не постусловие.
// helpers: { regQuery(key, value) → tri-state, bundleIdOf(path) → string }.
function verifyPostconditions(plan, opts, helpers) {
  helpers = helpers || {};
  const isWin = !!(opts && opts.platform === 'win32');
  const problems = [];
  const lstatOrNull = (p) => { try { return fs.lstatSync(p); } catch (e) { return null; } };
  for (const t of (plan && plan.targets) || []) {
    try {
      switch (t && t.type) {
        case 'file':
          if (lstatOrNull(t.path)) {
            // P0-1: gated shim — оставшийся файл ЗАКОНЕН, если нашего ownership-маркера
            // нет (значит файл не наш и мы его намеренно не трогали).
            if (t.onlyIfOwnerMarker && !anyOwnerMarker(t.onlyIfOwnerMarker)) break;
            problems.push('файл остался: ' + t.path);
          }
          break;
        case 'dirtree': {
          if (!lstatOrNull(t.path)) break;
          if (t.onlyIfContains) {
            let gated = false;
            try { gated = !fs.existsSync(path.join(t.path, t.onlyIfContains)); } catch (e) { gated = false; }
            if (gated) break; // нет нашего маркера → каталог намеренно оставлен (не наш)
          }
          problems.push('дерево осталось: ' + t.path);
          break;
        }
        case 'emptydir': {
          if (!lstatOrNull(t.path)) break;
          let n = -1;
          try { n = fs.readdirSync(t.path).length; } catch (e) { n = -1; }
          if (n === 0) problems.push('пустой каталог остался: ' + t.path);
          break;
        }
        case 'reg': {
          if (!isWin) break;
          if (typeof helpers.regQuery !== 'function') { problems.push('нет regQuery для пост-проверки реестра'); break; }
          const q = helpers.regQuery('HKCU\\' + t.key, t.value);
          if (!q || q.ok !== true) { problems.push('реестр не читается: ' + t.key + ' → ' + t.value + (q && q.error ? ' (' + q.error + ')' : '')); break; }
          if (q.found) problems.push('значение реестра осталось: ' + t.key + ' → ' + t.value);
          break;
        }
        case 'pathentry': {
          if (!isWin) break;
          if (lstatOrNull(t.dir)) break; // каталог существует → запись законно оставлена
          if (typeof helpers.regQuery !== 'function') { problems.push('нет regQuery для пост-проверки PATH'); break; }
          const q = helpers.regQuery('HKCU\\Environment', 'Path');
          if (!q || q.ok !== true) { problems.push('пользовательский PATH не читается' + (q && q.error ? ' (' + q.error + ')' : '')); break; }
          if (q.found && computeUserPathWithout(q.data, t.dir).changed) problems.push('запись PATH осталась: ' + t.dir);
          break;
        }
        case 'profileline': {
          let raw = null;
          try { raw = fs.readFileSync(t.file, 'utf8'); } catch (e) { raw = null; }
          if (raw == null) break;
          const want = String(t.line || '').trim();
          if (want && raw.split('\n').some((l) => l.trim() === want)) problems.push('installer-строка осталась в ' + t.file);
          break;
        }
        case 'launchagent':
          if (lstatOrNull(t.plist)) problems.push('plist остался: ' + t.plist);
          break;
        case 'appbundle': {
          if (!lstatOrNull(t.path)) break;
          const bid = typeof helpers.bundleIdOf === 'function' ? String(helpers.bundleIdOf(t.path) || '') : '';
          if (bid && t.expectBundleId && bid !== t.expectBundleId) break; // чужой .app → законно оставлен
          problems.push('.app остался: ' + t.path);
          break;
        }
        case 'killproc':
          break;
        default:
          problems.push('неизвестный тип цели в пост-проверке: ' + String(t && t.type));
      }
    } catch (e) {
      problems.push('пост-проверка ' + String(t && t.type) + ': ' + String((e && e.message) || e));
    }
  }
  return { ok: problems.length === 0, problems };
}

module.exports = {
  protectedRoots, checkTarget, valueHygieneOk, pathEq, isInside,
  removeFile, removeEmptyDir, removeDirTree, removeProfileLine,
  removeFileGated, removeDirTreeGated, anyOwnerMarker,
  allowedRcFiles, computeUserPathWithout,
  classifyRegQuery, classifyLaunchctlPrint, launchctlRemoveError,
  verifyPostconditions
};
