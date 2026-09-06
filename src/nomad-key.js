'use strict';
/**
 * nomad-key.js — запись облачного ключа Nomad в `config.yaml` ПОСЛЕ установки.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫМ ФАЙЛОМ. Логика жила внутри `ipcMain.handle('nomad-set-key')` в
 * `src/main.js`, а `main.js` требует `electron` — то есть из теста не грузится
 * вовсе. Поэтому у фичи не было ни одного теста, и это стоит отдельной строкой в
 * реестре рисков (4.2): блок пишется ТЕМИ ЖЕ тремя регулярками, что и
 * `scripts/windows/nomad.ps1:275`, и при расхождении ключ ляжет в файл криво —
 * агент не заведётся, а человек увидит «неверный ключ».
 *
 * ГЛАВНЫЙ ИНВАРИАНТ: повторная запись ЗАМЕНЯЕТ прежний управляемый блок, а не
 * добавляет второй. Два блока `model:` в одном YAML — валидный файл, в котором
 * парсер возьмёт ПОСЛЕДНИЙ, то есть старый ключ молча победит новый.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// Управляемый блок и «голый» model: — те же выражения, что в nomad.ps1:275.
const MANAGED_BLOCK = /^# >>> nomad-cloud[\s\S]*?# <<< nomad-cloud <<<\r?\n?/m;
const BARE_MODEL = /^model:[ \t]*\r?\n(?:(?:[ \t].*\r?\n)|(?:[ \t]*\r?\n))*/m;

/** Путь к config.yaml агента: HERMES_HOME, иначе платформенный дефолт. */
function nomadConfigPath(env, platform) {
  const e = env || process.env;
  const p = platform || process.platform;
  const hh = e.HERMES_HOME ||
    (p === 'win32'
      ? path.join(e.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'hermes')
      : path.join(os.homedir(), '.hermes'));
  return path.join(hh, 'config.yaml');
}

/**
 * Санитайз ключа. Кавычки и переводы строк сломали бы YAML — вырезаем.
 * Формат НЕ валидируем строго: у кабинета он может смениться, а ложный отказ
 * хуже попытки. Ловим только явный промах — вставили не то поле целиком.
 * @returns {{ok: true, key: string} | {ok: false, reason: 'empty'|'malformed'}}
 */
function sanitizeKey(key) {
  const raw = String(key == null ? '' : key).trim();
  if (!raw) return { ok: false, reason: 'empty' };
  const keySan = raw.replace(/["\r\n]/g, '');
  if (keySan.length < 8 || /\s/.test(keySan)) return { ok: false, reason: 'malformed' };
  return { ok: true, key: keySan };
}

/** Текст управляемого блока. Вынесен, чтобы тест сверял ФОРМУ, а не пересказ. */
function buildBlock(keySan, url, model, nl) {
  return '# >>> nomad-cloud (managed by installer -- do not edit inside markers) >>>' + nl +
    'model:' + nl +
    '  provider: "custom"' + nl +
    '  base_url: "' + url + '"' + nl +
    '  api_key: "' + keySan + '"' + nl +
    '  default: "' + model + '"' + nl +
    '# <<< nomad-cloud <<<' + nl;
}

/**
 * Записать ключ. Зависимости передаются снаружи — тест не поднимает Electron.
 * @param {string} key            ключ из кабинета
 * @param {object} opts
 * @param {object} opts.config    разобранный config.json (для nomad.cloud.*)
 * @param {string} [opts.file]    путь к config.yaml (по умолчанию nomadConfigPath())
 * @param {string} [opts.newline] перевод строки ('\r\n' на win32)
 */
function writeNomadKey(key, opts) {
  const o = opts || {};
  const san = sanitizeKey(key);
  if (!san.ok) return san;

  const cfg = o.config || {};
  const cloud = (cfg.nomad && cfg.nomad.cloud) || {};
  const url = String(cloud.baseUrl || 'https://cp.nomadnet.ai/v1').replace(/["\r\n]/g, '');
  // В config.json поле называется defaultModel (не model) — зеркалит nomad.ps1:284.
  const model = String(cloud.defaultModel || 'claude-opus-4-6').replace(/["\r\n]/g, '');

  const cfgY = o.file || nomadConfigPath();
  const nl = o.newline || (process.platform === 'win32' ? '\r\n' : '\n');
  try {
    fs.mkdirSync(path.dirname(cfgY), { recursive: true });
    let text = '';
    try {
      text = fs.readFileSync(cfgY, 'utf8');
    } catch (e) {
      // НЕ ПРОЧИТАЛИ — НЕ ПИШЕМ. Тот же инвариант, что в credentials-merge.js:12-16.
      // «Файла нет» — это ENOENT/ENOTDIR, и только тогда создавать с нуля безопасно.
      // Любая другая ошибка (EBUSY — конфиг открыт запущенным агентом, EACCES, EIO,
      // облачный placeholder OneDrive) значит «файл, возможно, ЕСТЬ, но мы его не
      // увидели». Прежний код глотал их все: text оставался пустым, и запись ниже
      // заменяла ВЕСЬ config.yaml человека одним нашим блоком — а кнопку «Ключ из
      // кабинета» жмут на финише, когда агентом уже пользовались и настройки в нём
      // накоплены. Потеря молчаливая: ответ приходил ok.
      if (!(e && (e.code === 'ENOENT' || e.code === 'ENOTDIR'))) {
        return { ok: false, reason: 'io',
          message: 'Не удалось прочитать текущий config.yaml (' + ((e && e.code) || String(e)) +
            '). Ключ НЕ записан, чтобы не потерять твои настройки агента. Закрой Nomad и попробуй снова.' };
      }
    }
    text = text.replace(MANAGED_BLOCK, '');
    text = text.replace(BARE_MODEL, '');
    // Без BOM: BOM ломает YAML-парсер (тот же вывод, что в nomad.ps1:311).
    // Запись через временный файл: падение посреди writeFileSync (диск полон,
    // антивирус) оставило бы ОБРЕЗАННЫЙ конфиг агента — то есть сломало бы то,
    // что мы пришли настроить.
    const tmpY = cfgY + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
    const fd = fs.openSync(tmpY, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, buildBlock(san.key, url, model, nl) + text, { encoding: 'utf8' });
      try { fs.fsyncSync(fd); } catch (e2) { /* fsync не везде обязателен */ }
    } finally {
      try { fs.closeSync(fd); } catch (e2) { /* ignore */ }
    }
    try { fs.renameSync(tmpY, cfgY); }
    catch (e2) { try { fs.rmSync(tmpY, { force: true }); } catch (e3) { /* ignore */ } throw e2; }
    return { ok: true, path: cfgY, model };
  } catch (e) {
    // Форма ответа — ровно как была в ipcMain.handle: renderer её уже читает.
    return { ok: false, reason: 'io', message: String((e && e.message) || e) };
  }
}

module.exports = {
  MANAGED_BLOCK, BARE_MODEL,
  nomadConfigPath, sanitizeKey, buildBlock, writeNomadKey,
};
