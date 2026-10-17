'use strict';

// Проход по цепочке пути перед записью из-под АДМИНИСТРАТОРА: ссылка на пути = отказ.
//
// ЗАЧЕМ. Установщик на Windows работает с токеном администратора и пишет файлы фиксированных имён в
// каталоги профиля пользователя: ~/.claude/settings.json (прокси), ~/.claude/.credentials.master.env (ключи),
// config.yaml агента, ~/.hamidun-setup/installed.json, receipts\<id>.json, install.log. Профиль доступен на
// запись любой программе того же пользователя, и junction (mklink /J) создаётся без прав администратора.
// Если ~/.claude (или любой каталог выше файла) подменён junction-ом на чужой каталог, путь продолжает «работать»:
// lstat самого файла видит обычный файл, mkdir молча идёт дальше, а запись и переименование приходятся на ту
// сторону — в каталог, куда пользователю писать нельзя, а администратору можно (профиль другой учётной записи).
// Проверено на Electron 44.5.1: writeProxyEnv() при home\.claude -> <чужой каталог> изменил <чужой>\settings.json и
// создал рядом копию. Тот же путь-ориентированный приём стоял в manifest/receipts/ключах/агенте/журнале.
//
// ЧТО ДЕЛАЕТ. Каждый компонент пути СТРОГО НИЖЕ корня (anchor — профиль, взятый по токену процесса, см.
// src/profile-env.js) обязан существовать как обычная папка (или не существовать вовсе — тогда его создаст
// сам писатель, и проверка повторяется после создания). Ссылка (symlink/junction) и не-папка в середине пути —
// отказ. Последний компонент (файл), если он есть, тоже не может быть ссылкой: чтение через неё вынесло бы
// содержимое чужого файла в наш. Сам корень НЕ проверяется: это доверенная опора (по токену), и профиль,
// перенесённый junction-ом на другой диск, — законная настройка.
//
// ЛОВУШКА libuv, из-за которой одного lstat мало (рецензия безопасности, раунд 2). Junction вида
// `mklink /J ссылка \\?\Volume{guid}\каталог` (точка монтирования с целью-томом; создаётся без прав
// администратора, как и обычная) libuv ссылкой НЕ считает: lstat не может разобрать цель, повторяет вызов как
// stat — ПО ссылке — и отдаёт статистику самой цели (isDirectory() истинно, isSymbolicLink() ложно). Проверка
// «не ссылка» по одному lstat пропустила бы её, и mkdir, копия и rename ушли бы в чужой каталог — ровно тот путь F16,
// который модуль закрывает. Поэтому у каждого каталога, который lstat считает обычным, сверяется КАНОНИЧЕСКОЕ
// имя (fs.realpathSync.native = GetFinalPathNameByHandle): оно обязано совпасть с каноническим именем родителя
// плюс имя компонента (регистр не важен). Расхождение — перенаправление, отказ с причиной 'link'. Отсчёт идёт от
// канонического имени КОРНЯ, поэтому корень по-прежнему может быть ссылкой, а короткие имена 8.3 и регистр в самом
// корне ни на что не влияют. Тот же приём — в src/fs-compat.js (classify) и в checkTarget (uninstall-exec.js).
// Сверка не зависит от того, КАК записана цель junction-а (том, GLOBALROOT, диск): сравнивается итоговое имя.
// Цена: компонент НИЖЕ корня, написанный не в каноническом виде (короткое имя 8.3, хвостовая точка или пробел), выглядит как
// перенаправление и отклоняется — тот же fail-closed, что у checkTarget. Писатели берут пути из фиксированных имён и профиля
// по токену, поэтому в жизни это не встречается; сам корень (и 8.3, и регистр в нём) на сверку не влияет.
//
// ГДЕ ДЕЙСТВУЕТ. Только Windows. На macOS/Linux главный процесс установщика не повышен (root появляется только
// внутри admin_run и там окружение стерто), границы привилегий нет, а ~/.claude как ссылка на каталог с
// dotfiles — обычная раскладка разработчиков: отказ там ломал бы законную настройку, ничего не защищая.
//
// ЧЕГО ЭТО НЕ ЗАКРЫВАЕТ (принято). (1) Окно между проверкой и использованием: писатели повторяют проверку после
// создания каталогов и сразу после создания временного файла — подмена после этого уже не может увести
// переименование (временный файл остался по эту сторону ссылки), но нет открытия «без перехода по ссылкам» на
// уровне ОС (Node не даёт openat/O_NOFOLLOW для каталогов). (2) Точки повторной обработки, чьё каноническое имя
// совпадает с обычным (облачные заглушки OneDrive и т.п.): это законные папки профиля, они не перенаправляют;
// перенаправляющие (junction на путь тома) ловит сверка канонических имён. (3) Жёсткие ссылки на сам файл: запись
// идёт через временный файл и rename, прежний файл не открывается на запись. (4) Висячая junction на путь тома (цель
// удалена): lstat отдаёт ENOENT, как для отсутствующего компонента, и проверка её пропускает; писатель упирается в
// mkdir (ENOENT) и ничего не создаёт и не пишет (проверено, тест «висячая junction»). Если цель появится ровно между
// stat и mkdir, перепроверка после mkdir отказывает до записи любого файла.

const fs = require('fs');
const path = require('path');

/** Каноническое имя пути (на Windows — GetFinalPathNameByHandle). Бросает при любой неудаче, в том числе когда
 *  `realpathSync.native` нет вовсе: вызывающие ловят это и отказывают (fail-closed), а не пропускают.
 *  Без `|| fs.realpathSync`: JS-вариант идёт по lstat и ту самую junction на путь тома не видит. */
function canonicalOf(p) { return fs.realpathSync.native(p); }

/** Одно и то же имя? Windows регистр в именах не различает. */
function sameName(a, b) { return a.toLowerCase() === b.toLowerCase(); }

/** Путь и ВСЕ его существующие предки (до корня ФС) — без symlink и junction.
 *
 *  Вынесено из uninstall-exec.js: нужно двум разным операциям с разными целями —
 *  `checkTarget` защищает от УДАЛЕНИЯ не того каталога, `removeMascotHooks` — от ЗАПИСИ не в тот файл.
 *  Проверка одна и та же, и держать её в двух копиях значит однажды починить одну из них.
 *
 *  Возвращает {ok:false, absent:true}, когда цели просто нет: это не отказ защиты, а «править нечего»,
 *  и звать это ошибкой было бы враньём. Любая другая ошибка lstat — отказ (fail-closed): не смогли
 *  убедиться, что ссылки нет, значит считаем, что она есть.
 *
 *  На Windows существующая цель дополнительно проходит сверку канонического имени (ловушка libuv в заголовке:
 *  junction на путь тома lstat не отличает от обычного каталога). Здесь корня-опоры нет, поэтому сверяется
 *  весь путь целиком, как в checkTarget (uninstall-exec.js): каноническое имя обязано равняться заявленному.
 */
function symlinkFreeChain(target) {
  const norm = path.resolve(String(target || ''));
  if (!norm) return { ok: false, error: 'пустой путь' };
  let self = null;
  let cur = norm;
  let prev = '';
  while (cur && cur !== prev) {
    let st = null;
    try {
      st = fs.lstatSync(cur);
    } catch (e) {
      const code = e && e.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        if (cur === norm) return { ok: false, absent: true };
      } else {
        return { ok: false, error: 'lstat(' + cur + '): ' + (code || e) };
      }
    }
    if (st) {
      if (st.isSymbolicLink()) return { ok: false, error: 'symlink/junction в цепочке: ' + cur };
      if (cur === norm) self = st;
    }
    prev = cur;
    cur = path.dirname(cur);
  }
  if (!self) return { ok: false, absent: true };
  if (enforced()) {
    let real;
    try { real = canonicalOf(norm); }
    catch (e) { return { ok: false, error: 'канонизация не удалась (' + ((e && e.code) || e) + '): ' + norm }; }
    if (!sameName(real, norm)) {
      return { ok: false, error: 'перенаправление в цепочке (junction на путь тома?): ' + norm + ' ведёт в ' + real };
    }
  }
  return { ok: true, isFile: self.isFile() };
}

/** Защита включена на этой платформе? Только Windows (почему — в заголовке). */
function enforced(platform) { return (platform || process.platform) === 'win32'; }

/**
 * Проверить цепочку от корня anchor вниз до target (включительно).
 * @param {string} target  файл (или каталог), в который собираются писать
 * @param {string} anchor  доверенный корень: профиль по токену; target обязан лежать СТРОГО внутри него
 * @param {{platform?: string}} [opts]
 * @returns {{ok: true, skipped?: true} |
 *           {ok: false, reason: 'outside-anchor'|'link'|'not-dir'|'lstat-failed', at?: string, error?: string}}
 *   at — компонент пути, на котором остановились (для сообщения человеку и журнала).
 */
function checkChain(target, anchor, opts) {
  const o = opts || {};
  if (!enforced(o.platform)) return { ok: true, skipped: true };
  const a = path.resolve(String(anchor || ''));
  const t = path.resolve(String(target || ''));
  if (!anchor || !target) return { ok: false, reason: 'outside-anchor', at: t };
  const rel = path.relative(a, t);
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
    return { ok: false, reason: 'outside-anchor', at: t };
  }
  const parts = rel.split(path.sep).filter(Boolean);
  let cur = a;
  let curReal = null;   // каноническое имя уже проверенного родителя; для первого каталога — каноническое имя корня
  for (let i = 0; i < parts.length; i++) {
    cur = path.join(cur, parts[i]);
    const last = i === parts.length - 1;
    let st;
    try {
      st = fs.lstatSync(cur);
    } catch (e) {
      const code = e && e.code;
      // Нет компонента — нет и всего, что ниже: писатель создаст каталоги сам и проверит цепочку ещё раз.
      if (code === 'ENOENT') return { ok: true };
      if (code === 'ENOTDIR') return { ok: false, reason: 'not-dir', at: cur };
      return { ok: false, reason: 'lstat-failed', at: cur, error: code || String(e) };
    }
    if (st.isSymbolicLink()) return { ok: false, reason: 'link', at: cur };   // обычные symlink и junction (Node видит оба)
    if (!last && !st.isDirectory()) return { ok: false, reason: 'not-dir', at: cur };
    if (st.isDirectory()) {
      // lstat «обычного каталога» ничего не гарантирует (ловушка libuv в заголовке): junction на путь тома (\\?\Volume{guid}\…)
      // выглядит как каталог. Каноническое имя обязано равняться «канонический родитель + имя»; иначе это перенаправление.
      let real;
      try {
        if (curReal === null) curReal = canonicalOf(a);
        real = canonicalOf(cur);
      } catch (e) {
        return { ok: false, reason: 'lstat-failed', at: cur, error: (e && e.code) || String(e) };
      }
      if (!sameName(real, path.join(curReal, parts[i]))) return { ok: false, reason: 'link', at: cur };
      curReal = real;
    }
  }
  return { ok: true };
}

/** Текст отказа для человека и журнала (один и тот же вид для всех писателей). */
function describe(r, what) {
  const subj = what ? what : 'файлу';
  if (!r || r.ok) return '';
  switch (r.reason) {
    case 'link':
      return 'путь к ' + subj + ' проходит через ссылку (junction или symlink) «' + r.at + '» — писать через неё нельзя, ничего не изменено';
    case 'not-dir':
      return 'на пути к ' + subj + ' «' + r.at + '» не папка — ничего не изменено';
    case 'outside-anchor':
      return 'путь «' + r.at + '» лежит вне профиля — писать туда установщик не будет';
    default:
      return 'не удалось проверить путь к ' + subj + ' («' + r.at + '», ' + (r.error || 'ошибка') + ') — ничего не изменено';
  }
}

/** То же, что checkChain, но бросает Error с code 'EHMLINK' (message — по-русски, начинается с «ЗАЩИТА:»). */
function assertNoLinkInChain(target, anchor, opts, what) {
  const r = checkChain(target, anchor, opts);
  if (!r.ok) {
    const e = new Error('ЗАЩИТА: ' + describe(r, what));
    e.code = 'EHMLINK';
    e.detail = r;
    throw e;
  }
  return r;
}

/** Булев вариант: цепочка чистая? */
function isLinkFree(target, anchor, opts) { return checkChain(target, anchor, opts).ok === true; }

module.exports = { symlinkFreeChain, checkChain, assertNoLinkInChain, isLinkFree, describe, enforced };
