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
// Снос дерева, который НЕ идёт по ссылкам. fs.rmSync(recursive) в Electron 40+ ходит по junction
// внутрь и стирает чужую цель — подробности и проверка в src/fs-compat.js.
const { removeTreeNoFollow } = require('./fs-compat');

// Синхронная пауза. Модуль сквозь весь файл синхронный (он крутится в main-процессе
// до закрытия окна), поэтому await сюда не вставить, а setTimeout не сработает.
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch (e) { /* SharedArrayBuffer недоступен — просто не ждём */ }
}

// Возврат каталога из карантина. Раньше это был ОДИН fs.renameSync без повторов — и
// в этом была асимметрия, стоившая чужих папок: ЗАХВАТ в карантин делает пять попыток,
// а ВОЗВРАТ не делал ни одной. На Windows rename на только что созданном дереве
// транзиентно падает с EPERM/EACCES/EBUSY, пока Defender или индексатор Search держат
// хендл на свежих файлах, — и чужой каталог оставался лежать под именем
// «.hm-quar.<hex>». Опаснее всего это в ветке «маркера нет»: там мы как раз и
// установили, что каталог НЕ наш.
//
// Ретраим только транзиентное. ENOENT (цель исчезла) и EXDEV (разные тома — так не
// бывает, карантин в том же родителе) повторять бессмысленно: это не «занято», а
// «иначе не будет».
const RENAME_TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY', 'EEXIST']);
function renameWithRetry(from, to, attempts, delayMs) {
  const n = attempts || 5;
  for (let i = 0; i < n; i++) {
    try { fs.renameSync(from, to); return true; }
    catch (e) {
      const code = e && e.code;
      if (!RENAME_TRANSIENT.has(code) || i === n - 1) return false;
      sleepSync((delayMs || 150) * (i + 1)); // линейный backoff: 150/300/450/600 мс
    }
  }
  return false;
}

function isCaseInsensitive(platform) { return platform === 'win32' || platform === 'darwin'; }
function normKey(p, platform) {
  const n = path.resolve(String(p));
  return isCaseInsensitive(platform) ? n.toLowerCase() : n;
}
function pathEq(a, b, platform) { return normKey(a, platform) === normKey(b, platform); }
// Путь и ВСЕ его существующие предки — без symlink и junction. Проверка живёт в src/link-guard.js (её же
// используют писатели под администратором: прокси, ключи, манифест, журнал) — здесь только импорт, чтобы
// `checkTarget` (защита от УДАЛЕНИЯ не того каталога) и `removeMascotHooks` (от ЗАПИСИ не в тот файл) и дальше
// опирались на одну и ту же проверку, а не на две копии.
const { symlinkFreeChain } = require('./link-guard');

function isInside(child, parent, platform) {
  const c = normKey(child, platform), p = normKey(parent, platform);
  return c.length > p.length && c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

// Защищённые корни: их самих, всё внутри них и их предков удалять НЕЛЬЗЯ.
// При полном удалении (A27 «Удалить всё») вызывающий может явно разрешить
// очистку ~/.hamidun-setup (allowSetupCleanup) и, после резервного копирования
// секретов, очистку ~/.claude и ~/CLAUDE.md (allowClaudeCleanup).
function protectedRoots(home, opts) {
  const o = opts || {};
  const roots = [];
  if (!o.allowClaudeCleanup) {
    roots.push(path.join(home, '.claude'));
    roots.push(path.join(home, 'CLAUDE.md'));
  }
  if (!o.allowSetupCleanup) {
    roots.push(path.join(home, '.hamidun-setup'));
  }
  return roots;
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
    const prot = protectedRoots(home, opts).concat(opts.extraProtected || []);
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
  // #10: атомарный quarantine-rename ДО рекурсивного удаления — схлопывает TOCTOU-окно
  // (medium-малварь того же юзера подменяет ancestor-симлинк между checkTarget и обходом
  // rmSync) до ОДНОГО rename в непредсказуемое имя-сиблинг. Тот же приём, что gated-путь.
  const parent = path.dirname(g.norm);
  let quarantine = '';
  for (let attempt = 0; attempt < 5 && !quarantine; attempt++) {
    const cand = path.join(parent, '.hm-quar.' + crypto.randomBytes(12).toString('hex'));
    try { fs.renameSync(g.norm, cand); quarantine = cand; }
    catch (e) { if (e && e.code === 'ENOENT') return res('absent', 'нечего удалять'); }
  }
  if (!quarantine) return res('failed', 'ЗАЩИТА: не удалось захватить дерево в карантин');
  // Провал удаления ОБЯЗАН вернуть дерево на исходный путь (как в gated-варианте):
  // иначе состояние на диске расходится с рапортом «не удалено» — каталог компонента
  // уехал в .hm-quar.<hex>, а повторный запуск видит ENOENT → 'absent' → рапортует
  // ложный успех и осиротевший карантин остаётся навсегда. Если и возврат не удался —
  // путь карантина попадает в сообщение (и в install.log), мусор не невидим.
  const restore = () => renameWithRetry(quarantine, g.norm);
  const links = [];
  try {
    // БЕЗ fs.rmSync: прежний комментарий здесь («rmSync не следует по симлинкам внутрь») описывал
    // Node 20 и с Electron 40 (Node 24, std::filesystem) стал ЛОЖЬЮ — рантайм заходит по junction
    // внутрь и стирает содержимое чужой цели с правами администратора. Дерево лежит в месте, куда
    // пишет любой процесс пользователя (checkTarget проверил цель и её предков, но не нутро), так
    // что junction внутри — это не фантазия. removeTreeNoFollow снимает ссылку как ссылку.
    // maxRetries/retryDelay — против транзиентных EPERM/EBUSY на Windows (процесс ещё
    // не отпустил образ сразу после taskkill, антивирус держит хендл).
    removeTreeNoFollow(quarantine, { force: false, maxRetries: 5, retryDelay: 200, onLink: (lp) => links.push(lp) });
  } catch (e) {
    if (fs.existsSync(quarantine)) {
      const back = restore();
      return res('failed', 'не удалось удалить дерево: ' + treeFailWhy(e) +
        (back ? ' (оставшееся дерево возвращено на место)' : ' — ОСТАТОК В КАРАНТИНЕ: ' + quarantine));
    }
  }
  if (fs.existsSync(quarantine)) {
    const back = restore();
    return res('failed', 'дерево осталось на месте' +
      (back ? ' (возвращено)' : ' — ОСТАТОК В КАРАНТИНЕ: ' + quarantine));
  }
  return res('removed', 'удалено дерево' + linksNote(links));
}

// Ссылки (symlink/junction), найденные внутри сносимого дерева, снимаются КАК ссылки, цель не
// трогается. Это не ошибка, но и не «обычное» удаление — в install.log должна остаться строка.
function linksNote(links) {
  if (!links.length) return '';
  return ' (внутри были ссылки: ' + links.length + ' — сняты как ссылки, содержимое их целей не тронуто)';
}

// Почему снос дерева отказал — для строки результата (она уходит и в UI, и в install.log). Голые коды
// ERR_HM_TREE_CHANGED и ENOTEMPTY ничего не объясняют, а русское пояснение лежит в e.message
// (src/fs-compat.js) и раньше терялось. Код остаётся первым: по нему ищут в логе и сверяют тесты.
function treeFailWhy(e) {
  const code = (e && e.code) || e;
  const msg = String((e && e.message) || '');
  if (code === 'ERR_HM_TREE_CHANGED') return code + ' — ' + msg.replace(/^ERR_HM_TREE_CHANGED:\s*/, '');
  if (code === 'ENOTEMPTY') {
    const note = /\[(это перенаправление[\s\S]*)\]$/.exec(msg);   // подпись removeLink стоит в конце сообщения; в самом пути бывают [ и ]
    if (note) return code + ' — ' + note[1];
  }
  return String(code);
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

  const restore = () => renameWithRetry(quarantine, g.norm);

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

  // 5. Маркер подтверждён на ЗАХВАЧЕННОМ каталоге → удаляем quarantine. Снос — removeTreeNoFollow, а не
  //    fs.rmSync: рантайм Electron 40+ ходит по junction внутрь дерева (см. removeDirTree выше).
  const links = [];
  try {
    removeTreeNoFollow(quarantine, { force: false, onLink: (lp) => links.push(lp) });
  } catch (e) {
    if (fs.existsSync(quarantine)) { restore(); return res('failed', 'не удалось удалить дерево: ' + treeFailWhy(e)); }
  }
  if (fs.existsSync(quarantine)) { restore(); return res('failed', 'дерево осталось в карантине'); }
  return res('removed', 'удалено дерево (карантин, маркер подтверждён)' + linksNote(links));
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
  try {
    atomicReplaceContent(g.norm, next);
    return res('removed', 'точная installer-строка убрана');
  } catch (e) {
    return res('failed', 'перезапись rc не удалась: ' + String((e && e.message) || e));
  }
}

// Укреплённая перезапись СУЩЕСТВУЮЩЕГО файла новым содержимым.
//
// Вынесено из removeProfileLine без единого изменения логики: появился второй
// потребитель (removeMascotHooks), а копия такого кода — гарантированный дрейф. Здесь
// каждая строка отвечает на конкретную атаку или на конкретный отказ Windows, и
// вторая копия рано или поздно отстала бы ровно на ту защиту, которую забыли
// перенести.
//
// Бросает при неудаче; временный файл за собой убирает.
function atomicReplaceContent(norm, next) {
  let tmp = '';
  try {
    // O_EXCL + случайное имя: заранее заготовленный hardlink на чужой файл
    // (например ~/.claude/settings.json) даст EEXIST, а не запись в его inode.
    let fd = -1;
    for (let attempt = 0; attempt < 3 && fd < 0; attempt++) {
      const cand = norm + '.hm-un.' + crypto.randomBytes(8).toString('hex') + '.tmp';
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
    try { fs.renameSync(tmp, norm); }
    catch (e) {
      // Windows EPERM поверх существующего: old→bak (тоже непредсказуемое имя),
      // tmp→dst, откат при сбое.
      const bak = norm + '.' + crypto.randomBytes(8).toString('hex') + '.bak';
      let moved = false;
      try {
        fs.renameSync(norm, bak); moved = true;
        fs.renameSync(tmp, norm);
        try { fs.rmSync(bak, { force: true }); } catch (e2) { /* bak останется рядом */ }
      } catch (e3) {
        if (moved) { try { fs.renameSync(bak, norm); } catch (e4) { /* bak остаётся для ручного восстановления */ } }
        throw e3;
      }
    }
    tmp = '';
  } finally {
    if (tmp) { try { fs.rmSync(tmp, { force: true }); } catch (e2) { /* ignore */ } }
  }
}

// ---- хуки скрепки в ~/.claude/settings.json ------------------------------------------
//
// Что здесь было раньше. Удаление возвращало адрес хука к «плейсхолдеру пака»
// (`127.0.0.1:45832/hook` → `127.0.0.1:VSCODE_PORT/hook`). Такой адрес — не URL (нечисловой
// порт, `new URL` бросает ERR_INVALID_URL), и Claude Code видит в settings.json невалидный
// хук: «Удалить скрепку» воспроизводила ту самую поломку (Settings Error), с которой люди
// приходили в поддержку (строки A25 и B01 разбора диалогов).
//
// Что теперь. Записи скрепки УДАЛЯЮТСЯ, и только её. Цену бездействия измерили раньше:
// обращение на закрытый локальный порт под Windows не отбивается мгновенно (SYN уходит в
// повтор) — 2,2 с на попытку, а хуков четырнадцать, то есть около полуминуты мёртвого
// ожидания в каждой сессии Claude Code у того, кто скрепку снял. Самолечению взяться
// неоткуда: оно живёт внутри самой скрепки, а её больше не запускают.

const MASCOT_HOOK_MARKER = 'claude-mascot';

// Чья это запись по адресу. Критерий намеренно узкий и повторяет тот, по которому свои записи
// опознаёт само приложение скрепки (hooks.rs, is_mascot_hook_group): http, 127.0.0.1, ровно наш
// порт, путь РОВНО /hook, а запрос пуст либо несёт метку ?src=claude-mascot (прежние версии
// писали адрес без метки). Чужой хук на том же порту — /hook/proxy, /other-tool, / — не наш,
// поэтому «подстрока :45832/hook» тут не годится: она ловит и /hook/proxy.
//
// Смотрим ТОЛЬКО поле url. Хук-команда, в тексте которой встречается адрес или слово
// claude-mascot (`curl http://127.0.0.1:45832/hook`), записью скрепки не считается: скрепка
// пишет http-хуки, команды в этом файле — чужие.
function isMascotHookUrl(url, port) {
  if (typeof url !== 'string') return false;
  let u;
  try { u = new URL(url.trim()); } catch (e) { return false; }
  if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || u.port !== String(port)) return false;
  if (u.username || u.password) return false;
  if (u.pathname !== '/hook') return false;
  return u.search === '' || u.searchParams.get('src') === MASCOT_HOOK_MARKER;
}

function hooksMapOf(settings) {
  const h = settings && typeof settings === 'object' && !Array.isArray(settings) ? settings.hooks : null;
  return h && typeof h === 'object' && !Array.isArray(h) ? h : null;
}

// Обойти все записи-хуки: settings.hooks[событие][группа].hooks[запись].
function forEachHookEntry(settings, fn) {
  const hooks = hooksMapOf(settings);
  if (!hooks) return;
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      if (!g || typeof g !== 'object' || !Array.isArray(g.hooks)) continue;
      for (const h of g.hooks) fn(h, event);
    }
  }
}
function countHookEntries(settings) {
  let n = 0;
  forEachHookEntry(settings, () => { n++; });
  return n;
}
function countMascotHooks(settings, port) {
  let n = 0;
  forEachHookEntry(settings, (h) => { if (h && typeof h === 'object' && isMascotHookUrl(h.url, port)) n++; });
  return n;
}

// Убрать записи скрепки из разобранного settings.json (объект меняется на месте).
//
// Единица снятия — ЗАПИСЬ, а не группа: если человек руками добавил свой хук в ту же группу,
// что и запись скрепки, его хук остаётся. Группа уходит только когда в ней не осталось ничего.
// Массив события уходит только если ЭТО СНЯТИЕ его опустошило, — значит в нём лежало одно
// лишь скрепочное, и ключа без скрепки не было. Массив, пустой ещё до нас, не трогаем: он не
// наш. Так же с самим `hooks`.
function stripMascotHooks(settings, port) {
  const stat = { removed: 0, groupsDropped: 0, eventsDropped: [], hooksDropped: false };
  const hooks = hooksMapOf(settings);
  if (!hooks) return stat;
  const hadEvents = Object.keys(hooks).length;
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    const before = groups.length;
    const kept = [];
    for (const g of groups) {
      if (!g || typeof g !== 'object' || !Array.isArray(g.hooks)) { kept.push(g); continue; }
      const left = g.hooks.filter((h) => !(h && typeof h === 'object' && isMascotHookUrl(h.url, port)));
      const gone = g.hooks.length - left.length;
      if (gone === 0) { kept.push(g); continue; }
      stat.removed += gone;
      if (left.length === 0) { stat.groupsDropped++; continue; }
      g.hooks = left;
      kept.push(g);
    }
    if (kept.length === 0 && before > 0) {
      delete hooks[event];
      stat.eventsDropped.push(event);
    } else if (kept.length !== before) {
      hooks[event] = kept;
    }
  }
  if (stat.removed > 0 && hadEvents > 0 && Object.keys(hooks).length === 0) {
    delete settings.hooks;
    stat.hooksDropped = true;
  }
  return stat;
}

// Записать объект в том виде, в каком лежал файл: отступ первой вложенной строки, переводы
// строк (CRLF/LF) и завершающий перевод строки сохраняются. Вид файла — не наше дело, и diff
// у человека (у него settings.json может лежать в git) должен показывать только снятое.
function serializeLikeOriginal(raw, obj) {
  const lead = /^[ \t]+(?=\S)/m.exec(raw);
  let out = JSON.stringify(obj, null, lead ? lead[0] : 0);
  if (raw.indexOf('\r\n') !== -1) out = out.replace(/\n/g, '\r\n');
  const tail = /\r?\n$/.exec(raw);
  return tail ? out + tail[0] : out;
}

// Убрать записи скрепки из ~/.claude/settings.json.
//
// БЕЗОПАСНОСТЬ. settings.json — весь конфиг человека, и он лежит внутри защищённого ~/.claude,
// куда checkTarget не пускает НИЧЕГО (и правильно: там нельзя удалять). Поэтому здесь свой
// узкий допуск, как у removeProfileLine с rc-файлами: ровно один разрешённый путь, ссылки в
// цепочке запрещены, JSON валидируется до и после, а число записей сверяется (снято ровно
// столько, сколько признано скрепочными, чужие все на месте), запись атомарная.
function removeMascotHooks(settingsFile, port, opts, dry) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return res('failed', 'ЗАЩИТА: некорректный порт');
  const home = path.resolve(opts.home);
  const allowed = path.join(home, '.claude', 'settings.json');
  if (!pathEq(allowed, settingsFile, opts.platform)) {
    return res('failed', 'ЗАЩИТА: правка хуков разрешена только для ~/.claude/settings.json, получено: ' + settingsFile);
  }
  // checkTarget здесь НЕ применим целиком (он защищает весь ~/.claude от удаления, а мы правим
  // файл ВНУТРИ него), но ссылку проверить обязаны: писать в файл, на который кто-то подложил
  // ссылку, нельзя. Проверяем ВСЮ ЦЕПОЧКУ, а не только сам файл: если `~/.claude` — junction или
  // symlink, lstat самого файла видит обычный файл, а запись уходит ПО ТУ СТОРОНУ ссылки. На
  // Windows junction создаётся без прав администратора, и перенос профиля junction-ом — обычная
  // практика при маленьком системном диске.
  const chain = symlinkFreeChain(settingsFile);
  if (!chain.ok) {
    if (chain.absent) return res('absent', 'settings.json нет — править нечего');
    return res('failed', 'ЗАЩИТА: ' + chain.error);
  }
  if (!chain.isFile) return res('failed', 'ЗАЩИТА: settings.json — не обычный файл');

  let raw;
  try { raw = fs.readFileSync(settingsFile, 'utf8'); }
  catch (e) { return res('failed', 'чтение settings.json: ' + ((e && e.code) || e)); }
  // Быстрый выход: нашего адреса в тексте нет вообще — файл не разбираем (и сломанный чужой
  // конфиг без нашего адреса не превращается в «отказ»).
  if (raw.indexOf(':' + port + '/hook') === -1) return res('absent', 'хуков скрепки в настройках нет');
  // Битый JSON не трогаем вовсе: чинить чужой сломанный конфиг — не наша работа, а испортить его
  // сильнее — легко.
  let settings;
  try { settings = JSON.parse(raw); }
  catch (e) { return res('failed', 'settings.json не парсится как JSON — не трогаю'); }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return res('failed', 'settings.json — не JSON-объект, не трогаю');
  }
  const entriesBefore = countHookEntries(settings);
  const st = stripMascotHooks(settings, port);
  if (st.removed === 0) return res('absent', 'хуков скрепки в настройках нет');
  // Страховка от ошибки в самом отборе: чужие записи обязаны остаться все до одной.
  if (countHookEntries(settings) !== entriesBefore - st.removed || countMascotHooks(settings, port) !== 0) {
    return res('failed', 'ЗАЩИТА: число записей не сошлось после снятия — файл не тронут');
  }
  const next = serializeLikeOriginal(raw, settings);
  try { JSON.parse(next); }
  catch (e) { return res('failed', 'после снятия JSON стал невалидным — откат, файл не тронут'); }
  const summary = 'записей хуков скрепки: ' + st.removed +
    (st.eventsDropped.length ? ', опустевших событий убрано: ' + st.eventsDropped.length : '');
  if (dry) return res('removed', '[dry-run] WOULD убрать ' + summary);
  // Файл могли изменить, пока мы работали (его пишет и сам Claude Code, и скрепка): чужую свежую
  // правку не затираем. Оставшийся зазор до rename — один системный вызов.
  try {
    if (fs.readFileSync(settingsFile, 'utf8') !== raw) {
      return res('failed', 'settings.json изменился во время удаления (его пишет другой процесс) — не трогаю, повтори');
    }
  } catch (e) { return res('failed', 'повторное чтение settings.json: ' + ((e && e.code) || e)); }
  try {
    atomicReplaceContent(settingsFile, next);
    return res('removed', 'убрано ' + summary + '; чужие хуки и остальные настройки не тронуты');
  } catch (e) {
    return res('failed', 'перезапись settings.json не удалась: ' + String((e && e.message) || e));
  }
}

// Наша ли запись автозапуска в HKCU\...\Run: значение — путь РОВНО к нашему exe (кавычки и
// пробелы по краям не в счёт, регистр тоже). Та же логика, что у Test-HmMascotRunValueOurs в
// scripts/windows/_mascot.ps1: установка и удаление обязаны считать «своё» одинаково.
function runValueIsOurs(value, exePath) {
  if (typeof value !== 'string' || typeof exePath !== 'string') return false;
  const v = value.trim().replace(/^"+|"+$/g, '').trim();
  const e = exePath.trim();
  if (!v || !e) return false;
  return v.toUpperCase() === e.toUpperCase();
}

// Удалить файл «по возможности»: отказ защиты или сбой — не провал удаления компонента.
// Нужен для ярлыка в меню «Пуск»: он лежит в AppData\Roaming, а профиль, где эта папка за
// junction, установка обходит молча (ярлыка там нет), и обязательная цель превращала бы каждое
// «Удалить» в «НЕ завершена» из-за файла, которого нет и которого мы не создавали.
function removeFileBestEffort(p, opts, dry) {
  const r = removeFile(p, opts, dry);
  if (r.status === 'failed') return res('kept', 'не критично, оставлен: ' + r.message);
  return r;
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

// Классификатор `reg query` (classifyRegQuery + REG_NOTFOUND_RE/REG_DENIED_RE) удалён:
// main.js читает реестр САМ (.NET Registry через winPsPayload, base64 — см. там же
// P1-7), парсить вывод reg.exe больше никому не нужно. Tri-state контракт regQuery
// ({ ok, found, type, data } | { ok:false, error }) живёт у вызывающего
// verifyPostconditions — helpers.regQuery подаётся снаружи.

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
            // bestEffort (ярлык в меню «Пуск»): остаться на месте ему законно — см. removeFileBestEffort.
            if (t.bestEffort) break;
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
          if (q.found) {
            // onlyIfValueIs: значение с чужим содержимым мы намеренно не трогали — оно законно осталось.
            if (t.onlyIfValueIs && !runValueIsOurs(q.data, t.onlyIfValueIs)) break;
            problems.push('значение реестра осталось: ' + t.key + ' → ' + t.value);
          }
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
        case 'hookentries': {
          // План удаления скрепки НАЧИНАЕТСЯ с этой цели (uninstall-targets.js), а пост-проверка её
          // раньше не знала и роняла в default — то есть КАЖДОЕ удаление скрепки рапортовало
          // «неизвестный тип цели», даже когда всё прошло. Человек видит проблему там, где её нет,
          // и перестаёт верить отчёту вообще.
          //
          // Проверяем то, ради чего цель существует: записей скрепки в файле больше нет.
          // Отсутствие файла — тоже успех: править нечего.
          let text = null;
          try { text = fs.readFileSync(t.file, 'utf8'); } catch (e) {
            if (!e || e.code !== 'ENOENT') {
              problems.push('пост-проверка hookentries: ' + t.file + ' не прочитан (' + ((e && e.code) || e) + ')');
            }
          }
          if (text !== null) {
            let parsed = null;
            try { parsed = JSON.parse(text); } catch (e) { parsed = null; }
            if (parsed !== null) {
              if (countMascotHooks(parsed, t.port) > 0) problems.push('хуки скрепки остались в ' + t.file);
            } else if (text.indexOf(':' + t.port + '/hook') !== -1) {
              // Файл не разобрать, а наш адрес в нём есть: убрать записи мы не могли — не молчим.
              problems.push('settings.json не разобрать, хуки скрепки могли остаться в ' + t.file);
            }
          }
          break;
        }
        default:
          problems.push('неизвестный тип цели в пост-проверке: ' + String(t && t.type));
      }
    } catch (e) {
      problems.push('пост-проверка ' + String(t && t.type) + ': ' + String((e && e.message) || e));
    }
  }
  return { ok: problems.length === 0, problems };
}

// A27: Резервное копирование секретов и базы чатов перед удалением ~/.claude.
// Не следует по симлинкам/junction; при любой ошибке чтения/записи возвращает ok:false,
// чтобы вызывающий остановил удаление ~/.claude (fail-closed).
function copyTreeNoFollow(srcDir, dstDir) {
  fs.mkdirSync(dstDir, { recursive: true });
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const e of entries) {
    const sp = path.join(srcDir, e.name);
    const dp = path.join(dstDir, e.name);
    const st = fs.lstatSync(sp);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      copyTreeNoFollow(sp, dp);
    } else if (st.isFile()) {
      fs.copyFileSync(sp, dp);
    }
  }
}

function backupClaudeSecrets(home, backupTargets, backupDir) {
  try {
    if (!home || !backupDir) return { ok: false, error: 'не задан каталог резервной копии' };
    const homeNorm = path.resolve(home);
    const dstNorm = path.resolve(backupDir);
    if (!symlinkFreeChain(dstNorm, homeNorm)) {
      return { ok: false, error: 'цепочка пути резервной копии содержит ссылку: ' + dstNorm };
    }
    const copied = [];
    for (const srcRaw of (backupTargets || [])) {
      if (!srcRaw) continue;
      const srcNorm = path.resolve(srcRaw);
      let st = null;
      try { st = fs.lstatSync(srcNorm); }
      catch (e) {
        if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) continue;
        return { ok: false, error: 'lstat(' + srcNorm + '): ' + ((e && e.code) || e) };
      }
      if (!st || st.isSymbolicLink()) continue;
      if (!symlinkFreeChain(srcNorm, homeNorm)) {
        return { ok: false, error: 'источник резервной копии за ссылкой: ' + srcNorm };
      }
      fs.mkdirSync(dstNorm, { recursive: true });
      const isRootClaudeMd = path.dirname(srcNorm) === homeNorm && path.basename(srcNorm).toLowerCase() === 'claude.md';
      const relName = isRootClaudeMd ? 'home-CLAUDE.md' : path.basename(srcNorm);
      const targetPath = path.join(dstNorm, relName);
      if (st.isDirectory()) {
        copyTreeNoFollow(srcNorm, targetPath);
        copied.push(targetPath);
      } else if (st.isFile()) {
        fs.copyFileSync(srcNorm, targetPath);
        copied.push(targetPath);
      }
    }
    return { ok: true, backupDir: dstNorm, copied };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

module.exports = {
  protectedRoots, checkTarget, valueHygieneOk, pathEq, isInside,
  removeFile, removeEmptyDir, removeDirTree, removeProfileLine,
  removeFileGated, removeDirTreeGated, anyOwnerMarker,
  allowedRcFiles, computeUserPathWithout,
  classifyLaunchctlPrint, launchctlRemoveError, removeMascotHooks, removeFileBestEffort,
  isMascotHookUrl, stripMascotHooks, countMascotHooks, runValueIsOurs,
  verifyPostconditions,
  backupClaudeSecrets,
  renameWithRetry // экспортируется РАДИ ТЕСТА: без него ретрай возврата из карантина
                  // проверяется только «повезло/не повезло» на живой ФС, то есть никак
};

