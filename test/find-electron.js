'use strict';
/**
 * Поиск бинарника Electron для тестов «под настоящим рантаймом».
 *
 * Зачем отдельным файлом. Такие тесты запускают РЕАЛЬНЫЙ Electron (ELECTRON_RUN_AS_NODE=1),
 * потому что поведение `fs.rmSync` в Electron 40+ (C++ поверх std::filesystem) отличается от
 * системного Node, и юнит-тесты под обычным Node его не видят. Рабочее дерево может не иметь
 * своего `node_modules` (worktree сборки/ревью), тогда пакет лежит в другом каталоге, на
 * который указывает NODE_PATH. Поэтому ищем и там — иначе тест молча пропускался бы именно
 * там, где его запускают для проверки.
 *
 * Лежит в test/, а не внутри IIFE-раздела run-tests.js: так его видят и точечные раннеры
 * (run_titles / run_section), у которых нет общих функций верхнего уровня.
 */
const fs = require('fs');
const path = require('path');

/** → { exe, version, dir } | null. Порядок: <root>/node_modules, затем каждый каталог NODE_PATH. */
function findElectron(root) {
  const dirs = [path.join(root, 'node_modules')];
  String(process.env.NODE_PATH || '').split(path.delimiter).forEach((d) => {
    if (d && dirs.indexOf(d) === -1) dirs.push(d);
  });
  for (const dir of dirs) {
    const pkgDir = path.join(dir, 'electron');
    let rel = '';
    try { rel = fs.readFileSync(path.join(pkgDir, 'path.txt'), 'utf8').trim(); } catch (e) { continue; }
    if (!rel) continue;
    const exe = path.join(pkgDir, 'dist', rel);
    if (!fs.existsSync(exe)) continue;
    let version = '';
    try { version = String(JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version || ''); } catch (e) { /* версия — только для сообщений */ }
    return { exe, version, dir: pkgDir };
  }
  return null;
}

module.exports = { findElectron };
