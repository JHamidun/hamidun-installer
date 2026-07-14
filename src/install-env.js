'use strict';

// #4 (finalize) — ИСТИННЫЙ allowlist для renderer-env элевейтед install-скриптов.
// Вынесено из main.js отдельным ЧИСТЫМ модулем (без electron), чтобы тесты могли
// прогонять фильтр напрямую.
//
// Renderer (medium integrity, тот же юзер) НЕЛЬЗЯ доверять произвольные env-ключи:
// NODE_OPTIONS=--require=...\evil.js, npm_config_*, GIT_EXEC_PATH, NODE_PATH и т.п.
// выполнили бы чужой код при старте npm/node под нашим elevated-токеном. Поэтому из
// renderer-env пропускаем ТОЛЬКО ключи, которые установщик реально эмитит — с
// префиксом HM_ (см. src/renderer/app.js → envForRun) — И ИСКЛЮЧАЕМ HM_REMOTE_CACHE:
// его задаёт main из проверенного (sha256) пути, renderer не должен его подменять.
// Сравнение имён РЕГИСТРОНЕЗАВИСИМО: в Windows env 'Path'/'PATH'/'path' — одно имя,
// поэтому и allowlist сверяем в нижнем регистре (иначе 'nodE_optionS' проскочил бы).
function isAllowedRendererEnvKey(k) {
  const lk = String(k).toLowerCase();
  if (lk === 'hm_remote_cache') return false; // ставит ТОЛЬКО main из проверенного пути
  return lk.indexOf('hm_') === 0;             // только HM_* установщика
}

// Вернуть НОВЫЙ объект с подмножеством renderer-env по allowlist (исходник не мутируем).
function filterRendererEnv(rendererEnv) {
  const out = {};
  const src = rendererEnv || {};
  for (const k of Object.keys(src)) {
    if (isAllowedRendererEnvKey(k)) out[k] = src[k];
  }
  return out;
}

// #4 (finalize round-2) — АВТОРИТЕТНЫЕ системные path-переменные из ВАЛИДИРОВАННОГО
// диска, а НЕ из launch-env. Update-Path в install-скриптах выводит каталоги git/node
// из $env:ProgramFiles/$env:SystemRoot; если установщик запущен с crafted env
// (ProgramFiles=C:\Users\...\evil), то без этой перезаписи в elevated PATH попал бы
// evil\Git\cmd\git.exe. Диск/корень берём из validated winSystemRoot (reparse-safe).
// Профильные переменные (USERPROFILE/LOCALAPPDATA/APPDATA) сюда НЕ входят — они
// по природе user-writable (abs-path fallback в user-профиль — принятый остаток).
function authoritativeWinSystemEnv(winRoot, drive) {
  const path = require('path');
  const root = String(winRoot);
  const drv = String(drive);
  const pf = path.join(drv, 'Program Files');
  const pf86 = path.join(drv, 'Program Files (x86)');
  const programData = path.join(drv, 'ProgramData');
  return {
    SystemRoot: root,
    windir: root,
    SystemDrive: drv.replace(/[\\/]+$/, ''),        // "C:" без хвостового слэша
    ProgramFiles: pf,
    'ProgramFiles(x86)': pf86,
    ProgramW6432: pf,
    ProgramData: programData,
    ALLUSERSPROFILE: programData,
    CommonProgramFiles: path.join(pf, 'Common Files'),
    'CommonProgramFiles(x86)': path.join(pf86, 'Common Files'),
    CommonProgramW6432: path.join(pf, 'Common Files')
  };
}

module.exports = { isAllowedRendererEnvKey, filterRendererEnv, authoritativeWinSystemEnv };
