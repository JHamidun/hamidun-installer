'use strict';

// Корни профиля пользователя берём из ТОКЕНА процесса, а не из переменных окружения.
//
// ЗАЧЕМ. Установщик идёт под UAC-токеном администратора, а USERPROFILE / APPDATA / LOCALAPPDATA
// (и HOMEDRIVE / HOMEPATH) — это ПЕРЕМЕННЫЕ ОКРУЖЕНИЯ, которые Windows собирает процессу из реестра:
// HKCU\Volatile Environment и HKCU\Environment. Оба ключа доступны на запись любому процессу того же
// пользователя без UAC. Всё, что установщик делает «в профиле» — пак в ~/.claude, HamidunStart,
// install.log, квитанции, настройки VS Code, миграции, удаление, — строится от этих значений:
// os.homedir() на Windows берёт USERPROFILE из окружения ПЕРВЫМ (libuv, uv_os_homedir), а скрипты
// читают $env:USERPROFILE / $env:APPDATA / $env:LOCALAPPDATA. Подмена на каталог ДРУГОЙ учётки
// превратила бы установку в запись и удаление под администратором внутри чужого профиля.
//
// Что проверено на рантайме Electron 44.5.1 (Node 24): os.homedir() идёт за USERPROFILE из окружения,
// а os.userInfo().homedir — НЕТ (GetUserProfileDirectoryW по токену → HKLM ProfileList, окружение не
// читается). Родные пути Electron appData / userData / logs раскрываются ЛЕНИВО, при первом
// app.getPath: папку «Roaming» отдаёт оболочка (HKCU User Shell Folders, по умолчанию
// %USERPROFILE%\AppData\Roaming), а %USERPROFILE% в ней подставляется из окружения процесса. Поэтому
// правка process.env в самом начале main.js возвращает их в профиль токена без app.setPath — но только
// пока никто не спросил app.getPath РАНЬШЕ замка: первый вызов запоминает значение (порядок стережёт
// тест). Абсолютное значение, записанное в сам ключ User Shell Folders, этим модулем не лечится: это класс
// «папки оболочки» (рабочий стол, меню «Пуск»), он вне этого файла.
// Чего проверить НЕЛЬЗЯ без элевации: получает ли UAC-элевированный процесс подмену из Volatile
// Environment. Поэтому это защита в глубину, а не доказанная дыра (границы — в THREAT-MODEL.md): стоит она
// дёшево, а в обычной установке (USERPROFILE совпал с профилем токена) молчит.
//
// Правила (только Windows, на других системах ничего не делаем):
//   • USERPROFILE обязан совпасть с профилем токена (без учёта регистра, формы слэшей и хвостового слэша),
//     иначе берётся профиль токена;
//   • HOMEDRIVE и HOMEPATH выводятся из профиля токена (в доменах там бывает сетевая «домашняя папка» H:\ —
//     у элевированного процесса её всё равно нет);
//   • APPDATA и LOCALAPPDATA должны лежать СТРОГО ВНУТРИ профиля токена: нестандартное место внутри
//     (перенос в OneDrive, подкаталог) сохраняется, всё остальное (другой диск, UNC, чужая учётка,
//     относительный путь, пусто, не задано) заменяется на <профиль>\AppData\Roaming и ...\Local;
//     оставленное значение отдаётся как «профиль В НАПИСАНИИ ТОКЕНА + хвост из значения» — регистр, вид слэшей и
//     написание префикса из окружения до скриптов не доходят;
//   • значение, совпавшее с профилем токена только ПОСЛЕ нормализации (регистр, слэши, хвостовой слэш, пробелы
//     по краям, ./..), молча переписывается каноническим написанием: иначе скрипты получили бы строку, которую
//     Win32 разбирает иначе, чем наше сравнение (в журнал такое не пишется — путь тот же);
//   • TEMP и TMP НЕ трогаем: распаковка portable-exe в %TEMP% — принятый владельцем остаток (THREAT-MODEL).
// «Внутри профиля» — по ТЕКСТУ пути, а не по файловой системе: каталог-связка (junction) внутри профиля,
// ведущая в чужую учётку, этим правилом не ловится, а точку связки злоумышленник может поставить и на самое
// стандартное место (AppData\Roaming). Это отдельный слой — проход по цепочке пути от профиля токена вниз
// до места записи с проверкой точек повторной обработки; он живёт в писателях, не здесь.
//
// Хвостовые точки и пробелы. Win32 (GetFullPathName) отбрасывает их у компонента пути: у ПОСЛЕДНЕГО — все точки
// и пробелы, у промежуточного — одну точку («C:\Users\x\...» он читает как «C:\Users\x\»; сверено на Windows 11
// и закреплено тестом с настоящим GetFullPathName). Текстовое «строго внутри» тогда расходится с тем, что видят
// скрипты: <профиль>\... оказывается самим профилем, как и наше же переписанное значение с пробелом на конце.
// За пределы профиля это не уводит — отбрасывание останавливается на родителе, поэтому чужой учётки оно не
// касается, — но путь попал бы не туда, где его читает проверка. Поэтому значение, у которого ЛЮБОЙ компонент
// после корня (кроме «.» и «..», их normalize уже свернул) оканчивается точкой или пробельным символом,
// непригодно целиком: не «внутри» и не профиль токена. Такие имена Windows сама не создаёт.
// Что правилом НЕ закрыто, и это принято: (а) каталог-связка, см. выше; (б) зарезервированные имена устройств
// (NUL, CON, COM1…): Win32 раскрывает «…\NUL» в «\\.\NUL» — самоповреждение внутри собственного профиля, не выход
// из него; (в) регистр сравнивается через toLowerCase, а NTFS — по своей таблице (знак Кельвина U+212A JS читает
// как «k»), и имя-двойник соседнего каталога может пройти как «внутри». Для USERPROFILE/APPDATA/LOCALAPPDATA
// двойник до скриптов не доходит (они получают профиль в написании токена), а HERMES_HOME в src/nomad-key.js
// отдаётся как задан: воспользоваться двойником можно только в паре с каталогом-соседом рядом с профилем, а
// создать его в C:\Users без прав администратора нельзя — тот же класс, что связка (а).
// Цена правила: на машине, где AppData(Roaming) перенаправлен политикой на сетевой каталог (корпоративная
// «Folder Redirection»), элевированный установщик работает в локальных <профиль>\AppData\* — в журнал
// пишется строка об этом. Это осознанный выбор «закрыто по умолчанию».

const nodePath = require('path');
const W = nodePath.win32;

// Пятак для разработки и e2e-прогонов (test/e2e-gui.js подменяет профиль на временный каталог). Работает
// ТОЛЬКО когда Electron сам говорит «сборка не упакована» (app.isPackaged === false, имя исполняемого
// файла electron.exe): в раздаваемом установщике переменная из реестра ничего не отключает.
const DEV_ENV_VAR = 'HM_ALLOW_PROFILE_ENV';

// Значение переменной по имени БЕЗ учёта регистра: process.env на Windows и так нечувствителен,
// обычный объект (тесты) — нет. Возвращает { key, value } с тем написанием имени, что уже есть в env.
function lookup(env, name) {
  if (!env) return { key: name, value: undefined };
  if (Object.prototype.hasOwnProperty.call(env, name)) return { key: name, value: env[name] };
  const want = name.toLowerCase();
  for (const k of Object.keys(env)) {
    if (k.toLowerCase() === want) return { key: k, value: env[k] };
  }
  return { key: name, value: undefined };
}

// Записать переменную, сохранив уже существующее написание имени (иначе в обычном объекте
// завелись бы USERPROFILE и UserProfile сразу).
function setVar(env, name, value) {
  const f = lookup(env, name);
  env[f.key] = value;
}

// Путь → строка для СРАВНЕНИЯ: слэши прямые → обратные, ./.. свёрнуты, хвостовой слэш снят (кроме корня).
// '' — значение непригодно: не строка, пусто, NUL, либо компонент после корня оканчивается точкой или пробельным
// символом (причина — в заголовке модуля: Win32 отбрасывает такие концы, и текст перестаёт совпадать с тем, что он
// читает). Точные «.» и «..» проверку проходят: normalize свернул их везде, кроме ведущих «..» относительного пути.
function normPath(p) {
  if (typeof p !== 'string') return '';
  let s = p.trim();
  if (!s || s.indexOf('\u0000') !== -1) return '';
  s = W.normalize(s.replace(/\//g, '\\'));
  const root = W.parse(s).root;
  while (s.length > root.length && s.endsWith('\\')) s = s.slice(0, -1);
  for (const c of s.slice(root.length).split('\\')) {
    if (c !== '.' && c !== '..' && /[.\s]$/.test(c)) return '';
  }
  return s;
}

// Абсолютный путь с диском или UNC-корнем, ниже самого корня.
function isUsableHome(p) {
  const s = normPath(p);
  if (!s || !W.isAbsolute(s)) return false;
  if (!/^[A-Za-z]:\\/.test(s) && !/^\\\\[^\\]+\\[^\\]+/.test(s)) return false;
  return s.length > W.parse(s).root.length;
}

const lower = (s) => s.toLowerCase();

// child строго ниже parent → child в написании parent (parent как есть + хвост из child); иначе ''.
// Граница — по КОМПОНЕНТАМ: «C:\Users\student2» НЕ внутри «C:\Users\student». Хвост берётся из компонентов child,
// а не срезом по длине строки: toLowerCase длину не сохраняет (U+0130 → «i» + U+0307), и срез по индексу дал бы
// другой путь, чем тот, что прошёл сравнение.
function under(parent, child) {
  const a = normPath(parent);
  const b = normPath(child);
  if (!a || !b || !W.isAbsolute(b)) return '';
  const ra = W.parse(a).root;
  const rb = W.parse(b).root;
  if (lower(ra) !== lower(rb)) return '';
  const ac = a.slice(ra.length).split('\\').filter(Boolean);
  const bc = b.slice(rb.length).split('\\').filter(Boolean);
  if (bc.length <= ac.length) return '';
  for (let i = 0; i < ac.length; i++) {
    if (lower(ac[i]) !== lower(bc[i])) return '';
  }
  return a + (a.endsWith('\\') ? '' : '\\') + bc.slice(ac.length).join('\\');
}

function isInside(parent, child) {
  return under(parent, child) !== '';
}

// HOMEDRIVE/HOMEPATH из профиля вида C:\Users\x → { drive: 'C:', path: '\Users\x' }; UNC → null.
function splitDrive(home) {
  const m = /^([A-Za-z]:)(\\.*)?$/.exec(normPath(home));
  return m ? { drive: m[1], path: m[2] || '\\' } : null;
}

// Чистая функция: что должно стоять в окружении, исходя из профиля ТОКЕНА.
// Возвращает { status, home, appData, localAppData, homeDrive, homePath,
//              overrides: [{ name, from, to }], respell: [{ name, from, to }] };
// overrides — значения, которые указывали НЕ на профиль токена (идут в журнал); respell — значения, совпавшие
// с ним лишь после нормализации (регистр, слэши, хвостовой слэш, пробелы по краям): их переписываем
// каноническим написанием молча. from — прежнее значение (null, если переменной не было), to — новое.
// Ничего не мутирует.
function resolveProfileRoots(opts) {
  const o = opts || {};
  const env = o.env || {};
  const empty = (status) => ({ status, home: '', appData: '', localAppData: '', homeDrive: '', homePath: '', overrides: [], respell: [] });
  if (o.platform !== 'win32') return empty('noop');
  if (!isUsableHome(o.tokenHome)) return empty('no-token-home');

  const home = normPath(o.tokenHome);
  const overrides = [];
  const respell = [];
  const cur = (name) => { const v = lookup(env, name).value; return v === undefined ? null : String(v); };
  const same = (a, b) => { const x = normPath(a); return x !== '' && lower(x) === lower(normPath(b)); };
  // Значение «то же место», но написанное иначе: строка в окружении всё равно заменяется (без записи в журнал).
  const spelled = (name, from, to) => { if (from !== to) respell.push({ name, from, to }); };

  // USERPROFILE — ровно профиль токена.
  const up = cur('USERPROFILE');
  if (up === null || !same(up, home)) overrides.push({ name: 'USERPROFILE', from: up, to: home });
  else spelled('USERPROFILE', up, home);

  // HOMEDRIVE / HOMEPATH — производные от профиля.
  const sd = splitDrive(home);
  let homeDrive = '';
  let homePath = '';
  if (sd) {
    homeDrive = sd.drive;
    homePath = sd.path;
    const hd = cur('HOMEDRIVE');
    const hp = cur('HOMEPATH');
    const hdSame = hd !== null && lower(hd.trim().replace(/[\\/]+$/, '')) === lower(sd.drive);
    // HOMEPATH сравниваем как путь на том же диске: «\Users\x\» = «\Users\x»
    const hpSame = hp !== null && lower(normPath(sd.drive + hp)) === lower(normPath(sd.drive + sd.path));
    if (!hdSame) overrides.push({ name: 'HOMEDRIVE', from: hd, to: sd.drive });
    else spelled('HOMEDRIVE', hd, sd.drive);
    if (!hpSame) overrides.push({ name: 'HOMEPATH', from: hp, to: sd.path });
    else spelled('HOMEPATH', hp, sd.path);
  }

  // APPDATA / LOCALAPPDATA — строго внутри профиля; оставленное значение отдаём как профиль в написании токена
  // + хвост из значения (префикс из окружения до скриптов не доходит).
  const defRoaming = W.join(home, 'AppData', 'Roaming');
  const defLocal = W.join(home, 'AppData', 'Local');
  const ad = cur('APPDATA');
  const la = cur('LOCALAPPDATA');
  const adIn = ad === null ? '' : under(home, ad);
  const laIn = la === null ? '' : under(home, la);
  const adOk = adIn !== '';
  const laOk = laIn !== '';
  const adNorm = adOk ? adIn : defRoaming;
  const laNorm = laOk ? laIn : defLocal;
  if (!adOk) overrides.push({ name: 'APPDATA', from: ad, to: defRoaming });
  else spelled('APPDATA', ad, adNorm);
  if (!laOk) overrides.push({ name: 'LOCALAPPDATA', from: la, to: defLocal });
  else spelled('LOCALAPPDATA', la, laNorm);

  return {
    status: 'ok',
    home,
    appData: adNorm,
    localAppData: laNorm,
    homeDrive,
    homePath,
    overrides,
    respell,
  };
}

// Применить результат к окружению (process.env): переопределённые переменные и переписанные каноническим
// написанием. Возвращает число ПЕРЕОПРЕДЕЛЁННЫХ (переписанные в счёт не входят — это не расхождение).
function applyProfileRoots(env, roots) {
  const list = (roots && roots.overrides) || [];
  for (const ov of list) setVar(env, ov.name, ov.to);
  const spelling = (roots && roots.respell) || [];
  for (const rs of spelling) setVar(env, rs.name, rs.to);
  return list.length;
}

// Значение из окружения попадает в журнал — его пишет процесс того же пользователя, поэтому управляющие
// символы (перевод строки подделал бы чужую строку журнала) заменяются, длина ограничивается. Класс — все
// управляющие C0 и C1 (U+0085 NEL читают как перевод строки Python str.splitlines и часть просмотрщиков),
// DEL, а также разделители строки и абзаца U+2028 и U+2029.
function clean(v) {
  return String(v).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '?').slice(0, 300);
}

// Строка для install.log по одному переопределению. В ней только пути (они и так попадают в журнал).
function describeOverride(ov, home) {
  const to = '«' + clean(ov.to) + '»';
  const from = ov.from === null ? null : clean(ov.from);
  if (ov.name === 'USERPROFILE') {
    return from === null
      ? 'Профиль: USERPROFILE не задан — беру профиль учётной записи по токену ' + to + '.'
      : 'Профиль: USERPROFILE указывал на «' + from + '», а профиль этой учётной записи по токену — ' + to + '. Работаю в профиле по токену.';
  }
  if (ov.name === 'APPDATA' || ov.name === 'LOCALAPPDATA') {
    return from === null || from === ''
      ? 'Профиль: ' + ov.name + ' не задан — беру ' + to + '.'
      : 'Профиль: ' + ov.name + ' («' + from + '») не лежит строго внутри профиля «' + clean(home) +
        '» (или оканчивается точкой или пробелом) — беру ' + to + '.';
  }
  return 'Профиль: ' + ov.name + (from === null ? ' не задан' : ' («' + from + '») не сходится с профилем') + ' — привожу к ' + to + '.';
}

// Пятак разрешён? Только для заведомо неупакованной сборки и только значением '1'.
function devEnvAllowed(env, isPackaged) {
  return isPackaged === false && String(lookup(env, DEV_ENV_VAR).value) === '1';
}

// Всё вместе, одним вызовом из самого начала main.js. Все зависимости передаются снаружи, поэтому
// функция проверяется без Electron.
//   env           — process.env (мутируется);
//   platform      — process.platform;
//   isPackaged    — app.isPackaged (boolean; что угодно кроме false считается «упакована»);
//   getTokenHome  — () => os.userInfo().homedir (профиль по токену);
//   getFallbackHome — () => app.getPath('home') (тоже по токену; зовётся, только если первый источник упал).
// Возвращает { status: 'noop'|'dev-env'|'ok'|'no-token-home', overrides, lines, roots }, где lines — строки
// для install.log (журнал к этому моменту ещё не открыт: main.js выведет их позже).
function lockProfileRoots(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const platform = o.platform || process.platform;
  const res = { status: 'noop', overrides: [], respell: [], lines: [], roots: null };
  if (platform !== 'win32') return res;

  // Сбой самой проверки (а не расхождение окружения) не должен превращать установщик в кирпич:
  // отказ виден строкой в журнале, дальше всё как до замка. Окружение при этом может остаться
  // исправленным лишь частично — но исключения здесь возможны только от ошибки в коде, не от злоумышленника.
  try {
    if (devEnvAllowed(env, o.isPackaged)) {
      res.status = 'dev-env';
      res.lines.push('Профиль: сборка не упакована и задан ' + DEV_ENV_VAR + '=1 — корни профиля берутся из окружения (режим разработки и e2e).');
      return res;
    }

    let tokenHome = '';
    let usedFallback = false;
    const sources = [o.getTokenHome, o.getFallbackHome];
    for (let i = 0; i < sources.length; i++) {
      if (typeof sources[i] !== 'function') continue;
      try {
        const v = sources[i]();
        if (isUsableHome(v)) { tokenHome = v; usedFallback = i > 0; break; }
      } catch (e) { /* пробуем следующий источник */ }
    }
    if (!tokenHome) {
      res.status = 'no-token-home';
      res.lines.push('ВНИМАНИЕ: профиль учётной записи по токену определить не удалось — каталоги профиля берутся из окружения, как раньше.');
      return res;
    }
    if (usedFallback) res.lines.push('Профиль: основной источник (os.userInfo) недоступен — взят запасной (app.getPath home), тоже по токену.');

    const roots = resolveProfileRoots({ env, tokenHome, platform });
    applyProfileRoots(env, roots);
    res.status = roots.status;
    res.roots = roots;
    res.overrides = roots.overrides;
    res.respell = roots.respell;
    res.lines = res.lines.concat(roots.overrides.map((ov) => describeOverride(ov, roots.home)));
    return res;
  } catch (e) {
    res.status = 'error';
    res.lines.push('ВНИМАНИЕ: проверка корней профиля упала (' + clean(e && e.message) + ') — каталоги профиля берутся из окружения, как раньше.');
    return res;
  }
}

module.exports = {
  DEV_ENV_VAR,
  resolveProfileRoots,
  applyProfileRoots,
  describeOverride,
  lockProfileRoots,
  // для других модулей, которым нужны «строго внутри профиля» и безопасная для журнала строка
  // (src/nomad-key.js: HERMES_HOME обязан лежать внутри профиля)
  isInside,
  cleanForLog: clean,
};
