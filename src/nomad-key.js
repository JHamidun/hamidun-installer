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
const profileEnv = require('./profile-env');
const linkGuard = require('./link-guard');

// Управляемый блок и «голый» model: — те же выражения, что в nomad.ps1:275.
const MANAGED_BLOCK = /^# >>> nomad-cloud[\s\S]*?# <<< nomad-cloud <<<\r?\n?/m;
const BARE_MODEL = /^model:[ \t]*\r?\n(?:(?:[ \t].*\r?\n)|(?:[ \t]*\r?\n))*/m;

// Каталог агента и путь к config.yaml: { file, message, log }. file === '' — писать НЕЛЬЗЯ: причина для человека
// в message, для install.log в log. Путь из окружения идёт только в log (там он очищен от управляющих
// символов); на экран он не попадает.
//
// HERMES_HOME — переменная окружения, а на Windows её читает ЭЛЕВИРОВАННЫЙ main-процесс (обработчик
// nomad-set-key): mkdir -p и замена файла идут под администратором. Переменную же пишет любой процесс
// того же пользователя (HKCU\Environment), так что без проверки она выбирала бы корень админской записи —
// каталог, куда пользователь писать не может, или чужой config.yaml (тот же класс, что USERPROFILE в
// src/profile-env.js; для Codex в этом репозитории CODEX_HOME не читается вовсе). Поэтому на Windows
// HERMES_HOME принимается, только если лежит СТРОГО ВНУТРИ профиля (profile-env.isInside: граница по
// разделителю, `..` свёрнуты, чужой диск/UNC/относительный путь не проходят). Вне профиля — ОТКАЗ, а не
// молчаливая подмена каталогом по умолчанию: человек с настоящим HERMES_HOME вне профиля получил бы
// «готово», а агент читал бы другой файл. «Внутри профиля» — по тексту пути: связи (junction) внутри
// профиля этим не закрываются, это отдельный слой защиты. Скрипты установки переменную не получают (её
// нет в WIN_SYS_ENV_KEYS), так что расхождения с ними нет. На macOS/Linux установщик не элевирован,
// граница привилегий отсутствует — значение переменной по-прежнему главнее.
// home — профиль (в проде os.homedir() ПОСЛЕ замка профиля = профиль токена); подменяется в тестах.
function resolveConfigPath(env, platform, home) {
  const e = env || process.env;
  const p = platform || process.platform;
  const requested = e.HERMES_HOME == null ? '' : String(e.HERMES_HOME).trim();
  let h = home || '';
  if (!h) { try { h = os.homedir(); } catch (err) { h = ''; } }
  if (p !== 'win32') {
    const hh = requested || (h ? path.join(h, '.hermes') : '');
    if (!hh) {
      // домашний каталог не определился: относительный .hermes (от cwd) писать нельзя
      return {
        file: '',
        message: 'Не удалось определить домашний каталог, куда писать config.yaml агента. Ключ НЕ записан.',
        log: 'Nomad: домашний каталог определить не удалось — ключ не записан.',
      };
    }
    return { file: path.join(hh, 'config.yaml'), message: '', log: '' };
  }
  const W = path.win32;
  if (requested) {
    if (h && profileEnv.isInside(h, requested)) return { file: W.join(requested, 'config.yaml'), message: '', log: '' };
    return {
      file: '',
      message: 'Переменная HERMES_HOME указывает вне твоего профиля, а в каталоги за его пределами установщик ' +
        'не пишет. Ключ НЕ записан. Убери переменную HERMES_HOME (или перенеси каталог агента внутрь профиля) и повтори.',
      log: 'Nomad: HERMES_HOME («' + profileEnv.cleanForLog(requested) + '») указывает вне профиля («' +
        profileEnv.cleanForLog(h) + '») — ключ не записан.',
    };
  }
  const local = e.LOCALAPPDATA || (h ? W.join(h, 'AppData', 'Local') : '');
  if (!local || !W.isAbsolute(local)) {
    return {
      file: '',
      message: 'Не удалось определить каталог профиля, куда писать config.yaml агента. Ключ НЕ записан.',
      log: 'Nomad: профиль и LOCALAPPDATA определить не удалось — ключ не записан.',
    };
  }
  return { file: W.join(local, 'hermes', 'config.yaml'), message: '', log: '' };
}

/** Путь к config.yaml агента или null, когда писать нельзя (см. resolveConfigPath). */
function nomadConfigPath(env, platform, home) {
  return resolveConfigPath(env, platform, home).file || null;
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
 * @param {string} [opts.file]    путь к config.yaml (по умолчанию resolveConfigPath())
 * @param {string} [opts.newline] перевод строки ('\r\n' на win32)
 * @param {object} [opts.env]     окружение для разрешения каталога (по умолчанию process.env)
 * @param {string} [opts.platform] платформа для разрешения каталога (по умолчанию process.platform)
 * @param {string} [opts.home]    профиль, внутри которого обязан лежать HERMES_HOME на Windows (по умолчанию os.homedir())
 * @returns при отказе выбрать каталог (HERMES_HOME вне профиля) ответ {ok:false, reason:'io', message, log}:
 *          message — человеку, log — строка для install.log (её пишет вызывающий)
 */
// Переименование временного файла поверх config.yaml на Windows спорадически падает с EPERM/EBUSY/EACCES:
// антивирус или индексатор на миг держит только что записанный файл. Замер: 23 отказа из 800 записей
// даже на свободной машине — человек видел «Не удалось записать ключ» там, где вторая попытка проходит.
// Повторяем только эти три кода, с растущей паузой (30, 120, 270, 480, 750 мс — до ~1,7 с в самом плохом
// случае); любой другой сбой (нет каталога, диск полон) пробрасываем сразу. rename/sleep подменяются в тесте.
const RENAME_RETRY_CODES = ['EPERM', 'EBUSY', 'EACCES'];
function renameWithRetry(from, to, opts) {
  const o = opts || {};
  const rename = o.rename || fs.renameSync;
  const sleep = o.sleep || ((ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms));
  let last = null;
  for (let i = 1; i <= 6; i++) {
    try { rename(from, to); return; }
    catch (e) {
      last = e;
      if (!e || RENAME_RETRY_CODES.indexOf(e.code) === -1 || i === 6) throw e;
      sleep(30 * i * i);
    }
  }
  throw last;
}

function writeNomadKey(key, opts) {
  const o = opts || {};
  const san = sanitizeKey(key);
  if (!san.ok) return san;

  const cfg = o.config || {};
  const cloud = (cfg.nomad && cfg.nomad.cloud) || {};
  const url = String(cloud.baseUrl || 'https://cp.nomadnet.ai/v1').replace(/["\r\n]/g, '');
  // В config.json поле называется defaultModel (не model) — зеркалит nomad.ps1:284.
  const model = String(cloud.defaultModel || 'claude-opus-4-6').replace(/["\r\n]/g, '');

  let cfgY = o.file;
  if (!cfgY) {
    // Каталог выбирает окружение (HERMES_HOME) — до mkdir и записи проверяем его; отказ не создаёт ничего.
    const r = resolveConfigPath(o.env, o.platform, o.home);
    if (!r.file) return { ok: false, reason: 'io', message: r.message, log: r.log };
    cfgY = r.file;
  }
  const nl = o.newline || (process.platform === 'win32' ? '\r\n' : '\n');
  // Ссылки на пути (u10a, F16). Запись идёт из процесса с правами администратора, а HERMES_HOME/LOCALAPPDATA
  // проверены лишь ПО ТЕКСТУ пути (строго внутри профиля, см. resolveConfigPath): каталог-связка (junction)
  // внутри профиля, ведущая в чужую учётку, этим не ловится. Поэтому цепочка от профиля до config.yaml
  // проверяется на ссылки (src/link-guard.js) до любых действий, после создания каталога и сразу после создания
  // временного файла. Ключ — секрет, поэтому отказ жёсткий: ничего не записано, человек видит причину.
  let home = o.home || '';
  if (!home) { try { home = os.homedir(); } catch (err) { home = ''; } }
  // Явный `file` без `home` (тестовый шов; main.js его не передаёт) — корнем служит каталог файла.
  const anchor = o.anchor || (o.file && !o.home ? path.dirname(cfgY) : home);
  const guard = () => linkGuard.assertNoLinkInChain(cfgY, anchor, { platform: o.platform }, 'файлу настроек агента (config.yaml)');
  try {
    guard();                                    // до mkdir: он тоже идёт по ссылке
    fs.mkdirSync(path.dirname(cfgY), { recursive: true });
    guard();                                    // каталог мог стать ссылкой между проверкой и созданием
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
    // Сразу после создания временного файла: подмена ПОСЛЕ этого уже не уведёт rename (временный файл остался по эту
    // сторону ссылки), подмена ДО — видна здесь; тогда убираем свой временный файл и отказываем (ключ в него НЕ пишем).
    try { guard(); }
    catch (e2) {
      try { fs.closeSync(fd); } catch (e3) { /* ignore */ }
      try { fs.rmSync(tmpY, { force: true }); } catch (e3) { /* ignore */ }
      throw e2;
    }
    try {
      fs.writeFileSync(fd, buildBlock(san.key, url, model, nl) + text, { encoding: 'utf8' });
      try { fs.fsyncSync(fd); } catch (e2) { /* fsync не везде обязателен */ }
    } finally {
      try { fs.closeSync(fd); } catch (e2) { /* ignore */ }
    }
    try { renameWithRetry(tmpY, cfgY, o); }
    catch (e2) { try { fs.rmSync(tmpY, { force: true }); } catch (e3) { /* ignore */ } throw e2; }
    return { ok: true, path: cfgY, model };
  } catch (e) {
    // Форма ответа — ровно как была в ipcMain.handle: renderer её уже читает.
    if (e && e.code === 'EHMLINK') return { ok: false, reason: 'io', message: e.message + '. Ключ НЕ записан.' };
    return { ok: false, reason: 'io', message: String((e && e.message) || e) };
  }
}

module.exports = {
  MANAGED_BLOCK, BARE_MODEL,
  nomadConfigPath, resolveConfigPath, sanitizeKey, buildBlock, renameWithRetry, writeNomadKey,
};
