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

module.exports = { isAllowedRendererEnvKey, filterRendererEnv };
