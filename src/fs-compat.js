'use strict';
/**
 * fs-compat.js — обход бага рантайма Electron 40+ на Windows: `fs.rmSync` падает с EPERM
 * на файле (и на каталоге, где он лежит), у которого стоит атрибут «только чтение».
 *
 * ОТКУДА. Начиная с Electron 40 (Node 24) `rmSync` реализован в C++ поверх
 * `std::filesystem::remove*`, а Electron собирает Node с libc++, который — в отличие от
 * MSVC STL — перед удалением атрибут read-only не снимает (electron/electron#52253,
 * nodejs/node#64374). В Electron 32 (Node 20) и в системном Node 22 такие файлы `rmSync`
 * удаляет — поэтому юнит-тесты, идущие под обычным Node, этот баг НЕ ВИДЯТ. Бэкпорт
 * «исправления» (electron#54255, значится в заметках 44.5.0) на деле не срабатывает:
 * проверено запуском на 44.5.1 и 44.7.0 (Windows 11, Node 24.21.0) — `rmSync` по-прежнему
 * бросает EPERM, тогда как `unlinkSync` и `fs.promises.rm` работают.
 *
 * ЧЕМ ЭТО БЬЁТ ПО УСТАНОВЩИКУ. Ни у одного вызова `fs.rmSync` в `src/` нет ничего, что
 * снимало бы read-only: `rmStagingTree` принимает EPERM за гонку, пять раз повторяет и
 * возвращает false — Admins-only каталог остаётся в %ProgramData%, пользователь стереть его
 * не может; снос карантина при удалении компонента возвращает дерево на место и рапортует
 * «не удалось удалить дерево: EPERM»; переустановка remote-компонента не может убрать прежний
 * finalDir («целевой каталог распаковки не освобождён»). Read-only файлы в таких деревьях
 * возможны (git-пачки в .git/objects, распаковка архивов, собранных на Unix).
 *
 * ЧТО ДЕЛАЕМ. Оборачиваем `fs.rmSync` ОДИН раз при старте main-процесса: поймали EPERM →
 * снимаем read-only у удаляемого дерева → повторяем РОВНО раз. Если снимать было нечего
 * (EPERM не про атрибут: ACL, чужой владелец) — отдаём исходную ошибку, ничего не трогая.
 * Любой другой код ошибки проходит как есть. macOS и рантаймы без бага не затрагиваются.
 * Убрать модуль можно, когда Electron реально починит rmSync (проверка — тест ниже в
 * test/run-tests.js, он гоняет настоящий рантайм).
 *
 * Безопасность. Установщик работает под админом, `chmodSync` идёт ПО ссылке, поэтому дерево
 * обходим через lstat и симлинки/junction не трогаем вовсе (иначе уборка превратилась бы в
 * «снять атрибуты у чужих файлов»). Снимается только атрибут записи у объектов внутри
 * дерева, которое и так сносится этим же вызовом.
 */
const fs = require('fs');
const path = require('path');

/**
 * Снять read-only у дерева (или одного файла). Возвращает, у скольких объектов сняли.
 * Не бросает: что не вышло — то повторный rmSync и так покажет своей ошибкой.
 */
function clearReadOnlyTree(p, fsx) {
  const f = fsx || fs;
  let st;
  try { st = f.lstatSync(p); } catch (e) { return 0; }
  if (st.isSymbolicLink()) return 0;                    // junction в Node тоже isSymbolicLink()
  let n = 0;
  if (st.isDirectory()) {
    let names = [];
    try { names = f.readdirSync(p); } catch (e) { names = []; }
    for (const name of names) n += clearReadOnlyTree(path.join(p, name), f);
  }
  // На Windows бита записи нет ⇔ стоит FILE_ATTRIBUTE_READONLY.
  if (!(st.mode & 0o200)) {
    try { f.chmodSync(p, st.mode | 0o200); n++; } catch (e) { /* не вышло — rmSync скажет сам */ }
  }
  return n;
}

/**
 * Обёртка над rmSync. `opts.fs` — для тестов, `opts.onRetry(path, cleared)` — для журнала.
 */
function wrapRmSync(orig, opts) {
  const o = opts || {};
  const wrapped = function rmSync(p, options) {
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
  return wrapped;
}

/**
 * Включить обход (только Windows, идемпотентно). `log(line)` вызывается, когда обход
 * сработал, — чтобы в install.log осталась строка, а не тихая подмена поведения.
 */
function install(log) {
  if (process.platform !== 'win32') return false;
  if (fs.rmSync && fs.rmSync.__hmReadOnlyRetry) return true;
  fs.rmSync = wrapRmSync(fs.rmSync, {
    onRetry: (p, n) => {
      if (typeof log === 'function') {
        log('rmSync: EPERM на read-only (рантайм Electron 40+) — атрибут снят (объектов: ' + n + '), повторяю: ' + p);
      }
    },
  });
  return true;
}

module.exports = { install, wrapRmSync, clearReadOnlyTree };
