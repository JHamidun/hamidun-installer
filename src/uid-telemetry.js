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
  // КРИТИЧНО для Windows: сборка — самораспаковывающийся portable-exe. Он распаковывает
  // приложение в %TEMP%\ns<rnd>.tmp\app и запускает ОТТУДА, поэтому process.execPath
  // указывает на «Hamidun Setup.exe» во временной папке, а НЕ на скачанный
  // Hamidun-Setup-Windows--u<uid>.exe. Привязка по имени файла молча не работала бы
  // вообще. Настоящий путь стаб кладёт в PORTABLE_EXECUTABLE_FILE (portable.nsi:78).
  const exePath = o.execPath || env.PORTABLE_EXECUTABLE_FILE || process.execPath || '';
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
    // uid — это telegram_id, то есть ТОЛЬКО цифры. Разбирать его как «любые
    // допустимые символы» нельзя: браузеры дописывают к повторной загрузке свой
    // суффикс, и жадный разбор возвращал несуществующий идентификатор.
    //   Windows/Chrome: «Hamidun-Setup-Windows--u123456 (1).exe»
    //   Safari:         «Hamidun-Setup-Mac--u123456-2.dmg»
    // Второй случай давал uid «123456-2» — хуже анонимности: бот не сматчит
    // человека, а его события выглядят как отдельный пользователь. И это ровно
    // тот человек, ради которого всё делалось: упёрся в блокировку и перекачал.
    const uidFromName = (name) => {
      const base = String(name).replace(/\.[A-Za-z0-9]+$/, '');
      const m = /--u(\d{1,32})(?:\s*\(\d+\)|-\d{1,3})?$/.exec(base);
      return m ? sanitizeUid(m[1]) : '';
    };
    const fromExe = uidFromName(path.basename(exePath));
    if (fromExe) return fromExe;

    // macOS: приложение запускается ИЗ ОБРАЗА, поэтому его собственный путь —
    // /Volumes/Hamidun Setup/Hamidun Setup.app, а имя скачанного файла
    // (Hamidun-Setup-Mac--u123456.dmg) до него не доезжает никак. Спрашиваем сам
    // смонтированный образ, из какого файла он поднят. Без этого привязка событий
    // к человеку на маке не работала вовсе — половина установок оставалась анонимной.
    const platform = o.platform || process.platform;
    if (platform === 'darwin') {
      const exec = o.execFileSync || require('child_process').execFileSync;
      try {
        const out = exec('/usr/bin/hdiutil', ['info'], { encoding: 'utf8', timeout: 15000 });
        for (const line of String(out).split(/\r?\n/)) {
          const im = /^image-path\s*:\s*(.+)$/.exec(line.trim());
          if (!im) continue;
          const name = path.basename(im[1].trim());
          // Только НАШ образ: у человека могут быть смонтированы посторонние dmg,
          // и брать uid из чужого имени файла — значит пускать внешние данные
          // в тело события.
          if (!/^Hamidun-Setup-Mac[A-Za-z0-9._ ()-]*\.dmg$/i.test(name)) continue;
          const got = uidFromName(name);
          if (got) return got;
        }
      } catch (e) { /* образ уже отцеплен или hdiutil недоступен — остаёмся анонимными */ }
    }

    // Последний источник: сам скачанный файл в «Загрузках». Включается, только
    // когда метку не дали ни имя запущенного файла, ни смонтированный образ, —
    // то есть когда приложение унесли из образа в «Программы» (мак) или файл
    // переименовали и перенесли (Windows). Замер по боевым событиям: до этой
    // ветки метка доезжала у 27% установок на Windows и у 5% на macOS.
    const fromDownloads = require('./uid-fallback').findDownloadedUid({ platform, env });
    if (fromDownloads) return fromDownloads;
  } catch (e) { /* uid необязателен: без него всё работает, просто анонимно */ }
  return '';
}

// Текст ошибки едет на сервер, а в нём почти всегда лежат пути вида
// C:\Users\Иван\AppData\... — это персональные данные, отправлять их нельзя.
// Слова, которыми люди называют машины и которые ОДНОВРЕМЕННО встречаются в наших
// же логах как имена компонентов и команд. Такое имя машины не вырезаем: потеря
// диагностики дороже, чем гипотетическая деанонимизация словом «python».
const HOST_DENY = /^(code|node|claude|cursor|python|vscode|nomad|hamidun|setup|extension|config|bridge|course|pydeps|mascot|handy|windows|macbook|imac|admin|user|users|local|home|test)$/i;

function scrubText(s, opts) {
  const o = opts || {};
  const home = o.home || os.homedir();
  const user = o.user || process.env.USERNAME || process.env.USER || '';
  const esc = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Режем ВХОД, а не только результат: регулярки ниже (в частности e-mail) на очень
  // длинной строке из «словных» символов ведут себя квадратично, а сюда приходит текст
  // ошибки произвольной длины. В телеметрию всё равно уезжает не больше 300 символов.
  let t = String(s == null ? '' : s).slice(0, 2000);
  // 1) Сначала e-mail и IP. Если делать это ПОСЛЕ имени пользователя, то у человека с
  //    ником «ivan» адрес ivanov@mail.ru превратится в «<user>ov@mail.ru»: адрес
  //    останется, а замена лишь испортит текст.
  t = t.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>');
  t = t.replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, '<ip>');
  // Диагностика примитива (HMSECFAIL) печатает СЫРЫЕ SID и, если Translate() не смог
  // достучаться до контроллера домена, строку вида DOMAIN\учётка. И то и другое —
  // идентификаторы машины/учётной записи, а не наши компонентные данные. Встроенные
  // SID (S-1-5-18, S-1-5-32-544) оставляем: они одинаковы у всех и как раз объясняют,
  // ЧТО не сошлось.
  t = t.replace(/\bS-1-5-21-[\d-]+/g, '<sid>');
  // DOMAIN\учётка. Границы обязательны: без них правило съело бы обычные пути
  // («C:\Users\student\AppData» → «C:\<account>\AppData»), то есть уничтожило бы саму
  // диагностику. Слева не должно быть разделителя пути/двоеточия/буквы, справа —
  // продолжения пути: тогда под правило попадает только отдельно стоящая пара
  // «домен\учётка», а многосегментные пути остаются целыми.
  t = t.replace(/(?<![\\/:\w])[A-Za-z][\w.-]{1,30}\\[A-Za-z][\w.$-]{1,30}(?![\\/\w])/g, '<account>');
  // Случайные имена служебных каталогов установщика (HmDeElev-<32hex>, unpacking-/
  // unpacked-<hex>). Это не ПД, но и не информация: в каждой установке они РАЗНЫЕ,
  // группировать по ним нельзя, а места в отчёте (300 символов на компонент) они
  // съедали до трети. Оставляем узнаваемое имя без случайной части.
  t = t.replace(/\b(HmDeElev|unpacking|unpacked)-[0-9a-f]{6,}/gi, '$1-<rnd>');
  try {
    // Имя компьютера — идентификатор машины: в отчёт не отдаём. Берём из окружения
    // (COMPUTERNAME на Windows) или os.hostname(). Два предохранителя, иначе чистка
    // сама уничтожит диагностику: короткие имена (≤4 символов) пропускаем, а машину,
    // названную словом из наших же логов («code», «claude», «python»), не вырезаем —
    // такая замена превратила бы «code.cmd не найден» в «<host>.cmd не найден».
    const host = o.host === undefined ? (process.env.COMPUTERNAME || os.hostname() || '') : o.host;
    if (host && String(host).length > 4 && !HOST_DENY.test(String(host))) {
      t = t.replace(new RegExp('(^|[^A-Za-z0-9_-])' + esc(host) + '(?![A-Za-z0-9_-])', 'gi'), '$1<host>');
    }
  } catch (e) { /* имя машины неизвестно — остальная чистка всё равно отрабатывает */ }
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
