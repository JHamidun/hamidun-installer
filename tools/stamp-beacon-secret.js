#!/usr/bin/env node
/* stamp-beacon-secret.js — подставить секрет подписи маяка В СБОРКУ, не в репозиторий.
 *
 * ЗАЧЕМ. Маяк завершения курса шлёт в академию `{ts, email, course}` и подписывает
 * их HMAC по общему секрету. Цепочка такая:
 *
 *   config.json → course.beaconSecret
 *     → src/main.js:1162 → childEnv.HM_COURSE_BEACON_SECRET
 *       → scripts/{macos/course.sh,windows/course.ps1} → HMAC-подпись
 *
 * Всё это было на месте и работало — кроме одного: значения. Поле стояло пустым, и
 * НИЧТО его не заполняло. Комментарий в config.json когда-то утверждал, что значение
 * подставляет fetch-vendor на сборке; проверено обходом файла — там не было ни одного
 * упоминания beaconSecret. Маяк уходил НЕПОДПИСАННЫМ во всех сборках, а академия
 * помечала его недоказанным. Это не регресс, так было всегда.
 *
 * Секрет при этом существовал: `CC_BEACON_SECRET` в контейнере `academy-funnel`.
 * Не хватало ровно моста между сервером и сборкой — им и является этот файл.
 *
 * ПОЧЕМУ ОТДЕЛЬНЫЙ ИНСТРУМЕНТ, А НЕ СТРОЧКА В fetch-vendor.ps1. Тот Windows-only, а
 * mac собирается своим воркфлоу и его не зовёт. Секрет, подставляемый только на одной
 * платформе, — это половина защиты, которая читается как целая.
 *
 * ГДЕ БЕРЁТСЯ ЗНАЧЕНИЕ, по убыванию приоритета:
 *   1. переменная окружения HM_COURSE_BEACON_SECRET — так его даёт CI (секрет GitHub);
 *   2. ~/.claude/.credentials.master.env → CC_BEACON_SECRET — так его берёт локальная
 *      сборка владельца;
 *   3. нет нигде → поле остаётся пустым, печатается честная строка, код возврата 0.
 *
 * ТРЕТИЙ СЛУЧАЙ НЕ ПАДЕНИЕ, И ЭТО ОСОЗНАННО. Собирать установщик должен уметь и тот,
 * у кого нет доступа к академии. Падение здесь превратило бы «подпись не настроена» в
 * «сборка сломана», а это разные вещи. Чтобы факт не потерялся, о нём говорит
 * release-check: неподписанный маяк — предупреждение вердикта, а не тишина.
 *
 * ЗАПОЛНЕННОЕ ПОЛЕ НЕ КОММИТИТСЯ. Инструмент правит config.json В РАБОЧЕМ ДЕРЕВЕ на
 * время сборки; в git поле обязано оставаться пустым, и это сторожит отдельный тест
 * («git: committed config.json НЕ содержит заполненный beaconSecret»). Проверка идёт
 * по `git show HEAD:config.json`, а не по диску, — именно потому, что на диске во
 * время сборки значение как раз стоит.
 *
 * Запуск:  node tools/stamp-beacon-secret.js [--clear]
 *   --clear возвращает поле в пустое (вызывается уборкой после сборки).
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CFG = path.join(ROOT, 'config.json');
const CREDS = path.join(os.homedir(), '.claude', '.credentials.master.env');

/** Значение из .credentials.master.env по имени ключа. Файл — построчный KEY=VALUE
 *  с комментариями; значение может содержать '=' (base64), поэтому режем по ПЕРВОМУ. */
function fromCreds(name) {
  let text;
  try { text = fs.readFileSync(CREDS, 'utf8'); } catch (e) { return ''; }
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const eq = s.indexOf('=');
    if (eq <= 0) continue;
    if (s.slice(0, eq).trim() !== name) continue;
    return s.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
  }
  return '';
}

function readCfg() {
  return fs.readFileSync(CFG, 'utf8');
}

/** Замена ЗНАЧЕНИЯ course.beaconSecret строго по месту.
 *
 *  Замена идёт ФУНКЦИЕЙ, а не строкой: `String.replace` со строкой-заменой толкует
 *  `$&`, `$1`, `$'` как ссылки на группы, а секрет — произвольные 64 знака, в которых
 *  доллар вполне может встретиться. Тот же класс ошибки уже ловили в записи ключей
 *  визарда (`src/credentials-merge.js`), и повторять его здесь незачем. */
function writeSecret(raw, value) {
  const re = /("beaconSecret"\s*:\s*)"(?:[^"\\]|\\.)*"/;
  if (!re.test(raw)) return null;
  const json = JSON.stringify(String(value));
  return raw.replace(re, () => '"beaconSecret": ' + json);
}

function main(argv) {
  const clear = argv.includes('--clear');
  const secret = clear ? '' : (process.env.HM_COURSE_BEACON_SECRET || fromCreds('CC_BEACON_SECRET') || '');

  let raw;
  try { raw = readCfg(); } catch (e) {
    console.log('[beacon] config.json не прочитан — ' + String(e.message || e));
    return 0;
  }

  const next = writeSecret(raw, secret);
  if (next === null) {
    console.log('[beacon] в config.json нет поля course.beaconSecret — подставлять некуда.');
    return 0;
  }

  if (next !== raw) fs.writeFileSync(CFG, next, 'utf8');

  if (clear) {
    console.log('[beacon] секрет убран из config.json (поле снова пустое).');
  } else if (secret) {
    const src = process.env.HM_COURSE_BEACON_SECRET ? 'HM_COURSE_BEACON_SECRET' : 'CC_BEACON_SECRET (креды)';
    console.log('[beacon] подпись маяка ВКЛЮЧЕНА: секрет взят из ' + src +
      ', длина ' + secret.length + '. В git поле остаётся пустым.');
  } else {
    console.log('[beacon] секрета нет ни в HM_COURSE_BEACON_SECRET, ни в CC_BEACON_SECRET — ' +
      'маяк уйдёт НЕПОДПИСАННЫМ, академия пометит его недоказанным. Это не ошибка сборки.');
  }
  return 0;
}

module.exports = { fromCreds, writeSecret, CFG, CREDS };

if (require.main === module) process.exit(main(process.argv));
