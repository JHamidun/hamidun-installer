'use strict';
/**
 * credentials-merge.js — слияние ключей мини-визарда в `.credentials.master.env`.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫМ ФАЙЛОМ. Логика жила внутри `ipcMain.handle('save-credentials')`
 * в `src/main.js`, а тот требует `electron` и из теста не грузится. При этом
 * цена ошибки здесь — ВСЕ ключи человека: неудачная запись затирает файл,
 * бэкапа нет, откатить нечем.
 *
 * ДВА ИНВАРИАНТА, ради которых код выглядит именно так:
 *
 * 1. **Не прочитали — не пишем.** `ENOENT`/`ENOTDIR` значит «файла нет» и это
 *    норма. ЛЮБАЯ другая ошибка чтения (EBUSY, EACCES, EIO, cloud-placeholder
 *    OneDrive) значит «файл, возможно, ЕСТЬ, но мы его не увидели» — и запись
 *    затёрла бы все прежние ключи одной новой строкой, вернув при этом `ok`.
 *    Поэтому fail-closed, как `probePath` в `install-mode.js`.
 *
 * 2. **Замена значения не толкует `$`.** `String.replace` со строкой-заменой
 *    трактует `$&`, `$1`, `$'` как ссылки. В API-ключах доллар встречается.
 *    Поэтому замена — ФУНКЦИЕЙ: она отдаёт строку буквально.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

/** Имя переменной окружения: заглавные, цифры и подчёркивание, начиная с буквы. */
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
/** «Файла нет» — единственные коды, при которых писать безопасно. */
const ABSENT = new Set(['ENOENT', 'ENOTDIR']);

function credentialsPath(home) {
  return path.join(home || os.homedir(), '.claude', '.credentials.master.env');
}

/**
 * Слить ключи в файл. Существующие `KEY=…` заменяются НА МЕСТЕ, недостающие
 * дописываются в конец. Ничего другого не удаляется и не переставляется.
 *
 * @param {object} obj          {KEY: 'value'} из визарда
 * @param {object} [opts]
 * @param {string} [opts.file]  путь к файлу ключей
 * @returns {{ok: true, saved: string[], path: string} | {ok: false, error: string}}
 */
function saveCredentials(obj, opts) {
  const o = opts || {};
  const file = o.file || credentialsPath(o.home);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      if (!(e && ABSENT.has(e.code))) {
        return { ok: false, error: 'Не удалось прочитать существующий файл ключей (' +
          ((e && e.code) || String(e)) + '). Ключи НЕ сохранены, чтобы не потерять уже записанные.' };
      }
      text = '';
    }

    const saved = [];
    for (const key of Object.keys(obj || {})) {
      if (!ENV_NAME.test(key)) continue;
      const raw = obj[key];
      if (typeof raw !== 'string') continue;
      const val = raw.trim().replace(/[\r\n]+/g, '');
      if (!val) continue;                       // пустые поля игнорируем
      const line = key + '=' + val;
      const re = new RegExp('^' + key + '=.*$', 'm');
      if (re.test(text)) text = text.replace(re, () => line);   // fn: `$` буквально
      else {
        if (text.length && !text.endsWith('\n')) text += '\n';
        text += line + '\n';
      }
      saved.push(key);
    }

    if (saved.length) {
      // Атомарная замена: без tmp+rename падение посреди записи (диск полон,
      // антивирус) оставило бы ОБРЕЗАННЫЙ файл ключей.
      const tmp = file + '.tmp-' + process.pid;
      fs.writeFileSync(tmp, text, 'utf8');
      try { fs.renameSync(tmp, file); }
      catch (e) { try { fs.rmSync(tmp, { force: true }); } catch (e2) { /* ignore */ } throw e; }
    }
    return { ok: true, saved, path: file };
  } catch (e) {
    return { ok: false, error: String(e) };   // форма ответа как была в ipcMain.handle
  }
}

module.exports = { ENV_NAME, ABSENT, credentialsPath, saveCredentials };
