'use strict';

// «Стоят ли Python-пакеты pydeps» — по ФАЙЛАМ, интерпретатор не запускается.
//
// ЗАЧЕМ. Детекция идёт при открытии окна, до единого клика, и под администратором. Раньше она
// запускала `python -E -c "import PIL, requests"`. Ключ -E не отключает user site-packages:
// при старте интерпретатор исполняет usercustomize.py и import-строки *.pth из
// %APPDATA%\Python\Python3xx\site-packages — каталога, куда пишет любой процесс того же пользователя
// (воспроизведено на настоящем Python: оба файла выполняются; гаснут они только от -s / -I). Использовать
// -s нельзя — pydeps ставит пакеты `pip install --user`, детекция стала бы вечно ложно-отрицательной.
// Поэтому ничего не запускаем: пакет «есть», если в нужном site-packages лежит каталог модуля с
// __init__.py ЛИБО <имя>-<версия>.dist-info.
//
// Где смотрим (версию интерпретатора определяем, НЕ запуская его):
//   • <каталог python.exe>\Lib\site-packages (общая установка; у venv — рядом с каталогом Scripts);
//   • user site: %APPDATA%\Python\Python<мажор><минор>[-32|-arm64]\site-packages, где версия берётся из имени
//     каталога PythonXYZ, из python3XY.dll рядом или из version= в pyvenv.cfg.
// Магазинный псевдоним (…\WindowsApps\python.exe) — не Python и пакетов не содержит: исключён, как в pydeps.ps1.
// Ложный минус безвреден (pydeps идемпотентен и поставит пакеты заново), ложный плюс лишь снимает галку.
// Переменная PYTHONUSERBASE не учитывается намеренно: она не вошла бы в доверенное окружение детекции.
//
// Модуль чистый: путь к ФС передаётся (по умолчанию настоящая), child_process не подключается — это
// проверяет тест (ни одного запуска процесса за время детекции).

const nodeFs = require('fs');
const nodePath = require('path');

// import-имя модуля → имя дистрибутива в <имя>-<версия>.dist-info (Pillow ставит модуль PIL).
// playwright — тот же набор, что проверяет финальный verify.ps1 («Python-пакеты»): карточка «уже установлено»
// не должна быть мягче итоговой проверки (браузер Playwright main.js требует отдельно).
const PYDEPS_MODULES = [
  { module: 'PIL', dist: 'pillow' },
  { module: 'requests', dist: 'requests' },
  { module: 'playwright', dist: 'playwright' },
];

function isStoreAlias(p) {
  return /[\\/]windowsapps[\\/]/i.test(String(p));
}

function safeReaddir(fsx, dir) {
  try { return fsx.readdirSync(dir, { withFileTypes: true }); } catch (e) { return []; }
}

function isFile(fsx, p) {
  try { return fsx.statSync(p).isFile(); } catch (e) { return false; }
}

// 'Python312' → '312'; не Python3 → ''.
const PY_DIR = /^python(3\d{1,2})(?:-32|-arm64)?$/i;

// Версия «3XY» интерпретатора без запуска: имя каталога → python3XY.dll рядом → pyvenv.cfg.
function pythonTag(pyExe, fsx) {
  const dir = nodePath.dirname(pyExe);
  let m = PY_DIR.exec(nodePath.basename(dir));
  if (m) return m[1];
  for (const ent of safeReaddir(fsx, dir)) {
    m = /^python(3\d{1,2})\.dll$/i.exec(ent.name);
    if (m) return m[1];
  }
  // venv: pyvenv.cfg лежит над каталогом Scripts (или рядом с python.exe)
  for (const cfg of [nodePath.join(nodePath.dirname(dir), 'pyvenv.cfg'), nodePath.join(dir, 'pyvenv.cfg')]) {
    try {
      const v = /^\s*version(?:_info)?\s*=\s*3\.(\d{1,2})/im.exec(fsx.readFileSync(cfg, 'utf8'));
      if (v) return '3' + v[1];
    } catch (e) { /* нет файла */ }
  }
  return '';
}

// Каталоги site-packages, где мог бы лежать пакет для этого интерпретатора.
function sitePackagesDirs(pyExe, appData, fsx) {
  const dir = nodePath.dirname(pyExe);
  const out = [nodePath.join(dir, 'Lib', 'site-packages')];
  if (/^scripts$/i.test(nodePath.basename(dir))) out.push(nodePath.join(nodePath.dirname(dir), 'Lib', 'site-packages'));
  const tag = pythonTag(pyExe, fsx);
  if (tag && appData) {
    // 32-битная и ARM64-сборки кладут user site в каталог с суффиксом платформы
    for (const sfx of ['', '-32', '-arm64']) out.push(nodePath.join(appData, 'Python', 'Python' + tag + sfx, 'site-packages'));
  }
  return out;
}

// В site лежит каталог модуля с __init__.py либо <dist>-<версия>.dist-info.
function hasPackage(site, mod, dist, fsx) {
  if (isFile(fsx, nodePath.join(site, mod, '__init__.py'))) return true;
  const rx = new RegExp('^' + String(dist).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-\\d', 'i');
  return safeReaddir(fsx, site).some((ent) => ent.isDirectory() && /\.dist-info$/i.test(ent.name) && rx.test(ent.name));
}

// opts: { pyExe, appData, modules?, fs? } → { installed, missing: [import-имена], sites: [...], skipped }
function detectPythonPackages(opts) {
  const o = opts || {};
  const fsx = o.fs || nodeFs;
  const modules = o.modules || PYDEPS_MODULES;
  const res = { installed: false, missing: modules.map((m) => m.module), sites: [], skipped: '' };
  const pyExe = o.pyExe ? String(o.pyExe) : '';
  if (!pyExe) { res.skipped = 'no-interpreter'; return res; }
  if (isStoreAlias(pyExe)) { res.skipped = 'store-alias'; return res; }
  const sites = sitePackagesDirs(pyExe, o.appData ? String(o.appData) : '', fsx);
  res.sites = sites;
  res.missing = modules.filter((m) => !sites.some((s) => hasPackage(s, m.module, m.dist, fsx))).map((m) => m.module);
  res.installed = res.missing.length === 0;
  return res;
}

module.exports = { PYDEPS_MODULES, detectPythonPackages, pythonTag, sitePackagesDirs, hasPackage, isStoreAlias };
