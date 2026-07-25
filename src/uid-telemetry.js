'use strict';
// Привязка установки к человеку + очистка текстов перед отправкой наружу.
//
// Вынесено из main.js отдельным модулем ровно потому, что это ГРАНИЦА ДОВЕРИЯ: значения
// отсюда уходят на сервер, и их надо проверять напрямую тестами, а не через выковыривание
// функций из большого файла.

const os = require('os');
const fs = require('fs');
const path = require('path');

// uid: 1..32 символа [A-Za-z0-9_-]. Всё остальное отбрасываем ЦЕЛИКОМ — значение едет
// в тело POST, и подставлять туда что попало из имени файла нельзя.
const UID_RE = /^[A-Za-z0-9_-]{1,32}$/;

function sanitizeUid(v) {
  const s = String(v == null ? '' : v).trim();
  return UID_RE.test(s) ? s : '';
}

// Бот выдаёт персональную ссылку hamidun.com/instal?uid=<tg_id>, страница подставляет uid
// в ИМЯ скачиваемого файла, установщик достаёт его здесь и кладёт в каждое событие. Без
// этого события анонимны, и бот не может сказать «вижу, установка упала на шаге X».
//
// Источники — от самого явного к самому косвенному:
//   1) HM_UID в окружении (отладка и автотесты);
//   2) файл hamidun-uid.txt рядом с исполняемым (сценарий dmg/архива, где имя файла
//      до установщика не доезжает);
//   3) собственное имя файла: суффикс --u<uid> перед расширением.
function resolveUid(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const exePath = o.execPath || process.execPath || '';
  try {
    const fromEnv = sanitizeUid(env.HM_UID);
    if (fromEnv) return fromEnv;

    try {
      const side = fs.readFileSync(path.join(path.dirname(exePath), 'hamidun-uid.txt'), 'utf8');
      const fromFile = sanitizeUid(String(side).split(/\r?\n/)[0]);
      if (fromFile) return fromFile;
    } catch (e) { /* нет файла — обычный случай */ }

    // «Hamidun-Setup-Windows--u123456 (1).exe» → 123456.
    // « (1)» Windows дописывает при повторном скачивании: без этой обрезки повторно
    // скачавший человек терял бы привязку.
    const base = path.basename(exePath).replace(/\.[A-Za-z0-9]+$/, '').replace(/\s*\(\d+\)$/, '');
    const m = /--u([A-Za-z0-9_-]{1,32})$/.exec(base);
    if (m) return sanitizeUid(m[1]);
  } catch (e) { /* uid необязателен: без него всё работает, просто анонимно */ }
  return '';
}

// Текст ошибки едет на сервер, а в нём почти всегда лежат пути вида
// C:\Users\Иван\AppData\... — это персональные данные, отправлять их нельзя.
function scrubText(s, opts) {
  const o = opts || {};
  const home = o.home || os.homedir();
  const user = o.user || process.env.USERNAME || process.env.USER || '';
  const esc = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let t = String(s == null ? '' : s);
  // 1) Сначала e-mail и IP. Если делать это ПОСЛЕ имени пользователя, то у человека с
  //    ником «ivan» адрес ivanov@mail.ru превратится в «<user>ov@mail.ru»: адрес
  //    останется, а замена лишь испортит текст.
  t = t.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>');
  t = t.replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, '<ip>');
  try {
    // 2) Домашний каталог — самое длинное и самое частое совпадение.
    if (home && home.length > 3) {
      t = t.split(home).join('~');
      t = t.replace(new RegExp(esc(home).replace(/\\\\/g, '[\\\\/]'), 'gi'), '~');
    }
    // 3) Домашние каталоги ЛЮБЫХ пользователей (в логе встречаются и чужие пути).
    //    Пробел в имени профиля — НОРМА на Windows («C:\Users\John Smith»). Класс
    //    символов, обрывающийся на пробеле, оставлял бы фамилию в тексте
    //    («~ Smith\AppData\…») — то есть ровно ту ПД, ради которой всё это писалось,
    //    и заодно калечил диагностику. Поэтому берём сегмент ЛЕНИВО до следующего
    //    разделителя пути или конца строки, с потолком длины (чтобы на строке без
    //    разделителя не съесть остаток предложения целиком).
    t = t.replace(/([A-Za-z]:)?[\\/]Users[\\/][^\\/"']{1,64}?(?=[\\/]|$)/gi, '~');
    t = t.replace(/[\\/]home[\\/][^\\/"']{1,64}?(?=[\\/]|$)/g, '~');
    // 4) Имя пользователя ОТДЕЛЬНЫМ словом. Без границ ник «hamid» съедал бы кусок
    //    Hamidun-Setup.exe, и вместо диагностики бот получал бы кашу.
    if (user && user.length > 2) {
      t = t.replace(new RegExp('(^|[^A-Za-z0-9_-])' + esc(user) + '(?![A-Za-z0-9_-])', 'gi'), '$1<user>');
    }
  } catch (e) { /* лучше отдать чуть менее чистый текст, чем упасть */ }
  return t.replace(/\s+/g, ' ').trim();
}

module.exports = { UID_RE, sanitizeUid, resolveUid, scrubText };
