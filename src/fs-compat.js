'use strict';
/**
 * fs-compat.js — обход двух багов рантайма Electron 40+ на Windows. Оба сидят в `fs.rmSync`.
 *
 * ОТКУДА. Начиная с Electron 40 (Node 24) `rmSync` реализован в C++ поверх
 * `std::filesystem::remove*`, а Electron собирает Node с libc++, который — в отличие от
 * MSVC STL — ведёт себя иначе. В Electron 32 (Node 20) и в системном Node 22 этих багов нет,
 * поэтому юнит-тесты, идущие под обычным Node, их НЕ ВИДЯТ: гонять надо настоящий рантайм.
 *
 * БАГ 1. READ-ONLY. libc++ перед удалением атрибут «только чтение» не снимает, и `rmSync`
 * падает с EPERM на файле (и на каталоге, где он лежит), у которого этот атрибут стоит
 * (electron/electron#52253, nodejs/node#64374). Бэкпорт «исправления» (electron#54255, значится
 * в заметках 44.5.0) на деле не срабатывает: проверено запуском на 44.5.1 и 44.7.0 (Windows 11,
 * Node 24.21.0) — `rmSync` по-прежнему бросает EPERM, тогда как `unlinkSync` и `fs.promises.rm`
 * работают. Бьёт по установщику так: `rmStagingTree` принимает EPERM за гонку, пять раз
 * повторяет и возвращает false — Admins-only каталог остаётся в %ProgramData%; снос карантина
 * при удалении компонента рапортует «не удалось удалить дерево: EPERM»; переустановка
 * remote-компонента не может убрать прежний finalDir. Read-only файлы в таких деревьях возможны
 * (git-пачки в .git/objects, распаковка архивов, собранных на Unix).
 *
 * БАГ 2. JUNCTION. Рекурсивный `rmSync` заходит по junction (точке монтирования, `mklink /J`)
 * внутрь и стирает содержимое ЧУЖОЙ цели; то же — если junction стоит прямо в корне сноса, и то же
 * для junction вида `\\?\Volume{guid}\…`. Причина, по-видимому, в том, что std::filesystem на
 * Windows считает ссылкой только символическую ссылку, а junction — обычным каталогом; но проверено
 * именно ПОВЕДЕНИЕ, не устройство libc++: на 44.5.1 голый `rmSync(recursive)` над деревом с
 * вложенной junction удаляет файлы цели, в системном Node 22 цель цела. Установщик работает ПОД
 * АДМИНОМ, а junction создаётся без прав: любой процесс того же пользователя подкладывает её в
 * дерево, которое человек потом сносит кнопкой «Удалить» (папка Скрепки в %LOCALAPPDATA%\Programs,
 * каталоги курса), — и содержимое чужого каталога, куда у пользователя доступа нет, стирается с
 * правами администратора.
 *
 * ЧТО ДЕЛАЕМ.
 *  - `removeTreeNoFollow` — свой снос дерева, который не идёт по ссылкам НИКОГДА (описание ниже).
 *    Прямые вызовы — в src/uninstall-exec.js (удаление компонентов) на ВСЕХ платформах: один путь
 *    кода — один набор тестов.
 *  - `install()` на Windows оборачивает `fs.rmSync` ОДИН раз при старте main-процесса: вызовы с
 *    `recursive: true` уходят в `removeTreeNoFollow`, а не в C++; остальные идут в рантайм, и на EPERM
 *    по read-only обёртка снимает атрибут и повторяет РОВНО раз. Так остальные места src/ (кэш
 *    докачки, staging) защищены без правки каждого вызова. На macOS `install()` ничего не меняет.
 *  Убрать модуль можно, когда Electron реально починит `rmSync` (проверка — тесты в test/run-tests.js,
 *  они гоняют настоящий рантайм и держат «контроль»: голый `rmSync` обязан показывать баг, иначе
 *  человек пересматривает модуль осознанно, а не обнаруживает это случайно).
 *
 * КАК removeTreeNoFollow НЕ ХОДИТ ПО ССЫЛКАМ. Обход через lstat, каждый элемент перепроверяется
 * lstat непосредственно перед действием. Симлинк и junction снимаются КАК ССЫЛКИ — `unlink`, а при
 * отказе `rmdir`: ни тот, ни другой не рекурсивны, и ни один не заходит внутрь (проверено на 44.5.1
 * и 22.15). Ссылка в самом корне сноса тоже снимается как ссылка.
 *
 * ЛОВУШКА libuv, из-за которой одного `lstat` мало. Junction вида `mklink /J x \\?\Volume{guid}\dir`
 * (точка монтирования с целью-томом) libuv ссылкой НЕ считает: при `lstat` он не может разобрать
 * цель, повторяет вызов как `stat` (по ссылке!) и отдаёт статистику самой ЦЕЛИ — `isDirectory()`
 * истинно, `isSymbolicLink()` ложно, `readlink` даёт EINVAL, а `readdir` идёт насквозь. Создаётся
 * без прав. Поэтому на Windows каталог, который lstat считает обычным, пускаем внутрь только если его
 * КАНОНИЧЕСКИЙ путь (GetFinalPathNameByHandle через `realpathSync.native`) равен каноническому пути
 * родителя + имя. Любое расхождение — перенаправление, и каталог снимается как ссылка (`rmdir`
 * нерекурсивен: настоящий непустой каталог он не удалит, а получит ENOTEMPTY). Висячая такая junction
 * даёт lstat=ENOENT при живой записи в readdir — её тоже пробуем снять `rmdir`.
 *
 * ЧТО НЕ ЗАКРЫВАЕТСЯ (честно). Обход идёт по ПУТЯМ, а у Node нет ни `openat`, ни открытия каталога
 * без перехода по ссылке: между проверкой каталога и операцией внутри него остаётся окно. Сужаем его
 * как можем — перед КАЖДЫМ удалением внутри каталога сверяем, что по этому пути по-прежнему лежит тот
 * же каталог (lstat: не ссылка, тот же inode) — и при расхождении бросаем ERR_HM_TREE_CHANGED, ничего
 * не тронув. Но выиграть окно в микросекунды процесс того же пользователя с хорошо рассчитанной
 * подменой теоретически может; полностью это закрывает только удаление по дескриптору (нативный код)
 * либо удаление без прав администратора. Предки корня сноса не проверяются: это забота вызывающего
 * (в uninstall-exec их сверяет checkTarget).
 */
const fs = require('fs');
const path = require('path');

// Сносить надо «настоящим» fs. Внутри Electron модуль `fs` подменён ради .asar: путь с компонентом
// `*.asar` для него — виртуальный КАТАЛОГ (lstat отдаёт выдуманные stat'ы с растущим inode, readdir
// перечисляет содержимое архива, битый архив бросает «Invalid package»), а первое же обращение
// открывает архив и держит его до конца процесса — файл потом не удалить (EBUSY). В деревьях, которые
// мы сносим, .asar бывают (node_modules.asar у VS Code/Cursor, app.asar у приложений). Рантайм-rmSync
// архивов не касался, и обход через подменённый fs стал бы регрессией. original-fs — fs без подмены;
// в обычном Node его нет, там берём сам fs.
let rawFs = fs;
try { rawFs = require('original-fs'); } catch (e) { /* не Electron */ }

// ---- общие мелочи -----------------------------------------------------------------------------

// Те же коды, что у `fs.rmSync(maxRetries)` по документации Node: «занято прямо сейчас».
const RETRY_CODES = new Set(['EBUSY', 'EMFILE', 'ENFILE', 'ENOTEMPTY', 'EPERM']);

// Синхронная пауза: снос идёт из синхронных участков main-процесса (закрытие окна, обработчик
// «Удалить»), где отдать управление циклу событий нельзя.
function sleepSync(ms) {
  if (!(ms > 0)) return;
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch (e) { const t = Date.now() + ms; while (Date.now() < t) { /* SharedArrayBuffer запрещён — крутимся */ } }
}

function fsError(code, syscall, p, text) {
  const e = new Error(code + ': ' + text + ", " + syscall + " '" + p + "'");
  e.code = code; e.syscall = syscall; e.path = p;
  return e;
}

// Каталог по пути оказался другим (подмена ссылкой/junction/другим каталогом) — ничего не трогаем.
function changedError(p) {
  const e = new Error('ERR_HM_TREE_CHANGED: каталог подменён во время сноса (ссылка, junction или другой каталог), ничего не тронуто: ' + p);
  e.code = 'ERR_HM_TREE_CHANGED'; e.path = p;
  return e;
}

// Путь как строка: rmSync принимает string | Buffer | URL.
function pathArg(p) {
  let s = p;
  if (Buffer.isBuffer(p)) s = p.toString('utf8');
  else if (p && typeof p === 'object' && typeof p.href === 'string' && p.protocol === 'file:') s = require('url').fileURLToPath(p);
  if (typeof s !== 'string') {
    const e = new TypeError('The "path" argument must be of type string or an instance of Buffer or URL.');
    e.code = 'ERR_INVALID_ARG_TYPE';
    throw e;
  }
  // Пустая строка через path.resolve превратилась бы в ТЕКУЩИЙ каталог процесса.
  if (!s || s.indexOf('\u0000') !== -1) {
    const e = new TypeError("The argument 'path' must be a non-empty string without null bytes.");
    e.code = 'ERR_INVALID_ARG_VALUE';
    throw e;
  }
  return s;
}

// ---- контекст обхода ---------------------------------------------------------------------------

/**
 * opts: fs (подставная ФС для тестов), platform, canonicalGate (сверка канонических путей каталогов;
 * по умолчанию включена на Windows), force, maxRetries, retryDelay, sleep, onLink(path),
 * onReadOnly(path).
 */
function makeCtx(opts) {
  const o = opts || {};
  const f = o.fs || rawFs;
  const platform = o.platform || process.platform;
  const win = platform === 'win32';
  const gate = o.canonicalGate === undefined ? win : !!o.canonicalGate;
  const rp = f.realpathSync && (f.realpathSync.native || f.realpathSync);
  if (gate && typeof rp !== 'function') {
    // Без сверки junction «через том» проходит как обычный каталог — молча без неё работать нельзя.
    throw new TypeError('fs-compat: для сверки канонических путей нужна fs.realpathSync');
  }
  return {
    f, gate, rp,
    ci: win || platform === 'darwin',                       // регистр имён в пути не различается
    force: !!o.force,
    maxRetries: Number.isInteger(o.maxRetries) && o.maxRetries > 0 ? o.maxRetries : 0,
    retryDelay: Number.isFinite(o.retryDelay) && o.retryDelay >= 0 ? o.retryDelay : 100,
    sleep: typeof o.sleep === 'function' ? o.sleep : sleepSync,
    onLink: typeof o.onLink === 'function' ? o.onLink : null,
    onReadOnly: typeof o.onReadOnly === 'function' ? o.onReadOnly : null,
    cleared: 0,                                             // счётчик для clearReadOnlyTree
  };
}

// Линейный backoff, как у `fs.rmSync(maxRetries, retryDelay)`; прочие коды — сразу наружу.
function withRetry(ctx, fn) {
  for (let attempt = 0; ; attempt++) {
    try { return fn(); }
    catch (e) {
      if (attempt >= ctx.maxRetries || !e || !RETRY_CODES.has(e.code)) throw e;
      ctx.sleep(ctx.retryDelay * (attempt + 1));
    }
  }
}

// lstat с BigInt: inode на NTFS — 64 бита, в Number он теряет младшие разряды выше 2^53, и два соседних
// объекта (каталог и подложенная рядом junction) могли бы сойтись за один.
function lstatOf(ctx, p) { return ctx.f.lstatSync(p, { bigint: true }); }

// Личность объекта: inode (+ том, когда он известен; libuv иногда отдаёт dev=0 — такое не сравниваем).
function idOf(st) {
  const ino = st && st.ino;
  if (!ino) return null;                                    // нет inode (подставная ФС, экзотика) — сверять нечем
  return { ino: String(ino), dev: st.dev ? String(st.dev) : '' };
}
function sameId(a, b) {
  if (!a || !b) return true;
  if (a.ino !== b.ino) return false;
  return !(a.dev && b.dev && a.dev !== b.dev);
}
function sameName(ctx, a, b) {
  return a === b || (ctx.ci && a.toLowerCase() === b.toLowerCase());
}

/**
 * Что лежит по пути p в каталоге с каноническим путём parentReal под именем name.
 * → { kind: 'absent' } | { kind: 'link' } | { kind: 'file', st } | { kind: 'dir', st, real, id }
 */
function classify(ctx, p, parentReal, name) {
  let st;
  try { st = lstatOf(ctx, p); }
  catch (e) { if (e && e.code === 'ENOENT') return { kind: 'absent' }; throw e; }
  if (st.isSymbolicLink()) return { kind: 'link' };
  if (!st.isDirectory()) return { kind: 'file', st };
  let real = p;
  if (ctx.gate) {
    try { real = ctx.rp(p); }
    catch (e) { if (e && e.code === 'ENOENT') return { kind: 'absent' }; throw e; }
    // lstat «обычного каталога» ничего не гарантирует (см. «ловушку libuv» в шапке): каноническое
    // имя обязано совпасть с родитель + имя, иначе это перенаправление.
    if (!sameName(ctx, real, path.join(parentReal, name))) return { kind: 'link' };
    let st2;
    try { st2 = lstatOf(ctx, p); }
    catch (e) { if (e && e.code === 'ENOENT') return { kind: 'absent' }; throw e; }
    // между первым lstat и сверкой пути объект успели подменить
    if (st2.isSymbolicLink() || !st2.isDirectory() || !sameId(idOf(st), idOf(st2))) throw changedError(p);
    st = st2;
  }
  return { kind: 'dir', st, real, id: idOf(st) };
}

/**
 * Перед каждой операцией ВНУТРИ каталога fr: по его пути по-прежнему тот же каталог (не ссылка, тот
 * же inode). Работает и для junction «через том»: lstat такой ссылки отдаёт статистику цели, а у цели
 * другой inode. false — каталога больше нет (его сняли без нас), тогда остаток кадра пропускаем.
 */
function fenceOk(ctx, fr) {
  let st;
  try { st = lstatOf(ctx, fr.dir); }
  catch (e) { if (e && e.code === 'ENOENT') return false; throw e; }
  if (st.isSymbolicLink() || !st.isDirectory() || !sameId(fr.id, idOf(st))) throw changedError(fr.dir);
  return true;
}

// ---- элементарные операции ---------------------------------------------------------------------

// Снять read-only у ОДНОГО объекта, который только что снова проверили lstat'ом: не ссылка и нужного
// вида. chmod идёт ПО ссылке (и по промежуточной junction в пути), поэтому вызывается только после
// такой проверки и — для объекта внутри каталога fr — после сверки, что fr на месте (ревью безопасности, находка M-7:
// иначе подмена каталога-родителя уводила chmod за пределы сносимого дерева). → true, если сняли.
function clearOneReadOnly(ctx, p, wantDir, fr) {
  if (fr && !fenceOk(ctx, fr)) return false;
  let st;
  try { st = lstatOf(ctx, p); } catch (e) { return false; }
  if (st.isSymbolicLink() || st.isDirectory() !== wantDir) return false;
  const mode = Number(st.mode);
  if (mode & 0o200) return false;                           // запись разрешена — EPERM не про атрибут
  try { ctx.f.chmodSync(p, (mode & 0o7777) | 0o200); } catch (e) { return false; }
  ctx.cleared++;
  if (ctx.onReadOnly) { try { ctx.onReadOnly(p); } catch (e) { /* журнал не должен ломать уборку */ } }
  return true;
}

// Снять ссылку (файловую, каталожную, junction), не трогая цель. unlink снимает файловые ссылки,
// симлинки на каталоги и обычные junction; junction «через том» libuv ему не отдаёт (EPERM) —
// её снимает rmdir. Оба нерекурсивны: настоящий непустой каталог rmdir не удалит (ENOTEMPTY), а unlink
// откажет настоящему каталогу (EPERM) — подмена «ссылка → каталог» не превращается в рекурсию.
function removeLink(ctx, p) {
  withRetry(ctx, () => {
    try { ctx.f.unlinkSync(p); return; }
    catch (e1) {
      if (e1 && e1.code === 'ENOENT') return;
      try { ctx.f.rmdirSync(p); return; }
      catch (e2) {
        // rmdir по файловой ссылке отвечает ENOTDIR (на Windows — даже ENOENT): это не «уже нет»,
        // а «rmdir тут ни при чём», и причина отказа — ошибка unlink.
        if (!e2 || e2.code === 'ENOTDIR' || e2.code === 'ENOENT') throw e1;
        if (e2.code === 'ENOTEMPTY') {
          // Считали ссылкой (канонический путь не совпал или подмена), а внутри есть содержимое:
          // не трогаем. Подпись нужна, чтобы по одной строке журнала было видно, ПОЧЕМУ отказ.
          e2.message += ' [это перенаправление/ссылка, но внутри есть содержимое — не трогаю: ' + p + ']';
        }
        throw e2;
      }
    }
  });
  if (ctx.onLink) { try { ctx.onLink(p); } catch (e) { /* журнал не должен ломать уборку */ } }
}

// fr — каталог, внутри которого лежит p (null для корня сноса).
function removeFile(ctx, p, fr) {
  withRetry(ctx, () => {
    try { ctx.f.unlinkSync(p); return; }
    catch (e) {
      if (e && e.code === 'ENOENT') return;
      // Атрибут read-only: сняли — повторяем РОВНО раз. EPERM не про атрибут (ACL, чужой владелец) —
      // исходная ошибка, ничего не меняли.
      if (e && (e.code === 'EPERM' || e.code === 'EACCES') && clearOneReadOnly(ctx, p, false, fr)) {
        try { ctx.f.unlinkSync(p); } catch (e2) { if (!e2 || e2.code !== 'ENOENT') throw e2; }
        return;
      }
      throw e;
    }
  });
}

function removeDir(ctx, p, fr) {
  withRetry(ctx, () => {
    try { ctx.f.rmdirSync(p); return; }
    catch (e) {
      if (e && e.code === 'ENOENT') return;
      if (e && (e.code === 'EPERM' || e.code === 'EACCES') && clearOneReadOnly(ctx, p, true, fr)) {
        try { ctx.f.rmdirSync(p); } catch (e2) { if (!e2 || e2.code !== 'ENOENT') throw e2; }
        return;
      }
      throw e;
    }
  });
}

// Запись есть в readdir, а lstat говорит ENOENT: так выглядит висячая junction «через том» (libuv
// пробует пройти по ней). Один rmdir: настоящий каталог/файл он не тронет, ссылку снимет.
// → true, если что-то сняли.
function removeDangling(ctx, p) {
  try { ctx.f.rmdirSync(p); } catch (e) { return false; }
  if (ctx.onLink) { try { ctx.onLink(p); } catch (e) { /* журнал не должен ломать уборку */ } }
  return true;
}

// ---- сам обход ---------------------------------------------------------------------------------

function openFrame(ctx, dirPath, info) {
  let names;
  try { names = withRetry(ctx, () => ctx.f.readdirSync(dirPath)); }
  catch (e) {
    if (e && e.code === 'ENOENT') names = [];               // каталог успели снять без нас
    else if (e && e.code === 'ENOTDIR') throw changedError(dirPath);
    else throw e;
  }
  return { dir: dirPath, real: info.real, id: info.id, names, i: 0 };
}

/**
 * Итеративный (не рекурсивный: глубина дерева не упирается в стек) обход в обратном порядке.
 * mode 'remove' — снести; 'clear' — только снять read-only (для обёртки над rmSync).
 */
function walk(ctx, rootPath, mode) {
  const remove = mode === 'remove';
  const parentOfRoot = path.dirname(rootPath);
  if (parentOfRoot === rootPath) throw fsError('EINVAL', 'rm', rootPath, 'нельзя сносить корень файловой системы');

  // Родитель корня — единственное, что берём на веру: его каноническое имя служит точкой отсчёта для
  // сверки самого корня (корень мог оказаться junction «через том»).
  let parentReal = parentOfRoot;
  if (ctx.gate) {
    // нет родителя (или в пути файл вместо каталога) — корня тоже нет, как у rmSync: тихо только с force
    try { parentReal = ctx.rp(parentOfRoot); } catch (e) { if (!e || (e.code !== 'ENOENT' && e.code !== 'ENOTDIR')) throw e; parentReal = null; }
  }
  const info = parentReal === null ? { kind: 'absent' } : classify(ctx, rootPath, parentReal, path.basename(rootPath));

  if (info.kind === 'absent') {
    if (!remove) return;
    if (removeDangling(ctx, rootPath)) return;
    if (ctx.force) return;
    throw fsError('ENOENT', 'rm', rootPath, 'no such file or directory');
  }
  if (info.kind === 'link') { if (remove) removeLink(ctx, rootPath); return; }
  if (info.kind === 'file') {
    if (remove) removeFile(ctx, rootPath); else clearOneReadOnly(ctx, rootPath, false);
    return;
  }

  // Каталог исчез из-под нас (его сняли без нас) → остаток кадра пропускаем. Подмену бросает fenceOk.
  const guard = (fr) => {
    if (fenceOk(ctx, fr)) return true;
    fr.i = fr.names.length; fr.gone = true;
    return false;
  };
  const stack = [openFrame(ctx, rootPath, info)];
  while (stack.length) {
    const fr = stack[stack.length - 1];
    if (fr.i < fr.names.length) {
      const name = fr.names[fr.i++];
      const child = path.join(fr.dir, name);
      const c = classify(ctx, child, fr.real, name);
      if (c.kind === 'dir') { stack.push(openFrame(ctx, child, c)); continue; }
      if (!guard(fr)) continue;
      if (c.kind === 'absent') { if (remove) removeDangling(ctx, child); }
      else if (c.kind === 'link') { if (remove) removeLink(ctx, child); }
      else if (remove) removeFile(ctx, child, fr);
      else clearOneReadOnly(ctx, child, false, fr);
    } else {
      stack.pop();
      if (fr.gone) continue;
      const parent = stack[stack.length - 1];
      if (parent && !guard(parent)) continue;
      if (remove) removeDir(ctx, fr.dir, parent); else clearOneReadOnly(ctx, fr.dir, true, parent);
    }
  }
}

/**
 * Снести дерево (или файл, или ссылку) и НЕ идти по ссылкам. Вызов как у `fs.rmSync(p, { recursive: true,
 * ... })`: `force` — ENOENT корня молчит только с ним; `maxRetries`/`retryDelay` — повторы EBUSY/EPERM/
 * ENOTEMPTY/EMFILE/ENFILE для каждой операции; ошибки сохраняют `.code`. Лишнее для тестов и журнала:
 * `fs`, `platform`, `canonicalGate`, `sleep`, `onLink(path)` (снята ссылка вместо захода в неё),
 * `onReadOnly(path)` (снят атрибут перед удалением).
 */
function removeTreeNoFollow(p, opts) {
  const ctx = makeCtx(opts);
  walk(ctx, path.resolve(pathArg(p)), 'remove');
}

/**
 * Снять read-only у дерева (или одного файла). Возвращает, у скольких объектов сняли.
 * Не бросает: что не вышло — то повторный rmSync и так покажет своей ошибкой. Обход тот же, что у
 * removeTreeNoFollow, — по ссылкам не идёт, и chmod (он ходит ПО ссылке) делается только по объекту,
 * который сразу перед этим проверили lstat'ом в каталоге, не подменённом за время обхода.
 */
function clearReadOnlyTree(p, fsx) {
  let ctx;
  try {
    const f = fsx || rawFs;
    // подставная ФС теста без realpathSync — без сверки путей; боевой вызов (fsx не задан) сверяет
    ctx = makeCtx({ fs: f, canonicalGate: (process.platform === 'win32') && typeof f.realpathSync === 'function' });
    walk(ctx, pathArg(p), 'clear');
  } catch (e) { /* не вышло — rmSync скажет сам */ }
  return ctx ? ctx.cleared : 0;
}

/**
 * Обёртка над rmSync. `opts.fs` — для тестов, `opts.onRetry(path, cleared)` — для журнала (EPERM на
 * read-only, атрибут снят, вызов повторён). `opts.noFollowRecursive` — вызовы с `recursive: true`
 * уходят в removeTreeNoFollow (а не в C++ рантайма); для них `opts.onLink(path)` — внутри дерева
 * нашлась ссылка и снята как ссылка, `opts.onReadOnly(path, cleared)` — атрибут снят перед удалением.
 * Без `noFollowRecursive` (по умолчанию) рекурсивные вызовы идут в рантайм, как раньше.
 */
function wrapRmSync(orig, opts) {
  const o = opts || {};
  const wrapped = function rmSync(p, options) {
    if (o.noFollowRecursive && options && options.recursive) return rmRecursive(p, options, o);
    try {
      return orig.call(this, p, options);
    } catch (e) {
      if (!e || e.code !== 'EPERM' || typeof p !== 'string') throw e;
      const cleared = clearReadOnlyTree(p, o.fs);
      if (!cleared) throw e;                            // не read-only: исходная ошибка, без повторов
      if (typeof o.onRetry === 'function') {
        try { o.onRetry(p, cleared); } catch (e2) { /* журнал не должен ломать уборку */ }
      }
      return orig.call(this, p, options);               // второй отказ — уже не про атрибут
    }
  };
  wrapped.__hmReadOnlyRetry = true;
  if (o.noFollowRecursive) wrapped.__hmNoFollow = true;
  return wrapped;
}

function rmRecursive(p, options, o) {
  const links = [];
  let cleared = 0;
  try {
    removeTreeNoFollow(p, {
      fs: o.fs, force: options.force, maxRetries: options.maxRetries, retryDelay: options.retryDelay,
      onLink: (lp) => { links.push(lp); },
      onReadOnly: () => { cleared++; },
    });
  } finally {
    // По строке на событие, но не больше десяти: дерево с сотней ссылок не должно забивать журнал.
    if (typeof o.onLink === 'function') {
      for (const lp of links.slice(0, 10)) { try { o.onLink(lp); } catch (e) { /* журнал не ломает уборку */ } }
      if (links.length > 10) { try { o.onLink('… и ещё ссылок: ' + (links.length - 10)); } catch (e) { /* ignore */ } }
    }
    // read-only — одной строкой на вызов, как раньше (в .git/objects таких файлов тысячи)
    if (cleared && typeof o.onReadOnly === 'function') { try { o.onReadOnly(String(p), cleared); } catch (e) { /* ignore */ } }
  }
}

/**
 * Включить обход (только Windows, идемпотентно). `log(line)` вызывается, когда обход
 * сработал, — чтобы в install.log осталась строка, а не тихая подмена поведения.
 */
function install(log) {
  if (process.platform !== 'win32') return false;
  if (fs.rmSync && fs.rmSync.__hmReadOnlyRetry) return true;
  const say = (line) => { if (typeof log === 'function') log(line); };
  fs.rmSync = wrapRmSync(fs.rmSync, {
    noFollowRecursive: true,
    onRetry: (p, n) => say('rmSync: EPERM на read-only (рантайм Electron 40+) — атрибут снят (объектов: ' + n + '), повторяю: ' + p),
    onReadOnly: (p, n) => say('rmSync: read-only (рантайм Electron 40+) — атрибут снят перед удалением (объектов: ' + n + '): ' + p),
    onLink: (lp) => say('rmSync: внутри сносимого дерева ссылка/junction — снята сама ссылка, содержимое её цели не тронуто: ' + lp),
  });
  return true;
}

module.exports = { install, wrapRmSync, clearReadOnlyTree, removeTreeNoFollow };
