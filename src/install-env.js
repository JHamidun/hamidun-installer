'use strict';

// #4 (finalize) — ИСТИННЫЙ allowlist для renderer-env элевейтед install-скриптов.
// Вынесено из main.js отдельным ЧИСТЫМ модулем (без electron), чтобы тесты могли
// прогонять фильтр напрямую.
//
// Renderer (medium integrity, тот же юзер) НЕЛЬЗЯ доверять произвольные env-ключи:
// NODE_OPTIONS=--require=...\evil.js, npm_config_*, GIT_EXEC_PATH, NODE_PATH и т.п.
// выполнили бы чужой код при старте npm/node под нашим elevated-токеном. Поэтому из
// renderer-env пропускаем ТОЛЬКО ключи, которые установщик реально эмитит.
//
// Это ЯВНЫЙ СПИСОК КЛЮЧЕЙ, а не префикс-тест HM_*: префикс пропускал бы и ключи,
// которых envForRun не эмитит НИКОГДА (HM_COURSE_TARGET, HM_COURSE_BEACON_URL,
// HM_NOMAD_CLOUD_BASEURL/KEY, HM_BRIDGE_TOKEN…), а их читают элевейтед install-скрипты
// как путь раскладки / внешний URL. HM_REMOTE_CACHE отсутствует в списке намеренно:
// его задаёт main из проверенного (sha256) пути, renderer не должен его подменять.
//
// ВАЖНО: новый HM_-ключ в src/renderer/app.js → envForRun ОБЯЗАН быть добавлен сюда,
// иначе он молча не доедет до install-скрипта.
const RENDERER_ENV_ALLOW = new Set([
  'hm_config_repo_url', 'hm_config_repo_branch', 'hm_claude_ext_id', 'hm_home',
  'hm_keep_skills', 'hm_all_pack_skills', 'hm_bridge_endpoint', 'hm_bridge_pacdomains',
  'hm_selected', 'hm_additive', 'hm_repair', 'hm_repair_confirmed',
  // Опции компонентов (галочки внутри карточки, components.json → options[]).
  // hm_handy_mic: '1' = человек разрешил записать согласие на микрофон для Handy.
  // Значение НИЧЕГО не резолвит (не путь, не URL) — только «да/нет» для install-скрипта.
  'hm_handy_mic'
]);

// Сравнение имён РЕГИСТРОНЕЗАВИСИМО: в Windows env 'Path'/'PATH'/'path' — одно имя,
// поэтому и allowlist сверяем в нижнем регистре (иначе 'nodE_optionS' проскочил бы).
// HM_REMOTE_CACHE режется самим списком (его там нет и быть не должно: ставит ТОЛЬКО
// main из sha256-проверенного пути; плюс main безусловно delete-ит его из renderer-env).
function isAllowedRendererEnvKey(k) {
  return RENDERER_ENV_ALLOW.has(String(k).toLowerCase());
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
  // Всегда win32-семантика (вызывается ТОЛЬКО из if(IS_WIN) в main.js, см. main.js:768) —
  // path.win32 явно, а не host-зависимый require('path'): иначе на CI-раннере macOS/Linux
  // (path === path.posix) join('C:\\Windows\\', 'Program Files') не строил бы Windows-путь,
  // и функция была бы непроверяема без физической Windows-машины.
  const path = require('path').win32;
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
